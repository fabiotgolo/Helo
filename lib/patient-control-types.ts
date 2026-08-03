// ——— Controles diretos do paciente: tipos do domínio (Fase 4.7) ———
// Módulo neutro (sem imports de servidor), irmão de option-conversation-types.ts.
//
// Até aqui, quem controlava o ritmo e a direção da conversa era sempre o
// cuidador: ele pausava, repetia, mudava de assunto e encerrava. O paciente
// respondia. Esta fase devolve esses cinco comandos a quem está conversando:
//
//   PAUSAR · REPETIR · NÃO ENTENDI · MUDAR DE ASSUNTO · ENCERRAR
//
// Nenhum deles depende de IA, de rede além da própria sessão, ou de qualquer
// interpretação: o paciente escolhe com os mesmos três gestos de sempre, e o
// cuidador confere o gesto observado antes de qualquer coisa acontecer.
//
// SÃO CINCO COMANDOS E TRÊS GESTOS. Por isso existem dois níveis, e por isso
// "MAIS CONTROLES" é um comando de verdade e não um detalhe de tela: o
// paciente o selecionou, e a trilha precisa registrar que ele pediu para ver
// o resto.
//
// O QUE ESTA ENTIDADE NÃO É: ela não tem texto apresentado nem resposta
// confirmada, e não é aceita pelo portão de autoria. Um comando NUNCA vira
// fala do paciente — pedir para pausar não é dizer nada.

import {
  RtqDomainError,
  type InteractionMode,
  type SemanticResponse,
} from "@/lib/realtime-question-types";

export { RtqDomainError };

// ---------- Comandos ----------

export type PatientCommand =
  | "PAUSE"
  | "REPEAT"
  | "MORE_CONTROLS"
  | "NOT_UNDERSTOOD"
  | "CHANGE_SUBJECT"
  | "END_CONVERSATION";

export type ControlLevel = 1 | 2;

/**
 * A ordem importa: é ela que amarra "primeiro gesto" a "primeiro comando".
 * Mudar a ordem mudaria o que o gesto do paciente significa.
 */
export const PATIENT_COMMAND_LEVELS: Readonly<
  Record<ControlLevel, readonly PatientCommand[]>
> = Object.freeze({
  1: ["PAUSE", "REPEAT", "MORE_CONTROLS"],
  2: ["NOT_UNDERSTOOD", "CHANGE_SUBJECT", "END_CONVERSATION"],
} as const);

export const PATIENT_COMMAND_LABELS: Record<PatientCommand, string> = {
  PAUSE: "PAUSAR",
  REPEAT: "REPETIR",
  MORE_CONTROLS: "MAIS CONTROLES",
  NOT_UNDERSTOOD: "NÃO ENTENDI",
  CHANGE_SUBJECT: "MUDAR DE ASSUNTO",
  END_CONVERSATION: "ENCERRAR",
};

/** Frase do paciente que cada comando representa — usada na conferência. */
export const PATIENT_COMMAND_MEANINGS: Record<PatientCommand, string> = {
  PAUSE: "Quero pausar",
  REPEAT: "Repita, por favor",
  MORE_CONTROLS: "Quero ver mais controles",
  NOT_UNDERSTOOD: "Não entendi",
  CHANGE_SUBJECT: "Quero mudar de assunto",
  END_CONVERSATION: "Quero encerrar",
};

export const PATIENT_COMMANDS: readonly PatientCommand[] = [
  ...PATIENT_COMMAND_LEVELS[1],
  ...PATIENT_COMMAND_LEVELS[2],
] as const;

export function isPatientCommand(v: unknown): v is PatientCommand {
  return (
    typeof v === "string" && (PATIENT_COMMANDS as readonly string[]).includes(v)
  );
}

export function levelOfCommand(command: PatientCommand): ControlLevel {
  return PATIENT_COMMAND_LEVELS[1].includes(command) ? 1 : 2;
}

// ---------- Estados ----------

export type PatientControlStatus =
  | "OPEN"
  | "PRESENTED"
  | "AWAITING_SELECTION"
  | "PROVISIONAL_SELECTION"
  | "CONFIRMED"
  /** Só de ENCERRAR: o SIM/TALVEZ/NÃO final antes de encerrar de verdade. */
  | "END_CONFIRMATION_PENDING"
  | "EXECUTED"
  | "CANCELED"
  /** "Voltar para a conversa": o painel fecha sem nada ter acontecido. */
  | "CLOSED";

export const TERMINAL_CONTROL_STATUSES: readonly PatientControlStatus[] = [
  "EXECUTED",
  "CANCELED",
  "CLOSED",
] as const;

