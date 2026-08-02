// ——— Conversa por opções: máquina de estados ———
// Módulo PURO (sem Firestore, sem React), irmão de
// realtime-question-machine.ts e com o mesmo contrato: é o ponto ÚNICO onde o
// estado de um caminho, de um nível ou de uma frase muda. Nenhum componente,
// rota ou serviço escreve `status` direto — todos passam por
// applyPathAction / applyNodeAction / applyStatementAction, que devolvem o novo
// estado, o patch e o evento de auditoria. Transição inválida lança e nada é
// gravado.
//
// A API é orientada a AÇÃO, não a estado: quem chama diz o que o assistente
// FEZ ("conferi a opção observada"), nunca para onde o registro deve ir. É por
// isso que estas três regras não têm como ser burladas pelo cliente:
//
//   1. nenhum nível avança sem conferência explícita da opção observada;
//   2. TALVEZ e NÃO jamais confirmam uma frase — só SIM confirma;
//   3. o que já foi apresentado ao paciente não é reescrito: a edição vira
//      substituição, com registro novo e o original preservado.

import {
  assertNodeInvariants,
  assertStatementInvariants,
  isTerminalPathStatus,
  MAX_OPTION_LABEL_LEN,
  MAX_PROMPT_LEN,
  MAX_STATEMENT_LEN,
  RtqDomainError,
  wasPresentedToPatient,
  statementWasPresented,
  type NodeStatus,
  type OptionConversationFinalStatement,
  type OptionConversationNode,
  type OptionConversationOption,
  type PathStatus,
  type StatementStatus,
} from "@/lib/option-conversation-types";
import {
  isSemanticResponse,
  isSensitiveCategory,
  isTerminalSessionStatus,
  type InteractionEventType,
  type RtqSessionStatus,
  type SemanticResponse,
  type SensitiveCategory,
} from "@/lib/realtime-question-types";

// ═══════════════════ Caminho ═══════════════════

export type PathAction =
  | { kind: "PAUSE" }
  | { kind: "RESUME" }
  | { kind: "COMPLETE"; finalStatementId?: string | null }
  | { kind: "INTERRUPT"; reason?: string }
  | { kind: "RESTART"; reason?: string };

export type PathActionKind = PathAction["kind"];

export const PATH_ACTION_KINDS: readonly PathActionKind[] = [
  "PAUSE",
  "RESUME",
  "COMPLETE",
  "INTERRUPT",
  "RESTART",
] as const;

export function isPathActionKind(v: unknown): v is PathActionKind {
  return (
    typeof v === "string" && (PATH_ACTION_KINDS as readonly string[]).includes(v)
  );
}

/** ACTIVE ⇄ PAUSED; ambos encerram. Terminais não voltam — reutilizar cria outro. */
export const ALLOWED_PATH_TRANSITIONS: Record<
  PathStatus,
  readonly PathStatus[]
> = {
  ACTIVE: ["PAUSED", "COMPLETED", "INTERRUPTED", "RESTARTED"],
  PAUSED: ["ACTIVE", "COMPLETED", "INTERRUPTED", "RESTARTED"],
  COMPLETED: [],
  INTERRUPTED: [],
  RESTARTED: [],
};

export function canTransitionPath(from: PathStatus, to: PathStatus): boolean {
  return ALLOWED_PATH_TRANSITIONS[from].includes(to);
}

const PATH_ACTION_TARGET: Record<PathActionKind, PathStatus> = {
  PAUSE: "PAUSED",
  RESUME: "ACTIVE",
  COMPLETE: "COMPLETED",
  INTERRUPT: "INTERRUPTED",
  RESTART: "RESTARTED",
};

const PATH_ACTION_EVENT: Record<PathActionKind, InteractionEventType> = {
  PAUSE: "CONVERSATION_PATH_PAUSED",
  RESUME: "CONVERSATION_PATH_RESUMED",
  COMPLETE: "CONVERSATION_PATH_COMPLETED",
  INTERRUPT: "CONVERSATION_PATH_INTERRUPTED",
  RESTART: "CONVERSATION_PATH_RESTARTED",
};

export interface PathStateChange {
  status: PathStatus;
  patch: Record<string, unknown>;
  event: {
    eventType: InteractionEventType;
    previousValue: unknown;
    newValue: unknown;
    metadata: Record<string, unknown> | null;
  };
}

