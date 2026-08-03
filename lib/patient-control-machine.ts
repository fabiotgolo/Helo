// ——— Controles do paciente: máquina de estados (Fase 4.7) ———
// Módulo PURO, no mesmo contrato das outras máquinas: recebe o pedido, devolve
// `{status, patch, event}` e não escreve nada.
//
// Três regras estão travadas aqui, e não na interface:
//
//   1. abrir o painel não confirma nada — a seleção passa por conferência do
//      cuidador, como toda seleção do paciente neste produto;
//   2. ENCERRAR nunca vai direto a executado: passa por uma pergunta fechada
//      ("Deseja encerrar a conversa?"), e só o SIM segue adiante (§29);
//   3. "Voltar para a conversa" fecha o painel sem executar nada e sem emitir
//      qualquer evento de RESPOSTA do paciente — é ação operacional do
//      cuidador, e a trilha diz isso.

import {
  assertPatientControlInvariants,
  isTerminalControlStatus,
  levelOfCommand,
  PATIENT_COMMAND_LEVELS,
  RtqDomainError,
  type ControlLevel,
  type PatientCommand,
  type PatientControlRequest,
  type PatientControlStatus,
} from "@/lib/patient-control-types";
import type { InteractionEventType } from "@/lib/audit-events";
import {
  isSemanticResponse,
  isTerminalSessionStatus,
  type RtqSessionStatus,
  type SemanticResponse,
} from "@/lib/realtime-question-types";

export const ALLOWED_CONTROL_TRANSITIONS: Record<
  PatientControlStatus,
  readonly PatientControlStatus[]
> = {
  OPEN: ["PRESENTED", "CLOSED", "CANCELED"],
  PRESENTED: ["AWAITING_SELECTION", "PRESENTED", "CLOSED", "CANCELED"],
  AWAITING_SELECTION: [
    "PROVISIONAL_SELECTION",
    "PRESENTED",
    "CLOSED",
    "CANCELED",
  ],
  PROVISIONAL_SELECTION: [
    "PROVISIONAL_SELECTION", // o cuidador corrige o que observou
    "AWAITING_SELECTION", // cancela a seleção
    "CONFIRMED",
    "CLOSED",
    "CANCELED",
  ],
  // MAIS CONTROLES volta a PRESENTED no nível 2; ENCERRAR vai para a pergunta
  // fechada; os demais executam.
  CONFIRMED: ["EXECUTED", "END_CONFIRMATION_PENDING", "PRESENTED", "CANCELED"],
  END_CONFIRMATION_PENDING: [
    "EXECUTED", // SIM
    "PRESENTED", // TALVEZ volta aos controles
    "CANCELED", // NÃO
    "END_CONFIRMATION_PENDING", // corrige a resposta observada
  ],
  EXECUTED: [],
  CANCELED: [],
  CLOSED: [],
};

export function canTransitionControl(
  from: PatientControlStatus,
  to: PatientControlStatus
): boolean {
  return ALLOWED_CONTROL_TRANSITIONS[from].includes(to);
}

export type PatientControlAction =
  | { kind: "PRESENT" }
  /** Reapresentar os mesmos comandos, sem trocar de nível. */
  | { kind: "REPRESENT" }
  | { kind: "AWAIT_SELECTION" }
  | { kind: "SELECT_COMMAND"; command: PatientCommand }
  | { kind: "CHANGE_COMMAND"; command: PatientCommand }
  | { kind: "REMOVE_SELECTION" }
  /** Conferência: "o comando marcado corresponde ao gesto que observei". */
  | { kind: "CONFIRM_COMMAND" }
  /**
   * Abre a pergunta fechada "Deseja encerrar a conversa?" (§29). É o passo que
   * impede a seleção inicial de encerrar sozinha: entre escolher ENCERRAR e a
   * conversa acabar existe, obrigatoriamente, um SIM do paciente.
   */
  | { kind: "ASK_END_CONFIRMATION" }
  /** Resposta à pergunta fechada de encerramento (§29). */
  | { kind: "RESPOND_END"; response: SemanticResponse }
  | { kind: "EXECUTE" }
  | { kind: "CANCEL"; reason?: string }
  /** "Voltar para a conversa" — não executa nada, não registra resposta. */
  | { kind: "CLOSE" };

