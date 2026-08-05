// ——— Conversa por opções: camada de dados ———
// Persistência sobre o Firestore, no mesmo padrão de
// realtime-question-store.ts: nenhuma escrita confia no cliente, tudo é
// normalizado no servidor e o isolamento por paciente é estrutural.
//
// Estrutura — tudo pendurado na sessão que JÁ existe, para que o isolamento
// por paciente, a pausa/retomada e a trilha de auditoria valham sem nada novo:
//
//   conversationQuestionSessions/{sessionId}/paths/{pathId}
//   conversationQuestionSessions/{sessionId}/nodes/{nodeId}       (campo pathId)
//   conversationQuestionSessions/{sessionId}/statements/{stmtId}  (campo pathId)
//   conversationQuestionSessions/{sessionId}/events/{eventId}     ← a MESMA trilha
//
// `nodes` e `statements` ficam PLANOS sob a sessão (e não aninhados no
// caminho) para que histórico, breadcrumb e leitura transacional sejam
// consultas simples.
//
// ATOMICIDADE (§33): toda mudança de estado e o evento de auditoria
// correspondente são gravados na MESMA transação, com horário do servidor e
// autoria da sessão autenticada.
//
// IMUTABILIDADE (§2): nada apresentado ao paciente é reescrito. Voltar,
// corrigir e reutilizar SEMPRE criam registros novos vinculados ao original —
// o antigo permanece, inclusive com a resposta que recebeu.

import { firestore } from "@/lib/firestore";
import {
  applyNodeAction,
  applyPathAction,
  applyStatementAction,
  applyStatementRejection,
  assertAcceptsNodeAction,
  assertAcceptsStatementAction,
  assertSessionAcceptsNewPath,
  type NodeAction,
  type PathAction,
  type StatementAction,
} from "@/lib/option-conversation-machine";
import {
  assertNodeInvariants,
  assertStatementInvariants,
  activeTrail,
  isPathKind,
  isStatementOrigin,
  isTerminalPathStatus,
  MODO_POR_ORIGEM,
  MAX_NODE_DEPTH,
  MAX_PROMPT_LEN,
  MAX_STATEMENT_LEN,
  normalizeOptions,
  RtqDomainError,
  trailSensitivity,
  type NodeStatus,
  type OptionConversationFinalStatement,
  type OptionConversationNode,
  type OptionConversationOption,
  type OptionConversationPath,
  type OptionPosition,
  type PathDetail,
  type PathKind,
  type PathStatus,
  type StatementOrigin,
  type StatementStatus,
} from "@/lib/option-conversation-types";
import { statementEventFor } from "@/lib/statement-events";
import {
  cleanText,
  getRtqSession,
  gravarLedger,
  lerLedger,
  newId,
  sessionDoc,
  writeAudit,
  type Assistant,
} from "@/lib/realtime-question-store";
import {
  isSensitiveCategory,
  type RtqSessionStatus,
  type SemanticResponse,
  type SensitiveCategory,
} from "@/lib/realtime-question-types";

const pathsCol = (sessionId: string) => sessionDoc(sessionId).collection("paths");
const nodesCol = (sessionId: string) => sessionDoc(sessionId).collection("nodes");
const statementsCol = (sessionId: string) =>
  sessionDoc(sessionId).collection("statements");

// ---------- Conversores ----------
// Todo campo novo tem padrão seguro (`null`, `0`, `false`): um documento
// gravado por uma versão anterior nunca quebra a leitura (§33).

function toPath(
  id: string,
  v: FirebaseFirestore.DocumentData
): OptionConversationPath {
  return {
    id,
    sessionId: String(v.sessionId ?? ""),
    patientId: Number(v.patientId),
    assistantId: String(v.assistantId ?? ""),
    // Caminhos gravados antes da Fase 4.2 não têm o campo: todos são árvore
    // de opções. Padrão seguro, sem migração de dados (§34).
    kind: isPathKind(v.kind) ? v.kind : "OPTION_TREE",
    status: (v.status as PathStatus) ?? "ACTIVE",
    rootNodeId: (v.rootNodeId as string) ?? null,
    activeNodeId: (v.activeNodeId as string) ?? null,
    activeBranchId: (v.activeBranchId as string) ?? null,
    finalStatementId: (v.finalStatementId as string) ?? null,
    sequence: Number(v.sequence ?? 1),
    restartedFromPathId: (v.restartedFromPathId as string) ?? null,
    reusedFromPathId: (v.reusedFromPathId as string) ?? null,
    clientRequestId: (v.clientRequestId as string) ?? null,
    startedAt: String(v.startedAt ?? ""),
    pausedAt: (v.pausedAt as string) ?? null,
    resumedAt: (v.resumedAt as string) ?? null,
    completedAt: (v.completedAt as string) ?? null,
    interruptedAt: (v.interruptedAt as string) ?? null,
    restartedAt: (v.restartedAt as string) ?? null,
    createdAt: String(v.createdAt ?? ""),
    updatedAt: String(v.updatedAt ?? ""),
  };
}

function toOption(v: FirebaseFirestore.DocumentData): OptionConversationOption {
  return {
    id: String(v.id ?? ""),
    position: Number(v.position ?? 1) as OptionPosition,
    label: String(v.label ?? ""),
    nextNodeId: (v.nextNodeId as string) ?? null,
    isTerminal: v.isTerminal === true,
    finalStatementDraft: (v.finalStatementDraft as string) ?? null,
    isSensitive: v.isSensitive === true,
    sensitiveCategory: (v.sensitiveCategory as SensitiveCategory) ?? null,
  };
}

function toNode(
  id: string,
  v: FirebaseFirestore.DocumentData
): OptionConversationNode {
  return {
    id,
    pathId: String(v.pathId ?? ""),
    sessionId: String(v.sessionId ?? ""),
    patientId: Number(v.patientId),
    assistantId: String(v.assistantId ?? ""),
    parentNodeId: (v.parentNodeId as string) ?? null,
    branchId: String(v.branchId ?? ""),
    depth: Number(v.depth ?? 0),
    sequence: Number(v.sequence ?? 1),
    interactionMode: "OPTION_SELECTION",
    promptText: String(v.promptText ?? ""),
    status: (v.status as NodeStatus) ?? "DRAFT",
    options: Array.isArray(v.options)
      ? (v.options as FirebaseFirestore.DocumentData[]).map(toOption)
      : [],
    provisionalOptionId: (v.provisionalOptionId as string) ?? null,
    confirmedOptionId: (v.confirmedOptionId as string) ?? null,
    reusedFromNodeId: (v.reusedFromNodeId as string) ?? null,
    replacesNodeId: (v.replacesNodeId as string) ?? null,
    replacedByNodeId: (v.replacedByNodeId as string) ?? null,
    isSensitive: v.isSensitive === true,
    sensitiveCategory: (v.sensitiveCategory as SensitiveCategory) ?? null,
    correctionCount: Number(v.correctionCount ?? 0),
    clientRequestId: (v.clientRequestId as string) ?? null,
    presentedAt: (v.presentedAt as string) ?? null,
    selectedAt: (v.selectedAt as string) ?? null,
    confirmedAt: (v.confirmedAt as string) ?? null,
    deactivatedAt: (v.deactivatedAt as string) ?? null,
    canceledAt: (v.canceledAt as string) ?? null,
    replacedAt: (v.replacedAt as string) ?? null,
    createdAt: String(v.createdAt ?? ""),
    updatedAt: String(v.updatedAt ?? ""),
  };
}

function toStatement(
  id: string,
  v: FirebaseFirestore.DocumentData
): OptionConversationFinalStatement {
  return {
    id,
    pathId: String(v.pathId ?? ""),
    sessionId: String(v.sessionId ?? ""),
    patientId: Number(v.patientId),
    assistantId: String(v.assistantId ?? ""),
    originNodeId: (v.originNodeId as string) ?? null,
    // Frases gravadas antes da Fase 4.2 nasceram de um caminho de opções. O
    // modo NUNCA é lido do documento: deriva da origem, para que um campo
    // adulterado no banco não consiga alegar outra autoria.
    origin: isStatementOrigin(v.origin) ? v.origin : "OPTION_PATH",
    interactionMode:
      MODO_POR_ORIGEM[isStatementOrigin(v.origin) ? v.origin : "OPTION_PATH"],
    originalDraft: String(v.originalDraft ?? ""),
    currentText: String(v.currentText ?? ""),
    presentedText: String(v.presentedText ?? ""),
    status: (v.status as StatementStatus) ?? "DRAFT",
    provisionalResponse: (v.provisionalResponse as SemanticResponse) ?? null,
    confirmedResponse: v.confirmedResponse === "YES" ? "YES" : null,
    reusedFromStatementId: (v.reusedFromStatementId as string) ?? null,
    replacesStatementId: (v.replacesStatementId as string) ?? null,
    replacedByStatementId: (v.replacedByStatementId as string) ?? null,
    isSensitive: v.isSensitive === true,
    sensitiveCategory: (v.sensitiveCategory as SensitiveCategory) ?? null,
    editCount: Number(v.editCount ?? 0),
    correctionCount: Number(v.correctionCount ?? 0),
    representCount: Number(v.representCount ?? 0),
    clientRequestId: (v.clientRequestId as string) ?? null,
    presentedAt: (v.presentedAt as string) ?? null,
    respondedAt: (v.respondedAt as string) ?? null,
    reconfirmedAt: (v.reconfirmedAt as string) ?? null,
    confirmedAt: (v.confirmedAt as string) ?? null,
    rejectedAt: (v.rejectedAt as string) ?? null,
    canceledAt: (v.canceledAt as string) ?? null,
    replacedAt: (v.replacedAt as string) ?? null,
    createdAt: String(v.createdAt ?? ""),
    updatedAt: String(v.updatedAt ?? ""),
  };
}

function stripId<T extends { id: string }>(v: T): Omit<T, "id"> {
  const { id: _id, ...rest } = v;
  void _id;
  return rest;
}

// ---------- Leituras ----------

