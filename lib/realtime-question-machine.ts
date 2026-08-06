// ——— Perguntas em tempo real: máquina de estados ———
// Módulo PURO (sem Firestore, sem React): é o ponto ÚNICO onde o estado de
// uma sessão ou de uma interação muda. Nenhum componente, rota ou serviço
// escreve `status` diretamente — todos passam por applySessionAction /
// applyTurnAction, que devolvem o novo estado, o patch e o evento de
// auditoria correspondente. Transição inválida lança e nada é gravado.
//
// A API é orientada a AÇÃO, não a estado: quem chama diz o que o assistente
// fez ("conferi a seleção"), nunca para onde a interação deve ir. É assim que
// a regra "pergunta sensível exige reconfirmação" não pode ser burlada pelo
// cliente.

import {
  assertTurnInvariants,
  isSemanticResponse,
  isSensitiveCategory,
  isTerminalSessionStatus,
  RtqConflictError,
  RtqDomainError,
  type ConversationQuestionTurn,
  type InteractionEventType,
  type RtqSessionStatus,
  type RtqTurnStatus,
  type SemanticResponse,
  type SensitiveCategory,
} from "@/lib/realtime-question-types";

// ---------- Sessão ----------

export type SessionAction = "PAUSE" | "RESUME" | "COMPLETE" | "ABANDON";

/** ACTIVE ⇄ PAUSED; ambos encerram em COMPLETED ou ABANDONED. Terminais não voltam. */
export const ALLOWED_SESSION_TRANSITIONS: Record<
  RtqSessionStatus,
  readonly RtqSessionStatus[]
> = {
  ACTIVE: ["PAUSED", "COMPLETED", "ABANDONED"],
  PAUSED: ["ACTIVE", "COMPLETED", "ABANDONED"],
  COMPLETED: [],
  ABANDONED: [],
};

export function canTransitionSession(
  from: RtqSessionStatus,
  to: RtqSessionStatus
): boolean {
  return ALLOWED_SESSION_TRANSITIONS[from].includes(to);
}

const SESSION_ACTION_TARGET: Record<SessionAction, RtqSessionStatus> = {
  PAUSE: "PAUSED",
  RESUME: "ACTIVE",
  COMPLETE: "COMPLETED",
  ABANDON: "ABANDONED",
};

const SESSION_ACTION_EVENT: Record<SessionAction, InteractionEventType> = {
  PAUSE: "SESSION_PAUSED",
  RESUME: "SESSION_RESUMED",
  COMPLETE: "SESSION_COMPLETED",
  ABANDON: "SESSION_ABANDONED",
};

export interface SessionStateChange {
  status: RtqSessionStatus;
  patch: Record<string, unknown>;
  event: {
    eventType: InteractionEventType;
    previousValue: unknown;
    newValue: unknown;
  };
}

export function applySessionAction(
  current: RtqSessionStatus,
  action: SessionAction,
  now: string
): SessionStateChange {
  const target = SESSION_ACTION_TARGET[action];
  if (!canTransitionSession(current, target)) {
    // ——— §10, casos 1 e 2 ———
    //
    // A recusa é a mesma de sempre; o que muda é ela passar a DIZER qual é.
    // Uma fila offline recusada aqui precisa distinguir "encerrada em outro
    // aparelho" (caso 1: nada do que ficou aqui entra, e a saída é levar os
    // textos como rascunho para uma conversa nova) de "pausada em outro
    // aparelho" (caso 2: dá para retomar e seguir enviando). As duas viravam
    // a mesma frase, e com ela a mesma tela — que não poderia oferecer
    // nenhuma das duas saídas certas.
    if (isTerminalSessionStatus(current)) {
      throw new RtqConflictError(
        "SESSION_COMPLETED",
        `transição de sessão inválida: ${current} → ${target}`,
        { serverStatus: current }
      );
    }
    if (current === "PAUSED") {
      throw new RtqConflictError(
        "SESSION_PAUSED",
        `transição de sessão inválida: ${current} → ${target}`,
        { serverStatus: current }
      );
    }
    throw new RtqDomainError(
      `transição de sessão inválida: ${current} → ${target}`
    );
  }
  const patch: Record<string, unknown> = { status: target, updatedAt: now };
  switch (action) {
    case "PAUSE":
      patch.pausedAt = now;
      break;
    case "RESUME":
      patch.resumedAt = now;
      break;
    case "COMPLETE":
      patch.completedAt = now;
      break;
    case "ABANDON":
      patch.abandonedAt = now;
      break;
  }
  return {
    status: target,
    patch,
    event: {
      eventType: SESSION_ACTION_EVENT[action],
      previousValue: { status: current },
      newValue: { status: target },
    },
  };
}

