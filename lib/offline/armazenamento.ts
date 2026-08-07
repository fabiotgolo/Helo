// ——— Pressão de armazenamento e teto da fila (R10 e R13) ———
//
// Módulo PURO: sem IndexedDB, sem React, sem rede. Decide, e não executa.
//
// ——— A ordem de prioridade, e por que ela não é negociável ———
//
// O armazenamento local guarda três coisas com estatutos diferentes
// (lib/offline/types.ts), e sob pressão elas NÃO valem o mesmo:
//
//   1. FILA — intenção do cuidador que o servidor ainda não aceitou. É a
//      única coisa aqui que NÃO é reconstruível. Perder uma operação é perder
//      um registro clínico que ninguém mais tem.
//   2. RASCUNHO — texto digitado e não submetido. Reconstruível só pela
//      memória de quem escreveu. Segue o TTL próprio (7 dias / 24h sensível).
//   3. SNAPSHOT — o que o servidor disse. Sempre reconstruível: basta uma
//      requisição. É a ÚNICA coisa que pode ser sacrificada.
//
// Por isso a degradação tem um nome só: "fila sem snapshot". Não existe
// "fila reduzida", não existe "descartar as operações mais antigas". §8 é
// explícito: nunca apagar operação pendente em silêncio — e sob pressão de
// cota, "silêncio" seria pior ainda, porque ninguém pediu nada.
//
// ——— Por que o teto existe, já que o snapshot resolve a cota ———
//
// O teto não é sobre bytes. R13 é sobre o cuidador confiar demais no modo
// offline e conduzir uma conversa longa inteira sem rede — e ir descobrir
// muito depois que nada daquilo chegou. O aviso é a parte que mitiga isso; o
// teto é a parada final, quando avisar já não bastou.

// ---------- Os números ----------
//
// Um turno de pergunta fechada custa ~5 operações (criar · revisar ·
// apresentar · selecionar · confirmar); um nível de conversa por opções,
// ~6. Os payloads são limitados (MAX_PROMPT_LEN 300, MAX_STATEMENT_LEN 500,
// MAX_OPTION_LABEL_LEN 80), o que dá ~1–2 KB por operação depois de cifrada.
//
// São valores de JULGAMENTO, derivados dessa contagem — não de medição em
// campo. Ficam aqui, exportados, para poderem ser ajustados quando houver
// dado real de duração de sessão.

/**
 * Onde o cuidador é avisado. ~200 operações ≈ 35–40 turnos sem conexão — uma
 * conversa por gestos com 35 perguntas já é exaustiva para o paciente. Quem
 * chegou aqui precisa saber que está longe do servidor há muito tempo.
 */
export const AVISO_DA_FILA = 200;

/**
 * Onde a fila para de aceitar. ~500 operações ≈ 85–100 turnos, além de
 * qualquer sessão plausível; ~1 MB cifrado, folgado contra a cota típica de
 * IndexedDB. É a parada protetiva, não a educativa.
 */
export const TETO_DA_FILA = 500;

/**
 * Fração da cota a partir da qual o snapshot passa a ser sacrificável.
 * 0.9 e não 0.95: `estimate()` é aproximada e o navegador pode recusar a
 * gravação antes do número bater, então a folga precisa ser real.
 */
export const FRACAO_DE_PRESSAO = 0.9;

// ---------- Estimativa de cota ----------

export interface EstimativaDeCota {
  /** `false` quando a API não existe — e isso NÃO é motivo para bloquear nada. */
  disponivel: boolean;
  usadoBytes: number | null;
  cotaBytes: number | null;
}

/**
 * Há pressão de cota AGORA?
 *
 * `navigator.storage.estimate()` não é garantia de nada: não existe em todo
 * navegador, é deliberadamente imprecisa (proteção contra fingerprinting) e
 * pode reportar folga no exato momento em que a gravação falha. Por isso ela
 * é um SINAL ANTECIPADO, e a proteção que vale é o `QuotaExceededError`
 * tratado na gravação (R10: "não depender dessa API como única proteção").
 *
 * Sem a API, a resposta é `false` — nunca "assume o pior". Bloquear
 * preventivamente um navegador que talvez tivesse espaço de sobra
 * transformaria uma proteção em perda de função.
 */
export function haPressaoDeCota(e: EstimativaDeCota): boolean {
  if (!e.disponivel || e.usadoBytes == null || e.cotaBytes == null) return false;
  if (e.cotaBytes <= 0) return false;
  return e.usadoBytes / e.cotaBytes >= FRACAO_DE_PRESSAO;
}

// ---------- O que pode ser descartado ----------

/**
 * As coleções que podem ser sacrificadas para liberar espaço, em ordem.
 *
 * A lista é FECHADA e curta de propósito — é a documentação executável de
 * "quais dados podem ser descartados sob pressão". `operacoes` não está aqui,
 * e não pode entrar: um `pruneWhere(predicado)` genérico seria o caminho por
 * onde, um dia, alguém liberaria espaço apagando intenção clínica.
 *
 * `rascunhos` também fica de fora: eles têm política própria (TTL de 7 dias,
 * 24h para sensível) e são texto que o cuidador escreveu e ainda não
 * submeteu. Sacrificá-los para caber um snapshot — que é reconstruível por
 * uma requisição — seria trocar o insubstituível pelo recuperável.
 */
