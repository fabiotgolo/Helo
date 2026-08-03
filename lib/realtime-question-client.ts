"use client";

// ——— Perguntas em tempo real: ponte única entre a interface e o servidor ———
//
// NENHUM componente do modo chama fetch diretamente. Tudo passa por aqui, e é
// isto que garante as regras da seção 17:
//
//   - as escritas são SERIALIZADAS numa fila: a ordem em que o assistente
//     agiu é a ordem em que o servidor recebe;
//   - cliques repetidos na MESMA ação com o MESMO conteúdo são deduplicados —
//     as duas chamadas compartilham a requisição em voo, e o servidor recebe
//     uma só;
//   - um contador de operações pendentes alimenta o indicador "Registrando…";
//   - o erro é traduzido para a linguagem do cuidador, sem código técnico.
//
// Este módulo não define nenhum tipo de domínio: ele reusa as entidades e as
// ações das Fases 1 e 2.

import { useCallback, useMemo, useRef, useState } from "react";
import type { SessionAction, TurnAction } from "@/lib/realtime-question-machine";
import type { SessionContextVersion } from "@/lib/session-context-types";
import type { PatientControlRequest } from "@/lib/patient-control-types";
import type { PatientControlAction } from "@/lib/patient-control-machine";
import type {
  NodeAction,
  PathAction,
  StatementAction,
} from "@/lib/option-conversation-machine";
import type {
  OptionConversationFinalStatement,
  OptionConversationNode,
  OptionConversationPath,
  PathDetail,
} from "@/lib/option-conversation-types";
import type {
  ConversationQuestionSession,
  ConversationQuestionTurn,
  PatientResponseProfile,
  QuestionSource,
  SensitiveCategory,
} from "@/lib/realtime-question-types";

const BASE = "/api/realtime-questions";

/**
 * Natureza da falha — a interface decide o que fazer com cada uma:
 *   offline/unknown → oferecer nova tentativa, preservando o que foi digitado;
 *   conflict/notFound → recarregar o estado persistido antes de continuar;
 *   unauthorized → mandar o operador entrar de novo.
 */
export type RtqErrorKind =
  | "offline"
  | "unauthorized"
  | "conflict"
  | "notFound"
  | "unknown";

export class RtqClientError extends Error {
  readonly kind: RtqErrorKind;
  constructor(kind: RtqErrorKind, message: string) {
    super(message);
    this.name = "RtqClientError";
    this.kind = kind;
  }
}

/** O que a tela envia ao abrir os controles do paciente. */
export interface OpenControlInput {
  clientRequestId: string;
  /** O que está no ar agora — alvo de REPETIR e de MUDAR DE ASSUNTO. */
  targetType?: "TURN" | "NODE" | "STATEMENT" | null;
  targetId?: string | null;
  targetPathId?: string | null;
}

/** O que a execução de um comando tocou — a tela substitui o que recebeu. */
export interface ControlActionResult {
  request: PatientControlRequest;
  turn?: ConversationQuestionTurn | null;
  node?: OptionConversationNode | null;
  statement?: OptionConversationFinalStatement | null;
  path?: OptionConversationPath | null;
  sessionStatus?: "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED" | null;
}

/** O que a tela envia ao registrar uma interpretação do cuidador. */
export interface CaregiverInterpretationInput {
  clientRequestId: string;
  text: string;
  isSensitive?: boolean;
  sensitiveCategory?: SensitiveCategory | null;
}

/**
 * O que a tela envia ao gravar o contexto. Só conteúdo: versão, status,
 * autoria e horário nascem no servidor.
 */
export interface SessionContextInput {
  clientRequestId: string;
  skipped?: boolean;
  interlocutorPersonId?: number | null;
  interlocutorName?: string | null;
  interlocutorRelation?: string | null;
  intention?: string | null;
  environment?: string | null;
  initialTopic?: string | null;
  notes?: string | null;
}

export interface SessionDetail {
  session: ConversationQuestionSession;
  turns: ConversationQuestionTurn[];
  /**
   * Contexto vigente da conversa (Fase 4.8), na MESMA leitura da sessão: a
   * tela precisa saber, já na abertura, se o cuidador ainda não decidiu entre
   * preencher e pular. `null` = nunca decidiu.
   */
  context: SessionContextVersion | null;
  /**
   * Painel de controles ainda aberto (Fase 4.7). A tela do painel é derivada
   * daqui, então um refresh no meio da seleção provisória do paciente volta
   * exatamente na seleção provisória.
   */
  controlRequest: PatientControlRequest | null;
}

