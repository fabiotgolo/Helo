// ——— Trilha de auditoria: contexto da sessão (Fase 4.8) ———
// Com quem, para quê e onde a conversa acontece. É anotação do cuidador sobre
// a circunstância — nunca fala do paciente, nunca confirmação de nada.
//
// Estes nomes são gravados no banco. Renomear um deles quebraria a leitura de
// eventos já registrados — a lista só cresce.

export type SessionContextEventType =
  | "SESSION_CONTEXT_CREATED"
  | "SESSION_CONTEXT_EDITED"
  | "SESSION_CONTEXT_REPLACED"
  | "SESSION_CONTEXT_VIEWED"
  /**
   * "Começar sem contexto". Precisa ser um fato persistido, e não a ausência
   * de um registro: sem ele, um refresh voltaria a perguntar o que o cuidador
   * já decidiu pular — atrasando justamente a conversa urgente.
   */
  | "SESSION_CONTEXT_SKIPPED";

export const SESSION_CONTEXT_EVENT_TYPES: readonly SessionContextEventType[] = [
  "SESSION_CONTEXT_CREATED",
  "SESSION_CONTEXT_EDITED",
  "SESSION_CONTEXT_REPLACED",
  "SESSION_CONTEXT_VIEWED",
  "SESSION_CONTEXT_SKIPPED",
] as const;
