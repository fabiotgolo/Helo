// ——— Contexto da sessão: camada de dados (Fase 4.8) ———
// Persistência sobre a MESMA sessão das Perguntas em tempo real, com o mesmo
// isolamento estrutural e a mesma trilha de auditoria:
//
//   conversationQuestionSessions/{sessionId}/contexts/{contextId}
//
// Versionamento (§6): editar não reescreve. A gravação cria a versão n+1 e
// marca a anterior como REPLACED na MESMA transação — nunca existem duas
// versões vigentes, e nenhuma versão some.
//
// O interlocutor vindo da rede do paciente é COPIADO como snapshot depois de
// validado contra o cadastro. Texto livre nunca cria contato (§2).

import { firestore } from "@/lib/firestore";
import { listPeople } from "@/lib/store";
import {
  eventsCol,
  newId,
  sessionDoc,
  writeAudit,
  type Assistant,
} from "@/lib/realtime-question-store";
import {
  applyContextReplacement,
  assertSessionAcceptsContextWrite,
} from "@/lib/session-context-machine";
import {
  assertSessionContextInvariants,
  MAX_CONTEXT_FIELD_LEN,
  MAX_CONTEXT_NOTES_LEN,
  RtqDomainError,
  type ContextInterlocutorSource,
  type SessionContextVersion,
} from "@/lib/session-context-types";
import {
  RtqConflictError,
  type RtqSessionStatus,
} from "@/lib/realtime-question-types";

const contextsCol = (sessionId: string) =>
  sessionDoc(sessionId).collection("contexts");

function toContext(
  id: string,
  v: FirebaseFirestore.DocumentData
): SessionContextVersion {
  return {
    id,
    sessionId: String(v.sessionId ?? ""),
    patientId: Number(v.patientId),
    assistantId: String(v.assistantId ?? ""),
    version: Number(v.version ?? 1),
    status: (v.status as SessionContextVersion["status"]) ?? "ACTIVE",
    interlocutorSource:
      (v.interlocutorSource as ContextInterlocutorSource | null) ?? null,
    interlocutorPersonId:
      v.interlocutorPersonId == null ? null : Number(v.interlocutorPersonId),
    interlocutorName: (v.interlocutorName as string) ?? null,
    interlocutorRelation: (v.interlocutorRelation as string) ?? null,
    intention: (v.intention as string) ?? null,
    environment: (v.environment as string) ?? null,
    initialTopic: (v.initialTopic as string) ?? null,
    notes: (v.notes as string) ?? null,
    skipped: v.skipped === true,
    filledBy: "ASSISTANT_MANUAL",
    replacesContextId: (v.replacesContextId as string) ?? null,
    replacedByContextId: (v.replacedByContextId as string) ?? null,
    clientRequestId: (v.clientRequestId as string) ?? null,
    createdAt: String(v.createdAt ?? ""),
    updatedAt: String(v.updatedAt ?? ""),
    replacedAt: (v.replacedAt as string) ?? null,
  };
}

/** Apara espaços excedentes e respeita o teto, preservando acentos (§6). */
function campo(v: unknown, max = MAX_CONTEXT_FIELD_LEN): string | null {
  if (typeof v !== "string") return null;
  const limpo = v.replace(/\s+/g, " ").trim().slice(0, max);
  return limpo || null;
}

function requestIdOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null;
}

export interface SaveSessionContextInput {
  clientRequestId?: unknown;
  skipped?: unknown;
  interlocutorPersonId?: unknown;
  interlocutorName?: unknown;
  interlocutorRelation?: unknown;
  intention?: unknown;
  environment?: unknown;
  initialTopic?: unknown;
  notes?: unknown;
  /**
   * `updatedAt` da versão vigente quando o cuidador começou a escrever
   * (Fase 4.9.3-C, §10 caso 7). Opcional: quem não manda segue com o
   * comportamento de sempre.
   */
  baseVersion?: unknown;
}

/**
 * O conteúdo de uma versão de contexto, para comparação. Só os campos que o
 * cuidador escreve — nem id, nem versão, nem horários, que mudam a cada
 * gravação sem que ninguém tenha mudado de ideia sobre nada.
 */
function conteudoDoContexto(c: {
  interlocutorName: string | null;
  interlocutorRelation: string | null;
  intention: string | null;
  environment: string | null;
  initialTopic: string | null;
  notes: string | null;
  skipped: boolean;
}): string {
  return JSON.stringify([
    c.interlocutorName ?? "",
    c.interlocutorRelation ?? "",
    c.intention ?? "",
    c.environment ?? "",
    c.initialTopic ?? "",
    c.notes ?? "",
    c.skipped,
  ]);
}

/**
 * Um resumo legível da versão do servidor, para a tela de decisão mostrar ao
 * lado da do cuidador. Não é o documento inteiro: numa resposta de ERRO só vai
 * o que a decisão exige ver.
 */
