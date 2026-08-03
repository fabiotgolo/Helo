// ——— Trilha de auditoria: interpretação do cuidador (Fase 4.2) ———
// O cuidador digita o que entendeu de uma vocalização do paciente, apresenta,
// e o paciente responde. Antes do SIM, é interpretação — e a trilha diz isso
// com nomes próprios, para que uma leitura futura nunca confunda uma frase
// escolhida pelo paciente com uma escrita pelo cuidador.
//
// Estes nomes são gravados no banco. Renomear um deles quebraria a leitura de
// eventos já registrados — a lista só cresce.

export type CaregiverInterpretationEventType =
  | "CAREGIVER_INTERPRETATION_CREATED"
  | "CAREGIVER_INTERPRETATION_REVIEWED"
  | "CAREGIVER_INTERPRETATION_EDITED"
  | "CAREGIVER_INTERPRETATION_PRESENTED"
  | "CAREGIVER_INTERPRETATION_REPRESENTED"
  | "CAREGIVER_INTERPRETATION_CONFIRMED"
  | "CAREGIVER_INTERPRETATION_REJECTED"
  | "CAREGIVER_INTERPRETATION_REUSED"
  | "CAREGIVER_INTERPRETATION_EDIT_REQUESTED"
  | "CAREGIVER_INTERPRETATION_REPLACED"
  | "CAREGIVER_INTERPRETATION_CANCELED";

export const CAREGIVER_INTERPRETATION_EVENT_TYPES: readonly CaregiverInterpretationEventType[] =
  [
    "CAREGIVER_INTERPRETATION_CREATED",
    "CAREGIVER_INTERPRETATION_REVIEWED",
    "CAREGIVER_INTERPRETATION_EDITED",
    "CAREGIVER_INTERPRETATION_PRESENTED",
    "CAREGIVER_INTERPRETATION_REPRESENTED",
    "CAREGIVER_INTERPRETATION_CONFIRMED",
    "CAREGIVER_INTERPRETATION_REJECTED",
    "CAREGIVER_INTERPRETATION_REUSED",
    "CAREGIVER_INTERPRETATION_EDIT_REQUESTED",
    "CAREGIVER_INTERPRETATION_REPLACED",
    "CAREGIVER_INTERPRETATION_CANCELED",
  ] as const;
