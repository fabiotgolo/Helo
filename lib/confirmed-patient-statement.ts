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
//   • origem fora de FINAL_STATEMENT_CONFIRMATION — nenhum outro modo de
//     interação produz fala confirmada.
//
// O construtor aceita APENAS um `OptionConversationFinalStatement` já
// persistido. Ele não aceita string, contexto de sessão, comando do paciente,
// rascunho nem interpretação do cuidador: não há sobrecarga que receba texto
// solto, justamente para que nenhuma dessas origens consiga produzir fala
// confirmada sem passar pela confirmação real.

import {
  assertStatementInvariants,
  RtqDomainError,
  type OptionConversationFinalStatement,
  type SensitiveCategory,
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

  // 5. Origem permitida: só a confirmação de frase final produz fala do
  //    paciente. Nenhum outro modo de interação chega aqui.
  if (statement.interactionMode !== "FINAL_STATEMENT_CONFIRMATION") {
    reject(`origem não permitida (${statement.interactionMode})`);
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
    confirmedAt: statement.confirmedAt,
    reconfirmedAt: statement.reconfirmedAt,
  };
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
