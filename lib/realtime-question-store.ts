// ——— Perguntas em tempo real: camada de dados ———
// Persistência sobre o Firestore, no mesmo padrão de lib/activity-store.ts:
// nenhuma escrita confia no cliente, tudo é normalizado no servidor e o
// isolamento por paciente é estrutural.
//
// Estrutura:
//   conversationQuestionSessions/{sessionId}                 ← sessão
//   conversationQuestionSessions/{sessionId}/turns/{turnId}  ← interações
//   conversationQuestionSessions/{sessionId}/events/{id}     ← trilha imutável
//   patients/{patientId}/realtimeQuestionConfig/responseProfile
//
// ATOMICIDADE (seção 12): toda mudança de estado e o evento de auditoria
// correspondente são gravados na MESMA transação. Nunca uma sem a outra.
// A transação relê o documento antes de decidir, então duas ações
// simultâneas não confirmam respostas diferentes: a segunda reexecuta contra
// o estado novo e é recusada pela máquina de estados.
//
// Horário: sempre gerado NO SERVIDOR (new Date().toISOString()), convenção de
// todo o projeto. O cliente nunca envia timestamps, autoria ou sequence.

import { firestore } from "@/lib/firestore";
import {
  applySessionAction,
  applyTurnAction,
  assertSessionAcceptsNewTurn,
  assertSessionAcceptsTurnAction,
  type SessionAction,
  type TurnAction,
} from "@/lib/realtime-question-machine";
import {
  assertTurnInvariants,
  DEFAULT_RESPONSE_MAPPINGS,
  IMPLEMENTED_QUESTION_SOURCES,
  isOpenAwaitingTurnStatus,
  isQuestionSource,
  isResponseInputMethod,
  isSemanticResponse,
  isSensitiveCategory,
  RtqConflictError,
  type RtqConflictFacts,
  RtqDomainError,
  type ConversationQuestionSession,
  type ConversationQuestionTurn,
  type InteractionAuditEvent,
  type InteractionEventType,
  type InteractionMode,
  type PatientResponseProfile,
  type QuestionSource,
  type ResponseSignalMapping,
  type RtqSessionStatus,
  type RtqTurnStatus,
  type SemanticResponse,
  type SensitiveCategory,
} from "@/lib/realtime-question-types";

const sessionsCol = () => firestore.collection("conversationQuestionSessions");
/** Compartilhado com a conversa por opções: mesma sessão, mesmo isolamento. */
export const sessionDoc = (sessionId: string) => sessionsCol().doc(sessionId);
const turnsCol = (sessionId: string) => sessionDoc(sessionId).collection("turns");
export const eventsCol = (sessionId: string) =>
  sessionDoc(sessionId).collection("events");
const responseProfileDoc = (patientId: number) =>
  firestore
    .collection("patients")
    .doc(String(patientId))
    .collection("realtimeQuestionConfig")
    .doc("responseProfile");

/** Compartilhado com a conversa por opções — um gerador de id só no projeto. */
export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

// ---------- Id proposto pelo cliente (Fase 4.9.3, revisão do §3.3) ----------
//
// A auditoria original propôs handles locais, trocados pelo id do servidor na
// sincronização. A Fase 4.9.2 — já implementada, testada e em produção —
// tomou outra decisão de produto: o CLIENTE cunha o id definitivo offline, no
// MESMO formato de `newId`, e `lib/offline/projection.ts` e toda a interface
// (openPathId, breadcrumb, dependências entre operações da fila) já tratam
// esse id como identidade real desde então, não como correlação temporária.
//
// Reescrever para handles agora — na Fase B, depois de duas fases já
// aprovadas sobre a outra base — significaria redesenhar `projection.ts`
// inteiro e cada referência da interface que hoje é o id do cliente, com
// risco real de regredir os testes offline já aprovados. A decisão registrada
// aqui é aceitar o id do cliente no servidor, com a MESMA autoridade que o
// resto do domínio sempre teve sobre tudo que não é identidade: autenticação,
// autorização, estado, versão e horário continuam exclusivamente do servidor.
// O cliente PROPÕE um nome; não propõe um fato.
//
// Isto substitui o §3.3 do documento de auditoria. O resto do documento —
// ledger de idempotência (§3.4), algoritmo de sincronização (§9), matriz de
// conflitos (§10) — continua valendo sem alteração: nenhum deles dependia de
// handles, só da identidade ser estável, e ela é, com ou sem handle.
import { isValidEntityId, PREFIXO, type PrefixoEntidade } from "@/lib/offline/ids";
import { metadadosDaOrigem } from "@/lib/origem-da-operacao";

/**
 * Resolve o id de um registro em criação.
 *
 * Se o cliente propôs um id válido (formato e prefixo do tipo certo), ele é
 * usado — o cliente PROPÕE a identidade, dentro do formato que só o domínio
 * define. Proposta ausente ou vazia: comportamento de sempre, o servidor
 * cunha um novo. Proposta malformada: erro de domínio, ANTES de qualquer
 * leitura ou escrita — nunca uma tentativa de "corrigir" um id ruim.
 *
 * A checagem de COLISÃO (o id já pertencer a outro registro) não está aqui:
 * exigiria uma leitura, e esta função roda antes da transação abrir. É
 * responsabilidade de quem chama, dentro da mesma transação que vai gravar —
 * ver o comentário em `createTurn`.
 */