function resumoDoContexto(c: {
  intention: string | null;
  environment: string | null;
  initialTopic: string | null;
  notes: string | null;
  interlocutorName: string | null;
  skipped: boolean;
}): string {
  if (c.skipped) return "Sem contexto registrado.";
  const partes = [
    c.interlocutorName && `Com: ${c.interlocutorName}`,
    c.intention && `Intenção: ${c.intention}`,
    c.environment && `Ambiente: ${c.environment}`,
    c.initialTopic && `Assunto: ${c.initialTopic}`,
    c.notes && `Notas: ${c.notes}`,
  ].filter(Boolean);
  return partes.length > 0 ? partes.join(" · ") : "Sem contexto registrado.";
}

export async function getActiveSessionContext(
  patientId: number,
  sessionId: string
): Promise<SessionContextVersion | null> {
  const session = await sessionDoc(sessionId).get();
  if (!session.exists) return null;
  if (Number(session.data()!.patientId) !== patientId) return null;
  const snap = await contextsCol(sessionId).get();
  const ativo = snap.docs
    .map((d) => toContext(d.id, d.data()))
    .find((c) => c.status === "ACTIVE");
  return ativo ?? null;
}

export async function listSessionContextVersions(
  patientId: number,
  sessionId: string
): Promise<SessionContextVersion[]> {
  const session = await sessionDoc(sessionId).get();
  if (!session.exists) return [];
  if (Number(session.data()!.patientId) !== patientId) return [];
  const snap = await contextsCol(sessionId).get();
  return snap.docs
    .map((d) => toContext(d.id, d.data()))
    .sort((a, b) => a.version - b.version);
}

/**
 * Grava o contexto — primeira versão ou versão corrigida.
 *
 * Deduplicação (§34): com `clientRequestId`, um segundo clique devolve a versão
 * que o primeiro gravou em vez de abrir outra. A checagem acontece DENTRO da
 * transação, então dois cliques simultâneos não escapam.
 */