export function isTerminalControlStatus(s: PatientControlStatus): boolean {
  return TERMINAL_CONTROL_STATUSES.includes(s);
}

/** O que o comando vai operar quando for executado. */
export type ControlTargetType = "TURN" | "NODE" | "STATEMENT";

export function isControlTargetType(v: unknown): v is ControlTargetType {
  return v === "TURN" || v === "NODE" || v === "STATEMENT";
}

// ---------- Entidade ----------

export interface PatientControlRequest {
  id: string;
  sessionId: string;
  patientId: number;
  assistantId: string;

  level: ControlLevel;
  /**
   * Nos níveis, OPTION_SELECTION: os três sinais significam comando 1, 2 e 3 —
   * e NUNCA SIM/TALVEZ/NÃO. Só a confirmação final de ENCERRAR volta a
   * CLOSED_CONFIRMATION, porque ali a pergunta é fechada de verdade.
   */
  interactionMode: Extract<
    InteractionMode,
    "OPTION_SELECTION" | "CLOSED_CONFIRMATION"
  >;

  status: PatientControlStatus;

  provisionalCommand: PatientCommand | null;
  confirmedCommand: PatientCommand | null;
  /** Resposta à pergunta "Deseja encerrar a conversa?" (§29). */
  endResponse: SemanticResponse | null;

  /** O que estava no ar quando o painel abriu — alvo de REPETIR e do resto. */
  targetType: ControlTargetType | null;
  targetId: string | null;
  targetPathId: string | null;

  notUnderstoodAt: string | null;
  subjectChangedAt: string | null;

  presentedAt: string | null;
  selectedAt: string | null;
  confirmedAt: string | null;
  executedAt: string | null;
  canceledAt: string | null;
  closedAt: string | null;

  representCount: number;
  correctionCount: number;

  clientRequestId: string | null;

  createdAt: string;
  updatedAt: string;
}

export function assertPatientControlInvariants(
  request: PatientControlRequest
): void {
  const bad = (msg: string): never => {
    throw new RtqDomainError(msg);
  };

  if (!request.sessionId) bad("o pedido precisa pertencer a uma sessão");
  if (!Number.isInteger(request.patientId) || request.patientId <= 0) {
    bad("pedido sem paciente válido");
  }
  if (!request.assistantId) bad("pedido sem assistente");
  if (request.level !== 1 && request.level !== 2) bad("nível de controles inválido");
  if (request.representCount < 0) bad("representCount inválido");
  if (request.correctionCount < 0) bad("correctionCount inválido");

  const noNivel = (c: PatientCommand | null) =>
    c === null || PATIENT_COMMAND_LEVELS[request.level].includes(c);
  if (!noNivel(request.provisionalCommand)) {
    bad("o comando selecionado não pertence ao nível apresentado");
  }
  if (!noNivel(request.confirmedCommand)) {
    bad("o comando confirmado não pertence ao nível apresentado");
  }

  if (request.status === "PROVISIONAL_SELECTION" && !request.provisionalCommand) {
    bad("seleção provisória exige um comando selecionado");
  }
  if (request.status === "AWAITING_SELECTION" && request.provisionalCommand) {
    bad("aguardando seleção não pode ter comando selecionado");
  }

  if (request.confirmedCommand !== null) {
    // A conferência ATESTA o que foi observado; ela não escolhe outra coisa.
    if (request.confirmedCommand !== request.provisionalCommand) {
      bad("a confirmação não pode alterar o comando observado");
    }
    if (!request.confirmedAt) bad("comando confirmado exige horário");
  }

  if (request.status === "END_CONFIRMATION_PENDING") {
    // Encerrar NUNCA acontece com a seleção inicial: é preciso um SIM na
    // pergunta fechada que vem depois (§29).
    if (request.confirmedCommand !== "END_CONVERSATION") {
      bad("a confirmação final só existe para o comando de encerrar");
    }
    if (request.interactionMode !== "CLOSED_CONFIRMATION") {
      bad("a confirmação final de encerrar é uma pergunta fechada");
    }
  }

  if (request.status === "EXECUTED") {
    if (!request.confirmedCommand) bad("comando executado exige confirmação");
    if (!request.executedAt) bad("comando executado exige horário");
    if (
      request.confirmedCommand === "END_CONVERSATION" &&
      request.endResponse !== "YES"
    ) {
      bad("encerrar só é executado depois do SIM na confirmação final");
    }
  }

  if (
    request.endResponse !== null &&
    request.confirmedCommand !== "END_CONVERSATION"
  ) {
    bad("só o comando de encerrar registra resposta de confirmação final");
  }
}
