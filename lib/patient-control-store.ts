// ——— Controles do paciente: camada de dados (Fase 4.7) ———
//
//   conversationQuestionSessions/{sessionId}/patientControls/{id}
//
// O QUE ESTA COLEÇÃO GUARDA, e só ela: o fato de que o PACIENTE pediu algo.
// A execução de cada comando delega aos verbos que já existem — pausar a
// sessão, reapresentar um turno/nível/frase, interromper um caminho — porque
// duplicar essas transições criaria um segundo jeito de mudar o mesmo estado.
//
// ATOMICIDADE: a execução acontece na MESMA transação do patch do pedido e da
// auditoria. Ou o comando inteiro entra, ou nada entra — nunca uma pausa
// registrada sem o pedido que a causou, nem um pedido "executado" cuja
// execução não aconteceu.
//
// ABRIR O PAINEL NÃO TOCA EM NADA. Nenhuma escrita fora do próprio documento
// do pedido: o turno, o nível e a frase em curso continuam exatamente como
// estavam, e é isso que faz "Voltar para a conversa" devolver a tela intacta.

import { firestore } from "@/lib/firestore";
import {
  gravarLedger,
  lerLedger,
  newId,
  sessionDoc,
  writeAudit,
  type Assistant,
} from "@/lib/realtime-question-store";
import {
  applySessionAction,
  applyTurnAction,
} from "@/lib/realtime-question-machine";
import {
  applyNodeAction,
  applyPathAction,
  applyStatementAction,
} from "@/lib/option-conversation-machine";
import {
  applyPatientControlAction,
  assertSessionAcceptsControlAction,
  assertSessionAcceptsNewControlRequest,
  PATIENT_REQUEST_EVENT,
  type PatientControlAction,
} from "@/lib/patient-control-machine";
import {
  assertPatientControlInvariants,
  isControlTargetType,
  isPatientCommand,
  isTerminalControlStatus,
  RtqDomainError,
  type ControlLevel,
  type ControlTargetType,
  type PatientCommand,
  type PatientControlRequest,
  type PatientControlStatus,
} from "@/lib/patient-control-types";
import type {
  ConversationQuestionTurn,
  RtqSessionStatus,
  SemanticResponse,
} from "@/lib/realtime-question-types";
import type {
  OptionConversationFinalStatement,
  OptionConversationNode,
  OptionConversationPath,
} from "@/lib/option-conversation-types";

const controlsCol = (sessionId: string) =>
  sessionDoc(sessionId).collection("patientControls");

function toControl(
  id: string,
  v: FirebaseFirestore.DocumentData
): PatientControlRequest {
  return {
    id,
    sessionId: String(v.sessionId ?? ""),
    patientId: Number(v.patientId),
    assistantId: String(v.assistantId ?? ""),
    level: (Number(v.level ?? 1) === 2 ? 2 : 1) as ControlLevel,
    interactionMode:
      v.interactionMode === "CLOSED_CONFIRMATION"
        ? "CLOSED_CONFIRMATION"
        : "OPTION_SELECTION",
    status: (v.status as PatientControlStatus) ?? "OPEN",
    provisionalCommand: isPatientCommand(v.provisionalCommand)
      ? v.provisionalCommand
      : null,
    confirmedCommand: isPatientCommand(v.confirmedCommand)
      ? v.confirmedCommand
      : null,
    endResponse: (v.endResponse as SemanticResponse) ?? null,
    targetType: isControlTargetType(v.targetType) ? v.targetType : null,
    targetId: (v.targetId as string) ?? null,
    targetPathId: (v.targetPathId as string) ?? null,
    notUnderstoodAt: (v.notUnderstoodAt as string) ?? null,
    subjectChangedAt: (v.subjectChangedAt as string) ?? null,
    presentedAt: (v.presentedAt as string) ?? null,
    selectedAt: (v.selectedAt as string) ?? null,
    confirmedAt: (v.confirmedAt as string) ?? null,
    executedAt: (v.executedAt as string) ?? null,
    canceledAt: (v.canceledAt as string) ?? null,
    closedAt: (v.closedAt as string) ?? null,
    representCount: Number(v.representCount ?? 0),
    correctionCount: Number(v.correctionCount ?? 0),
    clientRequestId: (v.clientRequestId as string) ?? null,
    createdAt: String(v.createdAt ?? ""),
    updatedAt: String(v.updatedAt ?? ""),
  };
}

function requestIdOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null;
}

/** O pedido ainda vivo desta sessão — no máximo um por vez. */
export async function getOpenPatientControl(
  patientId: number,
  sessionId: string
): Promise<PatientControlRequest | null> {
  const session = await sessionDoc(sessionId).get();
  if (!session.exists) return null;
  if (Number(session.data()!.patientId) !== patientId) return null;
  const snap = await controlsCol(sessionId).get();
  return (
    snap.docs
      .map((d) => toControl(d.id, d.data()))
      .find((r) => !isTerminalControlStatus(r.status)) ?? null
  );
}

export async function listPatientControls(
  patientId: number,
  sessionId: string
): Promise<PatientControlRequest[]> {
  const session = await sessionDoc(sessionId).get();
  if (!session.exists) return [];
  if (Number(session.data()!.patientId) !== patientId) return [];
  const snap = await controlsCol(sessionId).get();
  return snap.docs
    .map((d) => toControl(d.id, d.data()))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface OpenPatientControlInput {
  clientRequestId?: unknown;
  targetType?: unknown;
  targetId?: unknown;
  targetPathId?: unknown;
}

/**
 * Abre o painel. Não altera, não conclui e não apaga a interação em curso —
 * o único documento escrito é o do próprio pedido.
 */
export async function openPatientControl(
  patientId: number,
  sessionId: string,
  input: OpenPatientControlInput,
  assistant: Assistant
): Promise<PatientControlRequest> {
  const clientRequestId = requestIdOf(input.clientRequestId);
  const now = new Date().toISOString();
  const id = newId("pcr");

  return firestore.runTransaction(async (transaction) => {
    const sDoc = await transaction.get(sessionDoc(sessionId));
    if (!sDoc.exists) throw new RtqDomainError("sessão não encontrada");
    const sessionData = sDoc.data()!;
    if (Number(sessionData.patientId) !== patientId) {
      throw new RtqDomainError("sessão não encontrada");
    }
    assertSessionAcceptsNewControlRequest(
      (sessionData.status as RtqSessionStatus) ?? "ACTIVE"
    );

    const existentes = await transaction.get(controlsCol(sessionId));
    const todos = existentes.docs.map((d) => toControl(d.id, d.data()));

    if (clientRequestId) {
      const already = todos.find((r) => r.clientRequestId === clientRequestId);
      if (already) return already;
    }
    // Um painel por vez: reabrir devolve o que já está aberto.
    const vivo = todos.find((r) => !isTerminalControlStatus(r.status));
    if (vivo) return vivo;

    const request: PatientControlRequest = {
      id,
      sessionId,
      patientId,
      assistantId: assistant.id,
      level: 1,
      interactionMode: "OPTION_SELECTION",
      status: "OPEN",
      provisionalCommand: null,
      confirmedCommand: null,
      endResponse: null,
      targetType: isControlTargetType(input.targetType) ? input.targetType : null,
      targetId: requestIdOf(input.targetId),
      targetPathId: requestIdOf(input.targetPathId),
      notUnderstoodAt: null,
      subjectChangedAt: null,
      presentedAt: null,
      selectedAt: null,
      confirmedAt: null,
      executedAt: null,
      canceledAt: null,
      closedAt: null,
      representCount: 0,
      correctionCount: 0,
      clientRequestId,
      createdAt: now,
      updatedAt: now,
    };
    assertPatientControlInvariants(request);

    const { id: _id, ...data } = request;
    void _id;
    transaction.set(controlsCol(sessionId).doc(id), data);
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: request.targetType === "TURN" ? request.targetId : null,
        pathId: request.targetPathId,
        nodeId: request.targetType === "NODE" ? request.targetId : null,
        statementId: request.targetType === "STATEMENT" ? request.targetId : null,
        patientId,
        assistantId: assistant.id,
        eventType: "PATIENT_CONTROLS_OPENED",
        newValue: { status: "OPEN", level: 1 },
        metadata: {
          note: "abrir os controles não altera a interação em curso",
          targetType: request.targetType,
        },
      },
      now
    );
    return request;
  });
}

export interface ControlActionResult {
  request: PatientControlRequest;
  /** O que a execução tocou — a tela substitui o que recebeu. */
  turn?: ConversationQuestionTurn | null;
  node?: OptionConversationNode | null;
  statement?: OptionConversationFinalStatement | null;
  path?: OptionConversationPath | null;
  sessionStatus?: RtqSessionStatus | null;
}