// ---------- Requisição e tradução de erro ----------

async function request<T>(
  path: string,
  init?: Omit<RequestInit, "body"> & { body?: unknown }
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
      keepalive: init?.keepalive,
    });
  } catch {
    throw new RtqClientError(
      "offline",
      "Sem conexão com o Helo. O registro não foi salvo."
    );
  }

  if (response.ok) return (await response.json()) as T;

  // As mensagens do domínio já são frases em português escritas para quem
  // opera ("sessão pausada: retome a sessão antes de registrar respostas").
  // Nunca expomos status HTTP nem stack.
  const detail = (await response
    .json()
    .catch(() => null)) as { error?: string } | null;

  if (response.status === 401) {
    throw new RtqClientError(
      "unauthorized",
      "Sua sessão expirou. Entre novamente para continuar."
    );
  }
  if (response.status === 403) {
    throw new RtqClientError(
      "unauthorized",
      "Você não tem autorização para registrar nesta sessão."
    );
  }
  if (response.status === 404) {
    throw new RtqClientError(
      "notFound",
      "Não encontramos esta sessão. Ela pode ter sido encerrada em outro dispositivo."
    );
  }
  if (response.status === 400) {
    throw new RtqClientError(
      "conflict",
      detail?.error ?? "Esta ação não é possível no estado atual da sessão."
    );
  }
  throw new RtqClientError(
    "unknown",
    "Não foi possível registrar agora. Tente novamente."
  );
}

// ---------- Operações (espelham as rotas das Fases 1 e 2) ----------

export interface NewTurnInput {
  text: string;
  questionSource?: QuestionSource;
  isSensitive?: boolean;
  sensitiveCategory?: SensitiveCategory | null;
  /** Pergunta criada a partir de outra, pelo histórico (§24). */
  reusedFromTurnId?: string | null;
}

/** Uma opção como o assistente a escreve — o servidor posiciona e valida. */
export interface OptionDraft {
  label: string;
  isTerminal?: boolean;
  finalStatementDraft?: string | null;
  isSensitive?: boolean;
  sensitiveCategory?: SensitiveCategory | null;
}

export interface NewNodeInput {
  promptText: string;
  options: OptionDraft[];
  parentNodeId?: string | null;
  isSensitive?: boolean;
  sensitiveCategory?: SensitiveCategory | null;
  clientRequestId: string;
}

export interface ReviewNodeDraft {
  promptText?: string;
  options?: OptionDraft[];
  isSensitive?: boolean;
  sensitiveCategory?: SensitiveCategory | null;
}

export interface NewStatementInput {
  text: string;
  originNodeId?: string | null;
  isSensitive?: boolean;
  sensitiveCategory?: SensitiveCategory | null;
  clientRequestId: string;
}

export type HistoryItemType = "TURN" | "PATH" | "NODE" | "STATEMENT";