/**
 * Toda leitura passa por getRtqSession: a sessão só existe para quem consulta
 * com o MESMO patientId. Trocar o identificador na URL não alcança o caminho
 * de outro paciente.
 */
async function requireSession(patientId: number, sessionId: string) {
  const session = await getRtqSession(patientId, sessionId);
  if (!session) throw new RtqDomainError("sessão não encontrada");
  return session;
}

export async function listPaths(
  patientId: number,
  sessionId: string
): Promise<OptionConversationPath[] | null> {
  const session = await getRtqSession(patientId, sessionId);
  if (!session) return null;
  const snap = await pathsCol(sessionId).get();
  return snap.docs
    .map((d) => toPath(d.id, d.data()))
    .sort((a, b) => a.sequence - b.sequence);
}

/** Tudo o que a tela precisa de um caminho, numa leitura só (§32). */
export async function getPathDetail(
  patientId: number,
  sessionId: string,
  pathId: string
): Promise<PathDetail | null> {
  const session = await getRtqSession(patientId, sessionId);
  if (!session) return null;
  const doc = await pathsCol(sessionId).doc(pathId).get();
  if (!doc.exists) return null;
  const path = toPath(doc.id, doc.data()!);
  if (path.patientId !== patientId) return null;

  const [nodesSnap, statementsSnap] = await Promise.all([
    nodesCol(sessionId).where("pathId", "==", pathId).get(),
    statementsCol(sessionId).where("pathId", "==", pathId).get(),
  ]);
  return {
    path,
    nodes: nodesSnap.docs
      .map((d) => toNode(d.id, d.data()))
      .sort((a, b) => a.sequence - b.sequence),
    statements: statementsSnap.docs
      .map((d) => toStatement(d.id, d.data()))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

/** Todos os caminhos da sessão com seu conteúdo — alimenta o histórico (§22). */
export async function listPathDetails(
  patientId: number,
  sessionId: string
): Promise<PathDetail[] | null> {
  const session = await getRtqSession(patientId, sessionId);
  if (!session) return null;
  const [pathsSnap, nodesSnap, statementsSnap] = await Promise.all([
    pathsCol(sessionId).get(),
    nodesCol(sessionId).get(),
    statementsCol(sessionId).get(),
  ]);
  const nodes = nodesSnap.docs.map((d) => toNode(d.id, d.data()));
  const statements = statementsSnap.docs.map((d) => toStatement(d.id, d.data()));
  return pathsSnap.docs
    .map((d) => toPath(d.id, d.data()))
    .sort((a, b) => a.sequence - b.sequence)
    .map((path) => ({
      path,
      nodes: nodes
        .filter((n) => n.pathId === path.id)
        .sort((a, b) => a.sequence - b.sequence),
      statements: statements
        .filter((s) => s.pathId === path.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }));
}

// ---------- Leituras transacionais ----------

async function readPath(
  transaction: FirebaseFirestore.Transaction,
  patientId: number,
  sessionId: string,
  pathId: string
): Promise<OptionConversationPath> {
  const doc = await transaction.get(pathsCol(sessionId).doc(pathId));
  if (!doc.exists) throw new RtqDomainError("conversa por opções não encontrada");
  const path = toPath(doc.id, doc.data()!);
  if (path.patientId !== patientId || path.sessionId !== sessionId) {
    throw new RtqDomainError("conversa por opções não encontrada");
  }
  return path;
}

async function readNode(
  transaction: FirebaseFirestore.Transaction,
  patientId: number,
  sessionId: string,
  nodeId: string
): Promise<OptionConversationNode> {
  const doc = await transaction.get(nodesCol(sessionId).doc(nodeId));
  if (!doc.exists) throw new RtqDomainError("nível não encontrado");
  const node = toNode(doc.id, doc.data()!);
  if (node.patientId !== patientId) throw new RtqDomainError("nível não encontrado");
  return node;
}

async function readStatement(
  transaction: FirebaseFirestore.Transaction,
  patientId: number,
  sessionId: string,
  statementId: string
): Promise<OptionConversationFinalStatement> {
  const doc = await transaction.get(statementsCol(sessionId).doc(statementId));
  if (!doc.exists) throw new RtqDomainError("frase não encontrada");
  const statement = toStatement(doc.id, doc.data()!);
  if (statement.patientId !== patientId) {
    throw new RtqDomainError("frase não encontrada");
  }
  return statement;
}

/** Todos os nós de um caminho, dentro da transação. */
async function readPathNodes(
  transaction: FirebaseFirestore.Transaction,
  sessionId: string,
  pathId: string
): Promise<OptionConversationNode[]> {
  const snap = await transaction.get(
    nodesCol(sessionId).where("pathId", "==", pathId)
  );
  return snap.docs
    .map((d) => toNode(d.id, d.data()))
    .sort((a, b) => a.sequence - b.sequence);
}

// ---------- Caminhos ----------

export interface CreatePathInput {
  clientRequestId?: unknown;
  reusedFromPathId?: unknown;
  restartedFromPathId?: unknown;
  /** O que o caminho hospeda. Ausente = árvore de opções (Fase 4.2). */
  kind?: PathKind;
}

function requestIdOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null;
}

/**
 * Cria um caminho na sessão ativa.
 *
 * Deduplicação (§33): com `clientRequestId`, um segundo clique devolve o
 * caminho que o primeiro criou em vez de abrir outro. A checagem acontece
 * DENTRO da transação, então dois cliques simultâneos não escapam.
 */
export async function createPath(
  patientId: number,
  sessionId: string,
  input: CreatePathInput,
  assistant: Assistant
): Promise<OptionConversationPath> {
  const clientRequestId = requestIdOf(input.clientRequestId);
  const now = new Date().toISOString();
  const id = newId("ocp");

  return firestore.runTransaction(async (transaction) => {
    const sRef = sessionDoc(sessionId);
    const sDoc = await transaction.get(sRef);
    if (!sDoc.exists) throw new RtqDomainError("sessão não encontrada");
    const sessionData = sDoc.data()!;
    if (Number(sessionData.patientId) !== patientId) {
      throw new RtqDomainError("sessão não encontrada");
    }
    assertSessionAcceptsNewPath(
      (sessionData.status as RtqSessionStatus) ?? "ACTIVE"
    );

    const existing = await transaction.get(pathsCol(sessionId));
    const all = existing.docs.map((d) => toPath(d.id, d.data()));

    if (clientRequestId) {
      const already = all.find((p) => p.clientRequestId === clientRequestId);
      if (already) return already;
    }

    const path: OptionConversationPath = {
      id,
      sessionId,
      kind: isPathKind(input.kind) ? input.kind : "OPTION_TREE",
      // patientId e assistantId nunca vêm do corpo: o paciente é o da sessão
      // (imutável) e o assistente é o usuário autenticado.
      patientId,
      assistantId: assistant.id,
      status: "ACTIVE",
      rootNodeId: null,
      activeNodeId: null,
      activeBranchId: newId("br"),
      finalStatementId: null,
      sequence: all.length + 1,
      restartedFromPathId: requestIdOf(input.restartedFromPathId),
      reusedFromPathId: requestIdOf(input.reusedFromPathId),
      clientRequestId,
      startedAt: now,
      pausedAt: null,
      resumedAt: null,
      completedAt: null,
      interruptedAt: null,
      restartedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    transaction.set(pathsCol(sessionId).doc(id), stripId(path));
    transaction.set(sRef, { updatedAt: now }, { merge: true });
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId: id,
        patientId,
        assistantId: assistant.id,
        eventType: "CONVERSATION_PATH_STARTED",
        newValue: { status: "ACTIVE", sequence: path.sequence },
        metadata: {
          ...(path.restartedFromPathId
            ? { restartedFromPathId: path.restartedFromPathId }
            : {}),
          ...(path.reusedFromPathId
            ? { reusedFromPathId: path.reusedFromPathId }
            : {}),
        },
      },
      now
    );
    // O modo passa a ser explícito no exato momento em que a conversa começa.
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId: id,
        patientId,
        assistantId: assistant.id,
        eventType: "INTERACTION_MODE_SELECTED",
        previousValue: { interactionMode: "CLOSED_CONFIRMATION" },
        newValue: { interactionMode: "OPTION_SELECTION" },
        metadata: {
          note: "os sinais do paciente passam a significar opção 1, 2 e 3",
        },
      },
      now
    );
    return path;
  });
}

export async function runPathAction(
  patientId: number,
  sessionId: string,
  pathId: string,
  action: PathAction,
  assistant: Assistant,
  clientRequestIdRaw?: unknown
): Promise<OptionConversationPath> {
  const now = new Date().toISOString();
  const clientRequestId = requestIdOf(clientRequestIdRaw);
  return firestore.runTransaction(async (transaction) => {
    const path = await readPath(transaction, patientId, sessionId, pathId);
    const jaAplicada = await lerLedger(transaction, sessionId, clientRequestId);
    if (jaAplicada) return path;

    const change = applyPathAction(path.status, action, now);
    transaction.set(pathsCol(sessionId).doc(pathId), change.patch, { merge: true });
    transaction.set(sessionDoc(sessionId), { updatedAt: now }, { merge: true });
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        patientId,
        assistantId: assistant.id,
        eventType: change.event.eventType,
        previousValue: change.event.previousValue,
        newValue: change.event.newValue,
        metadata: change.event.metadata,
      },
      now
    );
    if (clientRequestId) {
      gravarLedger(
        transaction,
        sessionId,
        clientRequestId,
        { op: `runPathAction:${action.kind}`, resultRef: { kind: "path", id: pathId }, assistantId: assistant.id },
        now
      );
    }
    return { ...path, ...(change.patch as Partial<OptionConversationPath>) };
  });
}

/**
 * Reinicia a conversa (§16): o caminho atual é ENCERRADO como RESTARTED — não
 * apagado, e seus níveis permanecem — e um caminho novo nasce na mesma sessão.
 *
 * Reinício duplicado é impossível: a máquina recusa qualquer transição a
 * partir de RESTARTED, e o `clientRequestId` cobre o clique repetido.
 */