// ---------- Interações (turnos) ----------

/**
 * Transições permitidas. As marcadas com (§3/§5) não constam da lista de
 * fluxos alternativos da especificação, mas são exigidas pelas capacidades
 * que ela obriga a oferecer:
 *
 *   §3 (gesto incerto)  → "permitir reapresentar a pergunta" e "permitir
 *                          marcar ausência de resposta";
 *   §5 (antes de confirmar) → "registrar gesto incerto", "reapresentar a
 *                          pergunta" e "marcar ausência de resposta" também
 *                          quando já existe uma seleção provisória.
 *
 * Em todos esses caminhos a resposta provisória descartada é preservada em
 * `previousValue` do evento — nenhum histórico se perde.
 */
export const ALLOWED_TURN_TRANSITIONS: Record<
  RtqTurnStatus,
  readonly RtqTurnStatus[]
> = {
  DRAFT: ["REVIEWED", "CANCELED"],
  REVIEWED: ["PRESENTED", "CANCELED"],
  PRESENTED: ["AWAITING_RESPONSE", "NO_RESPONSE", "CANCELED"],
  AWAITING_RESPONSE: [
    "PROVISIONAL_RESPONSE",
    "UNCERTAIN_GESTURE",
    "NO_RESPONSE",
    "PRESENTED", // §3: reapresentar
    "CANCELED",
  ],
  PROVISIONAL_RESPONSE: [
    "PROVISIONAL_RESPONSE", // correção da seleção
    "RECONFIRMATION_PENDING", // sensível, após conferência
    "CONFIRMED", // não sensível, após conferência
    "AWAITING_RESPONSE", // remoção da seleção
    "UNCERTAIN_GESTURE", // §5
    "NO_RESPONSE", // §5
    "PRESENTED", // §5: reapresentar
    "CANCELED",
  ],
  RECONFIRMATION_PENDING: ["CONFIRMED", "AWAITING_RESPONSE", "CANCELED"],
  UNCERTAIN_GESTURE: [
    "AWAITING_RESPONSE",
    "PRESENTED", // §3: reapresentar
    "NO_RESPONSE", // §3
    "CANCELED",
  ],
  CONFIRMED: [],
  NO_RESPONSE: [],
  CANCELED: [],
};

export function canTransitionTurn(
  from: RtqTurnStatus,
  to: RtqTurnStatus
): boolean {
  return ALLOWED_TURN_TRANSITIONS[from].includes(to);
}

export type TurnAction =
  /**
   * Revisão do assistente antes de apresentar. A marcação de assunto sensível
   * entra AQUI (e só a partir de DRAFT, portanto sempre antes da
   * apresentação): é o assistente que marca, nunca uma classificação
   * automática. `QUESTION_REVIEWED` audita o antes e o depois.
   */
  | {
      kind: "REVIEW";
      reviewedText: string;
      isSensitive?: boolean;
      sensitiveCategory?: SensitiveCategory | null;
    }
  | { kind: "PRESENT" }
  | { kind: "REPRESENT" }
  | { kind: "AWAIT_RESPONSE" }
  | { kind: "SELECT_RESPONSE"; response: SemanticResponse }
  | { kind: "CHANGE_RESPONSE"; response: SemanticResponse }
  | { kind: "REMOVE_RESPONSE" }
  /** Conferência do assistente: "o botão corresponde ao gesto que observei". */
  | { kind: "VERIFY_RESPONSE" }
  /** Reconfirmação do paciente — exclusiva de perguntas sensíveis. */
  | { kind: "RECONFIRM_RESPONSE" }
  | { kind: "RECORD_UNCERTAIN_GESTURE" }
  | { kind: "RECORD_NO_RESPONSE"; reason?: string }
  | { kind: "CANCEL"; reason?: string };

