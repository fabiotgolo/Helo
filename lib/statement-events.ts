// ——— Nome do evento de uma frase, por origem (Fase 4.2) ———
//
// Uma frase escolhida entre opções e uma interpretação digitada pelo cuidador
// percorrem o MESMO ciclo, mas não podem deixar o mesmo rastro: quem lê a
// trilha depois precisa distinguir, sem interpretar campos, o que o paciente
// escolheu do que o cuidador escreveu.
//
// Este módulo é só um mapa. Ele não DECLARA nome nenhum — os nomes vivem em
// lib/audit-events/, um arquivo por domínio. Por isso ele fica fora de lá.
//
// Para OPTION_PATH os nomes devolvidos são EXATAMENTE os que já existiam nas
// Fases 4.1–4.6: nenhuma trilha gravada muda de vocabulário, e nenhum teste
// existente precisou ser reescrito.

import type { InteractionEventType } from "@/lib/audit-events";
import type { StatementOrigin } from "@/lib/option-conversation-types";

/** Os marcos do ciclo de uma frase, independentes de origem. */
export type MarcoDaFrase =
  | "DRAFTED"
  | "REVIEWED"
  | "EDITED"
  | "PRESENTED"
  | "REPRESENTED"
  | "CONFIRMED"
  | "REJECTED"
  | "REUSED"
  | "EDIT_REQUESTED"
  | "REPLACED"
  | "CANCELED";

const POR_ORIGEM: Record<
  StatementOrigin,
  Record<MarcoDaFrase, InteractionEventType>
> = {
  OPTION_PATH: {
    DRAFTED: "FINAL_STATEMENT_DRAFTED",
    // A frase final nunca teve evento próprio de revisão: editar antes de
    // apresentar sempre foi FINAL_STATEMENT_EDITED. Mantido como estava.
    REVIEWED: "FINAL_STATEMENT_EDITED",
    EDITED: "FINAL_STATEMENT_EDITED",
    PRESENTED: "FINAL_STATEMENT_PRESENTED",
    REPRESENTED: "FINAL_STATEMENT_PRESENTED",
    CONFIRMED: "FINAL_STATEMENT_CONFIRMED",
    REJECTED: "FINAL_STATEMENT_REJECTED",
    REUSED: "FINAL_STATEMENT_REUSED",
    EDIT_REQUESTED: "FINAL_STATEMENT_EDIT_REQUESTED",
    REPLACED: "FINAL_STATEMENT_REPLACED",
    CANCELED: "FINAL_STATEMENT_REJECTED",
  },
  CAREGIVER_INTERPRETATION: {
    DRAFTED: "CAREGIVER_INTERPRETATION_CREATED",
    REVIEWED: "CAREGIVER_INTERPRETATION_REVIEWED",
    EDITED: "CAREGIVER_INTERPRETATION_EDITED",
    PRESENTED: "CAREGIVER_INTERPRETATION_PRESENTED",
    REPRESENTED: "CAREGIVER_INTERPRETATION_REPRESENTED",
    CONFIRMED: "CAREGIVER_INTERPRETATION_CONFIRMED",
    REJECTED: "CAREGIVER_INTERPRETATION_REJECTED",
    REUSED: "CAREGIVER_INTERPRETATION_REUSED",
    EDIT_REQUESTED: "CAREGIVER_INTERPRETATION_EDIT_REQUESTED",
    REPLACED: "CAREGIVER_INTERPRETATION_REPLACED",
    CANCELED: "CAREGIVER_INTERPRETATION_CANCELED",
  },
};

export function statementEventFor(
  origin: StatementOrigin,
  marco: MarcoDaFrase
): InteractionEventType {
  return POR_ORIGEM[origin][marco];
}