export function applyPathAction(
  current: PathStatus,
  action: PathAction,
  now: string
): PathStateChange {
  const target = PATH_ACTION_TARGET[action.kind];
  if (!canTransitionPath(current, target)) {
    // Reiniciar duas vezes cai aqui: RESTARTED não transiciona (§16).
    throw new RtqDomainError(
      `transição de caminho inválida: ${current} → ${target}`
    );
  }
  const patch: Record<string, unknown> = { status: target, updatedAt: now };
  switch (action.kind) {
    case "PAUSE":
      patch.pausedAt = now;
      break;
    case "RESUME":
      patch.resumedAt = now;
      break;
    case "COMPLETE":
      patch.completedAt = now;
      if (action.finalStatementId) patch.finalStatementId = action.finalStatementId;
      break;
    case "INTERRUPT":
      patch.interruptedAt = now;
      break;
    case "RESTART":
      patch.restartedAt = now;
      break;
  }
  return {
    status: target,
    patch,
    event: {
      eventType: PATH_ACTION_EVENT[action.kind],
      previousValue: { status: current },
      newValue: { status: target },
      metadata:
        "reason" in action && action.reason ? { reason: action.reason } : null,
    },
  };
}

// ═══════════════════ Níveis ═══════════════════

export const ALLOWED_NODE_TRANSITIONS: Record<
  NodeStatus,
  readonly NodeStatus[]
> = {
  DRAFT: ["DRAFT", "REVIEWED", "CANCELED"],
  REVIEWED: ["DRAFT", "REVIEWED", "PRESENTED", "CANCELED"],
  PRESENTED: ["AWAITING_SELECTION", "INACTIVE", "CANCELED", "REPLACED"],
  AWAITING_SELECTION: [
    "PROVISIONAL_SELECTION",
    "PRESENTED", // reapresentar as opções do mesmo nível
    "INACTIVE",
    "CANCELED",
    "REPLACED",
  ],
  PROVISIONAL_SELECTION: [
    "PROVISIONAL_SELECTION", // correção da seleção (§12)
    "CONFIRMED", // após a conferência do assistente (§11)
    "AWAITING_SELECTION", // cancelar a seleção (§12)
    "INACTIVE",
    "CANCELED",
    "REPLACED",
  ],
  // Um nível confirmado ainda pode ser DESATIVADO: voltar pelo breadcrumb
  // abandona a ramificação posterior sem apagar nada (§14). E ainda pode ser
  // SUBSTITUÍDO por uma versão corrigida (§29).
  CONFIRMED: ["INACTIVE", "REPLACED"],
  // Reativado ao voltar pelo breadcrumb: as opções são reapresentadas.
  INACTIVE: ["AWAITING_SELECTION", "PRESENTED"],
  CANCELED: [],
  REPLACED: [],
};

export function canTransitionNode(from: NodeStatus, to: NodeStatus): boolean {
  return ALLOWED_NODE_TRANSITIONS[from].includes(to);
}

export type NodeAction =
  /**
   * Revisão antes de apresentar. É AQUI — e só a partir de DRAFT/REVIEWED,
   * portanto sempre antes de o paciente ver — que texto, opções e marcação de
   * assunto sensível mudam no MESMO registro (§27).
   */
  | {
      kind: "REVIEW";
      promptText?: string;
      options?: OptionConversationOption[];
      isSensitive?: boolean;
      sensitiveCategory?: SensitiveCategory | null;
    }
  | { kind: "PRESENT" }
  | { kind: "AWAIT_SELECTION" }
  /** Reapresentar as MESMAS opções, sem criar nível novo. */
  | { kind: "REPRESENT" }
  | { kind: "SELECT_OPTION"; optionId: string }
  | { kind: "CHANGE_OPTION"; optionId: string }
  | { kind: "REMOVE_SELECTION" }
  /** Conferência: "a opção marcada corresponde ao gesto que observei" (§10). */
  | { kind: "CONFIRM_OPTION" }
  /** Ficou numa ramificação abandonada. Preserva tudo (§14). */
  | { kind: "DEACTIVATE"; reason?: string }
  /** O original passa a apontar para a versão corrigida (§29). */
  | { kind: "MARK_REPLACED"; replacedByNodeId: string }
  | { kind: "CANCEL"; reason?: string };

export type NodeActionKind = NodeAction["kind"];

export const NODE_ACTION_KINDS: readonly NodeActionKind[] = [
  "REVIEW",
  "PRESENT",
  "AWAIT_SELECTION",
  "REPRESENT",
  "SELECT_OPTION",
  "CHANGE_OPTION",
  "REMOVE_SELECTION",
  "CONFIRM_OPTION",
  "DEACTIVATE",
  "MARK_REPLACED",
  "CANCEL",
] as const;

export function isNodeActionKind(v: unknown): v is NodeActionKind {
  return (
    typeof v === "string" && (NODE_ACTION_KINDS as readonly string[]).includes(v)
  );
}

/**
 * Ações que apresentam algo ao paciente ou registram o que ele sinalizou.
 * Um caminho ou uma sessão pausada não aceita nenhuma delas (§33).
 */
const PATIENT_FACING_NODE_ACTIONS: readonly NodeActionKind[] = [
  "PRESENT",
  "AWAIT_SELECTION",
  "REPRESENT",
  "SELECT_OPTION",
  "CHANGE_OPTION",
  "REMOVE_SELECTION",
  "CONFIRM_OPTION",
];