export function resolveEntityId(
  prefixo: PrefixoEntidade,
  proposto: unknown
): string {
  if (proposto === undefined || proposto === null || proposto === "") {
    return newId(prefixo);
  }
  if (!isValidEntityId(proposto, prefixo)) {
    throw new RtqDomainError(
      `identificador proposto pelo cliente é inválido para ${prefixo}`
    );
  }
  return proposto;
}

/** Apara os excessos e respeita o teto, preservando acentos e pontuação (§6). */
export function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

const MAX_QUESTION_LEN = 500;
const MAX_LABEL_LEN = 80;
const MAX_SIGNAL_KEY_LEN = 40;

/** Identidade do operador — vem SEMPRE da sessão autenticada. */
export interface Assistant {
  id: string;
  name: string;
}

// ---------- Conversores ----------

function toSession(
  id: string,
  v: FirebaseFirestore.DocumentData
): ConversationQuestionSession {
  return {
    id,
    patientId: Number(v.patientId),
    assistantId: String(v.assistantId ?? ""),
    assistantName: (v.assistantName as string) ?? null,
    status: (v.status as RtqSessionStatus) ?? "ACTIVE",
    startedAt: String(v.startedAt ?? ""),
    pausedAt: (v.pausedAt as string) ?? null,
    resumedAt: (v.resumedAt as string) ?? null,
    completedAt: (v.completedAt as string) ?? null,
    abandonedAt: (v.abandonedAt as string) ?? null,
    turnCount: Number(v.turnCount ?? 0),
    createdAt: String(v.createdAt ?? ""),
    updatedAt: String(v.updatedAt ?? ""),
  };
}

function toTurn(
  id: string,
  v: FirebaseFirestore.DocumentData
): ConversationQuestionTurn {
  return {
    id,
    sessionId: String(v.sessionId ?? ""),
    patientId: Number(v.patientId),
    assistantId: String(v.assistantId ?? ""),
    sequence: Number(v.sequence ?? 0),
    // Turnos gravados antes da Fase 4.5 não têm o campo: uma pergunta livre
    // sempre foi — e continua sendo — uma confirmação fechada.
    interactionMode:
      (v.interactionMode as InteractionMode) ?? "CLOSED_CONFIRMATION",
    questionSource: (v.questionSource as QuestionSource) ?? "MANUAL_TEXT",
    originalText: (v.originalText as string) ?? null,
    reviewedText: String(v.reviewedText ?? ""),
    presentedText: String(v.presentedText ?? ""),
    status: (v.status as RtqTurnStatus) ?? "DRAFT",
    provisionalResponse: (v.provisionalResponse as SemanticResponse) ?? null,
    confirmedResponse: (v.confirmedResponse as SemanticResponse) ?? null,
    isSensitive: v.isSensitive === true,
    sensitiveCategory: (v.sensitiveCategory as SensitiveCategory) ?? null,
    reusedFromTurnId: (v.reusedFromTurnId as string) ?? null,
    presentedAt: (v.presentedAt as string) ?? null,
    responseObservedAt: (v.responseObservedAt as string) ?? null,
    assistantVerifiedAt: (v.assistantVerifiedAt as string) ?? null,
    reconfirmedAt: (v.reconfirmedAt as string) ?? null,
    confirmedAt: (v.confirmedAt as string) ?? null,
    canceledAt: (v.canceledAt as string) ?? null,
    responseTimeMs: v.responseTimeMs != null ? Number(v.responseTimeMs) : null,
    correctionCount: Number(v.correctionCount ?? 0),
    representCount: Number(v.representCount ?? 0),
    createdAt: String(v.createdAt ?? ""),
    updatedAt: String(v.updatedAt ?? ""),
  };
}

export function toEvent(
  id: string,
  v: FirebaseFirestore.DocumentData
): InteractionAuditEvent {
  return {
    id,
    sessionId: String(v.sessionId ?? ""),
    turnId: (v.turnId as string) ?? null,
    // Eventos das Fases 1–4 não têm estes campos: `null` é o padrão seguro.
    pathId: (v.pathId as string) ?? null,
    nodeId: (v.nodeId as string) ?? null,
    statementId: (v.statementId as string) ?? null,
    contextId: (v.contextId as string) ?? null,
    patientId: Number(v.patientId),
    assistantId: String(v.assistantId ?? ""),
    eventType: v.eventType as InteractionEventType,
    previousValue: v.previousValue ?? null,
    newValue: v.newValue ?? null,
    metadata: (v.metadata as Record<string, unknown>) ?? null,
    createdAt: String(v.createdAt ?? ""),
  };
}

// ---------- Trilha de auditoria (append-only) ----------

export interface AuditInput {
  sessionId: string;
  turnId: string | null;
  /** Vínculos da conversa por opções — ausentes numa pergunta fechada. */
  pathId?: string | null;
  nodeId?: string | null;
  statementId?: string | null;
  /** Vínculo do contexto da sessão (Fase 4.8). */
  contextId?: string | null;
  patientId: number;
  assistantId: string;
  eventType: InteractionEventType;
  previousValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown> | null;
}