const api = {
  /** Mapeamento sinal observável → resposta semântica, por paciente. */
  responseProfile: (patientId: number) =>
    request<{ profile: PatientResponseProfile }>(
      `/response-profile?patientId=${patientId}`
    ).then((d) => d.profile),

  listSessions: (patientId: number) =>
    request<{ sessions: ConversationQuestionSession[] }>(
      `/sessions?patientId=${patientId}`
    ).then((d) => d.sessions),

  sessionDetail: (patientId: number, sessionId: string) =>
    request<SessionDetail>(
      `/sessions?patientId=${patientId}&sessionId=${encodeURIComponent(sessionId)}`
    ),

  createSession: (patientId: number) =>
    request<{ session: ConversationQuestionSession }>("/sessions", {
      method: "POST",
      body: { patientId },
    }).then((d) => d.session),

  /** Interpretação do cuidador + seu contêiner, numa chamada (Fase 4.2). */
  createCaregiverInterpretation: (
    patientId: number,
    sessionId: string,
    input: CaregiverInterpretationInput
  ) =>
    request<{
      path: OptionConversationPath;
      statement: OptionConversationFinalStatement;
    }>("/statements", {
      method: "POST",
      body: {
        patientId,
        sessionId,
        origin: "CAREGIVER_INTERPRETATION",
        ...input,
      },
    }),

  // ——— Controles do paciente (Fase 4.7) ———

  patientControl: (patientId: number, sessionId: string) =>
    request<{ request: PatientControlRequest | null }>(
      `/patient-controls?patientId=${patientId}&sessionId=${encodeURIComponent(sessionId)}`
    ).then((d) => d.request),

  openPatientControl: (
    patientId: number,
    sessionId: string,
    input: OpenControlInput
  ) =>
    request<{ request: PatientControlRequest }>("/patient-controls", {
      method: "POST",
      body: { patientId, sessionId, ...input },
    }).then((d) => d.request),

  patientControlAction: (
    patientId: number,
    sessionId: string,
    requestId: string,
    action: PatientControlAction
  ) =>
    request<ControlActionResult>("/patient-controls", {
      method: "PATCH",
      body: { patientId, sessionId, requestId, action },
    }),

  // ——— Contexto da conversa (Fase 4.8) ———

  sessionContext: (patientId: number, sessionId: string) =>
    request<{ context: SessionContextVersion | null }>(
      `/session-context?patientId=${patientId}&sessionId=${encodeURIComponent(sessionId)}`
    ).then((d) => d.context),

  sessionContextVersions: (patientId: number, sessionId: string) =>
    request<{ versions: SessionContextVersion[] }>(
      `/session-context?patientId=${patientId}&sessionId=${encodeURIComponent(sessionId)}&all=1`
    ).then((d) => d.versions),

  saveSessionContext: (
    patientId: number,
    sessionId: string,
    input: SessionContextInput
  ) =>
    request<{ context: SessionContextVersion }>("/session-context", {
      method: "POST",
      body: { patientId, sessionId, ...input },
    }).then((d) => d.context),

  openSessionContext: (
    patientId: number,
    sessionId: string,
    contextId: string
  ) =>
    request<{ ok: true }>("/session-context", {
      method: "PUT",
      body: { patientId, sessionId, contextId },
    }),

  sessionAction: (
    patientId: number,
    sessionId: string,
    action: SessionAction
  ) =>
    request<{ session: ConversationQuestionSession }>("/sessions", {
      method: "PATCH",
      body: { patientId, sessionId, action },
    }).then((d) => d.session),

  createTurn: (patientId: number, sessionId: string, input: NewTurnInput) =>
    request<{ turn: ConversationQuestionTurn }>("/turns", {
      method: "POST",
      body: {
        patientId,
        sessionId,
        text: input.text,
        questionSource: input.questionSource ?? "MANUAL_TEXT",
        isSensitive: input.isSensitive ?? false,
        sensitiveCategory: input.sensitiveCategory ?? undefined,
        reusedFromTurnId: input.reusedFromTurnId ?? undefined,
      },
    }).then((d) => d.turn),

  turnAction: (
    patientId: number,
    sessionId: string,
    turnId: string,
    action: TurnAction
  ) =>
    request<{ turn: ConversationQuestionTurn }>("/turns", {
      method: "PATCH",
      body: { patientId, sessionId, turnId, action },
    }).then((d) => d.turn),

  // ——— Conversa por opções ———
  // As mesmas rotas, a mesma fila e a mesma tradução de erro. Nada de uma
  // segunda ponte: duas filas dariam duas ordens possíveis para as ações do
  // assistente, e a ordem é justamente o que precisamos preservar.

  pathDetails: (patientId: number, sessionId: string) =>
    request<{ details: PathDetail[] }>(
      `/paths?patientId=${patientId}&sessionId=${encodeURIComponent(sessionId)}&detail=1`
    ).then((d) => d.details),

  pathDetail: (patientId: number, sessionId: string, pathId: string) =>
    request<PathDetail>(
      `/paths?patientId=${patientId}&sessionId=${encodeURIComponent(
        sessionId
      )}&pathId=${encodeURIComponent(pathId)}`
    ),

  createPath: (patientId: number, sessionId: string, clientRequestId: string) =>
    request<{ path: OptionConversationPath }>("/paths", {
      method: "POST",
      body: { patientId, sessionId, clientRequestId },
    }).then((d) => d.path),

  pathAction: (
    patientId: number,
    sessionId: string,
    pathId: string,
    action: PathAction
  ) =>
    request<{ path: OptionConversationPath }>("/paths", {
      method: "PATCH",
      body: { patientId, sessionId, pathId, action },
    }).then((d) => d.path),

  /** Volta a um nível anterior e abre a nova ramificação, numa operação só. */
  returnToLevel: (
    patientId: number,
    sessionId: string,
    pathId: string,
    nodeId: string,
    clientRequestId: string
  ) =>
    request<PathDetail>("/paths", {
      method: "PATCH",
      body: {
        patientId,
        sessionId,
        pathId,
        returnToNodeId: nodeId,
        clientRequestId,
      },
    }),

  restartPath: (
    patientId: number,
    sessionId: string,
    pathId: string,
    clientRequestId: string
  ) =>
    request<{
      previous: OptionConversationPath;
      created: OptionConversationPath;
    }>("/paths", {
      method: "PATCH",
      body: {
        patientId,
        sessionId,
        pathId,
        action: { kind: "RESTART" },
        clientRequestId,
      },
    }),

  createNode: (
    patientId: number,
    sessionId: string,
    pathId: string,
    input: NewNodeInput
  ) =>
    request<{ node: OptionConversationNode }>("/nodes", {
      method: "POST",
      body: { patientId, sessionId, pathId, ...input },
    }).then((d) => d.node),

  nodeAction: (
    patientId: number,
    sessionId: string,
    pathId: string,
    nodeId: string,
    action: NodeAction
  ) =>
    request<{ node: OptionConversationNode; path: OptionConversationPath }>(
      "/nodes",
      {
        method: "PATCH",
        body: { patientId, sessionId, pathId, nodeId, action },
      }
    ),

  /** Edição do rascunho — mesmo registro (§27). */
  reviewNode: (
    patientId: number,
    sessionId: string,
    pathId: string,
    nodeId: string,
    input: ReviewNodeDraft
  ) =>
    request<{ node: OptionConversationNode }>("/nodes", {
      method: "PATCH",
      body: {
        patientId,
        sessionId,
        pathId,
        nodeId,
        action: { kind: "REVIEW", ...input },
      },
    }).then((d) => d.node),

  /** Versão corrigida de um nível já apresentado (§28, §29). */
  replaceNode: (
    patientId: number,
    sessionId: string,
    pathId: string,
    nodeId: string,
    clientRequestId: string
  ) =>
    request<{
      original: OptionConversationNode;
      created: OptionConversationNode;
    }>("/nodes", {
      method: "POST",
      body: {
        patientId,
        sessionId,
        pathId,
        replaceNodeId: nodeId,
        clientRequestId,
      },
    }),

  createStatement: (
    patientId: number,
    sessionId: string,
    pathId: string,
    input: NewStatementInput
  ) =>
    request<{ statement: OptionConversationFinalStatement }>("/statements", {
      method: "POST",
      body: { patientId, sessionId, pathId, ...input },
    }).then((d) => d.statement),

  statementAction: (
    patientId: number,
    sessionId: string,
    pathId: string,
    statementId: string,
    action: StatementAction | { kind: "REJECT" }
  ) =>
    request<{
      statement: OptionConversationFinalStatement;
      path: OptionConversationPath;
    }>("/statements", {
      method: "PATCH",
      body: { patientId, sessionId, pathId, statementId, action },
    }),

  replaceStatement: (
    patientId: number,
    sessionId: string,
    pathId: string,
    statementId: string,
    clientRequestId: string
  ) =>
    request<{
      original: OptionConversationFinalStatement;
      created: OptionConversationFinalStatement;
    }>("/statements", {
      method: "POST",
      body: {
        patientId,
        sessionId,
        pathId,
        replaceStatementId: statementId,
        clientRequestId,
      },
    }),

  // ——— Reutilização pelo histórico (§24, §25) ———

  reuseNode: (
    patientId: number,
    sessionId: string,
    nodeId: string,
    clientRequestId: string,
    targetPathId?: string | null
  ) =>
    request<{ path: OptionConversationPath; node: OptionConversationNode }>(
      "/nodes",
      {
        method: "POST",
        body: {
          patientId,
          sessionId,
          reuseFromNodeId: nodeId,
          pathId: targetPathId ?? undefined,
          clientRequestId,
        },
      }
    ),

  reuseStatement: (
    patientId: number,
    sessionId: string,
    statementId: string,
    clientRequestId: string,
    targetPathId?: string | null
  ) =>
    request<{
      path: OptionConversationPath;
      statement: OptionConversationFinalStatement;
    }>("/statements", {
      method: "POST",
      body: {
        patientId,
        sessionId,
        reuseFromStatementId: statementId,
        pathId: targetPathId ?? undefined,
        clientRequestId,
      },
    }),

  reusePath: (
    patientId: number,
    sessionId: string,
    pathId: string,
    clientRequestId: string
  ) =>
    request<{
      path: OptionConversationPath;
      node: OptionConversationNode | null;
    }>("/paths", {
      method: "POST",
      body: { patientId, sessionId, reuseFromPathId: pathId, clientRequestId },
    }),

  /** Registra a CONSULTA de um item do histórico. Não altera nada (§22). */
  openHistoryItem: (
    patientId: number,
    sessionId: string,
    itemType: HistoryItemType,
    itemId: string,
    pathId?: string | null
  ) =>
    request<{ ok: true }>("/paths", {
      method: "PUT",
      body: { patientId, sessionId, itemType, itemId, pathId: pathId ?? null },
    }),
};