const NODE_ACTION_ALLOWED_FROM: Record<NodeActionKind, readonly NodeStatus[]> = {
  // Depois de PRESENTED a edição direta é RECUSADA aqui, no domínio: é o que
  // obriga a passar pela versão corrigida (§28).
  REVIEW: ["DRAFT", "REVIEWED"],
  PRESENT: ["REVIEWED"],
  AWAIT_SELECTION: ["PRESENTED", "INACTIVE"],
  REPRESENT: ["AWAITING_SELECTION", "PROVISIONAL_SELECTION", "INACTIVE"],
  SELECT_OPTION: ["AWAITING_SELECTION"],
  CHANGE_OPTION: ["PROVISIONAL_SELECTION"],
  REMOVE_SELECTION: ["PROVISIONAL_SELECTION"],
  CONFIRM_OPTION: ["PROVISIONAL_SELECTION"],
  DEACTIVATE: [
    "PRESENTED",
    "AWAITING_SELECTION",
    "PROVISIONAL_SELECTION",
    "CONFIRMED",
  ],
  MARK_REPLACED: [
    "PRESENTED",
    "AWAITING_SELECTION",
    "PROVISIONAL_SELECTION",
    "CONFIRMED",
  ],
  CANCEL: [
    "DRAFT",
    "REVIEWED",
    "PRESENTED",
    "AWAITING_SELECTION",
    "PROVISIONAL_SELECTION",
  ],
};

export interface NodeStateChange {
  status: NodeStatus;
  patch: Partial<OptionConversationNode>;
  event: {
    eventType: InteractionEventType;
    previousValue: unknown;
    newValue: unknown;
    metadata: Record<string, unknown> | null;
  };
}

export function applyNodeAction(
  node: OptionConversationNode,
  action: NodeAction,
  now: string
): NodeStateChange {
  const from = node.status;
  if (!NODE_ACTION_ALLOWED_FROM[action.kind].includes(from)) {
    throw new RtqDomainError(
      `ação ${action.kind} não é permitida no nível em ${from}`
    );
  }

  const change = buildNodeChange(node, action, now);

  if (!canTransitionNode(from, change.status)) {
    throw new RtqDomainError(
      `transição de nível inválida: ${from} → ${change.status}`
    );
  }

  assertNodeInvariants({ ...node, ...change.patch } as OptionConversationNode);
  return change;
}

function labelOf(node: OptionConversationNode, optionId: string | null): string | null {
  if (!optionId) return null;
  return node.options.find((o) => o.id === optionId)?.label ?? null;
}

