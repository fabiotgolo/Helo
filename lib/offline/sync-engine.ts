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
// ——— Revalidação pré-envio (requisito 7, complemento 4.9.4) ———
//
// Autenticação, identidade e acesso ao paciente são confirmados ANTES de
// consumir a fila — não só reativamente, no meio de um envio de verdade.
// `consultarPreflight` faz UMA requisição por CICLO (não por operação, e não
// quando a fila está vazia ou já bloqueada) e devolve o MESMO tipo de
// resultado que um envio de verdade devolveria — para que preflight e
// reação passem pelo MESMO tratamento (`tratarResultado`), sem duas regras.
//
// Quem decide continua sendo o servidor: `requirePatientAccess`, na rota
// `/api/realtime-questions/preflight`, é a MESMA função que toda escrita já
// chama. Nada de autorização é decidido aqui — só interpretado.
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
  return (await consultarServidor(timeoutMs)).alcancavel;
}

/**
 * Uma ida só, duas respostas: o servidor está de pé, e QUEM ele acha que
 * somos.
 *
 * A identidade sai de graça — `/api/auth/me` já devolve o usuário, e esta
 * chamada já acontecia antes de cada ciclo. Verificar antes de enviar evita
 * gastar a requisição de escrita para levar 403; a defesa que vale, porém, é
 * a do servidor (`requirePatientAccess`), porque uma checagem só de cliente é
 * uma checagem que uma aba velha pode pular.
 */
