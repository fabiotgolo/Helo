// ——— A invariável de autoria ———
//
// Uma frase só é FALA DO PACIENTE quando o próprio paciente a confirmou.
// Este módulo é o único caminho para afirmar isso: `ConfirmedPatientStatement`
// carrega uma marca que nenhum outro arquivo consegue escrever, porque o
// símbolo que a nomeia não é exportado. Fora daqui, só um `as` explícito —
// visível em revisão — forjaria o tipo.
//
// O que este portão recusa, por construção:
//
//   • rascunho e texto em construção — o que vale é o texto CONGELADO na
//     apresentação (`presentedText`), o único que o paciente de fato viu e
//     ouviu antes de responder. `currentText` continua editável depois da
//     apresentação, e por isso nunca vira fala confirmada;
//   • TALVEZ e NÃO — só SIM confirma (§20), e a confirmação não pode divergir
//     da resposta observada;
//   • frase sensível sem a reconfirmação reforçada concluída;
//   • frase sem vínculo íntegro com sessão, caminho, paciente e assistente;
//   • origem desconhecida, ou origem que não corresponde ao modo sob o qual a
//     frase foi apresentada — o par é conferido NOS DOIS SENTIDOS.
//
// AUTORIA ≠ FORMULAÇÃO (Fase 4.2). Uma frase pode nascer de duas maneiras: o
// paciente a escolheu entre opções, ou o cuidador a digitou como interpretação
// do que entendeu. Nos dois casos, quem CONFIRMA é o paciente, e só o SIM dele
// confirma — mas quem FORMULOU o texto é diferente, e isso não pode se perder
// na confirmação. Por isso o valor devolvido carrega `origin` e
// `textFormulatedBy`, e a interface pergunta a `rotuloDeAutoria` em vez de
// escrever a frase de autoria por conta própria.
//
// O construtor aceita APENAS um `OptionConversationFinalStatement` já
// persistido. Ele não aceita string, contexto de sessão, comando do paciente,
// rascunho nem interpretação do cuidador: não há sobrecarga que receba texto
// solto, justamente para que nenhuma dessas origens consiga produzir fala
// confirmada sem passar pela confirmação real.

import {
  assertStatementInvariants,
  isStatementOrigin,
  MODO_POR_ORIGEM,
  RtqDomainError,
  type OptionConversationFinalStatement,
  type SensitiveCategory,
  type StatementOrigin,
} from "@/lib/option-conversation-types";

// Marca em tempo de execução e de compilação. Não é exportada: de fora deste
// módulo, a propriedade não tem nome — logo, o objeto não tem como ser montado.
const AUTHORSHIP = Symbol("ConfirmedPatientStatement");

/**
 * Fala confirmada do paciente. Só existe quando `toConfirmedPatientStatement`
 * atestou uma confirmação válida — a posse deste tipo É a prova de autoria.
 */
export interface ConfirmedPatientStatement {
  readonly [AUTHORSHIP]: true;

  readonly statementId: string;
  readonly sessionId: string;
  readonly pathId: string;
  readonly patientId: number;
  readonly assistantId: string;

  /** O texto congelado na apresentação — nunca uma edição posterior. */
  readonly text: string;

  readonly isSensitive: boolean;
  readonly sensitiveCategory: SensitiveCategory | null;

  /** Como o texto nasceu. Preservado: o SIM confirma o conteúdo, não a origem. */
  readonly origin: StatementOrigin;
  /** Quem escreveu o texto — nunca quem o confirmou, que é sempre o paciente. */
  readonly textFormulatedBy: "PATIENT_BY_CHOICE" | "CAREGIVER";

  readonly confirmedAt: string;
  /** Preenchido quando o conteúdo é sensível; nulo quando não é. */
  readonly reconfirmedAt: string | null;
}

function reject(motivo: string): never {
  throw new RtqDomainError(`sem confirmação válida do paciente: ${motivo}`);
}