function buildNodeChange(
  node: OptionConversationNode,
  action: NodeAction,
  now: string
): NodeStateChange {
  const base = { updatedAt: now };

  switch (action.kind) {
    case "REVIEW": {
      const promptText =
        action.promptText === undefined
          ? node.promptText
          : action.promptText.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_LEN);
      if (!promptText) {
        throw new RtqDomainError("a pergunta do nível não pode ficar vazia");
      }
      const options = action.options ?? node.options;
      options.forEach((o) => {
        if (o.label.length > MAX_OPTION_LABEL_LEN) {
          throw new RtqDomainError("texto de opção acima do limite");
        }
      });

      const isSensitive =
        action.isSensitive === undefined ? node.isSensitive : action.isSensitive;
      let sensitiveCategory: SensitiveCategory | null = node.sensitiveCategory;
      if (action.isSensitive !== undefined || action.sensitiveCategory !== undefined) {
        const raw = action.sensitiveCategory ?? null;
        if (raw !== null && !isSensitiveCategory(raw)) {
          throw new RtqDomainError("categoria sensível inválida");
        }
        if (!isSensitive && raw !== null) {
          throw new RtqDomainError(
            "categoria sensível exige o nível marcado como sensível"
          );
        }
        sensitiveCategory = isSensitive ? raw : null;
      }

      return {
        status: "REVIEWED",
        patch: {
          ...base,
          status: "REVIEWED",
          promptText,
          options,
          isSensitive,
          sensitiveCategory,
        },
        event: {
          eventType: "OPTION_LEVEL_REVIEWED",
          previousValue: {
            promptText: node.promptText,
            options: node.options.map((o) => ({ position: o.position, label: o.label })),
            isSensitive: node.isSensitive,
            sensitiveCategory: node.sensitiveCategory,
          },
          newValue: {
            promptText,
            options: options.map((o) => ({ position: o.position, label: o.label })),
            isSensitive,
            sensitiveCategory,
          },
          metadata: null,
        },
      };
    }

    case "PRESENT": {
      if (!node.promptText.trim()) {
        throw new RtqDomainError("não há nível revisado para apresentar");
      }
      // A partir daqui as posições estão congeladas: o terceiro sinal do
      // paciente aponta para a terceira opção, e continuará apontando.
      return {
        status: "PRESENTED",
        patch: { ...base, status: "PRESENTED", presentedAt: now },
        event: {
          eventType: "OPTION_LEVEL_PRESENTED",
          previousValue: { status: node.status },
          newValue: {
            promptText: node.promptText,
            options: node.options.map((o) => ({ position: o.position, label: o.label })),
          },
          metadata: { interactionMode: "OPTION_SELECTION" },
        },
      };
    }

    case "AWAIT_SELECTION": {
      return {
        status: "AWAITING_SELECTION",
        patch: {
          ...base,
          status: "AWAITING_SELECTION",
          // Reativar um nível desativado nunca traz de volta a escolha antiga:
          // ela pertence à ramificação anterior (§14).
          provisionalOptionId: null,
          confirmedOptionId: null,
          deactivatedAt: null,
        },
        event: {
          eventType: "OPTION_LEVEL_PRESENTED",
          previousValue: { status: node.status },
          newValue: { status: "AWAITING_SELECTION" },
          metadata: { phase: "awaiting", from: node.status },
        },
      };
    }

    case "REPRESENT": {
      const discarded = node.provisionalOptionId;
      return {
        status: "PRESENTED",
        patch: {
          ...base,
          status: "PRESENTED",
          presentedAt: now,
          provisionalOptionId: null,
          confirmedOptionId: null,
          selectedAt: null,
          deactivatedAt: null,
          correctionCount: node.correctionCount + (discarded ? 1 : 0),
        },
        event: {
          eventType: "OPTION_LEVEL_PRESENTED",
          previousValue: {
            status: node.status,
            provisionalOptionId: discarded,
            provisionalLabel: labelOf(node, discarded),
          },
          newValue: { status: "PRESENTED" },
          metadata: { represent: true },
        },
      };
    }

    case "SELECT_OPTION": {
      const option = node.options.find((o) => o.id === action.optionId);
      if (!option) throw new RtqDomainError("opção inválida para este nível");
      return {
        status: "PROVISIONAL_SELECTION",
        patch: {
          ...base,
          status: "PROVISIONAL_SELECTION",
          provisionalOptionId: option.id,
          selectedAt: now,
        },
        event: {
          eventType: "OPTION_SELECTED",
          previousValue: { provisionalOptionId: null },
          newValue: {
            provisionalOptionId: option.id,
            position: option.position,
            label: option.label,
          },
          metadata: null,
        },
      };
    }

    case "CHANGE_OPTION": {
      const option = node.options.find((o) => o.id === action.optionId);
      if (!option) throw new RtqDomainError("opção inválida para este nível");
      if (option.id === node.provisionalOptionId) {
        throw new RtqDomainError("a opção selecionada já é essa");
      }
      // A seleção anterior fica preservada no evento — corrigir nunca apaga
      // histórico (§12).
      return {
        status: "PROVISIONAL_SELECTION",
        patch: {
          ...base,
          status: "PROVISIONAL_SELECTION",
          provisionalOptionId: option.id,
          selectedAt: now,
          correctionCount: node.correctionCount + 1,
        },
        event: {
          eventType: "OPTION_CHANGED",
          previousValue: {
            provisionalOptionId: node.provisionalOptionId,
            label: labelOf(node, node.provisionalOptionId),
          },
          newValue: {
            provisionalOptionId: option.id,
            position: option.position,
            label: option.label,
          },
          metadata: null,
        },
      };
    }

    case "REMOVE_SELECTION": {
      return {
        status: "AWAITING_SELECTION",
        patch: {
          ...base,
          status: "AWAITING_SELECTION",
          provisionalOptionId: null,
          selectedAt: null,
          correctionCount: node.correctionCount + 1,
        },
        event: {
          eventType: "OPTION_SELECTION_REMOVED",
          previousValue: {
            provisionalOptionId: node.provisionalOptionId,
            label: labelOf(node, node.provisionalOptionId),
          },
          newValue: { provisionalOptionId: null },
          metadata: null,
        },
      };
    }

    case "CONFIRM_OPTION": {
      if (!node.provisionalOptionId) {
        throw new RtqDomainError("não há opção observada para conferir");
      }
      const option = node.options.find((o) => o.id === node.provisionalOptionId);
      if (!option) throw new RtqDomainError("opção inválida para este nível");
      // Confirmar significa apenas que o assistente conferiu a
      // correspondência entre o gesto e a opção — não que o Helo concorda,
      // interpreta ou decide.
      return {
        status: "CONFIRMED",
        patch: {
          ...base,
          status: "CONFIRMED",
          confirmedOptionId: option.id,
          confirmedAt: now,
        },
        event: {
          eventType: "OPTION_CONFIRMED",
          previousValue: { status: node.status, confirmedOptionId: null },
          newValue: {
            confirmedOptionId: option.id,
            position: option.position,
            label: option.label,
            isTerminal: option.isTerminal,
          },
          metadata: option.isSensitive
            ? { sensitive: true, sensitiveCategory: option.sensitiveCategory }
            : null,
        },
      };
    }

    case "DEACTIVATE": {
      return {
        status: "INACTIVE",
        patch: { ...base, status: "INACTIVE", deactivatedAt: now },
        event: {
          eventType: "PATH_BRANCH_DEACTIVATED",
          previousValue: {
            status: node.status,
            branchId: node.branchId,
            confirmedOptionId: node.confirmedOptionId,
            confirmedLabel: labelOf(node, node.confirmedOptionId),
          },
          newValue: { status: "INACTIVE" },
          metadata: action.reason ? { reason: action.reason } : null,
        },
      };
    }

    case "MARK_REPLACED": {
      return {
        status: "REPLACED",
        patch: {
          ...base,
          status: "REPLACED",
          replacedByNodeId: action.replacedByNodeId,
          replacedAt: now,
        },
        event: {
          eventType: "OPTION_LEVEL_REPLACED",
          previousValue: {
            status: node.status,
            promptText: node.promptText,
            options: node.options.map((o) => ({ position: o.position, label: o.label })),
          },
          newValue: { replacedByNodeId: action.replacedByNodeId },
          metadata: null,
        },
      };
    }

    case "CANCEL": {
      return {
        status: "CANCELED",
        patch: {
          ...base,
          status: "CANCELED",
          provisionalOptionId: null,
          canceledAt: now,
        },
        event: {
          eventType: "OPTION_LEVEL_REVIEWED",
          previousValue: {
            status: node.status,
            provisionalOptionId: node.provisionalOptionId,
          },
          newValue: { status: "CANCELED" },
          metadata: action.reason ? { reason: action.reason } : null,
        },
      };
    }
  }
}