/**
 * Cria o evento DENTRO da transação em curso, sempre num documento novo:
 * nenhum evento anterior é sobrescrito e nada é apagado. Não existe rota de
 * escrita para esta coleção — a autoria e o horário nascem aqui.
 *
 * Exportado para que a conversa por opções grave na MESMA trilha, com a mesma
 * garantia. Duas trilhas paralelas dariam duas verdades sobre a mesma sessão.
 */
export function writeAudit(
  transaction: FirebaseFirestore.Transaction,
  input: AuditInput,
  now: string
): void {
  const ref = eventsCol(input.sessionId).doc(newId("ev"));
  // Origem da operação (4.9.5): entra aqui, uma vez, para os 48 pontos que
  // gravam trilha. `createdAt` continua sendo `now` — cunhado pelo servidor,
  // dentro desta transação. `intendedAt` é o que o APARELHO disse, e por isso
  // vive em `metadata`, ao lado dos demais metadados informativos, e nunca no
  // lugar de um horário oficial.
  const origem = metadadosDaOrigem();
  const metadata =
    origem === null
      ? (input.metadata ?? null)
      : { ...(input.metadata ?? {}), ...origem };
  transaction.set(ref, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    pathId: input.pathId ?? null,
    nodeId: input.nodeId ?? null,
    statementId: input.statementId ?? null,
    contextId: input.contextId ?? null,
    patientId: input.patientId,
    assistantId: input.assistantId,
    eventType: input.eventType,
    previousValue: input.previousValue ?? null,
    newValue: input.newValue ?? null,
    metadata,
    createdAt: now,
  });
}

// ---------- Ledger de idempotência (Fase 4.9.3, §3.4a da auditoria) ----------
//
// `conversationQuestionSessions/{sessionId}/appliedRequests/{clientRequestId}`
// — um documento por INTENÇÃO já aplicada, escrito na MESMA transação que a
// aplica. Antes de agir, toda função transacional desta camada relê este
// documento: se existe, a intenção já foi cumprida, e a função devolve o
// resultado registrado em vez de reaplicar.
//
// Isto fecha duas lacunas da auditoria de uma vez, para TODAS as operações,
// sem espalhar checagens `clientRequestId` por dez funções:
//
//   G1 — reuseNode/reuseStatement/reusePath chamavam recordReuse numa
//   transação PRÓPRIA; um reenvio duplicava o evento CONTENT_REUSED mesmo com
//   a criação corretamente deduplicada.
//   G2 — as transições de estado (runTurnAction, runNodeAction, ...) não
//   tinham proteção nenhuma contra replay. Na maioria dos casos a máquina de
//   estados barra a repetição — mas devolve um ERRO DE DOMÍNIO para uma ação
//   que de fato já foi aplicada, o que uma fila offline não consegue
//   distinguir de "recusada". Um caso, `REMOVE_RESPONSE` sobre frase, não era
//   nem barrado: o replay incrementava `correctionCount` de novo.
//
// Deliberadamente NÃO se usa `If-Match`/versão otimista (§3.4, nota final): a
// releitura transacional já resolve a concorrência ENTRE dispositivos — dois
// não confirmam respostas diferentes. O ledger resolve o REPLAY do mesmo
// dispositivo, que é um problema diferente.

export interface LedgerEntry {
  /** Nome curto da operação — só para leitura humana em caso de investigação. */
  op: string;
  /** O que o replay deve reler e devolver. `null` quando não há entidade própria. */
  resultRef: { kind: string; id: string } | null;
  assistantId: string;
  appliedAt: string;
  /**
   * Impressão do CONTEÚDO da intenção original (Fase 4.9.3). Opcional — só as
   * quatro criações que aceitam id proposto pelo cliente a preenchem.
   *
   * Sem isto, a MESMA `clientRequestId` reaparecendo com um payload
   * DIFERENTE seria tratada como replay e devolveria silenciosamente o
   * resultado antigo — descartando uma intenção genuinamente distinta do
   * cuidador. Com isto, essa situação vira um erro explícito: não é reenvio,
   * é a mesma chave usada para duas coisas diferentes.
   */
  payloadFingerprint?: string;
}

const appliedRequestsCol = (sessionId: string) =>
  sessionDoc(sessionId).collection("appliedRequests");

/**
 * Serialização estável de um objeto — chaves ordenadas, para que a mesma
 * intenção monte sempre a mesma impressão independente da ordem em que os
 * campos foram inseridos. Mesma técnica de `lib/offline/queue.ts:fingerprint`
 * (duplicada de propósito: aquele módulo é puro e não importa nada daqui).
 */
function conteudoEstavel(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(conteudoEstavel).join(",")}]`;
  const entradas = Object.entries(v as Record<string, unknown>)
    .filter(([, valor]) => valor !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entradas
    .map(([k, valor]) => `${JSON.stringify(k)}:${conteudoEstavel(valor)}`)
    .join(",")}}`;
}

export function payloadFingerprint(conteudo: unknown): string {
  return conteudoEstavel(conteudo);
}

/**
 * Erro específico para "mesma chave, intenção diferente" — distinto de um
 * `RtqDomainError` comum porque o cliente precisa reagir diferente: um erro
 * de domínio comum é "sua ação foi recusada"; este é "isto não é um
 * reenvio", e o motor de sincronização (Fase B) o marca CONFLICT, nunca
 * FAILED — retentar não resolve, é a mesma colisão de novo.
 */
