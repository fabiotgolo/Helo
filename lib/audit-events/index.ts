// ——— Trilha de auditoria: tipo agregado ———
// Um arquivo por domínio, uma união só para quem grava.
//
// `writeAudit` continua sendo o ponto ÚNICO de escrita da trilha e continua
// aceitando o tipo agregado, então nenhuma máquina, store ou rota precisa saber
// de qual domínio veio o evento que está emitindo.
//
// Acrescentar um evento a uma fase toca no arquivo daquela fase e nesta lista —
// nunca num arquivo que todos os outros domínios importam.

import {
  SESSION_EVENT_TYPES,
  type SessionEventType,
} from "@/lib/audit-events/session-events";
import {
  OPTION_CONVERSATION_EVENT_TYPES,
  type OptionConversationEventType,
} from "@/lib/audit-events/option-conversation-events";
import {
  SESSION_CONTEXT_EVENT_TYPES,
  type SessionContextEventType,
} from "@/lib/audit-events/session-context-events";
import {
  CAREGIVER_INTERPRETATION_EVENT_TYPES,
  type CaregiverInterpretationEventType,
} from "@/lib/audit-events/caregiver-interpretation-events";

export {
  SESSION_EVENT_TYPES,
  type SessionEventType,
} from "@/lib/audit-events/session-events";
export {
  OPTION_CONVERSATION_EVENT_TYPES,
  type OptionConversationEventType,
} from "@/lib/audit-events/option-conversation-events";
export {
  SESSION_CONTEXT_EVENT_TYPES,
  type SessionContextEventType,
} from "@/lib/audit-events/session-context-events";
export {
  CAREGIVER_INTERPRETATION_EVENT_TYPES,
  type CaregiverInterpretationEventType,
} from "@/lib/audit-events/caregiver-interpretation-events";

export type InteractionEventType =
  | SessionEventType
  | OptionConversationEventType
  | SessionContextEventType
  | CaregiverInterpretationEventType;

export const INTERACTION_EVENT_TYPES: readonly InteractionEventType[] = [
  ...SESSION_EVENT_TYPES,
  ...OPTION_CONVERSATION_EVENT_TYPES,
  ...SESSION_CONTEXT_EVENT_TYPES,
  ...CAREGIVER_INTERPRETATION_EVENT_TYPES,
] as const;

export function isInteractionEventType(v: unknown): v is InteractionEventType {
  return (
    typeof v === "string" &&
    (INTERACTION_EVENT_TYPES as readonly string[]).includes(v)
  );
}