// ═══════════════════ Frase final ═══════════════════

export const ALLOWED_STATEMENT_TRANSITIONS: Record<
  StatementStatus,
  readonly StatementStatus[]
> = {
  DRAFT: ["DRAFT", "REVIEWED", "CANCELED"],
  REVIEWED: ["DRAFT", "REVIEWED", "PRESENTED", "CANCELED"],
  PRESENTED: ["PROVISIONAL_RESPONSE", "CANCELED", "REPLACED"],
  PROVISIONAL_RESPONSE: [
    "PROVISIONAL_RESPONSE", // o assistente corrige o que observou
    "RECONFIRMATION_PENDING", // SIM em frase sensível
    "CONFIRMED", // SIM em frase não sensível
    "REJECTED", // NÃO
    "PRESENTED", // reapresentar a mesma frase
    "CANCELED",
    "REPLACED",
  ],
  RECONFIRMATION_PENDING: [
    "CONFIRMED",
    "PROVISIONAL_RESPONSE",
    "PRESENTED",
    "CANCELED",
    "REPLACED",
  ],
  // Confirmada ou rejeitada, a frase é imutável. Ainda pode originar uma
  // versão nova, e a resposta original continua valendo para o texto original
  // (§30).
  CONFIRMED: ["REPLACED"],
  REJECTED: ["REPLACED"],
  CANCELED: [],
  REPLACED: [],
};

export function canTransitionStatement(
  from: StatementStatus,
  to: StatementStatus
): boolean {
  return ALLOWED_STATEMENT_TRANSITIONS[from].includes(to);
}

export type StatementAction =
  /** Edição da mensagem em construção, antes de apresentar (§19, §27). */
  | {
      kind: "EDIT";
      text: string;
      isSensitive?: boolean;
      sensitiveCategory?: SensitiveCategory | null;
    }
  | { kind: "PRESENT" }
  /** A resposta OBSERVADA pelo assistente: SIM, TALVEZ ou NÃO. */
  | { kind: "RESPOND"; response: SemanticResponse }
  | { kind: "CHANGE_RESPONSE"; response: SemanticResponse }
  | { kind: "REMOVE_RESPONSE" }
  /** Reconfirmação reforçada — exclusiva de frase sensível (§21). */
  | { kind: "RECONFIRM" }
  /** Conferência do SIM observado → frase confirmada. */
  | { kind: "CONFIRM" }
  | { kind: "MARK_REPLACED"; replacedByStatementId: string }
  | { kind: "CANCEL"; reason?: string };

export type StatementActionKind = StatementAction["kind"];

export const STATEMENT_ACTION_KINDS: readonly StatementActionKind[] = [
  "EDIT",
  "PRESENT",
  "RESPOND",
  "CHANGE_RESPONSE",
  "REMOVE_RESPONSE",
  "RECONFIRM",
  "CONFIRM",
  "MARK_REPLACED",
  "CANCEL",
] as const;