export class RtqIdempotencyConflictError extends RtqConflictError {
  constructor(message = "mesma chave de idempotência usada para uma intenção diferente") {
    super("IDEMPOTENCY_MISMATCH", message);
    this.name = "RtqIdempotencyConflictError";
  }
}

/**
 * O código HTTP para um erro capturado numa rota de criação. Só as quatro
 * rotas que aceitam id proposto pelo cliente (turns, paths, nodes,
 * statements) usam isto — as demais continuam com 400 fixo, como sempre.
 */
export function statusForCreationError(e: unknown): number {
  return e instanceof RtqIdempotencyConflictError ? 409 : 400;
}

/**
 * A resposta de erro de uma rota RTQ, com o conflito NOMEADO quando houver um
 * (§10, Fase C).
 *
 * Existe como função única, e não como um objeto montado em cada `catch`,
 * porque são dezessete blocos: a chance de um deles esquecer o `code` — e com
 * ele condenar aquela rota a "conflito desconhecido" para sempre, sem erro de
 * compilação — é alta demais para depender de disciplina.
 *
 * O `error` em texto continua idêntico ao que sempre foi. Nada que já
 * consumia estas rotas precisa saber que o campo novo existe.
 */
export function respostaDeErro(e: unknown, status: number): Response {
  const corpo: { error: string; code?: string; facts?: RtqConflictFacts } = {
    error: (e as Error).message,
  };
  if (e instanceof RtqConflictError) {
    corpo.code = e.code;
    // Só vai o que a tela de decisão precisa mostrar. O documento inteiro
    // NUNCA entra numa resposta de erro: quem foi recusado é, por definição,
    // quem talvez não devesse mais estar lendo aquele dado (caso 9).
    if (Object.keys(e.facts).length > 0) corpo.facts = e.facts;
  }
  return Response.json(corpo, { status });
}

/** Normaliza um `clientRequestId` recebido do corpo da requisição. */
export function requestIdOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null;
}

/**
 * Lê o ledger DENTRO da transação — precisa ser chamado junto das demais
 * leituras, antes de qualquer `transaction.set`/`.update` (exigência do
 * Firestore: todas as leituras de uma transação vêm antes de toda escrita).
 *
 * `clientRequestId` ausente ou inválido devolve `null` sem tocar o banco: uma
 * chamada sem chave de idempotência nunca é deduplicada — é o comportamento
 * anterior, preservado para quem ainda não manda a chave.
 */
export async function lerLedger(
  transaction: FirebaseFirestore.Transaction,
  sessionId: string,
  clientRequestId: unknown
): Promise<LedgerEntry | null> {
  const key = requestIdOf(clientRequestId);
  if (!key) return null;
  const doc = await transaction.get(appliedRequestsCol(sessionId).doc(key));
  return doc.exists ? (doc.data() as LedgerEntry) : null;
}

/** Grava a marca de aplicada. Só chamar quando `clientRequestId` é válido. */
export function gravarLedger(
  transaction: FirebaseFirestore.Transaction,
  sessionId: string,
  clientRequestId: string,
  entry: Omit<LedgerEntry, "appliedAt">,
  now: string
): void {
  transaction.set(appliedRequestsCol(sessionId).doc(clientRequestId), {
    ...entry,
    appliedAt: now,
  });
}

// ---------- Sessões ----------

