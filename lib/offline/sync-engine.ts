"use client";

// ——— O motor de sincronização (Fase B) ———
//
// Consome a fila local e envia, de verdade, ao servidor — uma operação de
// cada vez, na ordem que `nextSendable` (lib/offline/queue.ts) determina.
// Este módulo NÃO decide o que enviar; só COMO enviar e o que fazer com a
// resposta. A decisão de ordem, dependência e backoff já existe, testada,
// desde a Fase 4.9.2.
//
// ——— Conectividade real (§9, requisito 1) ———
//
// `navigator.onLine` só diz que a conexão VOLTOU (o evento `online`) — não
// que o servidor está de pé. `servidorEstaAlcancavel` faz uma requisição de
// verdade: qualquer RESPOSTA HTTP, mesmo 401 ou 500, prova que o servidor
// respondeu; só uma falha de rede (o `fetch` rejeita, ou estoura o tempo)
// prova que não.
//
// ——— Confirmação individual (requisito 4) ———
//
// Cada operação é enviada e confirmada isoladamente. Não existe "enviar o
// lote"; o laço principal processa uma de cada vez e só avança para a
// seguinte depois que esta terminou — sucesso, falha ou bloqueio.
//
// ——— Concorrência (requisito 2) ———
//
// Duas defesas, para dois problemas diferentes:
//
//   1. `nextSendable` nunca devolve duas operações para enviar ao mesmo
//      tempo — uma operação SYNCING bloqueia a fila inteira até resolver.
//   2. `emVooPorEscopo` impede que DOIS CICLOS (o evento `online`, o botão
//      manual, o temporizador de backoff, todos podem disparar quase juntos)
//      leiam a fila ANTES de qualquer um marcar SYNCING, e mandem a MESMA
//      operação duas vezes. Sem isto, (1) sozinho não bastaria: a corrida
//      aconteceria na leitura, não na escrita.

import { buildSyncRequest, extractConfirmation } from "@/lib/offline/sync-endpoints";
import {
  classificarRecusa,
  comValorLocal,
  valorLocalDe,
  type ConflictCase,
  type ConflictFacts,
} from "@/lib/offline/conflicts";
import { nextSendable } from "@/lib/offline/queue";
import {
  backoffMs,
  MAX_RETRY,
  type OfflineOperation,
  type OfflineOperationError,
} from "@/lib/offline/types";
import type { OfflineSessionStore } from "@/lib/offline/store";

/** O que o motor precisa para operar — nunca acessa React nem o DOM diretamente. */
export interface SyncContext {
  store: OfflineSessionStore;
  /** Leitura SEMPRE fresca — nunca um fechamento antigo (mesmo cuidado de `filaRef`). */
  obterFila: () => OfflineOperation[];
  aplicarFila: (nova: OfflineOperation[]) => void;
}

// ---------- Conectividade real ----------

/**
 * `/api/auth/me` é intencional: já existe, é leve, e exige cookie — então a
 * mesma chamada também revela se a SESSÃO expirou (requisito 7, "revalidar
 * autenticação... antes do envio"), sem uma segunda ida ao servidor. Uma
 * rota de saúde dedicada não diria nada que esta já não diz.
 */
export async function servidorEstaAlcancavel(timeoutMs = 5000): Promise<boolean> {
  if (typeof fetch === "undefined") return false;
  try {
    const controlador =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controlador
      ? setTimeout(() => controlador.abort(), timeoutMs)
      : null;
    const resposta = await fetch("/api/auth/me", {
      method: "GET",
      cache: "no-store",
      signal: controlador?.signal,
    });
    if (timer) clearTimeout(timer);
    // Qualquer resposta HTTP prova que o servidor está de pé — inclusive um
    // erro do servidor (5xx): a REDE está boa, é o servidor que está mal, e
    // as duas coisas pedem tratamento diferente mais adiante.
    return resposta.status < 600;
  } catch {
    return false;
  }
}

// ---------- Envio de uma operação ----------