export function isStatementActionKind(v: unknown): v is StatementActionKind {
  return (
    typeof v === "string" &&
    (STATEMENT_ACTION_KINDS as readonly string[]).includes(v)
  );
}

const PATIENT_FACING_STATEMENT_ACTIONS: readonly StatementActionKind[] = [
  "PRESENT",
  "RESPOND",
  "CHANGE_RESPONSE",
  "REMOVE_RESPONSE",
  "RECONFIRM",
  "CONFIRM",
];

const STATEMENT_ACTION_ALLOWED_FROM: Record<
  StatementActionKind,
  readonly StatementStatus[]
> = {
  // Apresentada, a frase não é reescrita: quem quer corrigir cria uma versão
  // nova (§30). O domínio recusa; a interface não tem como contornar.
  EDIT: ["DRAFT", "REVIEWED"],
  PRESENT: ["REVIEWED", "PROVISIONAL_RESPONSE", "RECONFIRMATION_PENDING"],
  RESPOND: ["PRESENTED"],
  CHANGE_RESPONSE: ["PROVISIONAL_RESPONSE", "RECONFIRMATION_PENDING"],
  REMOVE_RESPONSE: ["PROVISIONAL_RESPONSE", "RECONFIRMATION_PENDING"],
  // A reconfirmação reforçada acontece DEPOIS do SIM observado e ANTES da
  // confirmação: é o passo extra que uma frase sensível não pode pular (§21).
  RECONFIRM: ["PROVISIONAL_RESPONSE"],
  // Frase comum confirma direto do SIM observado; frase sensível só depois de
  // passar pela reconfirmação.
  CONFIRM: ["PROVISIONAL_RESPONSE", "RECONFIRMATION_PENDING"],
  MARK_REPLACED: [
    "PRESENTED",
    "PROVISIONAL_RESPONSE",
    "RECONFIRMATION_PENDING",
    "CONFIRMED",
    "REJECTED",
  ],
  CANCEL: [
    "DRAFT",
    "REVIEWED",
    "PRESENTED",
    "PROVISIONAL_RESPONSE",
    "RECONFIRMATION_PENDING",
  ],
};

export interface StatementStateChange {
  status: StatementStatus;
  patch: Partial<OptionConversationFinalStatement>;
  event: {
    eventType: InteractionEventType;
    previousValue: unknown;
    newValue: unknown;
    metadata: Record<string, unknown> | null;
  };
}

export function applyStatementAction(
  statement: OptionConversationFinalStatement,
  action: StatementAction,
  now: string
): StatementStateChange {
  const from = statement.status;
  if (!STATEMENT_ACTION_ALLOWED_FROM[action.kind].includes(from)) {
    throw new RtqDomainError(
      `ação ${action.kind} não é permitida na frase em ${from}`
    );
  }

  const change = buildStatementChange(statement, action, now);

  if (!canTransitionStatement(from, change.status)) {
    throw new RtqDomainError(
      `transição de frase inválida: ${from} → ${change.status}`
    );
  }

  assertStatementInvariants({
    ...statement,
    ...change.patch,
  } as OptionConversationFinalStatement);
  return change;
}