function preenchido(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * O portão único da autoria. Devolve a fala confirmada ou lança
 * `RtqDomainError` — nunca devolve algo parcial.
 *
 * Rejeita tudo o que não seja uma confirmação real e completa do paciente.
 */
export function toConfirmedPatientStatement(
  statement: OptionConversationFinalStatement
): ConfirmedPatientStatement {
  // Defesa em profundidade: as invariáveis já vigentes valem aqui também, e
  // uma frase incoerente é recusada antes de qualquer leitura de autoria.
  assertStatementInvariants(statement);

  // 1. Estado confirmado.
  if (statement.status !== "CONFIRMED") {
    reject(`a frase está em ${statement.status}, não CONFIRMED`);
  }

  // 2. Resposta final SIM, sem divergir da observada. TALVEZ e NÃO param antes.
  if (statement.confirmedResponse !== "YES") {
    reject("somente SIM confirma uma frase");
  }
  if (statement.provisionalResponse !== "YES") {
    reject("a confirmação não corresponde à resposta observada");
  }
  if (!preenchido(statement.confirmedAt)) {
    reject("falta o horário da confirmação");
  }

  // 3. Reconfirmação reforçada concluída quando o conteúdo é sensível.
  if (statement.isSensitive && !preenchido(statement.reconfirmedAt)) {
    reject("frase sensível exige a reconfirmação reforçada concluída");
  }

  // 4. Vínculo íntegro com sessão, caminho, paciente e assistente.
  if (!preenchido(statement.id)) reject("frase sem identificador");
  if (!preenchido(statement.sessionId)) reject("frase sem sessão");
  if (!preenchido(statement.pathId)) reject("frase sem caminho");
  if (!Number.isInteger(statement.patientId) || statement.patientId <= 0) {
    reject("frase sem paciente válido");
  }
  if (!preenchido(statement.assistantId)) reject("frase sem assistente");

  // 5. Origem permitida, conferida NOS DOIS SENTIDOS contra a fonte única.
  //    Uma origem desconhecida não passa, e um par inconsistente — origem de
  //    interpretação alegando o modo da frase final, ou o contrário — também
  //    não. É o que impede um documento adulterado de trocar a autoria do
  //    texto sem que o portão perceba.
  if (!isStatementOrigin(statement.origin)) {
    reject("origem desconhecida");
  }
  if (MODO_POR_ORIGEM[statement.origin] !== statement.interactionMode) {
    reject(
      `origem e modo não correspondem (${statement.origin} ≠ ${statement.interactionMode})`
    );
  }

  // 6. O texto é o que foi APRESENTADO. Uma frase confirmada sempre passou pela
  //    apresentação, que congela o texto; sem ele, não há o que atribuir ao
  //    paciente — e `currentText` não serve de substituto, porque pode ter sido
  //    editado depois que ele respondeu.
  if (!preenchido(statement.presentedText)) {
    reject("a frase confirmada não tem texto apresentado");
  }

  return {
    [AUTHORSHIP]: true,
    statementId: statement.id,
    sessionId: statement.sessionId,
    pathId: statement.pathId,
    patientId: statement.patientId,
    assistantId: statement.assistantId,
    text: statement.presentedText,
    isSensitive: statement.isSensitive,
    sensitiveCategory: statement.sensitiveCategory,
    origin: statement.origin,
    textFormulatedBy:
      statement.origin === "CAREGIVER_INTERPRETATION"
        ? "CAREGIVER"
        : "PATIENT_BY_CHOICE",
    confirmedAt: statement.confirmedAt,
    reconfirmedAt: statement.reconfirmedAt,
  };
}

/**
 * A frase de autoria que a interface deve exibir.
 *
 * Existe para que nenhuma tela escreva "Confirmada pelo paciente" por conta
 * própria e acabe omitindo que o texto foi formulado pelo cuidador. Quem tem a
 * fala confirmada em mãos pergunta aqui.
 */
export function rotuloDeAutoria(fala: ConfirmedPatientStatement): string {
  return fala.textFormulatedBy === "CAREGIVER"
    ? "Confirmada pelo paciente · texto formulado pelo cuidador."
    : "Confirmada pelo paciente.";
}

/**
 * Versão silenciosa para a interface: devolve `null` em vez de lançar, para
 * uma tela poder perguntar "isto já é fala do paciente?" sem tratar exceção.
 * A regra é exatamente a mesma — não existe caminho mais permissivo.
 */
export function tryToConfirmedPatientStatement(
  statement: OptionConversationFinalStatement | null | undefined
): ConfirmedPatientStatement | null {
  if (!statement) return null;
  try {
    return toConfirmedPatientStatement(statement);
  } catch (e) {
    if (e instanceof RtqDomainError) return null;
    throw e;
  }
}

/** Reconhece a fala confirmada pela marca — não pela forma do objeto. */
export function isConfirmedPatientStatement(
  value: unknown
): value is ConfirmedPatientStatement {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[AUTHORSHIP] === true
  );
}