type ResultadoEnvio =
  | { kind: "sucesso"; remoteEntityId: string | null; remoteConfirmedAt: string | null }
  /** Falha de REDE — recuperável, entra no backoff. Inclui 5xx: o servidor
   *  passou mal, não é uma decisão de domínio sobre esta operação. */
  | { kind: "rede" }
  | { kind: "naoAutorizado"; mensagem: string; conflito: ConflictCase }
  | { kind: "conflito"; mensagem: string; conflito: ConflictCase }
  | { kind: "invalida"; mensagem: string };

async function enviarOperacao(op: OfflineOperation): Promise<ResultadoEnvio> {
  const req = buildSyncRequest(op);

  let resposta: Response;
  try {
    resposta = await fetch(`/api/realtime-questions${req.path}`, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
      cache: "no-store",
    });
  } catch {
    return { kind: "rede" };
  }

  // Só a faixa 4xx é decisão de DOMÍNIO sobre esta operação. 5xx é o servidor
  // passando mal — tenta de novo com backoff, não marca conflito por um
  // problema que pode não ser desta operação. E qualquer outro status
  // não-ok (um 3xx que escapasse do `redirect: follow`, por exemplo) também
  // cai aqui: preserva exatamente a faixa que a Fase B classificava, para que
  // nomear os conflitos não mude, de lambuja, o destino de um status que
  // ninguém analisou.
  if (!resposta.ok && (resposta.status < 400 || resposta.status >= 500)) {
    return { kind: "rede" };
  }

  if (!resposta.ok) {
    // O corpo é lido para TODAS as recusas 4xx, inclusive 401 e 403: é dele
    // que vem o `code` que diz QUAL das treze linhas da matriz aconteceu
    // (§10). A Fase B descartava o corpo de 401/403 e, com ele, a única
    // chance de distinguir "sua sessão expirou" de "seu acesso foi revogado"
    // — que pedem coisas opostas do cuidador: entrar de novo, ou parar.
    const detalhe = (await resposta.json().catch(() => null)) as
      | { error?: string; code?: unknown; facts?: ConflictFacts }
      | null;
    const mensagem = detalhe?.error ?? "O servidor recusou esta ação.";
    // O servidor manda o lado DELE; o lado do cuidador só existe aqui, na
    // operação que nunca chegou lá. Os casos 4 e 7 mostram os dois — e uma
    // tela com metade da comparação não permite decidir nada.
    const conflito = comValorLocal(
      classificarRecusa({
        status: resposta.status,
        code: detalhe?.code,
        mensagem,
        fatos: detalhe?.facts,
      }),
      valorLocalDe(op)
    );

    // 401 continua sendo "entre de novo" — sessão expirada não é conflito de
    // domínio, e o retorno separado é o que faz o chip pedir reautenticação
    // em vez de abrir uma tela de decisão que não teria decisão nenhuma.
    if (resposta.status === 401) {
      return {
        kind: "naoAutorizado",
        mensagem: "Sua sessão expirou. Entre novamente para enviar o que ficou guardado.",
        conflito,
      };
    }
    // 403 é o caso 9 — e é diferente do 401 justamente por NÃO ter saída de
    // "tentar de novo": o acesso não volta por reautenticar.
    if (resposta.status === 403) {
      return { kind: "naoAutorizado", mensagem: conflito.titulo, conflito };
    }
    return { kind: "conflito", mensagem, conflito };
  }

  let json: unknown;
  try {
    json = await resposta.json();
  } catch {
    return {
      kind: "invalida",
      mensagem: "O servidor respondeu de um jeito que não reconhecemos.",
    };
  }
  const { remoteEntityId, remoteConfirmedAt } = extractConfirmation(op, json);
  return { kind: "sucesso", remoteEntityId, remoteConfirmedAt };
}

// ---------- Orquestração ----------

/** Um escopo por vez — ver a nota de concorrência no cabeçalho do arquivo. */
const emVooPorEscopo = new Set<string>();

export function sincronizacaoEmVoo(escopo: string): boolean {
  return emVooPorEscopo.has(escopo);
}