export type PatientControlActionKind = PatientControlAction["kind"];

export const PATIENT_CONTROL_ACTION_KINDS: readonly PatientControlActionKind[] =
  [
    "PRESENT",
    "REPRESENT",
    "AWAIT_SELECTION",
    "SELECT_COMMAND",
    "CHANGE_COMMAND",
    "REMOVE_SELECTION",
    "CONFIRM_COMMAND",
    "ASK_END_CONFIRMATION",
    "RESPOND_END",
    "EXECUTE",
    "CANCEL",
    "CLOSE",
  ] as const;

export function isPatientControlActionKind(
  v: unknown
): v is PatientControlActionKind {
  return (
    typeof v === "string" &&
    (PATIENT_CONTROL_ACTION_KINDS as readonly string[]).includes(v)
  );
}

/**
 * Ações voltadas ao paciente. Numa sessão PAUSADA elas são recusadas — mas
 * abrir e fechar o painel continuam permitidos, senão o cuidador ficaria sem
 * como sair dele depois de uma pausa pedida pelo próprio paciente.
 */
const PATIENT_FACING_CONTROL_ACTIONS: readonly PatientControlActionKind[] = [
  "PRESENT",
  "REPRESENT",
  "AWAIT_SELECTION",
  "SELECT_COMMAND",
  "CHANGE_COMMAND",
  "REMOVE_SELECTION",
  "CONFIRM_COMMAND",
  "ASK_END_CONFIRMATION",
  "RESPOND_END",
  "EXECUTE",
];

const CONTROL_ACTION_ALLOWED_FROM: Record<
  PatientControlActionKind,
  readonly PatientControlStatus[]
> = {
  PRESENT: ["OPEN", "CONFIRMED", "END_CONFIRMATION_PENDING"],
  REPRESENT: ["PRESENTED", "AWAITING_SELECTION"],
  AWAIT_SELECTION: ["PRESENTED"],
  SELECT_COMMAND: ["AWAITING_SELECTION"],
  CHANGE_COMMAND: ["PROVISIONAL_SELECTION"],
  REMOVE_SELECTION: ["PROVISIONAL_SELECTION"],
  CONFIRM_COMMAND: ["PROVISIONAL_SELECTION"],
  ASK_END_CONFIRMATION: ["CONFIRMED"],
  RESPOND_END: ["END_CONFIRMATION_PENDING"],
  EXECUTE: ["CONFIRMED", "END_CONFIRMATION_PENDING"],
  CANCEL: [
    "OPEN",
    "PRESENTED",
    "AWAITING_SELECTION",
    "PROVISIONAL_SELECTION",
    "CONFIRMED",
    "END_CONFIRMATION_PENDING",
  ],
  CLOSE: [
    "OPEN",
    "PRESENTED",
    "AWAITING_SELECTION",
    "PROVISIONAL_SELECTION",
  ],
};

export interface ControlStateChange {
  status: PatientControlStatus;
  patch: Record<string, unknown>;
  event: {
    eventType: InteractionEventType;
    previousValue: unknown;
    newValue: unknown;
    metadata: Record<string, unknown> | null;
  };
}

/** O evento que nomeia o PEDIDO do paciente, por comando. */
export const PATIENT_REQUEST_EVENT: Record<
  PatientCommand,
  InteractionEventType | null