export async function saveSessionContext(
  patientId: number,
  sessionId: string,
  input: SaveSessionContextInput,
  assistant: Assistant
): Promise<SessionContextVersion> {
  const clientRequestId = requestIdOf(input.clientRequestId);
  const skipped = input.skipped === true;

  // A pessoa cadastrada é validada FORA da transação (leitura de outra
  // coleção) e copiada como snapshot. Nunca chamamos addPerson: informar um
  // nome à mão não cria contato (§2).
  let interlocutorSource: ContextInterlocutorSource | null = null;
  let interlocutorPersonId: number | null = null;
  let interlocutorName = campo(input.interlocutorName);
  let interlocutorRelation = campo(input.interlocutorRelation);

  if (!skipped) {
    const pedido =
      input.interlocutorPersonId == null
        ? null
        : Number(input.interlocutorPersonId);
    if (pedido != null && !Number.isNaN(pedido)) {
      const pessoa = (await listPeople(patientId)).find((p) => p.id === pedido);
      if (!pessoa) {
        throw new RtqDomainError(
          "a pessoa escolhida não está na rede deste paciente"
        );
      }
      interlocutorSource = "REGISTERED_PERSON";
      interlocutorPersonId = pessoa.id;
      interlocutorName = pessoa.name;
      interlocutorRelation = campo(pessoa.relation);
    } else if (interlocutorName) {
      interlocutorSource = "FREE_TEXT";
      interlocutorPersonId = null;
    }
  }

  const now = new Date().toISOString();
  const id = newId("ctx");

  return firestore.runTransaction(async (transaction) => {
    const sDoc = await transaction.get(sessionDoc(sessionId));
    if (!sDoc.exists) throw new RtqDomainError("sessão não encontrada");
    const sessionData = sDoc.data()!;
    if (Number(sessionData.patientId) !== patientId) {
      throw new RtqDomainError("sessão não encontrada");
    }
    assertSessionAcceptsContextWrite(
      (sessionData.status as RtqSessionStatus) ?? "ACTIVE"
    );

    const existentes = await transaction.get(contextsCol(sessionId));
    const todos = existentes.docs.map((d) => toContext(d.id, d.data()));

    if (clientRequestId) {
      const already = todos.find((c) => c.clientRequestId === clientRequestId);
      if (already) return already;
    }

    const vigente = todos.find((c) => c.status === "ACTIVE") ?? null;

    // §10, caso 7 — o contexto mudou no servidor enquanto esta gravação
    // esperava na fila.
    //
    // A fronteira com o caso 11 é a mesma do caso 4: o servidor ter uma
    // versão mais nova NÃO é conflito por si. Só é quando o CONTEÚDO diverge
    // — senão o cuidador seria interrompido para decidir entre dois textos
    // idênticos.
    //
    // E note o que este conflito NÃO é: uma disputa sobre sobrescrever.
    // Gravar contexto SEMPRE cria versão nova (§4.8) e nunca apaga a
    // anterior. O que está em jogo é qual passa a ser a VIGENTE — por isso a
    // saída "gravar a minha como nova versão" é o comportamento normal, e não
    // uma concessão perigosa.
    const baseVersion =
      typeof input.baseVersion === "string" && input.baseVersion
        ? input.baseVersion
        : null;
    if (baseVersion && vigente && baseVersion !== vigente.updatedAt) {
      const meu = conteudoDoContexto({
        interlocutorName: skipped ? null : interlocutorName,
        interlocutorRelation: skipped ? null : interlocutorRelation,
        intention: skipped ? null : campo(input.intention),
        environment: skipped ? null : campo(input.environment),
        initialTopic: skipped ? null : campo(input.initialTopic),
        notes: skipped ? null : campo(input.notes, MAX_CONTEXT_NOTES_LEN),
        skipped,
      });
      if (meu !== conteudoDoContexto(vigente)) {
        throw new RtqConflictError(
          "CONTEXT_VERSION",
          "o contexto desta conversa mudou desde que você começou a escrever",
          {
            serverAt: vigente.updatedAt,
            serverValue: resumoDoContexto(vigente),
          }
        );
      }
    }

    const version = todos.length + 1;

    const context: SessionContextVersion = {
      id,
      sessionId,
      // patientId e assistantId nunca vêm do corpo: o paciente é o da sessão
      // (imutável) e o assistente é o usuário autenticado.
      patientId,
      assistantId: assistant.id,
      version,
      status: "ACTIVE",
      interlocutorSource: skipped ? null : interlocutorSource,
      interlocutorPersonId: skipped ? null : interlocutorPersonId,
      interlocutorName: skipped ? null : interlocutorName,
      interlocutorRelation: skipped ? null : interlocutorRelation,
      intention: skipped ? null : campo(input.intention),
      environment: skipped ? null : campo(input.environment),
      initialTopic: skipped ? null : campo(input.initialTopic),
      notes: skipped ? null : campo(input.notes, MAX_CONTEXT_NOTES_LEN),
      skipped,
      filledBy: "ASSISTANT_MANUAL",
      replacesContextId: vigente?.id ?? null,
      replacedByContextId: null,
      clientRequestId,
      createdAt: now,
      updatedAt: now,
      replacedAt: null,
    };
    assertSessionContextInvariants(context);

    const { id: _id, ...data } = context;
    void _id;
    transaction.set(contextsCol(sessionId).doc(id), data);

    if (vigente) {
      // A versão anterior sai de cena na MESMA transação: nunca há duas
      // vigentes, nem uma janela em que a antiga já não vale e a nova ainda
      // não existe.
      const troca = applyContextReplacement(vigente, id, now);
      transaction.set(contextsCol(sessionId).doc(vigente.id), troca.patch, {
        merge: true,
      });
      writeAudit(
        transaction,
        {
          sessionId,
          turnId: null,
          contextId: vigente.id,
          patientId,
          assistantId: assistant.id,
          eventType: troca.event.eventType,
          previousValue: troca.event.previousValue,
          newValue: troca.event.newValue,
          metadata: troca.event.metadata ?? null,
        },
        now
      );
    }

    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        contextId: id,
        patientId,
        assistantId: assistant.id,
        eventType: skipped
          ? "SESSION_CONTEXT_SKIPPED"
          : vigente
            ? "SESSION_CONTEXT_EDITED"
            : "SESSION_CONTEXT_CREATED",
        previousValue: vigente
          ? {
              version: vigente.version,
              interlocutorName: vigente.interlocutorName,
              intention: vigente.intention,
              environment: vigente.environment,
              initialTopic: vigente.initialTopic,
              notes: vigente.notes,
            }
          : null,
        newValue: {
          version,
          interlocutorName: context.interlocutorName,
          intention: context.intention,
          environment: context.environment,
          initialTopic: context.initialTopic,
          notes: context.notes,
        },
        metadata: {
          version,
          skipped,
          filledBy: context.filledBy,
          interlocutorSource: context.interlocutorSource,
        },
      },
      now
    );

    return context;
  });
}

/** Registra a consulta ao contexto — leitura auditada, nada muda (§8). */
export async function recordSessionContextView(
  patientId: number,
  sessionId: string,
  contextId: string,
  assistant: Assistant
): Promise<{ ok: true }> {
  const now = new Date().toISOString();
  return firestore.runTransaction(async (transaction) => {
    const sDoc = await transaction.get(sessionDoc(sessionId));
    if (!sDoc.exists) throw new RtqDomainError("sessão não encontrada");
    if (Number(sDoc.data()!.patientId) !== patientId) {
      throw new RtqDomainError("sessão não encontrada");
    }
    const cDoc = await transaction.get(contextsCol(sessionId).doc(contextId));
    if (!cDoc.exists) throw new RtqDomainError("contexto não encontrado");

    const context = toContext(cDoc.id, cDoc.data()!);
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        contextId,
        patientId,
        assistantId: assistant.id,
        eventType: "SESSION_CONTEXT_VIEWED",
        metadata: { version: context.version, status: context.status },
      },
      now
    );
    return { ok: true as const };
  });
}

/** Só para os testes de trilha: os eventos de contexto desta sessão. */
export async function listSessionContextEvents(
  sessionId: string
): Promise<FirebaseFirestore.DocumentData[]> {
  const snap = await eventsCol(sessionId).get();
  return snap.docs.map((d) => d.data());
}