export type TurnActionKind = TurnAction["kind"];

export const TURN_ACTION_KINDS: readonly TurnActionKind[] = [
  "REVIEW",
  "PRESENT",
  "REPRESENT",
  "AWAIT_RESPONSE",
  "SELECT_RESPONSE",
  "CHANGE_RESPONSE",
  "REMOVE_RESPONSE",
  "VERIFY_RESPONSE",
  "RECONFIRM_RESPONSE",
  "RECORD_UNCERTAIN_GESTURE",
  "RECORD_NO_RESPONSE",
  "CANCEL",
] as const;

export function isTurnActionKind(v: unknown): v is TurnActionKind {
  return (
    typeof v === "string" &&
    (TURN_ACTION_KINDS as readonly string[]).includes(v)
  );
}

/**
 * Ações que registram, alteram ou apagam a resposta OBSERVADA do paciente,
 * ou que apresentam algo a ele. Uma sessão pausada não aceita nenhuma delas.
 */
const PATIENT_FACING_ACTIONS: readonly TurnActionKind[] = [
  "PRESENT",
  "REPRESENT",
  "AWAIT_RESPONSE",
  "SELECT_RESPONSE",
  "CHANGE_RESPONSE",
  "REMOVE_RESPONSE",
  "VERIFY_RESPONSE",
  "RECONFIRM_RESPONSE",
  "RECORD_UNCERTAIN_GESTURE",
  "RECORD_NO_RESPONSE",
];

/** Estados de origem exigidos por cada ação (antes da tabela de transições). */
const ACTION_ALLOWED_FROM: Record<TurnActionKind, readonly RtqTurnStatus[]> = {
  REVIEW: ["DRAFT"],
  PRESENT: ["REVIEWED"],
  REPRESENT: ["AWAITING_RESPONSE", "UNCERTAIN_GESTURE", "PROVISIONAL_RESPONSE"],
  // §3: depois de um gesto incerto o assistente pode simplesmente "aguardar
  // uma nova resposta", sem reapresentar a pergunta.
  AWAIT_RESPONSE: ["PRESENTED", "UNCERTAIN_GESTURE"],
  SELECT_RESPONSE: ["AWAITING_RESPONSE"],
  CHANGE_RESPONSE: ["PROVISIONAL_RESPONSE"],
  REMOVE_RESPONSE: ["PROVISIONAL_RESPONSE", "RECONFIRMATION_PENDING"],
  VERIFY_RESPONSE: ["PROVISIONAL_RESPONSE"],
  RECONFIRM_RESPONSE: ["RECONFIRMATION_PENDING"],
  RECORD_UNCERTAIN_GESTURE: ["AWAITING_RESPONSE", "PROVISIONAL_RESPONSE"],
  RECORD_NO_RESPONSE: [
    "PRESENTED",
    "AWAITING_RESPONSE",
    "UNCERTAIN_GESTURE",
    "PROVISIONAL_RESPONSE",
  ],
  CANCEL: [
    "DRAFT",
    "REVIEWED",
    "PRESENTED",
    "AWAITING_RESPONSE",
    "PROVISIONAL_RESPONSE",
    "RECONFIRMATION_PENDING",
    "UNCERTAIN_GESTURE",
  ],
};

export interface TurnStateChange {
  status: RtqTurnStatus;
  /** Campos a gravar no turno (já inclui `status` e `updatedAt`). */
  patch: Partial<ConversationQuestionTurn>;
  event: {
    eventType: InteractionEventType;
    previousValue: unknown;
    newValue: unknown;
    metadata: Record<string, unknown> | null;
  };
}

const MAX_RESPONSE_TIME_MS = 60 * 60 * 1000;

/** Tempo entre apresentar e observar a resposta. Registro — nunca decisão. */
function elapsedMs(presentedAt: string | null, now: string): number | null {
  if (!presentedAt) return null;
  const ms = new Date(now).getTime() - new Date(presentedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0 || ms >= MAX_RESPONSE_TIME_MS) return null;
  return Math.round(ms);
}