function buildStatementChange(
  statement: OptionConversationFinalStatement,
  action: StatementAction,
  now: string
): StatementStateChange {
  const base = { updatedAt: now };

  switch (action.kind) {
    case "EDIT": {
      const text = action.text.replace(/\s+/g, " ").trim().slice(0, MAX_STATEMENT_LEN);
      if (!text) throw new RtqDomainError("a frase não pode ficar vazia");

      const isSensitive =
        action.isSensitive === undefined
          ? statement.isSensitive
          : action.isSensitive;
      let sensitiveCategory: SensitiveCategory | null = statement.sensitiveCategory;
      if (action.isSensitive !== undefined || action.sensitiveCategory !== undefined) {
        const raw = action.sensitiveCategory ?? null;
        if (raw !== null && !isSensitiveCategory(raw)) {
          throw new RtqDomainError("categoria sensível inválida");
        }
        if (!isSensitive && raw !== null) {
          throw new RtqDomainError(
            "categoria sensível exige a frase marcada como sensível"
          );
        }
        sensitiveCategory = isSensitive ? raw : null;
      }

      const changed = text !== statement.currentText;
      return {
        status: "REVIEWED",
        patch: {
          ...base,
          status: "REVIEWED",
          currentText: text,
          isSensitive,
          sensitiveCategory,
          editCount: statement.editCount + (changed ? 1 : 0),
        },
        event: {
          eventType: "FINAL_STATEMENT_EDITED",
          previousValue: {
            currentText: statement.currentText,
            isSensitive: statement.isSensitive,
            sensitiveCategory: statement.sensitiveCategory,
          },
          newValue: { currentText: text, isSensitive, sensitiveCategory },
          // A frase original nunca se perde: fica aqui e em originalDraft.
          metadata: { originalDraft: statement.originalDraft },
        },
      };
    }

    case "PRESENT": {
      if (!statement.currentText.trim()) {
        throw new RtqDomainError("não há frase para apresentar");
      }
      const discarded = statement.provisionalResponse;
      return {
        status: "PRESENTED",
        patch: {
          ...base,
          status: "PRESENTED",
          // O texto apresentado congela aqui.
          presentedText: statement.currentText,
          presentedAt: now,
          provisionalResponse: null,
          respondedAt: null,
          reconfirmedAt: null,
          correctionCount: statement.correctionCount + (discarded ? 1 : 0),
        },
        event: {
          eventType: "FINAL_STATEMENT_PRESENTED",
          previousValue: {
            status: statement.status,
            provisionalResponse: discarded,
          },
          newValue: { presentedText: statement.currentText },
          metadata: {
            interactionMode: "FINAL_STATEMENT_CONFIRMATION",
            sensitive: statement.isSensitive,
          },
        },
      };
    }

    case "RESPOND":
    case "CHANGE_RESPONSE": {
      if (!isSemanticResponse(action.response)) {
        throw new RtqDomainError("resposta semântica inválida");
      }
      const changing = action.kind === "CHANGE_RESPONSE";
      if (changing && action.response === statement.provisionalResponse) {
        throw new RtqDomainError("a resposta selecionada já é essa");
      }
      // TALVEZ e NÃO param AQUI, como resposta observada e provisória. Não
      // existe transição deles para CONFIRMED: só SIM segue adiante (§20).
      return {
        status: "PROVISIONAL_RESPONSE",
        patch: {
          ...base,
          status: "PROVISIONAL_RESPONSE",
          provisionalResponse: action.response,
          respondedAt: now,
          reconfirmedAt: null,
          correctionCount: statement.correctionCount + (changing ? 1 : 0),
        },
        event: {
          eventType: changing
            ? "FINAL_STATEMENT_EDITED"
            : "FINAL_STATEMENT_PRESENTED",
          previousValue: { provisionalResponse: statement.provisionalResponse },
          newValue: { provisionalResponse: action.response },
          metadata: { phase: "response", confirmsStatement: action.response === "YES" },
        },
      };
    }

    case "REMOVE_RESPONSE": {
      return {
        status: "PROVISIONAL_RESPONSE",
        patch: {
          ...base,
          status: "PROVISIONAL_RESPONSE",
          provisionalResponse: null,
          respondedAt: null,
          reconfirmedAt: null,
          correctionCount: statement.correctionCount + 1,
        },
        event: {
          eventType: "FINAL_STATEMENT_EDITED",
          previousValue: { provisionalResponse: statement.provisionalResponse },
          newValue: { provisionalResponse: null },
          metadata: { phase: "response_removed" },
        },
      };
    }

    case "RECONFIRM": {
      if (statement.provisionalResponse !== "YES") {
        throw new RtqDomainError("só um SIM observado pode ser reconfirmado");
      }
      if (!statement.isSensitive) {
        throw new RtqDomainError(
          "a reconfirmação reforçada só existe em frase sensível"
        );
      }
      return {
        status: "RECONFIRMATION_PENDING",
        patch: { ...base, status: "RECONFIRMATION_PENDING", reconfirmedAt: now },
        event: {
          eventType: "FINAL_STATEMENT_PRESENTED",
          previousValue: { status: statement.status },
          newValue: { status: "RECONFIRMATION_PENDING" },
          metadata: {
            sensitive: true,
            sensitiveCategory: statement.sensitiveCategory,
          },
        },
      };
    }

    case "CONFIRM": {
      // O portão único da confirmação. Sem SIM observado, nada passa.
      if (statement.provisionalResponse !== "YES") {
        throw new RtqDomainError(
          "somente SIM confirma a frase: TALVEZ e NÃO não confirmam"
        );
      }
      if (statement.isSensitive && !statement.reconfirmedAt) {
        throw new RtqDomainError(
          "frase sensível exige reconfirmação antes de ser confirmada"
        );
      }
      return {
        status: "CONFIRMED",
        patch: {
          ...base,
          status: "CONFIRMED",
          confirmedResponse: "YES",
          confirmedAt: now,
        },
        event: {
          eventType: "FINAL_STATEMENT_CONFIRMED",
          previousValue: { status: statement.status, confirmedResponse: null },
          newValue: {
            status: "CONFIRMED",
            confirmedResponse: "YES",
            text: statement.presentedText || statement.currentText,
          },
          metadata: {
            sensitive: statement.isSensitive,
            sensitiveCategory: statement.sensitiveCategory,
          },
        },
      };
    }

    case "MARK_REPLACED": {
      return {
        status: "REPLACED",
        patch: {
          ...base,
          status: "REPLACED",
          replacedByStatementId: action.replacedByStatementId,
          replacedAt: now,
        },
        event: {
          eventType: "FINAL_STATEMENT_REPLACED",
          previousValue: {
            status: statement.status,
            text: statement.presentedText || statement.currentText,
            // A resposta anterior fica vinculada APENAS à frase original.
            confirmedResponse: statement.confirmedResponse,
          },
          newValue: { replacedByStatementId: action.replacedByStatementId },
          metadata: null,
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
          eventType: "FINAL_STATEMENT_REJECTED",
          previousValue: {
            status: statement.status,
            provisionalResponse: statement.provisionalResponse,
          },
          newValue: { status: "CANCELED" },
          metadata: action.reason ? { reason: action.reason } : { canceled: true },
        },
      };
    }
  }
}