/**
 * Encerramento em `beforeunload`. Fecha a sessão como PAUSADA — nunca
 * concluída nem abandonada: pausar é recuperável e não perde nada, enquanto
 * abandonar é uma declaração que cabe ao assistente fazer na tela.
 */
export function pauseOnUnload(patientId: number, sessionId: string): void {
  // fetch + keepalive (padrão do activity-player). sendBeacon não serve: ele
  // só emite POST, e POST /sessions CRIA uma sessão — pausar é PATCH.
  void fetch(`${BASE}/sessions`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patientId, sessionId, action: "PAUSE" }),
    keepalive: true,
  }).catch(() => {
    // Sair da página nunca pode falhar por causa do registro.
  });
}

// ---------- Hook: fila serializada, deduplicação e estado de gravação ----------

export interface RtqPersistence {
  /** Há alguma gravação em voo — alimenta o indicador "Registrando…". */
  saving: boolean;
  /** Última falha ainda não resolvida. */
  error: RtqClientError | null;
  clearError: () => void;
  responseProfile: (patientId: number) => Promise<PatientResponseProfile>;
  listSessions: (patientId: number) => Promise<ConversationQuestionSession[]>;
  sessionDetail: (patientId: number, sessionId: string) => Promise<SessionDetail>;
  createSession: (patientId: number) => Promise<ConversationQuestionSession>;
  sessionAction: (
    patientId: number,
    sessionId: string,
    action: SessionAction
  ) => Promise<ConversationQuestionSession>;
  createCaregiverInterpretation: (
    patientId: number,
    sessionId: string,
    input: CaregiverInterpretationInput
  ) => Promise<{
    path: OptionConversationPath;
    statement: OptionConversationFinalStatement;
  }>;
  patientControl: (
    patientId: number,
    sessionId: string
  ) => Promise<PatientControlRequest | null>;
  openPatientControl: (
    patientId: number,
    sessionId: string,
    input: OpenControlInput
  ) => Promise<PatientControlRequest>;
  patientControlAction: (
    patientId: number,
    sessionId: string,
    requestId: string,
    action: PatientControlAction
  ) => Promise<ControlActionResult>;
  sessionContext: (
    patientId: number,
    sessionId: string
  ) => Promise<SessionContextVersion | null>;
  sessionContextVersions: (
    patientId: number,
    sessionId: string
  ) => Promise<SessionContextVersion[]>;
  saveSessionContext: (
    patientId: number,
    sessionId: string,
    input: SessionContextInput
  ) => Promise<SessionContextVersion>;
  openSessionContext: (
    patientId: number,
    sessionId: string,
    contextId: string
  ) => Promise<{ ok: true }>;
  createTurn: (
    patientId: number,
    sessionId: string,
    input: NewTurnInput
  ) => Promise<ConversationQuestionTurn>;
  turnAction: (
    patientId: number,
    sessionId: string,
    turnId: string,
    action: TurnAction
  ) => Promise<ConversationQuestionTurn>;