export async function createRtqSession(
  patientId: number,
  assistant: Assistant
): Promise<ConversationQuestionSession> {
  const now = new Date().toISOString();
  const id = newId("cqs");
  const session: ConversationQuestionSession = {
    id,
    patientId,
    assistantId: assistant.id,
    assistantName: assistant.name,
    status: "ACTIVE",
    startedAt: now,
    pausedAt: null,
    resumedAt: null,
    completedAt: null,
    abandonedAt: null,
    turnCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const { id: _id, ...data } = session;
  void _id;
  await firestore.runTransaction(async (transaction) => {
    transaction.set(sessionDoc(id), data);
    writeAudit(
      transaction,
      {
        sessionId: id,
        turnId: null,
        patientId,
        assistantId: assistant.id,
        eventType: "SESSION_STARTED",
        newValue: { status: "ACTIVE" },
      },
      now
    );
  });
  return session;
}

/**
 * Isolamento: a sessão só existe para quem consulta com o MESMO patientId.
 * Trocar o identificador na URL não alcança dados de outro paciente.
 */
export async function getRtqSession(
  patientId: number,
  sessionId: string
): Promise<ConversationQuestionSession | null> {
  const doc = await sessionDoc(sessionId).get();
  if (!doc.exists) return null;
  const session = toSession(doc.id, doc.data()!);
  return session.patientId === patientId ? session : null;
}

export async function listRtqSessions(
  patientId: number,
  limit = 50
): Promise<ConversationQuestionSession[]> {
  const snap = await sessionsCol().where("patientId", "==", patientId).get();
  return snap.docs
    .map((d) => toSession(d.id, d.data()))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

/**
 * Pausa, retomada, conclusão e abandono.
 *
 * Ao CONCLUIR, as perguntas ainda abertas (apresentadas e sem resposta
 * observada) recebem NO_RESPONSE — a única situação em que a ausência de
 * resposta é registrada sem clique direto, e ainda assim disparada por ato
 * explícito do assistente (seção 4). Nunca por tempo.
 *
 * Ao ABANDONAR, nada é alterado: perguntas e eventos ficam exatamente como
 * estavam, e nenhuma pergunta sem resposta vira resposta negativa (seção 7).
 */
export async function runSessionAction(
  patientId: number,
  sessionId: string,
  action: SessionAction,
  assistant: Assistant,
  clientRequestIdRaw?: unknown
): Promise<ConversationQuestionSession> {
  const now = new Date().toISOString();
  const clientRequestId = requestIdOf(clientRequestIdRaw);
  return firestore.runTransaction(async (transaction) => {
    const ref = sessionDoc(sessionId);
    const doc = await transaction.get(ref);
    if (!doc.exists) throw new RtqDomainError("sessão não encontrada");
    const session = toSession(doc.id, doc.data()!);
    if (session.patientId !== patientId) {
      throw new RtqDomainError("sessão não encontrada");
    }
    const jaAplicada = await lerLedger(transaction, sessionId, clientRequestId);
    if (jaAplicada) return session;

    // Todas as leituras acontecem ANTES de qualquer escrita (exigência do
    // Firestore).
    const openTurns: ConversationQuestionTurn[] = [];
    if (action === "COMPLETE") {
      const turnsSnap = await transaction.get(turnsCol(sessionId));
      for (const d of turnsSnap.docs) {
        const turn = toTurn(d.id, d.data());
        if (isOpenAwaitingTurnStatus(turn.status)) openTurns.push(turn);
      }
    }

    const change = applySessionAction(session.status, action, now);
    transaction.set(ref, change.patch, { merge: true });
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
      },
      now
    );

    for (const turn of openTurns) {
      const turnChange = applyTurnAction(
        turn,
        { kind: "RECORD_NO_RESPONSE", reason: "session_completed" },
        now
      );
      transaction.set(turnsCol(sessionId).doc(turn.id), turnChange.patch, {
        merge: true,
      });
      writeAudit(
        transaction,
        {
          sessionId,
          turnId: turn.id,
          patientId,
          assistantId: assistant.id,
          eventType: turnChange.event.eventType,
          previousValue: turnChange.event.previousValue,
          newValue: turnChange.event.newValue,
          metadata: turnChange.event.metadata,
        },
        now
      );
    }

    if (clientRequestId) {
      gravarLedger(
        transaction,
        sessionId,
        clientRequestId,
        { op: `runSessionAction:${action}`, resultRef: null, assistantId: assistant.id },
        now
      );
    }
    return { ...session, ...(change.patch as Partial<ConversationQuestionSession>) };
  });
}

// ---------- Interações (turnos) ----------

export interface TurnInput {
  questionSource?: unknown;
  /** Transcrição como saiu do ditado, antes da revisão (Fase 5.2A). */
  originalText?: unknown;
  text?: unknown;
  isSensitive?: unknown;
  sensitiveCategory?: unknown;
  /** Origem quando a pergunta nasce de "Reutilizar como novo" no histórico. */
  reusedFromTurnId?: unknown;
  /** Chave de idempotência (Fase 4.9.3, §3.4a). Opcional — quem não manda não é deduplicado. */
  clientRequestId?: unknown;
  /** Id proposto pelo cliente (Fase 4.9.3, revisão do §3.3). Opcional. */
  turnId?: unknown;
}

function normalizeSource(v: unknown): QuestionSource {
  if (v === undefined || v === null) return "MANUAL_TEXT";
  if (!isQuestionSource(v)) throw new RtqDomainError("origem da pergunta inválida");
  if (!IMPLEMENTED_QUESTION_SOURCES.includes(v)) {
    // Voz e IA estão preparadas no modelo, mas não existem nesta fase.
    throw new RtqDomainError(`origem ${v} ainda não disponível nesta fase`);
  }
  return v;
}

/**
 * Cria a pergunta em DRAFT. O `sequence` é atribuído dentro da transação, a
 * partir do contador da sessão — a ordem das perguntas é preservada mesmo com
 * criações concorrentes.
 */