export async function restartPath(
  patientId: number,
  sessionId: string,
  pathId: string,
  clientRequestIdRaw: unknown,
  assistant: Assistant
): Promise<{ previous: OptionConversationPath; created: OptionConversationPath }> {
  const clientRequestId = requestIdOf(clientRequestIdRaw);
  const now = new Date().toISOString();
  const newPathId = newId("ocp");

  return firestore.runTransaction(async (transaction) => {
    const path = await readPath(transaction, patientId, sessionId, pathId);
    const allSnap = await transaction.get(pathsCol(sessionId));
    const all = allSnap.docs.map((d) => toPath(d.id, d.data()));

    if (clientRequestId) {
      const already = all.find((p) => p.clientRequestId === clientRequestId);
      if (already) {
        return { previous: { ...path }, created: already };
      }
    }

    const change = applyPathAction(path.status, { kind: "RESTART" }, now);
    transaction.set(pathsCol(sessionId).doc(pathId), change.patch, { merge: true });
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        patientId,
        assistantId: assistant.id,
        eventType: change.event.eventType,
        previousValue: change.event.previousValue,
        newValue: change.event.newValue,
        metadata: { restartedIntoPathId: newPathId },
      },
      now
    );

    const created: OptionConversationPath = {
      id: newPathId,
      sessionId,
      // Reiniciar preserva o que o caminho hospeda.
      kind: path.kind,
      patientId,
      assistantId: assistant.id,
      status: "ACTIVE",
      rootNodeId: null,
      activeNodeId: null,
      activeBranchId: newId("br"),
      finalStatementId: null,
      sequence: all.length + 1,
      restartedFromPathId: pathId,
      reusedFromPathId: null,
      clientRequestId,
      startedAt: now,
      pausedAt: null,
      resumedAt: null,
      completedAt: null,
      interruptedAt: null,
      restartedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    transaction.set(pathsCol(sessionId).doc(newPathId), stripId(created));
    transaction.set(sessionDoc(sessionId), { updatedAt: now }, { merge: true });
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId: newPathId,
        patientId,
        assistantId: assistant.id,
        eventType: "CONVERSATION_PATH_STARTED",
        previousValue: { restartedFromPathId: pathId },
        newValue: { status: "ACTIVE", sequence: created.sequence },
        metadata: { restart: true },
      },
      now
    );

    return {
      previous: { ...path, ...(change.patch as Partial<OptionConversationPath>) },
      created,
    };
  });
}

// ---------- Níveis ----------

export interface CreateNodeInput {
  promptText?: unknown;
  options?: unknown;
  parentNodeId?: unknown;
  isSensitive?: unknown;
  sensitiveCategory?: unknown;
  clientRequestId?: unknown;
  reusedFromNodeId?: unknown;
}

function normalizeSensitivity(
  isSensitiveRaw: unknown,
  categoryRaw: unknown
): { isSensitive: boolean; sensitiveCategory: SensitiveCategory | null } {
  const isSensitive = isSensitiveRaw === true;
  if (categoryRaw == null) return { isSensitive, sensitiveCategory: null };
  if (!isSensitive) {
    throw new RtqDomainError(
      "categoria sensível exige o conteúdo marcado como sensível"
    );
  }
  if (!isSensitiveCategory(categoryRaw)) {
    throw new RtqDomainError("categoria sensível inválida");
  }
  return { isSensitive, sensitiveCategory: categoryRaw };
}

/**
 * Constrói um nível em memória. Usado tanto na criação normal quanto na
 * recuperação por breadcrumb, na substituição e na reutilização — para que
 * essas três nunca divirjam da criação normal.
 */
function buildNode(args: {
  id: string;
  sessionId: string;
  pathId: string;
  patientId: number;
  assistantId: string;
  parentNodeId: string | null;
  branchId: string;
  depth: number;
  sequence: number;
  promptText: string;
  options: OptionConversationOption[];
  isSensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;
  status: NodeStatus;
  reusedFromNodeId: string | null;
  replacesNodeId: string | null;
  clientRequestId: string | null;
  now: string;
}): OptionConversationNode {
  return {
    id: args.id,
    pathId: args.pathId,
    sessionId: args.sessionId,
    patientId: args.patientId,
    assistantId: args.assistantId,
    parentNodeId: args.parentNodeId,
    branchId: args.branchId,
    depth: args.depth,
    sequence: args.sequence,
    interactionMode: "OPTION_SELECTION",
    promptText: args.promptText,
    status: args.status,
    options: args.options,
    provisionalOptionId: null,
    confirmedOptionId: null,
    reusedFromNodeId: args.reusedFromNodeId,
    replacesNodeId: args.replacesNodeId,
    replacedByNodeId: null,
    isSensitive: args.isSensitive,
    sensitiveCategory: args.sensitiveCategory,
    correctionCount: 0,
    clientRequestId: args.clientRequestId,
    presentedAt: null,
    selectedAt: null,
    confirmedAt: null,
    deactivatedAt: null,
    canceledAt: null,
    replacedAt: null,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/** Cópia do conteúdo de um nível, com ids de opção NOVOS e sem resposta alguma. */
function copyOptions(
  options: OptionConversationOption[]
): OptionConversationOption[] {
  return options.map((o) => ({
    ...o,
    id: newId("opt"),
    // O vínculo com o nível seguinte pertence ao original: a cópia começa sem
    // caminho posterior algum (§24, §29).
    nextNodeId: null,
  }));
}

/**
 * Cria um nível. Sem `parentNodeId` é a raiz do caminho; com ele, o nível
 * seguinte — e o pai precisa estar CONFIRMADO, porque aprofundar sem
 * conferência é exatamente o que este modo não pode fazer (§11).
 */
export async function createNode(
  patientId: number,
  sessionId: string,
  pathId: string,
  input: CreateNodeInput,
  assistant: Assistant
): Promise<OptionConversationNode> {
  const promptText = cleanText(input.promptText, MAX_PROMPT_LEN).replace(
    /\s+/g,
    " "
  );
  if (!promptText) {
    throw new RtqDomainError("o nível precisa de uma pergunta ou título");
  }
  const options = normalizeOptions(input.options, () => newId("opt"));
  const { isSensitive, sensitiveCategory } = normalizeSensitivity(
    input.isSensitive,
    input.sensitiveCategory
  );
  const clientRequestId = requestIdOf(input.clientRequestId);
  const parentNodeId = requestIdOf(input.parentNodeId);
  const reusedFromNodeId = requestIdOf(input.reusedFromNodeId);

  const now = new Date().toISOString();
  const id = newId("ocn");

  return firestore.runTransaction(async (transaction) => {
    const session = await requireSessionInTx(transaction, patientId, sessionId);
    const path = await readPath(transaction, patientId, sessionId, pathId);
    assertAcceptsNodeAction(session.status, path.status, "REVIEW");

    const nodes = await readPathNodes(transaction, sessionId, pathId);

    if (clientRequestId) {
      const already = nodes.find((n) => n.clientRequestId === clientRequestId);
      if (already) return already;
    }

    let parent: OptionConversationNode | null = null;
    let depth = 0;
    let branchId = path.activeBranchId ?? newId("br");

    if (parentNodeId) {
      parent = nodes.find((n) => n.id === parentNodeId) ?? null;
      if (!parent) throw new RtqDomainError("nível anterior não encontrado");
      if (parent.status !== "CONFIRMED") {
        throw new RtqDomainError(
          "o nível anterior precisa ter uma opção confirmada antes de aprofundar"
        );
      }
      const chosen = parent.options.find((o) => o.id === parent!.confirmedOptionId);
      if (!chosen) throw new RtqDomainError("opção confirmada não encontrada");
      if (chosen.isTerminal) {
        throw new RtqDomainError(
          "uma opção terminal abre o compositor da frase, não um novo nível"
        );
      }
      if (chosen.nextNodeId) {
        throw new RtqDomainError("esta opção já abriu o próximo nível");
      }
      depth = parent.depth + 1;
      if (depth > MAX_NODE_DEPTH) {
        throw new RtqDomainError("profundidade máxima da conversa atingida");
      }
      branchId = parent.branchId;
    } else if (nodes.some((n) => n.parentNodeId === null && n.status !== "CANCELED")) {
      throw new RtqDomainError("esta conversa já tem um nível inicial");
    }

    const node = buildNode({
      id,
      sessionId,
      pathId,
      patientId,
      assistantId: assistant.id,
      parentNodeId,
      branchId,
      depth,
      sequence: nodes.length + 1,
      promptText,
      options,
      isSensitive,
      sensitiveCategory,
      status: "DRAFT",
      reusedFromNodeId,
      replacesNodeId: null,
      clientRequestId,
      now,
    });
    assertNodeInvariants(node);

    transaction.set(nodesCol(sessionId).doc(id), stripId(node));

    // O vínculo entre níveis é gravado UMA vez, na criação do filho, e nunca
    // reescrito depois — nem quando o caminho muda (§14).
    if (parent) {
      const linked = parent.options.map((o) =>
        o.id === parent!.confirmedOptionId ? { ...o, nextNodeId: id } : o
      );
      transaction.set(
        nodesCol(sessionId).doc(parent.id),
        { options: linked, updatedAt: now },
        { merge: true }
      );
    }

    const patch: Record<string, unknown> = {
      activeNodeId: id,
      updatedAt: now,
    };
    if (!path.rootNodeId) patch.rootNodeId = id;
    transaction.set(pathsCol(sessionId).doc(pathId), patch, { merge: true });

    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        nodeId: id,
        patientId,
        assistantId: assistant.id,
        eventType: "OPTION_LEVEL_CREATED",
        newValue: {
          promptText,
          depth,
          sequence: node.sequence,
          options: options.map((o) => ({
            position: o.position,
            label: o.label,
            isTerminal: o.isTerminal,
          })),
        },
        metadata: {
          interactionMode: "OPTION_SELECTION",
          ...(parentNodeId ? { parentNodeId } : {}),
          ...(isSensitive ? { isSensitive: true, sensitiveCategory } : {}),
        },
      },
      now
    );

    if (reusedFromNodeId) {
      writeAudit(
        transaction,
        {
          sessionId,
          turnId: null,
          pathId,
          nodeId: id,
          patientId,
          assistantId: assistant.id,
          eventType: "OPTION_LEVEL_REUSED",
          previousValue: { sourceNodeId: reusedFromNodeId },
          newValue: { targetNodeId: id, status: "DRAFT" },
          metadata: { note: "nenhuma resposta anterior foi copiada" },
        },
        now
      );
    }

    return node;
  });
}