> = {
  PAUSE: "PATIENT_REQUESTED_PAUSE",
  REPEAT: "PATIENT_REQUESTED_REPEAT",
  NOT_UNDERSTOOD: "PATIENT_REPORTED_NOT_UNDERSTOOD",
  CHANGE_SUBJECT: "PATIENT_REQUESTED_SUBJECT_CHANGE",
  END_CONVERSATION: "PATIENT_REQUESTED_SESSION_END",
  // Ver o resto dos controles não é um pedido sobre a conversa.
  MORE_CONTROLS: null,
};

export function applyPatientControlAction(
  request: PatientControlRequest,
  action: PatientControlAction,
  now: string
): ControlStateChange {
  if (isTerminalControlStatus(request.status)) {
    throw new RtqDomainError("este pedido de controles já foi encerrado");
  }
  const allowed = CONTROL_ACTION_ALLOWED_FROM[action.kind];
  if (!allowed.includes(request.status)) {
    throw new RtqDomainError(
      `ação ${action.kind} não é permitida com o painel em ${request.status}`
    );
  }

  const change = build(request, action, now);
  if (!canTransitionControl(request.status, change.status)) {
    throw new RtqDomainError(
      `transição de controles inválida: ${request.status} → ${change.status}`
    );
  }
  assertPatientControlInvariants({
    ...request,
    ...(change.patch as Partial<PatientControlRequest>),
  });
  return change;
}