export async function createTurn(
  patientId: number,
  sessionId: string,
  input: TurnInput,
  assistant: Assistant
): Promise<ConversationQuestionTurn> {
  const questionSource = normalizeSource(input.questionSource);
  const text = cleanText(input.text, MAX_QUESTION_LEN);
  if (!text) throw new RtqDomainError("a pergunta não pode ficar vazia");

  // O texto de origem só é aceito quando a origem o justifica. Numa pergunta
  // digitada ele é descartado em silêncio — não é erro do cuidador, é campo
  // que não se aplica.
  const originalText =
    questionSource === "VOICE_TRANSCRIPTION"
      ? cleanText(input.originalText, MAX_QUESTION_LEN) || null
      : null;

  // Nesta fase quem marca o assunto sensível é o assistente — não há
  // detecção automática em lugar algum.
  const isSensitive = input.isSensitive === true;
  let sensitiveCategory: SensitiveCategory | null = null;
  if (isSensitive) {
    if (input.sensitiveCategory != null) {
      if (!isSensitiveCategory(input.sensitiveCategory)) {
        throw new RtqDomainError("categoria sensível inválida");
      }
      sensitiveCategory = input.sensitiveCategory;
    }
  } else if (input.sensitiveCategory != null) {
    throw new RtqDomainError(
      "categoria sensível exige a pergunta marcada como sensível"
    );
  }

  const reusedFromTurnId =
    typeof input.reusedFromTurnId === "string" && input.reusedFromTurnId
      ? input.reusedFromTurnId
      : null;

  const now = new Date().toISOString();
  // O cliente PROPÕE a identidade (Fase 4.9.3); o formato é a única coisa
  // verificada aqui. `resolveEntityId` lança ANTES de qualquer leitura se a
  // proposta for malformada — nunca tenta "corrigir" um id ruim.
  const id = resolveEntityId(PREFIXO.turn, input.turnId);
  const clientRequestId = requestIdOf(input.clientRequestId);

  return firestore.runTransaction(async (transaction) => {
    const ref = sessionDoc(sessionId);
    const tRef = turnsCol(sessionId).doc(id);
    const [doc, jaExiste] = await Promise.all([
      transaction.get(ref),
      transaction.get(tRef),
    ]);
    if (!doc.exists) throw new RtqDomainError("sessão não encontrada");
    const session = toSession(doc.id, doc.data()!);
    if (session.patientId !== patientId) {
      throw new RtqDomainError("sessão não encontrada");
    }

    // G2 fechado para criação: um reenvio da mesma intenção (mesma
    // `clientRequestId`) devolve o turno já criado em vez de tentar criar um
    // segundo. Antes disto, a dedup só existia no cliente.
    const fingerprint = payloadFingerprint({
      text,
      questionSource,
      isSensitive,
      sensitiveCategory,
      reusedFromTurnId,
    });
    const jaAplicada = await lerLedger(transaction, sessionId, clientRequestId);
    if (jaAplicada?.resultRef) {
      const existente = await transaction.get(
        turnsCol(sessionId).doc(jaAplicada.resultRef.id)
      );
      if (existente.exists) {
        // Mesma chave, conteúdo DIFERENTE: não é reenvio, é colisão de
        // intenções — nunca devolve o resultado da outra em silêncio.
        if (
          jaAplicada.payloadFingerprint &&
          jaAplicada.payloadFingerprint !== fingerprint
        ) {
          throw new RtqIdempotencyConflictError();
        }
        return toTurn(existente.id, existente.data()!);
      }
      // Ledger aponta para algo que sumiu — segue como se não houvesse
      // registro; é mais seguro tentar de novo do que travar o cuidador.
    }

    // Chegou até aqui sem ter sido reconhecida pelo ledger: se o id proposto
    // já pertence a um registro, é uma COLISÃO de verdade — não um replay —
    // e nunca vira sobrescrita silenciosa. Só é alcançável quando o cliente
    // propôs um id (id gerado no servidor nunca colide: `newId` inclui o
    // relógio e aleatoriedade próprios).
    if (jaExiste.exists) {
      throw new RtqDomainError(
        "identificador já pertence a outro registro; não é possível reutilizá-lo"
      );
    }

    assertSessionAcceptsNewTurn(session.status);

    // A origem precisa existir NESTA sessão: reutilizar não atravessa
    // pacientes nem inventa vínculo.
    if (reusedFromTurnId) {
      const origin = await transaction.get(turnsCol(sessionId).doc(reusedFromTurnId));
      if (!origin.exists) {
        throw new RtqDomainError("pergunta de origem não encontrada");
      }
    }

    const turn: ConversationQuestionTurn = {
      id,
      sessionId,
      // patientId e assistantId nunca vêm do corpo da requisição: o paciente
      // é o da sessão (imutável) e o assistente é o usuário autenticado.
      patientId: session.patientId,
      assistantId: assistant.id,
      sequence: session.turnCount + 1,
      interactionMode: "CLOSED_CONFIRMATION",
      questionSource,
      originalText,
      reviewedText: text,
      presentedText: "",
      status: "DRAFT",
      provisionalResponse: null,
      confirmedResponse: null,
      isSensitive,
      sensitiveCategory,
      // Só o TEXTO é copiado da origem. Resposta e confirmação ficam com ela.
      reusedFromTurnId,
      presentedAt: null,
      responseObservedAt: null,
      assistantVerifiedAt: null,
      reconfirmedAt: null,
      confirmedAt: null,
      canceledAt: null,
      responseTimeMs: null,
      correctionCount: 0,
      representCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    assertTurnInvariants(turn);

    const { id: _id, ...data } = turn;
    void _id;
    transaction.set(turnsCol(sessionId).doc(id), data);
    transaction.set(ref, { turnCount: turn.sequence, updatedAt: now }, { merge: true });
    writeAudit(
      transaction,
      {
        sessionId,
        turnId: id,
        patientId: session.patientId,
        assistantId: assistant.id,
        eventType: "QUESTION_CREATED",
        newValue: { sequence: turn.sequence, questionSource },
        metadata:
          isSensitive || reusedFromTurnId
            ? {
                ...(isSensitive ? { isSensitive: true, sensitiveCategory } : {}),
                ...(reusedFromTurnId ? { reusedFromTurnId } : {}),
              }
            : null,
      },
      now
    );
    if (reusedFromTurnId) {
      writeAudit(
        transaction,
        {
          sessionId,
          turnId: id,
          patientId: session.patientId,
          assistantId: assistant.id,
          eventType: "CONTENT_REUSED",
          previousValue: { sourceType: "TURN", sourceId: reusedFromTurnId },
          newValue: { targetType: "TURN", targetId: id, status: "DRAFT" },
        },
        now
      );
    }
    if (clientRequestId) {
      gravarLedger(
        transaction,
        sessionId,
        clientRequestId,
        {
          op: "createTurn",
          resultRef: { kind: "turn", id },
          assistantId: assistant.id,
          payloadFingerprint: fingerprint,
        },
        now
      );
    }
    return turn;
  });
}

/**
 * Aplica uma ação do assistente a uma interação: valida a sessão, valida a
 * transição na máquina de estados, checa as invariantes e grava turno +
 * evento de auditoria no MESMO commit.
 */
/**
 * A resposta que ESTA ação quer registrar. Só três ações carregam uma; as
 * demais (apresentar, cancelar, registrar ausência) não falam de resposta
 * nenhuma e por isso não podem divergir de uma.
 */
function respostaPretendida(action: TurnAction): SemanticResponse | null {
  return action.kind === "SELECT_RESPONSE" || action.kind === "CHANGE_RESPONSE"
    ? action.response
    : null;
}

/**
 * §10, caso 4 — "resposta alterada".
 *
 * A fronteira com o caso 11 é o que esta função existe para respeitar, e é
 * sutil: o servidor ter mudado NÃO é conflito por si só. O cuidador pode ter
 * reapresentado a pergunta noutro aparelho sem tocar em resposta alguma —
 * tratar isso como conflito encheria a tela de decisões vazias, e o cuidador
 * aprenderia a clicar sem ler, que é pior do que não ter tela.
 *
 * Conflito é quando o CONTEÚDO diverge: o servidor já tem uma resposta, e ela
 * não é a que esta ação quer registrar. Aí, e só aí, alguém precisa decidir —
 * porque uma das duas vai valer como o que o paciente comunicou.
 *
 * Sem `baseVersion` não há o que comparar: quem não manda segue com o
 * comportamento de sempre. É o que mantém compatível todo cliente online, que
 * está lendo o estado atual da tela e não precisa disto.
 */
function assertRespostaNaoMudou(
  turn: ConversationQuestionTurn,
  action: TurnAction,
  baseVersion: string | null
): void {
  if (!baseVersion || baseVersion === turn.updatedAt) return;

  const pretendida = respostaPretendida(action);
  if (!pretendida) return;

  // A confirmada pesa mais que a provisória: se o paciente já confirmou, é
  // ela que o cuidador precisa ver do outro lado da tela.
  const noServidor = turn.confirmedResponse ?? turn.provisionalResponse;
  if (!noServidor || noServidor === pretendida) return;

  throw new RtqConflictError(
    "RESPONSE_CHANGED",
    "a resposta registrada nesta pergunta mudou desde que você agiu",
    {
      serverStatus: turn.status,
      serverAt: turn.updatedAt,
      serverValue: noServidor,
    }
  );
}

export async function runTurnAction(
  patientId: number,
  sessionId: string,
  turnId: string,
  action: TurnAction,
  assistant: Assistant,
  clientRequestIdRaw?: unknown,
  baseVersionRaw?: unknown
): Promise<ConversationQuestionTurn> {
  const now = new Date().toISOString();
  const clientRequestId = requestIdOf(clientRequestIdRaw);
  const baseVersion =
    typeof baseVersionRaw === "string" && baseVersionRaw ? baseVersionRaw : null;
  return firestore.runTransaction(async (transaction) => {
    const sRef = sessionDoc(sessionId);
    const tRef = turnsCol(sessionId).doc(turnId);
    const [sDoc, tDoc, jaAplicada] = await Promise.all([
      transaction.get(sRef),
      transaction.get(tRef),
      lerLedger(transaction, sessionId, clientRequestId),
    ]);
    if (!sDoc.exists) throw new RtqDomainError("sessão não encontrada");
    const session = toSession(sDoc.id, sDoc.data()!);
    if (session.patientId !== patientId) {
      throw new RtqDomainError("sessão não encontrada");
    }
    if (!tDoc.exists) throw new RtqDomainError("pergunta não encontrada");
    const turn = toTurn(tDoc.id, tDoc.data()!);

    // G2: um reenvio da mesma ação devolve o turno como ficou da primeira
    // vez, em vez de reexecutar a transição (que na maioria dos casos seria
    // recusada pela máquina de estados como se fosse uma ação NOVA rejeitada
    // — indistinguível de "sua ação não foi aceita" para quem está sem rede)
    // ou, no caso de REMOVE_RESPONSE sobre frase, seria aceita de novo e
    // incrementaria `correctionCount` uma segunda vez.
    if (jaAplicada) return turn;

    // §10, caso 4 — a resposta mudou no servidor enquanto esta ação esperava
    // na fila. Vem DEPOIS do ledger de propósito: um reenvio da mesma
    // intenção não é conflito nenhum, e checar antes transformaria toda
    // retentativa numa tela de decisão.
    assertRespostaNaoMudou(turn, action, baseVersion);

    assertSessionAcceptsTurnAction(session.status, action.kind);
    const change = applyTurnAction(turn, action, now);

    transaction.set(tRef, change.patch, { merge: true });
    transaction.set(sRef, { updatedAt: now }, { merge: true });
    writeAudit(
      transaction,
      {
        sessionId,
        turnId,
        patientId: session.patientId,
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
        { op: `runTurnAction:${action.kind}`, resultRef: { kind: "turn", id: turnId }, assistantId: assistant.id },
        now
      );
    }
    return { ...turn, ...change.patch };
  });
}

export async function listTurns(
  patientId: number,
  sessionId: string
): Promise<ConversationQuestionTurn[] | null> {
  const session = await getRtqSession(patientId, sessionId);
  if (!session) return null;
  const snap = await turnsCol(sessionId).get();
  return snap.docs
    .map((d) => toTurn(d.id, d.data()))
    .sort((a, b) => a.sequence - b.sequence);
}

/**
 * Recortes da trilha. Todos são opcionais e se combinam por AND; sem nenhum,
 * vem a sessão inteira — perguntas fechadas e conversa por opções na mesma
 * ordem cronológica.
 */
export interface AuditFilter {
  turnId?: string | null;
  pathId?: string | null;
  nodeId?: string | null;
  statementId?: string | null;
}

/** Trilha de auditoria — somente leitura, em ordem cronológica. */
export async function listAuditEvents(
  patientId: number,
  sessionId: string,
  filter: AuditFilter = {}
): Promise<InteractionAuditEvent[] | null> {
  const session = await getRtqSession(patientId, sessionId);
  if (!session) return null;
  const snap = await eventsCol(sessionId).get();
  return snap.docs
    .map((d) => toEvent(d.id, d.data()))
    .filter(
      (e) =>
        (!filter.turnId || e.turnId === filter.turnId) &&
        (!filter.pathId || e.pathId === filter.pathId) &&
        (!filter.nodeId || e.nodeId === filter.nodeId) &&
        (!filter.statementId || e.statementId === filter.statementId)
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

// ---------- Configuração: sinal → resposta semântica ----------

export async function getResponseProfile(
  patientId: number
): Promise<PatientResponseProfile> {
  const doc = await responseProfileDoc(patientId).get();
  if (!doc.exists) {
    return {
      patientId,
      mappings: [...DEFAULT_RESPONSE_MAPPINGS],
      updatedByUserId: null,
      updatedAt: "",
    };
  }
  const v = doc.data()!;
  const mappings = Array.isArray(v.mappings)
    ? (v.mappings as ResponseSignalMapping[])
    : [...DEFAULT_RESPONSE_MAPPINGS];
  return {
    patientId,
    mappings,
    updatedByUserId: (v.updatedByUserId as string) ?? null,
    updatedAt: String(v.updatedAt ?? ""),
  };
}

/**
 * Grava o mapeamento sinal físico → resposta semântica do paciente. Cada uma
 * das três respostas precisa ter exatamente um sinal: o assistente não pode
 * ficar sem como registrar SIM, TALVEZ ou NÃO, nem com dois sinais
 * significando a mesma coisa.
 *
 * Isto NÃO altera o significado dos gestos fora deste modo.
 */
export async function setResponseProfile(
  patientId: number,
  rawMappings: unknown,
  user: { id: string }
): Promise<PatientResponseProfile> {
  if (!Array.isArray(rawMappings)) {
    throw new RtqDomainError("mapeamento inválido");
  }
  const mappings: ResponseSignalMapping[] = [];
  const seenSignals = new Set<string>();
  const seenResponses = new Set<SemanticResponse>();
  for (const raw of rawMappings) {
    const m = raw as Partial<ResponseSignalMapping>;
    if (!isResponseInputMethod(m.method)) {
      throw new RtqDomainError("método de entrada inválido");
    }
    if (m.method !== "GESTURE") {
      // Os demais métodos existem no modelo, mas não são configuráveis nesta
      // fase — o sistema ainda não detecta nenhum sinal automaticamente.
      throw new RtqDomainError(
        `método ${m.method} ainda não disponível nesta fase`
      );
    }
    const signalKey = cleanText(m.signalKey, MAX_SIGNAL_KEY_LEN);
    if (!signalKey) throw new RtqDomainError("sinal sem identificador");
    if (!isSemanticResponse(m.response)) {
      throw new RtqDomainError("resposta semântica inválida");
    }
    const key = `${m.method}:${signalKey}`;
    if (seenSignals.has(key)) {
      throw new RtqDomainError(`sinal repetido: ${signalKey}`);
    }
    if (seenResponses.has(m.response)) {
      throw new RtqDomainError(`resposta repetida: ${m.response}`);
    }
    seenSignals.add(key);
    seenResponses.add(m.response);
    mappings.push({
      method: m.method,
      signalKey,
      label: cleanText(m.label, MAX_LABEL_LEN) || signalKey,
      response: m.response,
    });
  }
  if (seenResponses.size !== 3) {
    throw new RtqDomainError(
      "o mapeamento precisa cobrir SIM, TALVEZ e NÃO"
    );
  }

  const now = new Date().toISOString();
  await responseProfileDoc(patientId).set({
    patientId,
    mappings,
    updatedByUserId: user.id,
    updatedAt: now,
  });
  return { patientId, mappings, updatedByUserId: user.id, updatedAt: now };
}