/**
 * Sessão dentro da transação, com o mesmo isolamento das leituras públicas: a
 * sessão só existe para quem consulta com o MESMO patientId.
 */
async function requireSessionInTx(
  transaction: FirebaseFirestore.Transaction,
  patientId: number,
  sessionId: string
): Promise<{ status: RtqSessionStatus }> {
  const doc = await transaction.get(sessionDoc(sessionId));
  if (!doc.exists) throw new RtqDomainError("sessão não encontrada");
  const data = doc.data()!;
  if (Number(data.patientId) !== patientId) {
    throw new RtqDomainError("sessão não encontrada");
  }
  return { status: (data.status as RtqSessionStatus) ?? "ACTIVE" };
}

export interface ReviewNodeInput {
  promptText?: unknown;
  /** Ausente = mantém as opções atuais. Presente = substitui a lista inteira. */
  options?: unknown;
  isSensitive?: unknown;
  sensitiveCategory?: unknown;
  /** Chave de idempotência (Fase 4.9.3). */
  clientRequestId?: unknown;
}

/**
 * Edição ANTES da apresentação (§27): título, opções e sensibilidade mudam no
 * MESMO registro, que continua em rascunho.
 *
 * Depois de apresentado o domínio recusa esta ação (REVIEW só existe a partir
 * de DRAFT/REVIEWED) — daí em diante o caminho é a versão corrigida (§28).
 */
export async function reviewNode(
  patientId: number,
  sessionId: string,
  pathId: string,
  nodeId: string,
  input: ReviewNodeInput,
  assistant: Assistant
): Promise<OptionConversationNode> {
  const promptText =
    input.promptText === undefined
      ? undefined
      : cleanText(input.promptText, MAX_PROMPT_LEN).replace(/\s+/g, " ");
  // A normalização é a MESMA da criação: limite de três, sem lacunas, espaços
  // aparados e acentos preservados.
  const options =
    input.options === undefined
      ? undefined
      : normalizeOptions(input.options, () => newId("opt"));

  const now = new Date().toISOString();
  const clientRequestId = requestIdOf(input.clientRequestId);
  return firestore.runTransaction(async (transaction) => {
    const session = await requireSessionInTx(transaction, patientId, sessionId);
    const path = await readPath(transaction, patientId, sessionId, pathId);
    const node = await readNode(transaction, patientId, sessionId, nodeId);
    if (node.pathId !== pathId) throw new RtqDomainError("nível não encontrado");
    // Sem esta checagem, um reenvio não corrompe contador (REVIEW é
    // naturalmente idempotente no conteúdo), mas grava um SEGUNDO evento de
    // auditoria para a mesma edição — G2 da auditoria.
    const jaAplicada = await lerLedger(transaction, sessionId, clientRequestId);
    if (jaAplicada) return node;

    assertAcceptsNodeAction(session.status, path.status, "REVIEW");
    const change = applyNodeAction(
      node,
      {
        kind: "REVIEW",
        ...(promptText !== undefined ? { promptText } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(input.isSensitive !== undefined
          ? { isSensitive: input.isSensitive === true }
          : {}),
        ...(input.sensitiveCategory !== undefined
          ? {
              sensitiveCategory: isSensitiveCategory(input.sensitiveCategory)
                ? input.sensitiveCategory
                : null,
            }
          : {}),
      },
      now
    );

    transaction.set(nodesCol(sessionId).doc(nodeId), change.patch, { merge: true });
    transaction.set(sessionDoc(sessionId), { updatedAt: now }, { merge: true });
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        nodeId,
        patientId,
        assistantId: assistant.id,
        eventType: change.event.eventType,
        previousValue: change.event.previousValue,
        newValue: change.event.newValue,
        metadata: { sameRecord: true },
      },
      now
    );
    if (clientRequestId) {
      gravarLedger(
        transaction,
        sessionId,
        clientRequestId,
        { op: "reviewNode", resultRef: { kind: "node", id: nodeId }, assistantId: assistant.id },
        now
      );
    }
    return { ...node, ...change.patch };
  });
}

export async function runNodeAction(
  patientId: number,
  sessionId: string,
  pathId: string,
  nodeId: string,
  action: NodeAction,
  assistant: Assistant,
  clientRequestIdRaw?: unknown
): Promise<{ node: OptionConversationNode; path: OptionConversationPath }> {
  const now = new Date().toISOString();
  const clientRequestId = requestIdOf(clientRequestIdRaw);
  return firestore.runTransaction(async (transaction) => {
    const session = await requireSessionInTx(transaction, patientId, sessionId);
    const path = await readPath(transaction, patientId, sessionId, pathId);
    const node = await readNode(transaction, patientId, sessionId, nodeId);
    if (node.pathId !== pathId) throw new RtqDomainError("nível não encontrado");
    const jaAplicada = await lerLedger(transaction, sessionId, clientRequestId);
    if (jaAplicada) return { node, path };

    assertAcceptsNodeAction(session.status, path.status, action.kind);
    const change = applyNodeAction(node, action, now);

    transaction.set(nodesCol(sessionId).doc(nodeId), change.patch, { merge: true });

    // Apresentar ou confirmar torna este o nível ativo do caminho.
    const pathPatch: Record<string, unknown> = { updatedAt: now };
    if (
      action.kind === "PRESENT" ||
      action.kind === "AWAIT_SELECTION" ||
      action.kind === "REPRESENT"
    ) {
      pathPatch.activeNodeId = nodeId;
    }
    transaction.set(pathsCol(sessionId).doc(pathId), pathPatch, { merge: true });
    transaction.set(sessionDoc(sessionId), { updatedAt: now }, { merge: true });

    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        nodeId,
        patientId,
        assistantId: assistant.id,
        eventType: change.event.eventType,
        previousValue: change.event.previousValue,
        newValue: change.event.newValue,
        metadata: change.event.metadata,
      },
      now
    );
    if (clientRequestId) {
      gravarLedger(
        transaction,
        sessionId,
        clientRequestId,
        { op: `runNodeAction:${action.kind}`, resultRef: { kind: "node", id: nodeId }, assistantId: assistant.id },
        now
      );
    }

    return {
      node: { ...node, ...change.patch },
      path: { ...path, ...(pathPatch as Partial<OptionConversationPath>) },
    };
  });
}

// ---------- Retorno pelo breadcrumb e mudança de caminho ----------

/** Todos os descendentes vivos de um nó, na ordem em que devem ser desativados. */
function descendantsOf(
  nodes: OptionConversationNode[],
  rootId: string
): OptionConversationNode[] {
  const out: OptionConversationNode[] = [];
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const n of nodes) {
      if (n.parentNodeId === current) {
        out.push(n);
        queue.push(n.id);
      }
    }
  }
  return out;
}

const DEACTIVATABLE: readonly NodeStatus[] = [
  "PRESENTED",
  "AWAITING_SELECTION",
  "PROVISIONAL_SELECTION",
  "CONFIRMED",
];

/**
 * Volta a um nível anterior pelo breadcrumb (§14) e abre a nova ramificação
 * (§15) — as duas coisas na MESMA transação, porque separá-las deixaria o
 * caminho num estado sem nível ativo.
 *
 * O nível de destino NÃO é reescrito. Ele e seus descendentes ficam INACTIVE,
 * com a escolha que receberam preservada para sempre, e uma CÓPIA do seu
 * conteúdo nasce numa ramificação nova, já aguardando seleção. É a única forma
 * de "permitir nova escolha a partir de Saúde" sem violar §2 — a escolha
 * antiga (Dor) continua registrada como o que de fato aconteceu.
 */