  // ——— Conversa por opções ———
  pathDetails: (patientId: number, sessionId: string) => Promise<PathDetail[]>;
  pathDetail: (
    patientId: number,
    sessionId: string,
    pathId: string
  ) => Promise<PathDetail>;
  createPath: (
    patientId: number,
    sessionId: string,
    clientRequestId: string
  ) => Promise<OptionConversationPath>;
  pathAction: (
    patientId: number,
    sessionId: string,
    pathId: string,
    action: PathAction
  ) => Promise<OptionConversationPath>;
  returnToLevel: (
    patientId: number,
    sessionId: string,
    pathId: string,
    nodeId: string,
    clientRequestId: string
  ) => Promise<PathDetail>;
  restartPath: (
    patientId: number,
    sessionId: string,
    pathId: string,
    clientRequestId: string
  ) => Promise<{
    previous: OptionConversationPath;
    created: OptionConversationPath;
  }>;
  createNode: (
    patientId: number,
    sessionId: string,
    pathId: string,
    input: NewNodeInput
  ) => Promise<OptionConversationNode>;
  nodeAction: (
    patientId: number,
    sessionId: string,
    pathId: string,
    nodeId: string,
    action: NodeAction
  ) => Promise<{
    node: OptionConversationNode;
    path: OptionConversationPath;
  }>;
  reviewNode: (
    patientId: number,
    sessionId: string,
    pathId: string,
    nodeId: string,
    input: ReviewNodeDraft
  ) => Promise<OptionConversationNode>;
  replaceNode: (
    patientId: number,
    sessionId: string,
    pathId: string,
    nodeId: string,
    clientRequestId: string
  ) => Promise<{
    original: OptionConversationNode;
    created: OptionConversationNode;
  }>;
  createStatement: (
    patientId: number,
    sessionId: string,
    pathId: string,
    input: NewStatementInput
  ) => Promise<OptionConversationFinalStatement>;
  statementAction: (
    patientId: number,
    sessionId: string,
    pathId: string,
    statementId: string,
    action: StatementAction | { kind: "REJECT" }
  ) => Promise<{
    statement: OptionConversationFinalStatement;
    path: OptionConversationPath;
  }>;
  replaceStatement: (
    patientId: number,
    sessionId: string,
    pathId: string,
    statementId: string,
    clientRequestId: string
  ) => Promise<{
    original: OptionConversationFinalStatement;
    created: OptionConversationFinalStatement;
  }>;
  reuseNode: (
    patientId: number,
    sessionId: string,
    nodeId: string,
    clientRequestId: string,
    targetPathId?: string | null
  ) => Promise<{
    path: OptionConversationPath;
    node: OptionConversationNode;
  }>;
  reuseStatement: (
    patientId: number,
    sessionId: string,
    statementId: string,
    clientRequestId: string,
    targetPathId?: string | null
  ) => Promise<{
    path: OptionConversationPath;
    statement: OptionConversationFinalStatement;
  }>;
  reusePath: (
    patientId: number,
    sessionId: string,
    pathId: string,
    clientRequestId: string
  ) => Promise<{
    path: OptionConversationPath;
    node: OptionConversationNode | null;
  }>;
  openHistoryItem: (
    patientId: number,
    sessionId: string,
    itemType: HistoryItemType,
    itemId: string,
    pathId?: string | null
  ) => Promise<{ ok: true }>;
}