/**
 * NÃO observado → frase rejeitada. Fica como transição própria (e não como um
 * `RESPOND` que decide sozinho) porque rejeitar é um ato do assistente depois
 * de conferir o gesto, igual em peso à confirmação — e porque uma frase
 * rejeitada nunca pode ser tratada como comunicação confirmada (§20).
 */
export function applyStatementRejection(
  statement: OptionConversationFinalStatement,
  now: string
): StatementStateChange {
  if (statement.status !== "PROVISIONAL_RESPONSE") {
    throw new RtqDomainError(
      `ação REJECT não é permitida na frase em ${statement.status}`
    );
  }
  if (statement.provisionalResponse !== "NO") {
    throw new RtqDomainError("rejeitar exige o NÃO como resposta observada");
  }
  const change: StatementStateChange = {
    status: "REJECTED",
    patch: {
      updatedAt: now,
      status: "REJECTED",
      rejectedAt: now,
      confirmedResponse: null,
    },
    event: {
      eventType: "FINAL_STATEMENT_REJECTED",
      previousValue: { status: statement.status },
      newValue: {
        status: "REJECTED",
        text: statement.presentedText || statement.currentText,
      },
      metadata: { confirmed: false },
    },
  };
  assertStatementInvariants({
    ...statement,
    ...change.patch,
  } as OptionConversationFinalStatement);
  return change;
}

// ═══════════════════ Guardas ═══════════════════

/** Sessão encerrada não aceita caminho novo (§33). */
export function assertSessionAcceptsNewPath(status: RtqSessionStatus): void {
  if (isTerminalSessionStatus(status)) {
    throw new RtqDomainError("sessão encerrada não aceita nova conversa por opções");
  }
}

/**
 * Guarda combinada de sessão + caminho. Uma sessão pausada não aceita
 * apresentar nem registrar seleção; um caminho encerrado não aceita nada.
 */
export function assertAcceptsNodeAction(
  sessionStatus: RtqSessionStatus,
  pathStatus: PathStatus,
  kind: NodeActionKind
): void {
  if (isTerminalSessionStatus(sessionStatus)) {
    throw new RtqDomainError("sessão encerrada não aceita novas interações");
  }
  if (isTerminalPathStatus(pathStatus)) {
    // Um caminho concluído não volta a ser ativo: reutilizar cria outro (§25).
    throw new RtqDomainError(
      "esta conversa por opções já foi encerrada; reutilize o conteúdo para iniciar outra"
    );
  }
  const paused = sessionStatus === "PAUSED" || pathStatus === "PAUSED";
  if (paused && PATIENT_FACING_NODE_ACTIONS.includes(kind)) {
    throw new RtqDomainError(
      "conversa pausada: retome antes de apresentar ou registrar seleções"
    );
  }
}

export function assertAcceptsStatementAction(
  sessionStatus: RtqSessionStatus,
  pathStatus: PathStatus,
  kind: StatementActionKind
): void {
  if (isTerminalSessionStatus(sessionStatus)) {
    throw new RtqDomainError("sessão encerrada não aceita novas interações");
  }
  if (isTerminalPathStatus(pathStatus)) {
    throw new RtqDomainError(
      "esta conversa por opções já foi encerrada; reutilize o conteúdo para iniciar outra"
    );
  }
  const paused = sessionStatus === "PAUSED" || pathStatus === "PAUSED";
  if (paused && PATIENT_FACING_STATEMENT_ACTIONS.includes(kind)) {
    throw new RtqDomainError(
      "conversa pausada: retome antes de apresentar ou registrar respostas"
    );
  }
}

/**
 * Editar depois de apresentar exige uma versão corrigida (§28). Quem chama usa
 * isto para saber se pode editar no mesmo registro ou se precisa substituir —
 * a recusa em si já está em ACTION_ALLOWED_FROM.
 */
export function requiresReplacement(node: OptionConversationNode): boolean {
  return wasPresentedToPatient(node.status);
}

export function statementRequiresReplacement(
  statement: OptionConversationFinalStatement
): boolean {
  return statementWasPresented(statement.status);
}