export async function returnToNode(
  patientId: number,
  sessionId: string,
  pathId: string,
  targetNodeId: string,
  clientRequestIdRaw: unknown,
  assistant: Assistant
): Promise<PathDetail> {
  const clientRequestId = requestIdOf(clientRequestIdRaw);
  const now = new Date().toISOString();
  const newNodeId = newId("ocn");
  const newBranchId = newId("br");

  return firestore.runTransaction(async (transaction) => {
    const session = await requireSessionInTx(transaction, patientId, sessionId);
    const path = await readPath(transaction, patientId, sessionId, pathId);
    assertAcceptsNodeAction(session.status, path.status, "AWAIT_SELECTION");

    const nodes = await readPathNodes(transaction, sessionId, pathId);
    const statementsSnap = await transaction.get(
      statementsCol(sessionId).where("pathId", "==", pathId)
    );
    const statements = statementsSnap.docs.map((d) => toStatement(d.id, d.data()));

    if (clientRequestId) {
      const already = nodes.find((n) => n.clientRequestId === clientRequestId);
      if (already) {
        return buildDetail(path, nodes, statements);
      }
    }

    const target = nodes.find((n) => n.id === targetNodeId);
    if (!target) throw new RtqDomainError("nível não encontrado");

    const trail = activeTrail(nodes, path.activeNodeId);
    if (!trail.some((n) => n.id === targetNodeId)) {
      throw new RtqDomainError(
        "o breadcrumb só navega dentro do caminho ativo"
      );
    }
    if (path.activeNodeId === targetNodeId) {
      throw new RtqDomainError("este já é o nível atual");
    }

    // ——— 1. Desativar o alvo e tudo o que veio depois dele ———
    const toDeactivate = [target, ...descendantsOf(nodes, targetNodeId)].filter(
      (n) => DEACTIVATABLE.includes(n.status)
    );
    const updated = new Map<string, OptionConversationNode>();
    for (const n of toDeactivate) {
      const change = applyNodeAction(
        n,
        { kind: "DEACTIVATE", reason: "breadcrumb_return" },
        now
      );
      transaction.set(nodesCol(sessionId).doc(n.id), change.patch, { merge: true });
      updated.set(n.id, { ...n, ...change.patch });
      writeAudit(
        transaction,
        {
          sessionId,
          turnId: null,
          pathId,
          nodeId: n.id,
          patientId,
          assistantId: assistant.id,
          eventType: change.event.eventType,
          previousValue: change.event.previousValue,
          newValue: change.event.newValue,
          metadata: { returnedTo: targetNodeId },
        },
        now
      );
    }

    // A frase em construção pertencia à ramificação abandonada: ela não
    // atravessa para o caminho novo (§15).
    for (const s of statements) {
      if (
        s.status === "DRAFT" ||
        s.status === "REVIEWED" ||
        s.status === "PRESENTED" ||
        s.status === "PROVISIONAL_RESPONSE" ||
        s.status === "RECONFIRMATION_PENDING"
      ) {
        const change = applyStatementAction(
          s,
          { kind: "CANCEL", reason: "breadcrumb_return" },
          now
        );
        transaction.set(statementsCol(sessionId).doc(s.id), change.patch, {
          merge: true,
        });
        writeAudit(
          transaction,
          {
            sessionId,
            turnId: null,
            pathId,
            statementId: s.id,
            patientId,
            assistantId: assistant.id,
            eventType: change.event.eventType,
            previousValue: change.event.previousValue,
            newValue: change.event.newValue,
            metadata: { returnedTo: targetNodeId },
          },
          now
        );
      }
    }

    // ——— 2. Recriar o nível na ramificação nova, já aguardando seleção ———
    let fresh = buildNode({
      id: newNodeId,
      sessionId,
      pathId,
      patientId,
      assistantId: assistant.id,
      parentNodeId: target.parentNodeId,
      branchId: newBranchId,
      depth: target.depth,
      sequence: nodes.length + 1,
      promptText: target.promptText,
      options: copyOptions(target.options),
      isSensitive: target.isSensitive,
      sensitiveCategory: target.sensitiveCategory,
      status: "REVIEWED",
      reusedFromNodeId: target.id,
      replacesNodeId: null,
      clientRequestId,
      now,
    });
    // As mesmas opções, apresentadas de novo: passa por PRESENT e
    // AWAIT_SELECTION para que os marcos e os eventos sejam os de sempre.
    for (const kind of ["PRESENT", "AWAIT_SELECTION"] as const) {
      const change = applyNodeAction(fresh, { kind }, now);
      fresh = { ...fresh, ...change.patch };
    }
    assertNodeInvariants(fresh);
    transaction.set(nodesCol(sessionId).doc(newNodeId), stripId(fresh));

    // ——— 3. Apontar o caminho para a ramificação nova ———
    transaction.set(
      pathsCol(sessionId).doc(pathId),
      {
        activeNodeId: newNodeId,
        activeBranchId: newBranchId,
        finalStatementId: null,
        updatedAt: now,
      },
      { merge: true }
    );
    transaction.set(sessionDoc(sessionId), { updatedAt: now }, { merge: true });

    const trailLabels = trail.map((n) => n.promptText);
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        nodeId: newNodeId,
        patientId,
        assistantId: assistant.id,
        eventType: "PATH_LEVEL_RETURNED",
        previousValue: {
          activeNodeId: path.activeNodeId,
          activeBranchId: path.activeBranchId,
          trail: trailLabels,
        },
        newValue: { activeNodeId: newNodeId, returnedToNodeId: targetNodeId },
        metadata: { deactivatedCount: toDeactivate.length },
      },
      now
    );
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        nodeId: newNodeId,
        patientId,
        assistantId: assistant.id,
        eventType: "PATH_BRANCH_CREATED",
        previousValue: { branchId: path.activeBranchId },
        newValue: { branchId: newBranchId, rootNodeId: newNodeId },
        metadata: null,
      },
      now
    );
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        nodeId: newNodeId,
        patientId,
        assistantId: assistant.id,
        eventType: "PATH_CHANGED",
        previousValue: { trail: trailLabels },
        newValue: { fromNodeId: targetNodeId, intoNodeId: newNodeId },
        metadata: { note: "a ramificação anterior foi preservada" },
      },
      now
    );

    const finalNodes = nodes
      .map((n) => updated.get(n.id) ?? n)
      .concat(fresh)
      .sort((a, b) => a.sequence - b.sequence);
    const finalPath: OptionConversationPath = {
      ...path,
      activeNodeId: newNodeId,
      activeBranchId: newBranchId,
      finalStatementId: null,
      updatedAt: now,
    };
    return buildDetail(finalPath, finalNodes, statements);
  });
}

function buildDetail(
  path: OptionConversationPath,
  nodes: OptionConversationNode[],
  statements: OptionConversationFinalStatement[]
): PathDetail {
  return { path, nodes, statements };
}

// ---------- Substituição de nível (§28, §29) ----------

/**
 * Cria a VERSÃO CORRIGIDA de um nível já apresentado. O original permanece
 * intacto e passa a apontar para a nova versão; a nova nasce em DRAFT, numa
 * ramificação nova, e sem nenhuma resposta herdada.
 */
export async function replaceNode(
  patientId: number,
  sessionId: string,
  pathId: string,
  nodeId: string,
  clientRequestIdRaw: unknown,
  assistant: Assistant
): Promise<{ original: OptionConversationNode; created: OptionConversationNode }> {
  const clientRequestId = requestIdOf(clientRequestIdRaw);
  const now = new Date().toISOString();
  const newNodeId = newId("ocn");
  const newBranchId = newId("br");

  return firestore.runTransaction(async (transaction) => {
    const session = await requireSessionInTx(transaction, patientId, sessionId);
    const path = await readPath(transaction, patientId, sessionId, pathId);
    assertAcceptsNodeAction(session.status, path.status, "MARK_REPLACED");

    const nodes = await readPathNodes(transaction, sessionId, pathId);

    if (clientRequestId) {
      const already = nodes.find((n) => n.clientRequestId === clientRequestId);
      if (already) {
        const original = nodes.find((n) => n.id === nodeId)!;
        return { original, created: already };
      }
    }

    const original = nodes.find((n) => n.id === nodeId);
    if (!original) throw new RtqDomainError("nível não encontrado");

    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        nodeId,
        patientId,
        assistantId: assistant.id,
        eventType: "OPTION_LEVEL_EDIT_REQUESTED",
        previousValue: { status: original.status, promptText: original.promptText },
        newValue: { willReplaceWith: newNodeId },
        metadata: { reason: "conteúdo já apresentado ao paciente" },
      },
      now
    );

    // Os níveis posteriores pertencem ao texto antigo: nenhuma resposta deles
    // pode migrar para a versão corrigida (§29).
    for (const n of descendantsOf(nodes, nodeId).filter((d) =>
      DEACTIVATABLE.includes(d.status)
    )) {
      const change = applyNodeAction(
        n,
        { kind: "DEACTIVATE", reason: "level_replaced" },
        now
      );
      transaction.set(nodesCol(sessionId).doc(n.id), change.patch, { merge: true });
      writeAudit(
        transaction,
        {
          sessionId,
          turnId: null,
          pathId,
          nodeId: n.id,
          patientId,
          assistantId: assistant.id,
          eventType: change.event.eventType,
          previousValue: change.event.previousValue,
          newValue: change.event.newValue,
          metadata: { replacedNodeId: nodeId },
        },
        now
      );
    }

    const created = buildNode({
      id: newNodeId,
      sessionId,
      pathId,
      patientId,
      assistantId: assistant.id,
      parentNodeId: original.parentNodeId,
      branchId: newBranchId,
      depth: original.depth,
      sequence: nodes.length + 1,
      promptText: original.promptText,
      options: copyOptions(original.options),
      isSensitive: original.isSensitive,
      sensitiveCategory: original.sensitiveCategory,
      // DRAFT: o texto foi copiado PARA EDIÇÃO, e precisa ser revisado e
      // apresentado de novo antes de qualquer seleção (§28).
      status: "DRAFT",
      reusedFromNodeId: null,
      replacesNodeId: nodeId,
      clientRequestId,
      now,
    });
    assertNodeInvariants(created);
    transaction.set(nodesCol(sessionId).doc(newNodeId), stripId(created));

    const markChange = applyNodeAction(
      original,
      { kind: "MARK_REPLACED", replacedByNodeId: newNodeId },
      now
    );
    transaction.set(nodesCol(sessionId).doc(nodeId), markChange.patch, {
      merge: true,
    });
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        nodeId,
        patientId,
        assistantId: assistant.id,
        eventType: markChange.event.eventType,
        previousValue: markChange.event.previousValue,
        newValue: markChange.event.newValue,
        metadata: { replacedByNodeId: newNodeId },
      },
      now
    );

    transaction.set(
      pathsCol(sessionId).doc(pathId),
      {
        activeNodeId: newNodeId,
        activeBranchId: newBranchId,
        updatedAt: now,
      },
      { merge: true }
    );
    transaction.set(sessionDoc(sessionId), { updatedAt: now }, { merge: true });
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        nodeId: newNodeId,
        patientId,
        assistantId: assistant.id,
        eventType: "PATH_BRANCH_CREATED",
        previousValue: { branchId: path.activeBranchId },
        newValue: { branchId: newBranchId, replacesNodeId: nodeId },
        metadata: null,
      },
      now
    );

    return {
      original: { ...original, ...markChange.patch },
      created,
    };
  });
}

// ---------- Frase final ----------

export interface CreateStatementInput {
  text?: unknown;
  originNodeId?: unknown;
  /** Quem formulou o texto. Ausente = escolhido entre opções (Fase 4.2). */
  origin?: StatementOrigin;
  isSensitive?: unknown;
  sensitiveCategory?: unknown;
  clientRequestId?: unknown;
  reusedFromStatementId?: unknown;
  replacesStatementId?: unknown;
}