function erro(kind: OfflineOperationError["kind"], mensagem: string): OfflineOperationError {
  return { kind, message: mensagem, at: new Date().toISOString() };
}

/**
 * Drena o que puder da fila AGORA — envia, uma de cada vez, até esvaziar ou
 * até topar com algo que exige esperar (backoff, dependência) ou decidir
 * (conflito, falha, autenticação). Devolve sem lançar: um problema de rede,
 * de domínio ou de autenticação é um RESULTADO desta função, nunca uma
 * exceção — a fila é o registro do que aconteceu, não um efeito colateral
 * escondido num catch de quem chamou.
 */
export async function sincronizarFila(ctx: SyncContext): Promise<void> {
  const escopo = ctx.store.escopo;
  if (emVooPorEscopo.has(escopo)) return;
  emVooPorEscopo.add(escopo);

  try {
    for (;;) {
      const fila = ctx.obterFila();
      const proxima = nextSendable(fila);
      if (proxima.kind !== "ENVIAR") return;

      // SYNCING é marcado ANTES do envio: é o que faz um segundo ciclo (outra
      // aba? um clique manual bem no meio?) ver a fila bloqueada, em vez de
      // pegar a mesma operação — ver a nota de concorrência acima.
      const emVoo = await ctx.store.marcar(fila, proxima.operacao.id, "SYNCING");
      ctx.aplicarFila(emVoo);

      const resultado = await enviarOperacao(proxima.operacao);

      switch (resultado.kind) {
        case "sucesso": {
          const antes = ctx.obterFila();
          const confirmada = await ctx.store.marcar(antes, proxima.operacao.id, "SYNCED", {
            remoteEntityId: resultado.remoteEntityId,
            remoteConfirmedAt: resultado.remoteConfirmedAt,
            error: null,
          });
          ctx.aplicarFila(confirmada);
          continue; // a próxima, se houver
        }

        case "rede": {
          const antes = ctx.obterFila();
          const alvo = antes.find((o) => o.id === proxima.operacao.id);
          const tentativas = (alvo?.retryCount ?? 0) + 1;
          if (tentativas > MAX_RETRY) {
            const falhou = await ctx.store.marcar(antes, proxima.operacao.id, "FAILED", {
              incrementRetry: true,
              error: erro(
                "offline",
                "Não conseguimos enviar depois de várias tentativas. Você pode tentar de novo quando quiser."
              ),
            });
            ctx.aplicarFila(falhou);
          } else {
            const proximaTentativa = new Date(Date.now() + backoffMs(tentativas)).toISOString();
            const pendente = await ctx.store.marcar(antes, proxima.operacao.id, "PENDING", {
              incrementRetry: true,
              nextRetryAt: proximaTentativa,
              error: erro("offline", "Sem conexão com o Helo. Vamos tentar de novo em instantes."),
            });
            ctx.aplicarFila(pendente);
          }
          return; // rede fora: nada mais desta fila vai adiante agora
        }

        case "naoAutorizado": {
          const antes = ctx.obterFila();
          // §7: preserva — nunca finge sincronização, e não tenta de novo
          // sozinho (entrar de novo é decisão do cuidador, não um retry).
          const falhou = await ctx.store.marcar(antes, proxima.operacao.id, "FAILED", {
            error: erro("unauthorized", resultado.mensagem),
            conflict: resultado.conflito,
          });
          ctx.aplicarFila(falhou);
          return;
        }

        case "conflito": {
          const antes = ctx.obterFila();
          const emConflito = await ctx.store.marcar(antes, proxima.operacao.id, "CONFLICT", {
            error: erro("conflict", resultado.mensagem),
            conflict: resultado.conflito,
          });
          ctx.aplicarFila(emConflito);
          return;
        }

        case "invalida": {
          const antes = ctx.obterFila();
          const falhou = await ctx.store.marcar(antes, proxima.operacao.id, "FAILED", {
            error: erro("unknown", resultado.mensagem),
          });
          ctx.aplicarFila(falhou);
          return;
        }
      }
    }
  } finally {
    emVooPorEscopo.delete(escopo);
  }
}