export async function runPatientControlAction(
  patientId: number,
  sessionId: string,
  requestId: string,
  action: PatientControlAction,
  assistant: Assistant,
  clientRequestIdRaw?: unknown
): Promise<ControlActionResult> {
  const now = new Date().toISOString();
  const clientRequestId = requestIdOf(clientRequestIdRaw);

  return firestore.runTransaction(async (transaction) => {
    // Firestore exige todas as leituras antes de qualquer escrita.
    const sRef = sessionDoc(sessionId);
    const rRef = controlsCol(sessionId).doc(requestId);
    const [sDoc, rDoc, jaAplicada] = await Promise.all([
      transaction.get(sRef),
      transaction.get(rRef),
      lerLedger(transaction, sessionId, clientRequestId),
    ]);
    if (!sDoc.exists) throw new RtqDomainError("sessão não encontrada");
    const sessionData = sDoc.data()!;
    if (Number(sessionData.patientId) !== patientId) {
      throw new RtqDomainError("sessão não encontrada");
    }
    if (!rDoc.exists) throw new RtqDomainError("pedido de controles não encontrado");

    const request = toControl(rDoc.id, rDoc.data()!);
    // EXECUTE delega a verbos com efeito cascata (turno, nível, frase,
    // caminho, sessão) — reconstruir tudo isso a partir do ledger exigiria
    // guardar o resultado inteiro. Nesta fase, o replay devolve só o pedido
    // já com a ação aplicada; o cuidador que perdeu a resposta do primeiro
    // envio já recebe a confirmação de que a ação foi registrada, mesmo sem
    // os campos opcionais de "o que a execução tocou".
    if (jaAplicada) return { request };

    const sessionStatus = (sessionData.status as RtqSessionStatus) ?? "ACTIVE";
    assertSessionAcceptsControlAction(sessionStatus, action.kind);

    const change = applyPatientControlAction(request, action, now);

    const result: ControlActionResult = {
      request: { ...request, ...(change.patch as Partial<PatientControlRequest>) },
    };

    // A execução delega aos verbos existentes, no MESMO commit.
    if (action.kind === "EXECUTE" && request.confirmedCommand) {
      await executarComando(
        transaction,
        {
          patientId,
          sessionId,
          sessionStatus,
          request,
          command: request.confirmedCommand,
          assistant,
          now,
        },
        result
      );
    }

    transaction.set(rRef, change.patch, { merge: true });
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: request.targetType === "TURN" ? request.targetId : null,
        pathId: request.targetPathId,
        nodeId: request.targetType === "NODE" ? request.targetId : null,
        statementId: request.targetType === "STATEMENT" ? request.targetId : null,
        patientId,
        assistantId: assistant.id,
        eventType: change.event.eventType,
        previousValue: change.event.previousValue,
        newValue: change.event.newValue,
        metadata: change.event.metadata,
      },
      now
    );

    // O evento que nomeia o PEDIDO do paciente — separado do evento de
    // execução, porque respondem a perguntas diferentes.
    if (action.kind === "EXECUTE" && request.confirmedCommand) {
      const pedido = PATIENT_REQUEST_EVENT[request.confirmedCommand];
      if (pedido) {
        writeAudit(
          transaction,
          {
            sessionId,
            turnId: request.targetType === "TURN" ? request.targetId : null,
            pathId: request.targetPathId,
            nodeId: request.targetType === "NODE" ? request.targetId : null,
            statementId:
              request.targetType === "STATEMENT" ? request.targetId : null,
            patientId,
            assistantId: assistant.id,
            eventType: pedido,
            newValue: { command: request.confirmedCommand },
            metadata: {
              requestedByPatient: true,
              targetType: request.targetType,
            },
          },
          now
        );
      }
    }

    transaction.set(sRef, { updatedAt: now }, { merge: true });
    if (clientRequestId) {
      gravarLedger(
        transaction,
        sessionId,
        clientRequestId,
        { op: `runPatientControlAction:${action.kind}`, resultRef: { kind: "control", id: requestId }, assistantId: assistant.id },
        now
      );
    }
    return result;
  });
}

/**
 * A execução de cada comando. Nenhum estado novo é inventado aqui: tudo passa
 * pelas máquinas que já governam sessão, turno, nível, frase e caminho.
 */