function buildStatement(args: {
  id: string;
  sessionId: string;
  pathId: string;
  patientId: number;
  assistantId: string;
  originNodeId: string | null;
  text: string;
  isSensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;
  reusedFromStatementId: string | null;
  replacesStatementId: string | null;
  clientRequestId: string | null;
  origin: StatementOrigin;
  now: string;
}): OptionConversationFinalStatement {
  return {
    id: args.id,
    pathId: args.pathId,
    sessionId: args.sessionId,
    patientId: args.patientId,
    assistantId: args.assistantId,
    originNodeId: args.originNodeId,
    origin: args.origin,
    // O modo deriva da origem, sempre pela fonte única — nunca é escolhido
    // aqui nem aceito do cliente.
    interactionMode: MODO_POR_ORIGEM[args.origin],
    originalDraft: args.text,
    currentText: args.text,
    presentedText: "",
    status: "DRAFT",
    provisionalResponse: null,
    confirmedResponse: null,
    reusedFromStatementId: args.reusedFromStatementId,
    replacesStatementId: args.replacesStatementId,
    replacedByStatementId: null,
    isSensitive: args.isSensitive,
    sensitiveCategory: args.sensitiveCategory,
    editCount: 0,
    correctionCount: 0,
    representCount: 0,
    clientRequestId: args.clientRequestId,
    presentedAt: null,
    respondedAt: null,
    reconfirmedAt: null,
    confirmedAt: null,
    rejectedAt: null,
    canceledAt: null,
    replacedAt: null,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/**
 * Abre a mensagem em construção (§17). O texto vem da frase associada à opção
 * terminal ou do que o assistente escreveu a partir do caminho confirmado —
 * nunca de IA.
 *
 * A sensibilidade é HERDADA do caminho: se qualquer nível ou opção confirmada
 * foi marcada como sensível, a frase também é, e passará pela reconfirmação
 * reforçada (§21).
 */
export async function createStatement(
  patientId: number,
  sessionId: string,
  pathId: string,
  input: CreateStatementInput,
  assistant: Assistant
): Promise<OptionConversationFinalStatement> {
  const text = cleanText(input.text, MAX_STATEMENT_LEN).replace(/\s+/g, " ");
  if (!text) throw new RtqDomainError("a frase não pode ficar vazia");
  const clientRequestId = requestIdOf(input.clientRequestId);
  const originNodeId = requestIdOf(input.originNodeId);
  const origin: StatementOrigin = isStatementOrigin(input.origin)
    ? input.origin
    : "OPTION_PATH";
  if (origin === "CAREGIVER_INTERPRETATION" && originNodeId) {
    // Uma interpretação nasce de uma vocalização do paciente, não de uma opção
    // que ele escolheu. Aceitar as duas coisas juntas confundiria a autoria.
    throw new RtqDomainError(
      "uma interpretação do cuidador não nasce de um nível de opções"
    );
  }
  const reusedFromStatementId = requestIdOf(input.reusedFromStatementId);
  const declared = normalizeSensitivity(input.isSensitive, input.sensitiveCategory);

  const now = new Date().toISOString();
  const id = newId("ocs");

  return firestore.runTransaction(async (transaction) => {
    const session = await requireSessionInTx(transaction, patientId, sessionId);
    const path = await readPath(transaction, patientId, sessionId, pathId);
    assertAcceptsStatementAction(session.status, path.status, "EDIT");

    const nodes = await readPathNodes(transaction, sessionId, pathId);
    const existingSnap = await transaction.get(
      statementsCol(sessionId).where("pathId", "==", pathId)
    );
    const existing = existingSnap.docs.map((d) => toStatement(d.id, d.data()));

    if (clientRequestId) {
      const already = existing.find((s) => s.clientRequestId === clientRequestId);
      if (already) return already;
    }

    const trail = activeTrail(nodes, path.activeNodeId);
    const inherited = trailSensitivity(trail);
    const isSensitive = declared.isSensitive || inherited.isSensitive;
    const sensitiveCategory =
      declared.sensitiveCategory ?? (isSensitive ? inherited.sensitiveCategory : null);

    const statement = buildStatement({
      id,
      sessionId,
      pathId,
      origin,
      patientId,
      assistantId: assistant.id,
      originNodeId,
      text,
      isSensitive,
      sensitiveCategory,
      reusedFromStatementId,
      replacesStatementId: null,
      clientRequestId,
      now,
    });
    assertStatementInvariants(statement);
    transaction.set(statementsCol(sessionId).doc(id), stripId(statement));
    transaction.set(
      pathsCol(sessionId).doc(pathId),
      { finalStatementId: id, updatedAt: now },
      { merge: true }
    );
    transaction.set(sessionDoc(sessionId), { updatedAt: now }, { merge: true });

    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        statementId: id,
        patientId,
        assistantId: assistant.id,
        eventType: statementEventFor(origin, "DRAFTED"),
        newValue: { originalDraft: text, status: "DRAFT" },
        metadata: {
          trail: trail.map((n) => n.promptText),
          ...(isSensitive
            ? { isSensitive: true, sensitiveCategory, inherited: inherited.isSensitive }
            : {}),
          ...(originNodeId ? { originNodeId } : {}),
        },
      },
      now
    );

    if (reusedFromStatementId) {
      writeAudit(
        transaction,
        {
          sessionId,
          turnId: null,
          pathId,
          statementId: id,
          patientId,
          assistantId: assistant.id,
          eventType: statementEventFor(origin, "REUSED"),
          previousValue: { sourceStatementId: reusedFromStatementId },
          newValue: { targetStatementId: id, status: "DRAFT" },
          metadata: { note: "nenhuma resposta anterior foi copiada" },
        },
        now
      );
    }

    return statement;
  });
}

/**
 * Interpretação digitada pelo cuidador (Fase 4.2).
 *
 * Compõe o contêiner e a frase numa operação só. O contêiner é um caminho SEM
 * nós: ele existe para ordenar a interação na sessão e para que a
 * interpretação herde de graça pausa, histórico, reutilização e auditoria —
 * exatamente o que a frase final já usa. Não há entidade nem coleção nova.
 *
 * Idempotente nos DOIS documentos: o caminho leva `${clientRequestId}:path` e a
 * frase leva o id puro, a mesma convenção de fan-out de reuseNode/reuseStatement.
 * Um clique repetido devolve o par que o primeiro criou.
 */
export async function createCaregiverInterpretation(
  patientId: number,
  sessionId: string,
  input: {
    text?: unknown;
    isSensitive?: unknown;
    sensitiveCategory?: unknown;
    clientRequestId?: unknown;
    reusedFromStatementId?: unknown;
  },
  assistant: Assistant
): Promise<{
  path: OptionConversationPath;
  statement: OptionConversationFinalStatement;
}> {
  const clientRequestId = requestIdOf(input.clientRequestId);
  const path = await createPath(
    patientId,
    sessionId,
    {
      kind: "CAREGIVER_INTERPRETATION",
      clientRequestId: clientRequestId ? `${clientRequestId}:path` : undefined,
    },
    assistant
  );
  const statement = await createStatement(
    patientId,
    sessionId,
    path.id,
    {
      text: input.text,
      origin: "CAREGIVER_INTERPRETATION",
      isSensitive: input.isSensitive,
      sensitiveCategory: input.sensitiveCategory,
      clientRequestId,
      reusedFromStatementId: input.reusedFromStatementId,
    },
    assistant
  );
  return { path, statement };
}

export async function runStatementAction(
  patientId: number,
  sessionId: string,
  pathId: string,
  statementId: string,
  action: StatementAction | { kind: "REJECT" },
  assistant: Assistant,
  clientRequestIdRaw?: unknown
): Promise<{
  statement: OptionConversationFinalStatement;
  path: OptionConversationPath;
}> {
  const now = new Date().toISOString();
  const clientRequestId = requestIdOf(clientRequestIdRaw);
  return firestore.runTransaction(async (transaction) => {
    const session = await requireSessionInTx(transaction, patientId, sessionId);
    const path = await readPath(transaction, patientId, sessionId, pathId);
    const statement = await readStatement(
      transaction,
      patientId,
      sessionId,
      statementId
    );
    if (statement.pathId !== pathId) throw new RtqDomainError("frase não encontrada");

    // G2 da auditoria — o caso que CORROMPE, não só confunde: sem esta
    // checagem, um reenvio de REMOVE_RESPONSE sobre uma frase (única
    // transição do domínio que aceita replay — PROVISIONAL_RESPONSE →
    // PROVISIONAL_RESPONSE) incrementava `correctionCount` de novo a cada
    // repetição. `correctionCount` é dado observacional sobre a interação do
    // paciente; infla-lo é o tipo de corrupção silenciosa que o resto do
    // projeto evita.
    const jaAplicada = await lerLedger(transaction, sessionId, clientRequestId);
    if (jaAplicada) return { statement, path };

    const kind = action.kind === "REJECT" ? "CONFIRM" : action.kind;
    assertAcceptsStatementAction(session.status, path.status, kind);

    const change =
      action.kind === "REJECT"
        ? applyStatementRejection(statement, now)
        : applyStatementAction(statement, action, now);

    transaction.set(statementsCol(sessionId).doc(statementId), change.patch, {
      merge: true,
    });

    const pathPatch: Record<string, unknown> = { updatedAt: now };
    // Confirmar a frase CONCLUI o caminho (§20). Rejeitar não conclui nada:
    // uma frase rejeitada nunca é comunicação confirmada.
    let pathChange: ReturnType<typeof applyPathAction> | null = null;
    if (change.status === "CONFIRMED" && !isTerminalPathStatus(path.status)) {
      pathChange = applyPathAction(
        path.status,
        { kind: "COMPLETE", finalStatementId: statementId },
        now
      );
      Object.assign(pathPatch, pathChange.patch);
    }
    transaction.set(pathsCol(sessionId).doc(pathId), pathPatch, { merge: true });
    transaction.set(sessionDoc(sessionId), { updatedAt: now }, { merge: true });

    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        statementId,
        patientId,
        assistantId: assistant.id,
        eventType: change.event.eventType,
        previousValue: change.event.previousValue,
        newValue: change.event.newValue,
        metadata: change.event.metadata,
      },
      now
    );
    if (action.kind === "PRESENT") {
      writeAudit(
        transaction,
        {
          sessionId,
          turnId: null,
          pathId,
          statementId,
          patientId,
          assistantId: assistant.id,
          eventType: "INTERACTION_MODE_SELECTED",
          // Numa interpretação não houve escolha entre opções antes: o modo
          // anterior é nenhum, e dizer "OPTION_SELECTION" seria falso.
          previousValue: {
            interactionMode:
              statement.origin === "CAREGIVER_INTERPRETATION"
                ? null
                : "OPTION_SELECTION",
          },
          newValue: { interactionMode: statement.interactionMode },
          metadata: {
            note:
              statement.origin === "CAREGIVER_INTERPRETATION"
                ? "os sinais do paciente significam SIM, TALVEZ e NÃO sobre o que o cuidador entendeu"
                : "os sinais do paciente voltam a significar SIM, TALVEZ e NÃO",
          },
        },
        now
      );
    }
    if (pathChange) {
      writeAudit(
        transaction,
        {
          sessionId,
          turnId: null,
          pathId,
          statementId,
          patientId,
          assistantId: assistant.id,
          eventType: pathChange.event.eventType,
          previousValue: pathChange.event.previousValue,
          newValue: pathChange.event.newValue,
          metadata: { finalStatementId: statementId },
        },
        now
      );
    }
    if (clientRequestId) {
      gravarLedger(
        transaction,
        sessionId,
        clientRequestId,
        { op: `runStatementAction:${action.kind}`, resultRef: { kind: "statement", id: statementId }, assistantId: assistant.id },
        now
      );
    }

    return {
      statement: { ...statement, ...change.patch },
      path: { ...path, ...(pathPatch as Partial<OptionConversationPath>) },
    };
  });
}

