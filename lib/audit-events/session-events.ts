// ——— Trilha de auditoria: sessão e pergunta fechada (Fases 1–4) ———
// Os marcos da sessão de Perguntas em tempo real e do ciclo de uma pergunta
// fechada: apresentar, observar a resposta, conferir, reconfirmar, registrar
// gesto incerto ou ausência de resposta.
//
// Estes nomes são gravados no banco. Renomear um deles quebraria a leitura de
// eventos já registrados — a lista só cresce.

export type SessionEventType =
  | "SESSION_STARTED"
  | "SESSION_PAUSED"
  | "SESSION_RESUMED"
  | "SESSION_COMPLETED"
  | "SESSION_ABANDONED"
  | "QUESTION_CREATED"
  | "QUESTION_REVIEWED"
  | "QUESTION_PRESENTED"
  | "RESPONSE_SELECTED"
  | "RESPONSE_CHANGED"
  | "RESPONSE_REMOVED"
  | "RESPONSE_VERIFIED"
  | "RESPONSE_RECONFIRMED"
  | "UNCERTAIN_GESTURE_RECORDED"
  | "NO_RESPONSE_RECORDED"
  | "QUESTION_REPRESENTED"
  | "QUESTION_CANCELED"
  /**
   * Mudança do significado dos três sinais do paciente. Vive aqui, e não num
   * domínio específico, porque o modo é uma propriedade da sessão: é ele que
   * diz se o segundo gesto significa TALVEZ ou "opção 2".
   */
  | "INTERACTION_MODE_SELECTED";

export const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  "SESSION_STARTED",
  "SESSION_PAUSED",
  "SESSION_RESUMED",
  "SESSION_COMPLETED",
  "SESSION_ABANDONED",
  "QUESTION_CREATED",
  "QUESTION_REVIEWED",
  "QUESTION_PRESENTED",
  "RESPONSE_SELECTED",
  "RESPONSE_CHANGED",
  "RESPONSE_REMOVED",
  "RESPONSE_VERIFIED",
  "RESPONSE_RECONFIRMED",
  "UNCERTAIN_GESTURE_RECORDED",
  "NO_RESPONSE_RECORDED",
  "QUESTION_REPRESENTED",
  "QUESTION_CANCELED",
  "INTERACTION_MODE_SELECTED",
] as const;