export async function consultarServidor(
  timeoutMs = 5000
): Promise<{ alcancavel: boolean; userId: string | null }> {
  if (typeof fetch === "undefined") return { alcancavel: false, userId: null };
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
    const alcancavel = resposta.status < 600;
    let userId: string | null = null;
    if (resposta.ok) {
      const corpo = (await resposta.json().catch(() => null)) as
        | { user?: { id?: unknown } | null }
        | null;
      if (typeof corpo?.user?.id === "string") userId = corpo.user.id;
    }
    return { alcancavel, userId };
  } catch {
    return { alcancavel: false, userId: null };
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

// ---------- Preflight: autenticação, identidade e acesso, ANTES do envio ----------

/**
 * Pergunta ao servidor, uma vez, se este ciclo pode escrever — antes de
 * consumir qualquer coisa da fila.
 *
 * Devolve `null` quando pode seguir (a resposta foi "sim", ou foi
 * inconclusiva e cabe ao envio de verdade decidir — um 5xx aqui não é
 * decisão de domínio, é o servidor passando mal). Devolve o MESMO formato
 * que `enviarOperacao` devolveria para uma recusa, para que os dois
 * caminhos — pego antes, ou pego durante — recebam o MESMO tratamento.
 *
 * Uma falha de REDE ao perguntar já é uma falha de rede para enviar — sem
 * gastar a tentativa de escrita para descobrir a mesma coisa duas vezes.
 */
async function consultarPreflight(
  store: OfflineSessionStore
): Promise<Exclude<ResultadoEnvio, { kind: "sucesso" }> | null> {
  let resposta: Response;
  try {
    resposta = await fetch(
      `/api/realtime-questions/preflight?patientId=${encodeURIComponent(
        store.patientId
      )}&expectedUserId=${encodeURIComponent(store.userId)}`,
      { method: "GET", cache: "no-store" }
    );
  } catch {
    return { kind: "rede" };
  }

  if (resposta.ok) return null;
  if (resposta.status !== 401 && resposta.status !== 403) {
    // 5xx, ou qualquer coisa que não seja uma decisão de identidade/acesso:
    // este endpoint não é quem decide isso — o envio de verdade decide.
    return null;
  }

  const detalhe = (await resposta.json().catch(() => null)) as
    | { error?: string; code?: unknown; facts?: ConflictFacts }
    | null;
  const mensagem = detalhe?.error ?? "O servidor recusou o acesso.";
  const conflito = classificarRecusa({
    status: resposta.status,
    code: detalhe?.code,
    mensagem,
    fatos: detalhe?.facts,
  });

  if (resposta.status === 401) {
    return {
      kind: "naoAutorizado",
      mensagem: "Sua sessão expirou. Entre novamente para enviar o que ficou guardado.",
      conflito,
    };
  }
  // 403: mesma regra do envio de verdade — "não há saída de forçar",
  // independente de ser acesso revogado (caso 9) ou identidade trocada (R6).
  return { kind: "naoAutorizado", mensagem: conflito.titulo, conflito };
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
 * O que acontece a UMA operação depois de um resultado que NÃO foi sucesso —
 * seja ele de um envio de verdade, seja de uma recusa pega no preflight.
 * Um lugar só, para que os dois caminhos produzam exatamente o mesmo efeito
 * na fila: nunca SYNCED, nunca troca de `idempotencyKey`, nunca finge.
 */
async function tratarResultado(
  ctx: SyncContext,
  fila: OfflineOperation[],
  operationId: string,
  resultado: Exclude<ResultadoEnvio, { kind: "sucesso" }>
): Promise<void> {
  switch (resultado.kind) {
    case "rede": {
      const alvo = fila.find((o) => o.id === operationId);
      const tentativas = (alvo?.retryCount ?? 0) + 1;
      if (tentativas > MAX_RETRY) {
        const falhou = await ctx.store.marcar(fila, operationId, "FAILED", {
          incrementRetry: true,
          error: erro(
            "offline",
            "Não conseguimos enviar depois de várias tentativas. Você pode tentar de novo quando quiser."
          ),
        });
        ctx.aplicarFila(falhou);
      } else {
        const proximaTentativa = new Date(Date.now() + backoffMs(tentativas)).toISOString();
        const pendente = await ctx.store.marcar(fila, operationId, "PENDING", {
          incrementRetry: true,
          nextRetryAt: proximaTentativa,
          error: erro("offline", "Sem conexão com o Helo. Vamos tentar de novo em instantes."),
        });
        ctx.aplicarFila(pendente);
      }
      return;
    }

    case "naoAutorizado": {
      // §7: preserva — nunca finge sincronização, e não tenta de novo
      // sozinho (entrar de novo é decisão do cuidador, não um retry).
      const falhou = await ctx.store.marcar(fila, operationId, "FAILED", {
        error: erro("unauthorized", resultado.mensagem),
        conflict: resultado.conflito,
      });
      ctx.aplicarFila(falhou);
      return;
    }

    case "conflito": {
      const emConflito = await ctx.store.marcar(fila, operationId, "CONFLICT", {
        error: erro("conflict", resultado.mensagem),
        conflict: resultado.conflito,
      });
      ctx.aplicarFila(emConflito);
      return;
    }

    case "invalida": {
      const falhou = await ctx.store.marcar(fila, operationId, "FAILED", {
        error: erro("unknown", resultado.mensagem),
      });
      ctx.aplicarFila(falhou);
      return;
    }
  }
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
    // Nada para enviar? Nenhuma requisição — nem o preflight, nem o envio.
    // "Impacto desnecessário no servidor" começa por não perguntar quando a
    // pergunta não muda nada.
    const filaInicial = ctx.obterFila();
    const primeira = nextSendable(filaInicial);
    if (primeira.kind !== "ENVIAR") return;

    // SYNCING é marcado ANTES do preflight, não só antes do envio — e é
    // essencial, não decorativo: `markStatus` trata PENDING→PENDING como
    // "nada mudou" e IGNORA os campos extras (retryCount, erro), por design
    // — é o que deixa marcar um status igual ao atual seguro em qualquer
    // outro lugar. Sem isto, uma recusa do preflight tentaria PENDING→PENDING
    // e o retry, silenciosamente, nunca contaria. Marcar SYNCING agora faz da
    // recusa uma transição de VERDADE (SYNCING→PENDING/FAILED/CONFLICT) —
    // exatamente a mesma que um envio de verdade já produzia.
    //
    // É por isto, também, que esta primeira operação NÃO passa de novo por
    // `nextSendable` depois do preflight: SYNCING bloquearia a fila inteira
    // (é a defesa de concorrência do cabeçalho), inclusive ELA MESMA.
    const emPreparo = await ctx.store.marcar(filaInicial, primeira.operacao.id, "SYNCING");
    ctx.aplicarFila(emPreparo);

    // Preflight — UMA consulta por CICLO. Confirma autenticação, identidade
    // (R6) e acesso ao paciente ANTES do primeiro envio deste ciclo.
    const resultadoPreflight = await consultarPreflight(ctx.store);
    if (resultadoPreflight) {
      await tratarResultado(ctx, ctx.obterFila(), primeira.operacao.id, resultadoPreflight);
      return;
    }

    // Preflight passou: envia esta operação — já selecionada, já marcada
    // SYNCING. Da segunda em diante, o laço volta ao caminho normal:
    // `nextSendable` escolhe, e cada uma é marcada SYNCING na hora.
    let atual = primeira.operacao;
    for (;;) {
      const resultado = await enviarOperacao(atual);

      if (resultado.kind === "sucesso") {
        const antes = ctx.obterFila();
        const confirmada = await ctx.store.marcar(antes, atual.id, "SYNCED", {
          remoteEntityId: resultado.remoteEntityId,
          remoteConfirmedAt: resultado.remoteConfirmedAt,
          error: null,
        });
        ctx.aplicarFila(confirmada);
      } else {
        // Qualquer coisa que não seja sucesso pausa o dreno deste ciclo — a
        // mesma regra de sempre, agora compartilhada com o preflight acima.
        await tratarResultado(ctx, ctx.obterFila(), atual.id, resultado);
        return;
      }

      const fila = ctx.obterFila();
      const proxima = nextSendable(fila);
      if (proxima.kind !== "ENVIAR") return;
      const emVoo = await ctx.store.marcar(fila, proxima.operacao.id, "SYNCING");
      ctx.aplicarFila(emVoo);
      atual = proxima.operacao;
    }
  } finally {
    emVooPorEscopo.delete(escopo);
  }
}