async function executarComando(
  transaction: FirebaseFirestore.Transaction,
  ctx: {
    patientId: number;
    sessionId: string;
    sessionStatus: RtqSessionStatus;
    request: PatientControlRequest;
    command: PatientCommand;
    assistant: Assistant;
    now: string;
  },
  result: ControlActionResult
): Promise<void> {
  const { patientId, sessionId, command, assistant, now } = ctx;

  // NÃO ENTENDI não toca em NADA. Registrar que o paciente não compreendeu é
  // o comando inteiro: quem decide o que fazer a seguir é o cuidador, e
  // interpretar isso como recusa seria responder por ele (§27).
  if (command === "NOT_UNDERSTOOD") return;

  if (command === "PAUSE") {
    const change = applySessionAction(ctx.sessionStatus, "PAUSE", now);
    transaction.set(sessionDoc(sessionId), change.patch, { merge: true });
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        patientId,
        assistantId: assistant.id,
        eventType: change.event.eventType,
        previousValue: change.event.previousValue,
        newValue: change.event.newValue,
        metadata: { requestedByPatient: true },
      },
      now
    );
    result.sessionStatus = change.status;
    return;
  }

  if (command === "REPEAT") {
    await reapresentarAlvo(transaction, ctx, result);
    return;
  }

  if (command === "CHANGE_SUBJECT") {
    await interromperAlvo(transaction, ctx, result);
    return;
  }

  // END_CONVERSATION: a conclusão da sessão continua sendo um ato do cuidador,
  // pelo fluxo de saída que já existe. Aqui o pedido fica registrado como
  // executado e a interface abre aquele fluxo — encerrar por dentro daqui
  // pularia a confirmação de saída que o cuidador precisa ver.
  if (command === "END_CONVERSATION") {
    result.sessionStatus = ctx.sessionStatus;
    return;
  }
}

/** REPETIR: reapresenta exatamente o que está no ar, sem criar nada novo. */
async function reapresentarAlvo(
  transaction: FirebaseFirestore.Transaction,
  ctx: {
    patientId: number;
    sessionId: string;
    request: PatientControlRequest;
    assistant: Assistant;
    now: string;
  },
  result: ControlActionResult
): Promise<void> {
  const { patientId, sessionId, request, assistant, now } = ctx;
  const { targetType, targetId, targetPathId } = request;
  if (!targetType || !targetId) {
    throw new RtqDomainError(
      "não há conteúdo apresentado para repetir neste momento"
    );
  }

  const ref = refDoAlvo(sessionId, targetType, targetId);
  const doc = await transaction.get(ref);
  if (!doc.exists) throw new RtqDomainError("o conteúdo a repetir não existe mais");
  const data = doc.data()!;

  const audit = {
    sessionId,
    turnId: targetType === "TURN" ? targetId : null,
    pathId: targetPathId,
    nodeId: targetType === "NODE" ? targetId : null,
    statementId: targetType === "STATEMENT" ? targetId : null,
    patientId,
    assistantId: assistant.id,
  };

  if (targetType === "TURN") {
    const turn = { id: doc.id, ...data } as unknown as ConversationQuestionTurn;
    const repres = applyTurnAction(turn, { kind: "REPRESENT" }, now);
    // Reapresentar deixa a pergunta em PRESENTED; o paciente precisa voltar a
    // PODER responder, senão repetir teria travado a conversa (§26). As duas
    // transições vão no mesmo commit.
    const reaberto = { ...turn, ...(repres.patch as Partial<ConversationQuestionTurn>) };
    const aguarda = applyTurnAction(reaberto, { kind: "AWAIT_RESPONSE" }, now);
    transaction.set(ref, { ...repres.patch, ...aguarda.patch }, { merge: true });
    writeAudit(
      transaction,
      { ...audit, eventType: repres.event.eventType, previousValue: repres.event.previousValue, newValue: repres.event.newValue, metadata: { requestedByPatient: true } },
      now
    );
    result.turn = { ...reaberto, ...(aguarda.patch as Partial<ConversationQuestionTurn>) };
    return;
  }

  if (targetType === "NODE") {
    const node = { id: doc.id, ...data } as unknown as OptionConversationNode;
    const repres = applyNodeAction(node, { kind: "REPRESENT" }, now);
    const reaberto = { ...node, ...(repres.patch as Partial<OptionConversationNode>) };
    const aguarda = applyNodeAction(reaberto, { kind: "AWAIT_SELECTION" }, now);
    transaction.set(ref, { ...repres.patch, ...aguarda.patch }, { merge: true });
    writeAudit(
      transaction,
      { ...audit, eventType: repres.event.eventType, previousValue: repres.event.previousValue, newValue: repres.event.newValue, metadata: { requestedByPatient: true } },
      now
    );
    result.node = { ...reaberto, ...(aguarda.patch as Partial<OptionConversationNode>) };
    return;
  }

  const statement = {
    id: doc.id,
    ...data,
  } as unknown as OptionConversationFinalStatement;
  const change = applyStatementAction(statement, { kind: "REPRESENT" }, now);
  transaction.set(ref, change.patch, { merge: true });
  writeAudit(
    transaction,
    { ...audit, eventType: change.event.eventType, previousValue: change.event.previousValue, newValue: change.event.newValue, metadata: { requestedByPatient: true } },
    now
  );
  result.statement = {
    ...statement,
    ...(change.patch as Partial<OptionConversationFinalStatement>),
  };
}