/**
 * Versão corrigida de uma frase já apresentada (§30). A frase original — e a
 * resposta que ela recebeu, inclusive uma confirmação — permanece válida para
 * o texto original. A nova exige apresentação e confirmação próprias.
 */
export async function replaceStatement(
  patientId: number,
  sessionId: string,
  pathId: string,
  statementId: string,
  clientRequestIdRaw: unknown,
  assistant: Assistant
): Promise<{
  original: OptionConversationFinalStatement;
  created: OptionConversationFinalStatement;
  /** Caminho onde a nova versão nasceu — pode ser um caminho novo. */
  path: OptionConversationPath;
}> {
  const clientRequestId = requestIdOf(clientRequestIdRaw);

  // Uma frase CONFIRMADA conclui o caminho. Corrigi-la continua sendo direito
  // do assistente (§30), mas um caminho concluído nunca volta a ser ativo
  // (§25) — então a versão corrigida nasce num caminho NOVO, vinculado ao
  // anterior. A frase original e a confirmação que ela recebeu ficam onde
  // estão.
  const origem = await getPathDetail(patientId, sessionId, pathId);
  if (!origem) throw new RtqDomainError("conversa por opções não encontrada");
  if (isTerminalPathStatus(origem.path.status)) {
    return replaceStatementIntoNewPath(
      patientId,
      sessionId,
      origem,
      statementId,
      clientRequestId,
      assistant
    );
  }

  const now = new Date().toISOString();
  const newStatementId = newId("ocs");

  return firestore.runTransaction(async (transaction) => {
    const session = await requireSessionInTx(transaction, patientId, sessionId);
    const path = await readPath(transaction, patientId, sessionId, pathId);
    assertAcceptsStatementAction(session.status, path.status, "MARK_REPLACED");

    const existingSnap = await transaction.get(
      statementsCol(sessionId).where("pathId", "==", pathId)
    );
    const existing = existingSnap.docs.map((d) => toStatement(d.id, d.data()));

    const original = existing.find((s) => s.id === statementId);
    if (!original) throw new RtqDomainError("frase não encontrada");

    if (clientRequestId) {
      const already = existing.find((s) => s.clientRequestId === clientRequestId);
      if (already) return { original, created: already, path };
    }

    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        statementId,
        patientId,
        assistantId: assistant.id,
        eventType: statementEventFor(original.origin, "EDIT_REQUESTED"),
        previousValue: {
          status: original.status,
          text: original.presentedText || original.currentText,
        },
        newValue: { willReplaceWith: newStatementId },
        metadata: { reason: "frase já apresentada ao paciente" },
      },
      now
    );

    const created = buildStatement({
      id: newStatementId,
      sessionId,
      // A versão corrigida herda a origem: corrigir o texto não muda quem o
      // formulou.
      origin: original.origin,
      pathId,
      patientId,
      assistantId: assistant.id,
      originNodeId: original.originNodeId,
      text: original.presentedText || original.currentText,
      isSensitive: original.isSensitive,
      sensitiveCategory: original.sensitiveCategory,
      reusedFromStatementId: null,
      replacesStatementId: statementId,
      clientRequestId,
      now,
    });
    assertStatementInvariants(created);
    transaction.set(statementsCol(sessionId).doc(newStatementId), stripId(created));

    const markChange = applyStatementAction(
      original,
      { kind: "MARK_REPLACED", replacedByStatementId: newStatementId },
      now
    );
    transaction.set(statementsCol(sessionId).doc(statementId), markChange.patch, {
      merge: true,
    });
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId,
        statementId,
        patientId,
        assistantId: assistant.id,
        eventType: markChange.event.eventType,
        previousValue: markChange.event.previousValue,
        newValue: markChange.event.newValue,
        metadata: {
          replacedByStatementId: newStatementId,
          note: "a resposta anterior continua vinculada apenas à frase original",
        },
      },
      now
    );

    transaction.set(
      pathsCol(sessionId).doc(pathId),
      { finalStatementId: newStatementId, updatedAt: now },
      { merge: true }
    );
    transaction.set(sessionDoc(sessionId), { updatedAt: now }, { merge: true });

    return { original: { ...original, ...markChange.patch }, created, path };
  });
}

/**
 * Versão corrigida de uma frase cujo caminho já foi encerrado. Cria um caminho
 * novo para abrigá-la — é o único jeito de dar à frase corrigida a
 * apresentação e a confirmação próprias que §30 exige sem reabrir um caminho
 * concluído, o que §25 proíbe.
 */
async function replaceStatementIntoNewPath(
  patientId: number,
  sessionId: string,
  origem: PathDetail,
  statementId: string,
  clientRequestId: string | null,
  assistant: Assistant
): Promise<{
  original: OptionConversationFinalStatement;
  created: OptionConversationFinalStatement;
  path: OptionConversationPath;
}> {
  const original = origem.statements.find((s) => s.id === statementId);
  if (!original) throw new RtqDomainError("frase não encontrada");

  const path = await createPath(
    patientId,
    sessionId,
    {
      clientRequestId: clientRequestId ? `${clientRequestId}:path` : null,
      reusedFromPathId: origem.path.id,
    },
    assistant
  );

  const now = new Date().toISOString();
  const newStatementId = newId("ocs");

  return firestore.runTransaction(async (transaction) => {
    const fresh = await readStatement(
      transaction,
      patientId,
      sessionId,
      statementId
    );
    const existingSnap = await transaction.get(
      statementsCol(sessionId).where("pathId", "==", path.id)
    );
    const existing = existingSnap.docs.map((d) => toStatement(d.id, d.data()));
    if (clientRequestId) {
      const already = existing.find((s) => s.clientRequestId === clientRequestId);
      if (already) return { original: fresh, created: already, path };
    }

    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId: origem.path.id,
        statementId,
        patientId,
        assistantId: assistant.id,
        eventType: statementEventFor(original.origin, "EDIT_REQUESTED"),
        previousValue: {
          status: fresh.status,
          text: fresh.presentedText || fresh.currentText,
          confirmedResponse: fresh.confirmedResponse,
        },
        newValue: { willReplaceWith: newStatementId, intoPathId: path.id },
        metadata: {
          reason: "frase já apresentada em uma conversa encerrada",
        },
      },
      now
    );

    const created = buildStatement({
      id: newStatementId,
      sessionId,
      // A versão corrigida herda a origem: corrigir o texto não muda quem o
      // formulou.
      origin: original.origin,
      pathId: path.id,
      patientId,
      assistantId: assistant.id,
      originNodeId: null,
      text: fresh.presentedText || fresh.currentText,
      isSensitive: fresh.isSensitive,
      sensitiveCategory: fresh.sensitiveCategory,
      reusedFromStatementId: null,
      replacesStatementId: statementId,
      clientRequestId,
      now,
    });
    assertStatementInvariants(created);
    transaction.set(statementsCol(sessionId).doc(newStatementId), stripId(created));

    const markChange = applyStatementAction(
      fresh,
      { kind: "MARK_REPLACED", replacedByStatementId: newStatementId },
      now
    );
    transaction.set(statementsCol(sessionId).doc(statementId), markChange.patch, {
      merge: true,
    });
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId: origem.path.id,
        statementId,
        patientId,
        assistantId: assistant.id,
        eventType: markChange.event.eventType,
        previousValue: markChange.event.previousValue,
        newValue: markChange.event.newValue,
        metadata: {
          replacedByStatementId: newStatementId,
          intoPathId: path.id,
          note: "a resposta anterior continua vinculada apenas à frase original",
        },
      },
      now
    );

    transaction.set(
      pathsCol(sessionId).doc(path.id),
      { finalStatementId: newStatementId, updatedAt: now },
      { merge: true }
    );

    return { original: { ...fresh, ...markChange.patch }, created, path };
  });
}

// ---------- Reutilização pelo histórico (§24, §25) ----------

/**
 * Reutiliza um nível concluído como base de um nível NOVO. Não retoma nada:
 * o original fica intacto, e a cópia nasce em DRAFT, sem seleção e sem
 * confirmação.
 *
 * Sem `targetPathId`, um caminho novo é criado e a cópia vira a raiz dele —
 * é como "iniciar um novo caminho baseado no conteúdo anterior" (§25).
 */