/**
 * Aplica uma ação do assistente a uma interação. Devolve o novo estado, os
 * campos a gravar e o evento de auditoria — os três juntos, para que a
 * persistência os grave numa única transação.
 *
 * A sessão precisa ser validada ANTES (assertSessionAcceptsTurnAction).
 */
export function applyTurnAction(
  turn: ConversationQuestionTurn,
  action: TurnAction,
  now: string
): TurnStateChange {
  const from = turn.status;
  const allowedFrom = ACTION_ALLOWED_FROM[action.kind];
  if (!allowedFrom.includes(from)) {
    throw new RtqDomainError(
      `ação ${action.kind} não é permitida no estado ${from}`
    );
  }

  const change = buildTurnChange(turn, action, now);

  if (!canTransitionTurn(from, change.status)) {
    throw new RtqDomainError(
      `transição de interação inválida: ${from} → ${change.status}`
    );
  }

  // Checagem defensiva: o turno resultante precisa satisfazer as invariantes
  // antes que a persistência sequer tente gravar.
  assertTurnInvariants({ ...turn, ...change.patch } as ConversationQuestionTurn);
  return change;
}

function buildTurnChange(
  turn: ConversationQuestionTurn,
  action: TurnAction,
  now: string
): TurnStateChange {
  const base = { updatedAt: now };

  switch (action.kind) {
    case "REVIEW": {
      const reviewedText = action.reviewedText.trim();
      if (!reviewedText) {
        throw new RtqDomainError("a pergunta revisada não pode ficar vazia");
      }
      // Sensibilidade só muda quando o assistente a informa; omitir mantém o
      // que já estava no turno.
      const isSensitive =
        action.isSensitive === undefined ? turn.isSensitive : action.isSensitive;
      let sensitiveCategory: SensitiveCategory | null = turn.sensitiveCategory;
      if (action.isSensitive !== undefined || action.sensitiveCategory !== undefined) {
        const raw = action.sensitiveCategory ?? null;
        if (raw !== null && !isSensitiveCategory(raw)) {
          throw new RtqDomainError("categoria sensível inválida");
        }
        if (!isSensitive && raw !== null) {
          throw new RtqDomainError(
            "categoria sensível exige a pergunta marcada como sensível"
          );
        }
        sensitiveCategory = isSensitive ? raw : null;
      }
      return {
        status: "REVIEWED",
        patch: {
          ...base,
          status: "REVIEWED",
          reviewedText,
          isSensitive,
          sensitiveCategory,
        },
        event: {
          eventType: "QUESTION_REVIEWED",
          previousValue: {
            reviewedText: turn.reviewedText,
            isSensitive: turn.isSensitive,
            sensitiveCategory: turn.sensitiveCategory,
          },
          newValue: { reviewedText, isSensitive, sensitiveCategory },
          metadata: null,
        },
      };
    }

    case "PRESENT": {
      if (!turn.reviewedText.trim()) {
        throw new RtqDomainError("não há pergunta revisada para apresentar");
      }
      // O texto apresentado congela aqui: revisar depois não reescreve o que
      // o paciente já viu.
      return {
        status: "PRESENTED",
        patch: {
          ...base,
          status: "PRESENTED",
          presentedText: turn.reviewedText,
          presentedAt: now,
        },
        event: {
          eventType: "QUESTION_PRESENTED",
          previousValue: { status: turn.status },
          newValue: { presentedText: turn.reviewedText },
          metadata: null,
        },
      };
    }

    case "REPRESENT": {
      // Reapresentar reabre o ciclo: a seleção provisória em curso, se
      // houver, é descartada (e preservada no evento).
      const discarded = turn.provisionalResponse;
      return {
        status: "PRESENTED",
        patch: {
          ...base,
          status: "PRESENTED",
          presentedAt: now,
          provisionalResponse: null,
          responseObservedAt: null,
          responseTimeMs: null,
          assistantVerifiedAt: null,
          correctionCount: turn.correctionCount + (discarded ? 1 : 0),
          representCount: turn.representCount + 1,
        },
        event: {
          eventType: "QUESTION_REPRESENTED",
          previousValue: {
            status: turn.status,
            provisionalResponse: discarded,
          },
          newValue: { status: "PRESENTED" },
          metadata: null,
        },
      };
    }

    case "AWAIT_RESPONSE": {
      // Mudança de estado sem evento próprio na lista da especificação: o
      // marco observável é QUESTION_PRESENTED, registrado no passo anterior.
      return {
        status: "AWAITING_RESPONSE",
        patch: { ...base, status: "AWAITING_RESPONSE" },
        event: {
          eventType: "QUESTION_PRESENTED",
          previousValue: { status: turn.status },
          newValue: { status: "AWAITING_RESPONSE" },
          metadata: { phase: "awaiting", from: turn.status },
        },
      };
    }

    case "SELECT_RESPONSE": {
      if (!isSemanticResponse(action.response)) {
        throw new RtqDomainError("resposta semântica inválida");
      }
      return {
        status: "PROVISIONAL_RESPONSE",
        patch: {
          ...base,
          status: "PROVISIONAL_RESPONSE",
          provisionalResponse: action.response,
          responseObservedAt: now,
          responseTimeMs: elapsedMs(turn.presentedAt, now),
        },
        event: {
          eventType: "RESPONSE_SELECTED",
          previousValue: { provisionalResponse: null },
          newValue: { provisionalResponse: action.response },
          metadata: null,
        },
      };
    }

    case "CHANGE_RESPONSE": {
      if (!isSemanticResponse(action.response)) {
        throw new RtqDomainError("resposta semântica inválida");
      }
      if (action.response === turn.provisionalResponse) {
        throw new RtqDomainError("a resposta selecionada já é essa");
      }
      // A seleção anterior fica preservada no evento — correção nunca apaga
      // histórico.
      return {
        status: "PROVISIONAL_RESPONSE",
        patch: {
          ...base,
          status: "PROVISIONAL_RESPONSE",
          provisionalResponse: action.response,
          responseObservedAt: now,
          // Uma correção invalida a conferência anterior, se houve.
          assistantVerifiedAt: null,
          correctionCount: turn.correctionCount + 1,
        },
        event: {
          eventType: "RESPONSE_CHANGED",
          previousValue: { provisionalResponse: turn.provisionalResponse },
          newValue: { provisionalResponse: action.response },
          metadata: null,
        },
      };
    }

    case "REMOVE_RESPONSE": {
      return {
        status: "AWAITING_RESPONSE",
        patch: {
          ...base,
          status: "AWAITING_RESPONSE",
          provisionalResponse: null,
          responseObservedAt: null,
          responseTimeMs: null,
          assistantVerifiedAt: null,
          correctionCount: turn.correctionCount + 1,
        },
        event: {
          eventType: "RESPONSE_REMOVED",
          previousValue: { provisionalResponse: turn.provisionalResponse },
          newValue: { provisionalResponse: null },
          metadata: null,
        },
      };
    }

    case "VERIFY_RESPONSE": {
      if (!isSemanticResponse(turn.provisionalResponse)) {
        throw new RtqDomainError(
          "não há resposta observada para conferir"
        );
      }
      // A conferência do assistente NÃO é uma nova decisão do paciente: ela
      // não altera a resposta, só atesta que o botão corresponde ao gesto.
      if (turn.isSensitive) {
        return {
          status: "RECONFIRMATION_PENDING",
          patch: {
            ...base,
            status: "RECONFIRMATION_PENDING",
            assistantVerifiedAt: now,
          },
          event: {
            eventType: "RESPONSE_VERIFIED",
            previousValue: { status: turn.status },
            newValue: {
              status: "RECONFIRMATION_PENDING",
              provisionalResponse: turn.provisionalResponse,
            },
            metadata: {
              sensitive: true,
              sensitiveCategory: turn.sensitiveCategory,
            },
          },
        };
      }
      return {
        status: "CONFIRMED",
        patch: {
          ...base,
          status: "CONFIRMED",
          assistantVerifiedAt: now,
          confirmedResponse: turn.provisionalResponse,
          confirmedAt: now,
        },
        event: {
          eventType: "RESPONSE_VERIFIED",
          previousValue: { status: turn.status, confirmedResponse: null },
          newValue: {
            status: "CONFIRMED",
            confirmedResponse: turn.provisionalResponse,
          },
          metadata: { sensitive: false },
        },
      };
    }

    case "RECONFIRM_RESPONSE": {
      if (!isSemanticResponse(turn.provisionalResponse)) {
        throw new RtqDomainError("não há resposta observada para reconfirmar");
      }
      if (!turn.assistantVerifiedAt) {
        throw new RtqDomainError("a seleção ainda não foi conferida");
      }
      return {
        status: "CONFIRMED",
        patch: {
          ...base,
          status: "CONFIRMED",
          reconfirmedAt: now,
          confirmedResponse: turn.provisionalResponse,
          confirmedAt: now,
        },
        event: {
          eventType: "RESPONSE_RECONFIRMED",
          previousValue: { status: turn.status, confirmedResponse: null },
          newValue: {
            status: "CONFIRMED",
            confirmedResponse: turn.provisionalResponse,
          },
          metadata: {
            sensitive: true,
            sensitiveCategory: turn.sensitiveCategory,
          },
        },
      };
    }

    case "RECORD_UNCERTAIN_GESTURE": {
      // Controle INTERNO do assistente: não é uma quarta resposta. Não
      // registra SIM/TALVEZ/NÃO e não conta como resposta em estatística.
      const discarded = turn.provisionalResponse;
      return {
        status: "UNCERTAIN_GESTURE",
        patch: {
          ...base,
          status: "UNCERTAIN_GESTURE",
          provisionalResponse: null,
          responseObservedAt: null,
          responseTimeMs: null,
          assistantVerifiedAt: null,
          correctionCount: turn.correctionCount + (discarded ? 1 : 0),
        },
        event: {
          eventType: "UNCERTAIN_GESTURE_RECORDED",
          previousValue: {
            status: turn.status,
            provisionalResponse: discarded,
          },
          newValue: { status: "UNCERTAIN_GESTURE" },
          metadata: null,
        },
      };
    }

    case "RECORD_NO_RESPONSE": {
      // O silêncio NUNCA é interpretado: nenhuma resposta semântica é
      // gravada, e este estado só é alcançado por ato explícito do
      // assistente (ou pela conclusão explícita da sessão).
      const discarded = turn.provisionalResponse;
      return {
        status: "NO_RESPONSE",
        patch: {
          ...base,
          status: "NO_RESPONSE",
          provisionalResponse: null,
          responseObservedAt: null,
          responseTimeMs: null,
          assistantVerifiedAt: null,
          correctionCount: turn.correctionCount + (discarded ? 1 : 0),
        },
        event: {
          eventType: "NO_RESPONSE_RECORDED",
          previousValue: {
            status: turn.status,
            provisionalResponse: discarded,
          },
          newValue: { status: "NO_RESPONSE" },
          metadata: action.reason ? { reason: action.reason } : null,
        },
      };
    }

    case "CANCEL": {
      return {
        status: "CANCELED",
        patch: {
          ...base,
          status: "CANCELED",
          provisionalResponse: null,
          canceledAt: now,
        },
        event: {
          eventType: "QUESTION_CANCELED",
          previousValue: {
            status: turn.status,
            provisionalResponse: turn.provisionalResponse,
          },
          newValue: { status: "CANCELED" },
          metadata: action.reason ? { reason: action.reason } : null,
        },
      };
    }
  }
}

// ---------- Guardas de sessão ----------

/** Sessão encerrada não aceita novas perguntas (seção 12). */
export function assertSessionAcceptsNewTurn(status: RtqSessionStatus): void {
  if (isTerminalSessionStatus(status)) {
    throw new RtqDomainError(
      "sessão encerrada não aceita novas perguntas"
    );
  }
}

/** Sessão pausada não aceita novas respostas (seção 12). */
export function assertSessionAcceptsTurnAction(
  status: RtqSessionStatus,
  kind: TurnActionKind
): void {
  if (isTerminalSessionStatus(status)) {
    throw new RtqDomainError("sessão encerrada não aceita novas interações");
  }
  if (status === "PAUSED" && PATIENT_FACING_ACTIONS.includes(kind)) {
    throw new RtqDomainError(
      "sessão pausada: retome a sessão antes de registrar respostas"
    );
  }
}