export const DESCARTAVEIS_SOB_PRESSAO = ["snapshots"] as const;

export type DescartavelSobPressao = (typeof DESCARTAVEIS_SOB_PRESSAO)[number];

// ---------- Decisão sobre uma nova operação ----------

export type DecisaoDeEnfileiramento =
  /** Cabe. Segue o fluxo normal. */
  | { kind: "ACEITA" }
  /** Cabe, mas está perto do teto — o cuidador precisa saber AGORA. */
  | { kind: "ACEITA_COM_AVISO"; pendentes: number; teto: number }
  /**
   * NÃO cabe. A operação não é gravada, e quem chamou precisa dizer isso à
   * tela — nunca fingir que salvou (R13: "não fingir que uma operação foi
   * salva").
   */
  | { kind: "RECUSADA"; pendentes: number; teto: number };

/**
 * Conta o que OCUPA a fila. `SYNCED` fica de fora: já foi aceito pelo
 * servidor e sai na próxima limpeza — contá-lo faria o teto chegar mais cedo
 * por causa de trabalho que já terminou.
 */
export function ocupacaoDaFila(
  fila: readonly { status: string }[]
): number {
  return fila.filter((op) => op.status !== "SYNCED").length;
}

export function decidirEnfileiramento(
  fila: readonly { status: string }[],
  teto: number = TETO_DA_FILA,
  aviso: number = AVISO_DA_FILA
): DecisaoDeEnfileiramento {
  const pendentes = ocupacaoDaFila(fila);
  if (pendentes >= teto) return { kind: "RECUSADA", pendentes, teto };
  if (pendentes + 1 >= aviso) {
    return { kind: "ACEITA_COM_AVISO", pendentes: pendentes + 1, teto };
  }
  return { kind: "ACEITA" };
}

/**
 * A fila não aceitou. Erro, e não um retorno "deu ruim", de propósito: quem
 * chamou precisa ser OBRIGADO a tratar. Um campo booleano ignorável no
 * retorno seria a porta para a tela seguir como se tivesse salvado.
 */
export class OfflineStorageFullError extends Error {
  readonly pendentes: number;
  readonly teto: number;
  constructor(pendentes: number, teto: number) {
    super(
      `este aparelho não consegue guardar mais registros desta conversa (${pendentes} de ${teto})`
    );
    this.name = "OfflineStorageFullError";
    this.pendentes = pendentes;
    this.teto = teto;
  }
}

// ---------- Erro de cota ----------

/**
 * Reconhece o estouro de cota do IndexedDB.
 *
 * O nome é `QuotaExceededError` em todos os navegadores atuais, mas o Safari
 * já usou o código legado 22 — e um estouro não reconhecido viraria "falha
 * desconhecida ao salvar", que é exatamente a mensagem que não ajuda ninguém
 * à beira do leito.
 */
export function ehErroDeCota(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { name?: unknown; code?: unknown };
  return (
    err.name === "QuotaExceededError" ||
    err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    err.code === 22
  );
}

// ---------- O que a tela mostra ----------

/**
 * O estado do armazenamento, para o chip. Separado de `OfflineStatusSummary`
 * porque é outra coisa: aquele fala do que está pendente de ENVIO, este fala
 * do que o APARELHO consegue guardar.
 */
export interface EstadoDoArmazenamento {
  /** O snapshot foi descartado (ou não é mais gravado) para caber a fila. */
  degradado: boolean;
  /** A fila passou do limiar de aviso. */
  perto: boolean;
  /** A fila atingiu o teto: nada novo entra. */
  cheia: boolean;
  pendentes: number;
  teto: number;
}

export const ARMAZENAMENTO_TRANQUILO: EstadoDoArmazenamento = {
  degradado: false,
  perto: false,
  cheia: false,
  pendentes: 0,
  teto: TETO_DA_FILA,
};

/**
 * A frase que o cuidador lê. Devolve `null` quando não há nada a dizer —
 * silêncio é a resposta certa quando está tudo bem.
 *
 * A ordem importa: fila cheia é mais grave que degradação de snapshot, e
 * anunciar a menor primeiro esconderia a maior.
 */
export function fraseDoArmazenamento(e: EstadoDoArmazenamento): string | null {
  if (e.cheia) {
    return `Este aparelho não consegue guardar mais registros desta conversa (${e.pendentes}). Recupere a conexão para enviar o que já está aqui antes de continuar.`;
  }
  if (e.perto) {
    return `Você já registrou ${e.pendentes} coisas sem conexão, de no máximo ${e.teto}. Assim que possível, recupere a conexão para enviá-las.`;
  }
  if (e.degradado) {
    // Nomeia o que se perdeu E o que NÃO se perdeu. Sem a segunda metade, o
    // cuidador teria motivo para achar que perdeu registro.
    return "Espaço curto neste aparelho: a recuperação visual da conversa foi reduzida. Nenhum registro pendente foi apagado.";
  }
  return null;
}
