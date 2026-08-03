// ——— Trilha de auditoria: controles diretos do paciente (Fase 4.7) ———
// Pausar, repetir, dizer que não entendeu, mudar de assunto, encerrar.
//
// Estes eventos existem para responder a uma pergunta que nenhum outro evento
// responde: QUEM PEDIU. Uma pausa registrada por SESSION_PAUSED diz que a
// sessão parou; PATIENT_REQUESTED_PAUSE diz que quem pediu para parar foi o
// paciente. Por isso a execução de um comando grava os dois.
//
// Estes nomes são gravados no banco. Renomear um deles quebraria a leitura de
// eventos já registrados — a lista só cresce.

export type PatientControlEventType =
  // Ciclo do painel
  | "PATIENT_CONTROLS_OPENED"
  /** "Voltar para a conversa" — operacional, do cuidador. NUNCA é resposta. */
  | "PATIENT_CONTROLS_CLOSED"
  | "PATIENT_CONTROL_PRESENTED"
  | "PATIENT_CONTROL_SELECTED"
  | "PATIENT_CONTROL_CONFIRMED"
  | "PATIENT_CONTROL_EXECUTED"
  | "PATIENT_CONTROL_CANCELED"
  // O pedido do paciente, por comando
  | "PATIENT_REQUESTED_PAUSE"
  | "PATIENT_REQUESTED_REPEAT"
  | "PATIENT_REPORTED_NOT_UNDERSTOOD"
  | "PATIENT_REQUESTED_SUBJECT_CHANGE"
  | "PATIENT_REQUESTED_SESSION_END";

export const PATIENT_CONTROL_EVENT_TYPES: readonly PatientControlEventType[] = [
  "PATIENT_CONTROLS_OPENED",
  "PATIENT_CONTROLS_CLOSED",
  "PATIENT_CONTROL_PRESENTED",
  "PATIENT_CONTROL_SELECTED",
  "PATIENT_CONTROL_CONFIRMED",
  "PATIENT_CONTROL_EXECUTED",
  "PATIENT_CONTROL_CANCELED",
  "PATIENT_REQUESTED_PAUSE",
  "PATIENT_REQUESTED_REPEAT",
  "PATIENT_REPORTED_NOT_UNDERSTOOD",
  "PATIENT_REQUESTED_SUBJECT_CHANGE",
  "PATIENT_REQUESTED_SESSION_END",
] as const;