function build(
  request: PatientControlRequest,
  action: PatientControlAction,
  now: string
): ControlStateChange {
  const base = { updatedAt: now };

  switch (action.kind) {
    case "PRESENT": {
      // Vindo de CONFIRMED com MAIS CONTROLES, o nível avança e a seleção
      // anterior é zerada: o comando já foi cumprido ao trocar de nível.
      const subindoDeNivel =
        request.status === "CONFIRMED" &&
        request.confirmedCommand === "MORE_CONTROLS";
      const level: ControlLevel = subindoDeNivel ? 2 : request.level;
      return {
        status: "PRESENTED",
        patch: {
          ...base,
          status: "PRESENTED",
          level,
          interactionMode: "OPTION_SELECTION",
          provisionalCommand: null,
          confirmedCommand: null,
          endResponse: null,
          presentedAt: now,
          selectedAt: null,
          confirmedAt: null,
        },
        event: {
          eventType: "PATIENT_CONTROL_PRESENTED",
          previousValue: { level: request.level, status: request.status },
          newValue: { level, status: "PRESENTED" },
          metadata: { commands: PATIENT_COMMAND_LEVELS[level] },
        },
      };
    }

    case "REPRESENT": {
      return {
        status: "PRESENTED",
        patch: {
          ...base,
          status: "PRESENTED",
          presentedAt: now,
          representCount: request.representCount + 1,
        },
        event: {
          eventType: "PATIENT_CONTROL_PRESENTED",
          previousValue: { representCount: request.representCount },
          newValue: { representCount: request.representCount + 1 },
          metadata: { commands: PATIENT_COMMAND_LEVELS[request.level] },
        },
      };
    }

    case "AWAIT_SELECTION": {
      return {
        status: "AWAITING_SELECTION",
        patch: { ...base, status: "AWAITING_SELECTION", provisionalCommand: null },
        event: {
          eventType: "PATIENT_CONTROL_PRESENTED",
          previousValue: { status: request.status },
          newValue: { status: "AWAITING_SELECTION" },
          metadata: null,
        },
      };
    }

    case "SELECT_COMMAND":
    case "CHANGE_COMMAND": {
      const command = action.command;
      if (!PATIENT_COMMAND_LEVELS[request.level].includes(command)) {
        throw new RtqDomainError(
          "este comando não está entre os apresentados agora"
        );
      }
      const changing = action.kind === "CHANGE_COMMAND";
      if (changing && command === request.provisionalCommand) {
        throw new RtqDomainError("o comando selecionado já é esse");
      }
      return {
        status: "PROVISIONAL_SELECTION",
        patch: {
          ...base,
          status: "PROVISIONAL_SELECTION",
          provisionalCommand: command,
          selectedAt: now,
          correctionCount: request.correctionCount + (changing ? 1 : 0),
        },
        event: {
          eventType: "PATIENT_CONTROL_SELECTED",
          previousValue: { provisionalCommand: request.provisionalCommand },
          newValue: { provisionalCommand: command },
          metadata: { level: request.level, corrigindo: changing },
        },
      };
    }

    case "REMOVE_SELECTION": {
      return {
        status: "AWAITING_SELECTION",
        patch: {
          ...base,
          status: "AWAITING_SELECTION",
          provisionalCommand: null,
          selectedAt: null,
          correctionCount: request.correctionCount + 1,
        },
        event: {
          eventType: "PATIENT_CONTROL_SELECTED",
          previousValue: { provisionalCommand: request.provisionalCommand },
          newValue: { provisionalCommand: null },
          metadata: { phase: "selecao_removida" },
        },
      };
    }

    case "CONFIRM_COMMAND": {
      const command = request.provisionalCommand;
      if (!command) {
        throw new RtqDomainError("não há comando observado para conferir");
      }
      return {
        status: "CONFIRMED",
        patch: {
          ...base,
          status: "CONFIRMED",
          confirmedCommand: command,
          confirmedAt: now,
        },
        event: {
          eventType: "PATIENT_CONTROL_CONFIRMED",
          previousValue: { status: request.status },
          newValue: { status: "CONFIRMED", confirmedCommand: command },
          metadata: { level: request.level },
        },
      };
    }

    case "ASK_END_CONFIRMATION": {
      if (request.confirmedCommand !== "END_CONVERSATION") {
        throw new RtqDomainError(
          "só o comando de encerrar abre a confirmação final"
        );
      }
      return {
        status: "END_CONFIRMATION_PENDING",
        patch: {
          ...base,
          status: "END_CONFIRMATION_PENDING",
          // Aqui, e só aqui, os três sinais voltam a significar SIM/TALVEZ/NÃO:
          // a pergunta "Deseja encerrar a conversa?" é fechada de verdade.
          interactionMode: "CLOSED_CONFIRMATION",
          endResponse: null,
          presentedAt: now,
        },
        event: {
          eventType: "PATIENT_CONTROL_PRESENTED",
          previousValue: { interactionMode: request.interactionMode },
          newValue: {
            status: "END_CONFIRMATION_PENDING",
            interactionMode: "CLOSED_CONFIRMATION",
          },
          metadata: { question: "Deseja encerrar a conversa?" },
        },
      };
    }

    case "RESPOND_END": {
      if (!isSemanticResponse(action.response)) {
        throw new RtqDomainError("resposta semântica inválida");
      }
      // TALVEZ e NÃO param aqui: nenhum dos dois encerra a conversa.
      if (action.response === "YES") {
        return {
          status: "END_CONFIRMATION_PENDING",
          patch: { ...base, endResponse: "YES" },
          event: {
            eventType: "PATIENT_CONTROL_CONFIRMED",
            previousValue: { endResponse: request.endResponse },
            newValue: { endResponse: "YES" },
            metadata: { note: "o paciente confirmou que deseja encerrar" },
          },
        };
      }
      if (action.response === "MAYBE") {
        return {
          status: "PRESENTED",
          patch: {
            ...base,
            status: "PRESENTED",
            level: 1,
            interactionMode: "OPTION_SELECTION",
            endResponse: null,
            provisionalCommand: null,
            confirmedCommand: null,
            presentedAt: now,
            confirmedAt: null,
          },
          event: {
            eventType: "PATIENT_CONTROL_PRESENTED",
            previousValue: { endResponse: request.endResponse },
            newValue: { status: "PRESENTED", level: 1 },
            metadata: { note: "TALVEZ na confirmação final volta aos controles" },
          },
        };
      }
      return {
        status: "CANCELED",
        patch: {
          ...base,
          status: "CANCELED",
          endResponse: null,
          confirmedCommand: null,
          provisionalCommand: null,
          canceledAt: now,
        },
        event: {
          eventType: "PATIENT_CONTROL_CANCELED",
          previousValue: { confirmedCommand: "END_CONVERSATION" },
          newValue: { status: "CANCELED" },
          metadata: { note: "NÃO na confirmação final: a conversa continua" },
        },
      };
    }

    case "EXECUTE": {
      const command = request.confirmedCommand;
      if (!command) {
        throw new RtqDomainError("não há comando confirmado para executar");
      }
      if (command === "END_CONVERSATION" && request.endResponse !== "YES") {
        // A regra mais importante desta fase: a seleção inicial não encerra.
        throw new RtqDomainError(
          "encerrar exige a confirmação final do paciente"
        );
      }
      if (command === "MORE_CONTROLS") {
        throw new RtqDomainError(
          "ver mais controles não é executado: o painel apresenta o nível 2"
        );
      }
      const patch: Record<string, unknown> = {
        ...base,
        status: "EXECUTED",
        executedAt: now,
      };
      if (command === "NOT_UNDERSTOOD") patch.notUnderstoodAt = now;
      if (command === "CHANGE_SUBJECT") patch.subjectChangedAt = now;
      return {
        status: "EXECUTED",
        patch,
        event: {
          eventType: "PATIENT_CONTROL_EXECUTED",
          previousValue: { status: request.status },
          newValue: { status: "EXECUTED", confirmedCommand: command },
          metadata: {
            targetType: request.targetType,
            targetId: request.targetId,
          },
        },
      };
    }

    case "CANCEL": {
      return {
        status: "CANCELED",
        patch: {
          ...base,
          status: "CANCELED",
          provisionalCommand: null,
          confirmedCommand: null,
          endResponse: null,
          canceledAt: now,
        },
        event: {
          eventType: "PATIENT_CONTROL_CANCELED",
          previousValue: {
            status: request.status,
            provisionalCommand: request.provisionalCommand,
          },
          newValue: { status: "CANCELED" },
          metadata: action.reason ? { reason: action.reason } : null,
        },
      };
    }

    case "CLOSE": {
      // Fechar não é resposta do paciente e não executa nada. A interação em
      // curso continua exatamente onde estava.
      return {
        status: "CLOSED",
        patch: {
          ...base,
          status: "CLOSED",
          provisionalCommand: null,
          closedAt: now,
        },
        event: {
          eventType: "PATIENT_CONTROLS_CLOSED",
          previousValue: {
            status: request.status,
            provisionalCommand: request.provisionalCommand,
          },
          newValue: { status: "CLOSED" },
          metadata: {
            note: "nenhuma resposta do paciente foi registrada",
          },
        },
      };
    }
  }
}

/**
 * Sessão pausada não recebe ação voltada ao paciente — mas abrir e fechar o
 * painel continuam livres. Sessão encerrada não recebe nada.
 */
export function assertSessionAcceptsControlAction(
  sessionStatus: RtqSessionStatus,
  kind: PatientControlActionKind
): void {
  if (isTerminalSessionStatus(sessionStatus)) {
    throw new RtqDomainError(
      "esta sessão já foi encerrada: os controles não operam mais"
    );
  }
  if (
    sessionStatus === "PAUSED" &&
    PATIENT_FACING_CONTROL_ACTIONS.includes(kind)
  ) {
    throw new RtqDomainError(
      "sessão pausada: retome a sessão antes de operar os controles"
    );
  }
}

export function assertSessionAcceptsNewControlRequest(
  sessionStatus: RtqSessionStatus
): void {
  if (isTerminalSessionStatus(sessionStatus)) {
    throw new RtqDomainError(
      "esta sessão já foi encerrada: não é possível abrir os controles"
    );
  }
}

export { levelOfCommand };
