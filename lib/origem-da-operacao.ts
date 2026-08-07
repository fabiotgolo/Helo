// ——— Origem da operação: online ou offline, e quando o aparelho diz que foi ———
//
// Fase 4.9.5. Fecha a §3.5 e o item 7 da §7 da auditoria, que prometiam marcar
// na trilha que uma operação nasceu sem conexão — e a que horas o cuidador
// agiu, pelo relógio dele.
//
// ——— O QUE ESTE MÓDULO NÃO É ———
//
// `intendedAt` NÃO é um horário do servidor, e nada aqui o promove a isso. Ele
// não ordena, não autoriza, não decide conflito e não entra em nenhuma
// comparação de domínio. O `createdAt` de cada registro continua sendo cunhado
// dentro da transação que o aplica, como sempre foi. O que este metadado
// preserva é contexto histórico: sem ele, uma conversa inteira conduzida sem
// rede aparece na trilha como se tivesse acontecido no minuto em que a conexão
// voltou.
//
// Por isso a validação abaixo é de FORMATO e de PLAUSIBILIDADE, não de
// verdade: não há como o servidor saber que horas eram no aparelho. O que ele
// pode fazer é recusar um valor que claramente não descreve o que diz
// descrever, e recusar significa OMITIR — nunca corrigir para um horário que
// ninguém observou.

import { AsyncLocalStorage } from "node:async_hooks";

export interface OrigemDaOperacao {
  /** A operação nasceu sem conexão efetiva com o servidor. */
  offlineQueued: boolean;
  /**
   * Quando o cuidador agiu, pelo relógio do aparelho. `null` quando ausente
   * ou quando o valor não passou na validação — e um `null` aqui, junto de
   * `offlineQueued: true`, é informação: o aparelho afirmou uma origem
   * offline com um relógio em que não se pôde confiar.
   */
  intendedAt: string | null;
}

/**
 * Um relógio adiantado é o caso que a auditoria nomeia (R11). 24h de folga
 * cobre fuso mal configurado e relógio à deriva sem aceitar um "amanhã".
 */
const FUTURO_TOLERADO_MS = 24 * 60 * 60 * 1000;

/**
 * A fila expira em 7 dias (§8). 30 dias dá folga generosa para um aparelho
 * que ficou guardado e ainda assim recusa um horário de outro mês, que só
 * poderia vir de relógio quebrado.
 */
const PASSADO_TOLERADO_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Lê a origem do corpo da requisição. Nunca lança: um corpo malformado não
 * pode impedir a operação de acontecer — o cuidador agiu, e o registro do que
 * ele fez vale mais do que o metadado sobre quando.
 */
export function lerOrigem(
  body: unknown,
  agoraMs: number = Date.now()
): OrigemDaOperacao {
  const v = (body ?? {}) as Record<string, unknown>;
  return {
    offlineQueued: v.offlineQueued === true,
    intendedAt: validarIntendedAt(v.intendedAt, agoraMs),
  };
}

/**
 * ISO 8601 em UTC, plausível. Devolve a forma NORMALIZADA (sempre `Z`), para
 * que a trilha não guarde meia dúzia de grafias do mesmo instante.
 */
export function validarIntendedAt(
  bruto: unknown,
  agoraMs: number = Date.now()
): string | null {
  if (typeof bruto !== "string" || !bruto) return null;
  // `Date.parse` aceita coisas demais ("2026", "March 5"). Exigir a forma
  // completa é o que impede um "1" de virar um horário do ano 2001.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(bruto)) {
    return null;
  }
  const ms = Date.parse(bruto);
  if (Number.isNaN(ms)) return null;
  if (ms > agoraMs + FUTURO_TOLERADO_MS) return null;
  if (ms < agoraMs - PASSADO_TOLERADO_MS) return null;
  return new Date(ms).toISOString();
}

// ---------- Transporte até a trilha ----------
//
// Os 48 pontos que gravam auditoria vivem dentro das funções de domínio, que
// não conhecem — e não devem conhecer — o corpo HTTP. Threading da origem por
// 29 assinaturas até 48 chamadas teria uma falha de modo previsível: o único
// ponto esquecido seria justamente o que passaria despercebido na trilha.
//
// É o mesmo problema que `buildSyncRequest` resolve do outro lado do fio, e a
// resposta aqui é a mesma: um lugar só. `AsyncLocalStorage` carrega a origem
// pela requisição inteira, e `writeAudit` a lê no momento de gravar. Fora de
// uma requisição — teste de domínio, script — não há origem, e a trilha sai
// exatamente como saía antes desta fase.

const contexto = new AsyncLocalStorage<OrigemDaOperacao>();

/** Roda `fn` com a origem visível para todo `writeAudit` que ela alcançar. */
export function comOrigem<T>(origem: OrigemDaOperacao, fn: () => T): T {
  return contexto.run(origem, fn);
}

/** A origem da requisição em curso, ou `null` fora de uma. */
export function origemAtual(): OrigemDaOperacao | null {
  return contexto.getStore() ?? null;
}

/**
 * Os campos que entram em `metadata` do evento. Vazio quando não há origem
 * (fora de requisição) e quando a operação nasceu online sem horário local —
 * a trilha de quem sempre esteve conectado não muda de forma por causa desta
 * fase.
 */
export function metadadosDaOrigem(): Record<string, unknown> | null {
  const origem = origemAtual();
  if (!origem) return null;
  const extra: Record<string, unknown> = { offlineQueued: origem.offlineQueued };
  if (origem.intendedAt) extra.intendedAt = origem.intendedAt;
  return extra;
}