export function useRtqPersistence(): RtqPersistence {
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<RtqClientError | null>(null);
  // Fila: cada escrita só começa quando a anterior termina, então o servidor
  // recebe as ações na ordem em que o assistente agiu.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  // Requisições idênticas ainda em voo — o segundo clique reaproveita a
  // primeira promessa em vez de gravar de novo.
  const inflight = useRef(new Map<string, Promise<unknown>>());

  const run = useCallback(
    <T,>(key: string, op: () => Promise<T>, queued: boolean): Promise<T> => {
      const existing = inflight.current.get(key);
      if (existing) return existing as Promise<T>;

      setPending((n) => n + 1);
      const started = queued
        ? chain.current.then(op, op) // a falha anterior não trava a fila
        : op();
      const tracked = started
        .catch((e: unknown) => {
          const err =
            e instanceof RtqClientError
              ? e
              : new RtqClientError(
                  "unknown",
                  "Não foi possível registrar agora. Tente novamente."
                );
          setError(err);
          throw err;
        })
        .finally(() => {
          inflight.current.delete(key);
          setPending((n) => Math.max(0, n - 1));
        });

      inflight.current.set(key, tracked);
      // A fila não pode parar numa falha: encadeamos a versão silenciada.
      if (queued) chain.current = tracked.catch(() => undefined);
      return tracked;
    },
    []
  );

  return useMemo<RtqPersistence>(
    () => ({
      saving: pending > 0,
      error,
      clearError: () => setError(null),

      // Leituras não entram na fila — consultar não pode esperar gravação.
      responseProfile: (patientId) =>
        run(`profile:${patientId}`, () => api.responseProfile(patientId), false),
      listSessions: (patientId) =>
        run(`list:${patientId}`, () => api.listSessions(patientId), false),
      sessionDetail: (patientId, sessionId) =>
        run(
          `detail:${patientId}:${sessionId}`,
          () => api.sessionDetail(patientId, sessionId),
          false
        ),

      patientControl: (patientId, sessionId) =>
        run(
          `ctrl:${patientId}:${sessionId}`,
          () => api.patientControl(patientId, sessionId),
          false
        ),
      openPatientControl: (patientId, sessionId, input) =>
        run(
          `ctrlOpen:${sessionId}:${input.clientRequestId}`,
          () => api.openPatientControl(patientId, sessionId, input),
          true
        ),
      patientControlAction: (patientId, sessionId, requestId, action) =>
        run(
          `ctrlAct:${requestId}:${JSON.stringify(action)}`,
          () => api.patientControlAction(patientId, sessionId, requestId, action),
          true
        ),
      sessionContext: (patientId, sessionId) =>
        run(
          `ctx:${patientId}:${sessionId}`,
          () => api.sessionContext(patientId, sessionId),
          false
        ),
      sessionContextVersions: (patientId, sessionId) =>
        run(
          `ctxAll:${patientId}:${sessionId}`,
          () => api.sessionContextVersions(patientId, sessionId),
          false
        ),
      openSessionContext: (patientId, sessionId, contextId) =>
        run(
          `ctxOpen:${sessionId}:${contextId}`,
          () => api.openSessionContext(patientId, sessionId, contextId),
          false
        ),

      createSession: (patientId) =>
        run(`newSession:${patientId}`, () => api.createSession(patientId), true),
      sessionAction: (patientId, sessionId, action) =>
        run(
          `session:${sessionId}:${action}`,
          () => api.sessionAction(patientId, sessionId, action),
          true
        ),
      createCaregiverInterpretation: (patientId, sessionId, input) =>
        run(
          `interp:${sessionId}:${input.clientRequestId}`,
          () => api.createCaregiverInterpretation(patientId, sessionId, input),
          true
        ),
      saveSessionContext: (patientId, sessionId, input) =>
        run(
          // O clientRequestId entra na chave: um segundo clique no MESMO botão
          // compartilha a requisição em voo, e o servidor dedupica o resto.
          `ctxSave:${sessionId}:${input.clientRequestId}`,
          () => api.saveSessionContext(patientId, sessionId, input),
          true
        ),
      createTurn: (patientId, sessionId, input) =>
        run(
          // O texto entra na chave: reenviar a MESMA pergunta é clique
          // duplicado; uma pergunta diferente é intenção nova.
          `newTurn:${sessionId}:${input.text}`,
          () => api.createTurn(patientId, sessionId, input),
          true
        ),
      turnAction: (patientId, sessionId, turnId, action) =>
        run(
          `turn:${turnId}:${JSON.stringify(action)}`,
          () => api.turnAction(patientId, sessionId, turnId, action),
          true
        ),

      // ——— Conversa por opções ———
      // Leituras fora da fila; escritas dentro dela, com a chave carregando o
      // `clientRequestId` quando existe — assim o clique repetido é barrado
      // duas vezes: aqui (mesma requisição em voo) e no servidor (mesmo id).

      pathDetails: (patientId, sessionId) =>
        run(
          `paths:${patientId}:${sessionId}`,
          () => api.pathDetails(patientId, sessionId),
          false
        ),
      pathDetail: (patientId, sessionId, pathId) =>
        run(
          `path:${patientId}:${sessionId}:${pathId}`,
          () => api.pathDetail(patientId, sessionId, pathId),
          false
        ),

      createPath: (patientId, sessionId, clientRequestId) =>
        run(
          `newPath:${sessionId}:${clientRequestId}`,
          () => api.createPath(patientId, sessionId, clientRequestId),
          true
        ),
      pathAction: (patientId, sessionId, pathId, action) =>
        run(
          `pathAction:${pathId}:${JSON.stringify(action)}`,
          () => api.pathAction(patientId, sessionId, pathId, action),
          true
        ),
      returnToLevel: (patientId, sessionId, pathId, nodeId, clientRequestId) =>
        run(
          `return:${pathId}:${clientRequestId}`,
          () =>
            api.returnToLevel(
              patientId,
              sessionId,
              pathId,
              nodeId,
              clientRequestId
            ),
          true
        ),
      restartPath: (patientId, sessionId, pathId, clientRequestId) =>
        run(
          `restart:${pathId}:${clientRequestId}`,
          () => api.restartPath(patientId, sessionId, pathId, clientRequestId),
          true
        ),

      createNode: (patientId, sessionId, pathId, input) =>
        run(
          `newNode:${pathId}:${input.clientRequestId}`,
          () => api.createNode(patientId, sessionId, pathId, input),
          true
        ),
      nodeAction: (patientId, sessionId, pathId, nodeId, action) =>
        run(
          `node:${nodeId}:${JSON.stringify(action)}`,
          () => api.nodeAction(patientId, sessionId, pathId, nodeId, action),
          true
        ),
      reviewNode: (patientId, sessionId, pathId, nodeId, input) =>
        run(
          `reviewNode:${nodeId}:${JSON.stringify(input)}`,
          () => api.reviewNode(patientId, sessionId, pathId, nodeId, input),
          true
        ),
      replaceNode: (patientId, sessionId, pathId, nodeId, clientRequestId) =>
        run(
          `replaceNode:${nodeId}:${clientRequestId}`,
          () =>
            api.replaceNode(
              patientId,
              sessionId,
              pathId,
              nodeId,
              clientRequestId
            ),
          true
        ),

      createStatement: (patientId, sessionId, pathId, input) =>
        run(
          `newStatement:${pathId}:${input.clientRequestId}`,
          () => api.createStatement(patientId, sessionId, pathId, input),
          true
        ),
      statementAction: (patientId, sessionId, pathId, statementId, action) =>
        run(
          `statement:${statementId}:${JSON.stringify(action)}`,
          () =>
            api.statementAction(
              patientId,
              sessionId,
              pathId,
              statementId,
              action
            ),
          true
        ),
      replaceStatement: (
        patientId,
        sessionId,
        pathId,
        statementId,
        clientRequestId
      ) =>
        run(
          `replaceStatement:${statementId}:${clientRequestId}`,
          () =>
            api.replaceStatement(
              patientId,
              sessionId,
              pathId,
              statementId,
              clientRequestId
            ),
          true
        ),

      reuseNode: (patientId, sessionId, nodeId, clientRequestId, targetPathId) =>
        run(
          `reuseNode:${nodeId}:${clientRequestId}`,
          () =>
            api.reuseNode(
              patientId,
              sessionId,
              nodeId,
              clientRequestId,
              targetPathId
            ),
          true
        ),
      reuseStatement: (
        patientId,
        sessionId,
        statementId,
        clientRequestId,
        targetPathId
      ) =>
        run(
          `reuseStatement:${statementId}:${clientRequestId}`,
          () =>
            api.reuseStatement(
              patientId,
              sessionId,
              statementId,
              clientRequestId,
              targetPathId
            ),
          true
        ),
      reusePath: (patientId, sessionId, pathId, clientRequestId) =>
        run(
          `reusePath:${pathId}:${clientRequestId}`,
          () => api.reusePath(patientId, sessionId, pathId, clientRequestId),
          true
        ),

      // Abrir um item nunca altera dados: fica FORA da fila, para não atrasar
      // nenhuma gravação de verdade.
      openHistoryItem: (patientId, sessionId, itemType, itemId, pathId) =>
        run(
          `open:${itemType}:${itemId}`,
          () =>
            api.openHistoryItem(patientId, sessionId, itemType, itemId, pathId),
          false
        ),
    }),
    [pending, error, run]
  );
}

/**
 * Identificador de intenção para as criações. Estável por gesto do assistente:
 * o mesmo botão clicado duas vezes precisa carregar o MESMO id, senão o
 * servidor entende como duas intenções diferentes e cria dois registros.
 */
export function newRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}