/**
 * MUDAR DE ASSUNTO: interrompe o que está em curso SEM apagar nada. Respostas
 * já confirmadas ficam; só a seleção provisória — que não é resposta de
 * ninguém — é descartada. A sessão continua aberta (§28).
 */
async function interromperAlvo(
  transaction: FirebaseFirestore.Transaction,
  ctx: {
    patientId: number;
    sessionId: string;
    request: PatientControlRequest;
    assistant: Assistant;
    now: string;
  },
  result: ControlActionResult
): Promise<void> {
  const { patientId, sessionId, request, assistant, now } = ctx;
  const { targetType, targetId, targetPathId } = request;

  const audit = {
    sessionId,
    turnId: targetType === "TURN" ? targetId : null,
    pathId: targetPathId,
    nodeId: targetType === "NODE" ? targetId : null,
    statementId: targetType === "STATEMENT" ? targetId : null,
    patientId,
    assistantId: assistant.id,
    metadata: { requestedByPatient: true, reason: "mudar_de_assunto" },
  };

  // Caminho da conversa por opções: interrompe o caminho inteiro.
  if (targetPathId) {
    const pRef = sessionDoc(sessionId).collection("paths").doc(targetPathId);
    const pDoc = await transaction.get(pRef);
    if (pDoc.exists) {
      const path = { id: pDoc.id, ...pDoc.data() } as unknown as OptionConversationPath;
      const change = applyPathAction(
        path.status,
        { kind: "INTERRUPT", reason: "o paciente pediu para mudar de assunto" },
        now
      );
      transaction.set(pRef, change.patch, { merge: true });
      writeAudit(
        transaction,
        { ...audit, eventType: change.event.eventType, previousValue: change.event.previousValue, newValue: change.event.newValue },
        now
      );
      result.path = { ...path, ...(change.patch as Partial<OptionConversationPath>) };
      return;
    }
  }

  // Pergunta fechada: cancela o turno em curso, preservando o que já foi
  // confirmado nos turnos anteriores.
  if (targetType === "TURN" && targetId) {
    const tRef = sessionDoc(sessionId).collection("turns").doc(targetId);
    const tDoc = await transaction.get(tRef);
    if (tDoc.exists) {
      const turn = { id: tDoc.id, ...tDoc.data() } as unknown as ConversationQuestionTurn;
      const change = applyTurnAction(
        turn,
        { kind: "CANCEL", reason: "o paciente pediu para mudar de assunto" },
        now
      );
      transaction.set(tRef, change.patch, { merge: true });
      writeAudit(
        transaction,
        { ...audit, eventType: change.event.eventType, previousValue: change.event.previousValue, newValue: change.event.newValue },
        now
      );
      result.turn = { ...turn, ...(change.patch as Partial<ConversationQuestionTurn>) };
    }
  }
}

function refDoAlvo(
  sessionId: string,
  targetType: ControlTargetType,
  targetId: string
): FirebaseFirestore.DocumentReference {
  const col =
    targetType === "TURN"
      ? "turns"
      : targetType === "NODE"
        ? "nodes"
        : "statements";
  return sessionDoc(sessionId).collection(col).doc(targetId);
}