export async function reuseNode(
  patientId: number,
  sessionId: string,
  sourceNodeId: string,
  options: { targetPathId?: unknown; clientRequestId?: unknown },
  assistant: Assistant
): Promise<{ path: OptionConversationPath; node: OptionConversationNode }> {
  const clientRequestId = requestIdOf(options.clientRequestId);
  const targetPathId = requestIdOf(options.targetPathId);

  const source = await firestore
    .collection("conversationQuestionSessions")
    .doc(sessionId)
    .collection("nodes")
    .doc(sourceNodeId)
    .get();
  if (!source.exists) throw new RtqDomainError("nível de origem não encontrado");
  const origin = toNode(source.id, source.data()!);
  if (origin.patientId !== patientId) {
    throw new RtqDomainError("nível de origem não encontrado");
  }

  let path: OptionConversationPath;
  if (targetPathId) {
    const detail = await getPathDetail(patientId, sessionId, targetPathId);
    if (!detail) throw new RtqDomainError("conversa por opções não encontrada");
    if (isTerminalPathStatus(detail.path.status)) {
      throw new RtqDomainError(
        "esta conversa já foi encerrada; inicie uma nova para reutilizar"
      );
    }
    path = detail.path;
  } else {
    path = await createPath(
      patientId,
      sessionId,
      {
        clientRequestId: clientRequestId ? `${clientRequestId}:path` : null,
        reusedFromPathId: origin.pathId,
      },
      assistant
    );
  }

  const node = await createNode(
    patientId,
    sessionId,
    path.id,
    {
      promptText: origin.promptText,
      // Só o CONTEÚDO é copiado. Nenhuma resposta, nenhuma confirmação e
      // nenhum vínculo com o nível seguinte do original.
      options: origin.options.map((o) => ({
        label: o.label,
        isTerminal: o.isTerminal,
        finalStatementDraft: o.finalStatementDraft ?? undefined,
        isSensitive: o.isSensitive,
        sensitiveCategory: o.sensitiveCategory ?? undefined,
      })),
      isSensitive: origin.isSensitive,
      sensitiveCategory: origin.sensitiveCategory ?? undefined,
      clientRequestId,
      reusedFromNodeId: sourceNodeId,
    },
    assistant
  );

  await recordReuse(
    patientId,
    sessionId,
    assistant,
    { sourceType: "NODE", sourceId: sourceNodeId },
    { targetType: "NODE", targetId: node.id, pathId: path.id, nodeId: node.id },
    clientRequestId
  );

  return { path, node };
}

/** Reutiliza uma frase concluída como rascunho novo, sem a resposta antiga. */
export async function reuseStatement(
  patientId: number,
  sessionId: string,
  sourceStatementId: string,
  options: { targetPathId?: unknown; clientRequestId?: unknown },
  assistant: Assistant
): Promise<{
  path: OptionConversationPath;
  statement: OptionConversationFinalStatement;
}> {
  const clientRequestId = requestIdOf(options.clientRequestId);
  const targetPathId = requestIdOf(options.targetPathId);

  const source = await statementsCol(sessionId).doc(sourceStatementId).get();
  if (!source.exists) throw new RtqDomainError("frase de origem não encontrada");
  const origin = toStatement(source.id, source.data()!);
  if (origin.patientId !== patientId) {
    throw new RtqDomainError("frase de origem não encontrada");
  }

  let path: OptionConversationPath;
  if (targetPathId) {
    const detail = await getPathDetail(patientId, sessionId, targetPathId);
    if (!detail) throw new RtqDomainError("conversa por opções não encontrada");
    if (isTerminalPathStatus(detail.path.status)) {
      throw new RtqDomainError(
        "esta conversa já foi encerrada; inicie uma nova para reutilizar"
      );
    }
    path = detail.path;
  } else {
    path = await createPath(
      patientId,
      sessionId,
      {
        clientRequestId: clientRequestId ? `${clientRequestId}:path` : null,
        reusedFromPathId: origin.pathId,
      },
      assistant
    );
  }

  const statement = await createStatement(
    patientId,
    sessionId,
    path.id,
    {
      text: origin.presentedText || origin.currentText,
      isSensitive: origin.isSensitive,
      sensitiveCategory: origin.sensitiveCategory ?? undefined,
      clientRequestId,
      reusedFromStatementId: sourceStatementId,
    },
    assistant
  );

  await recordReuse(
    patientId,
    sessionId,
    assistant,
    { sourceType: "STATEMENT", sourceId: sourceStatementId },
    {
      targetType: "STATEMENT",
      targetId: statement.id,
      pathId: path.id,
      statementId: statement.id,
    },
    clientRequestId
  );

  return { path, statement };
}

/**
 * Reutiliza um caminho concluído: cria um caminho NOVO e copia o conteúdo do
 * primeiro nível dele. O caminho original nunca volta a ser ativo (§25).
 */
export async function reusePath(
  patientId: number,
  sessionId: string,
  sourcePathId: string,
  clientRequestIdRaw: unknown,
  assistant: Assistant
): Promise<{ path: OptionConversationPath; node: OptionConversationNode | null }> {
  const clientRequestId = requestIdOf(clientRequestIdRaw);
  const detail = await getPathDetail(patientId, sessionId, sourcePathId);
  if (!detail) throw new RtqDomainError("conversa de origem não encontrada");

  const path = await createPath(
    patientId,
    sessionId,
    {
      clientRequestId: clientRequestId ? `${clientRequestId}:path` : null,
      reusedFromPathId: sourcePathId,
    },
    assistant
  );

  const root =
    detail.nodes.find((n) => n.id === detail.path.rootNodeId) ??
    detail.nodes.find((n) => n.parentNodeId === null) ??
    null;

  let node: OptionConversationNode | null = null;
  if (root) {
    node = await createNode(
      patientId,
      sessionId,
      path.id,
      {
        promptText: root.promptText,
        options: root.options.map((o) => ({
          label: o.label,
          isTerminal: o.isTerminal,
          finalStatementDraft: o.finalStatementDraft ?? undefined,
          isSensitive: o.isSensitive,
          sensitiveCategory: o.sensitiveCategory ?? undefined,
        })),
        isSensitive: root.isSensitive,
        sensitiveCategory: root.sensitiveCategory ?? undefined,
        clientRequestId,
        reusedFromNodeId: root.id,
      },
      assistant
    );
  }

  await recordReuse(
    patientId,
    sessionId,
    assistant,
    { sourceType: "PATH", sourceId: sourcePathId },
    { targetType: "PATH", targetId: path.id, pathId: path.id, nodeId: node?.id },
    clientRequestId
  );

  return { path, node };
}

/**
 * Evento único de reutilização, seja qual for o tipo de conteúdo (§34).
 *
 * G1 da auditoria da Fase 4.9: esta função abria uma transação PRÓPRIA,
 * separada da criação (`createNode`/`createStatement`/`createPath`, essas
 * sim idempotentes por `clientRequestId`). Um reenvio da mesma intenção —
 * rotina numa fila offline, não exceção — deduplicava a criação
 * corretamente e ainda assim gravava um SEGUNDO evento `CONTENT_REUSED` para
 * a mesma reutilização, porque nada aqui sabia que já tinha rodado.
 *
 * A chave de ledger usa um sufixo (`:reuse-event`) diferente da chave que a
 * criação já consumiu: são duas coisas que a mesma intenção do cuidador
 * produz, e cada uma precisa da sua própria marca de "já aconteceu".
 */
async function recordReuse(
  patientId: number,
  sessionId: string,
  assistant: Assistant,
  from: { sourceType: string; sourceId: string },
  to: {
    targetType: string;
    targetId: string;
    pathId?: string;
    nodeId?: string;
    statementId?: string;
  },
  clientRequestId: string | null
): Promise<void> {
  const now = new Date().toISOString();
  const ledgerKey = clientRequestId ? `${clientRequestId}:reuse-event` : null;
  await firestore.runTransaction(async (transaction) => {
    const jaAplicada = await lerLedger(transaction, sessionId, ledgerKey);
    if (jaAplicada) return;

    writeAudit(
      transaction,
      {
        sessionId,
        turnId: null,
        pathId: to.pathId ?? null,
        nodeId: to.nodeId ?? null,
        statementId: to.statementId ?? null,
        patientId,
        assistantId: assistant.id,
        eventType: "CONTENT_REUSED",
        previousValue: from,
        newValue: { ...to, status: "DRAFT" },
        metadata: {
          note: "o registro original permanece intacto; nenhuma resposta foi copiada",
        },
      },
      now
    );
    if (ledgerKey) {
      gravarLedger(
        transaction,
        sessionId,
        ledgerKey,
        { op: "recordReuse", resultRef: null, assistantId: assistant.id },
        now
      );
    }
  });
}

/**
 * Abrir um item do histórico (§22). Registra a consulta e NADA MAIS: nenhum
 * campo do item é tocado, porque abrir nunca pode alterar o que aconteceu.
 */
export async function recordHistoryOpen(
  patientId: number,
  sessionId: string,
  target: {
    itemType: "TURN" | "PATH" | "NODE" | "STATEMENT";
    itemId: string;
    pathId?: string | null;
  },
  assistant: Assistant
): Promise<void> {
  await requireSession(patientId, sessionId);
  const now = new Date().toISOString();
  await firestore.runTransaction(async (transaction) => {
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: target.itemType === "TURN" ? target.itemId : null,
        pathId:
          target.itemType === "PATH" ? target.itemId : (target.pathId ?? null),
        nodeId: target.itemType === "NODE" ? target.itemId : null,
        statementId: target.itemType === "STATEMENT" ? target.itemId : null,
        patientId,
        assistantId: assistant.id,
        eventType: "HISTORY_ITEM_OPENED",
        newValue: { itemType: target.itemType, itemId: target.itemId },
        metadata: { readOnly: true },
      },
      now
    );
  });
}
