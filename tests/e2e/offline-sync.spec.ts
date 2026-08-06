// ——— O motor de sincronização, contra o servidor real (Fase B) ———
//
// Os testes anteriores (offline-continuidade, offline-app-shell) provam que a
// fila SOBREVIVE — a refresh, a fechar o navegador, ao contexto mudar de aba.
// Nenhum deles prova que ela CHEGA ao servidor. É isso que este arquivo
// prova: cada cenário aqui derruba a rede de VERDADE (`context.setOffline`)
// ou intercepta a resposta de verdade (`page.route`), e confere o que o
// SERVIDOR tem — não só o que a tela mostra.
//
// `page.route(...).fetch()` é a peça que faz "resposta perdida DEPOIS de
// persistir" um cenário de teste de verdade, e não uma simulação: a
// requisição chega ao servidor, grava, e SÓ ENTÃO a resposta é descartada
// antes de voltar ao navegador — o servidor não sabe que "falhou" nada.

import { expect, test, type Page, type BrowserContext } from "@playwright/test";
import { abrirModo, entrarComo, pularContexto, semear, type Semente } from "./helpers";
import { criarNivel } from "./option-conversation-helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

const RTQ = "/api/realtime-questions";
const chip = (page: Page) => page.getByTestId("offline-chip");
const campoDaPergunta = (page: Page) =>
  page.getByLabel("Pergunta para o paciente");
const botaoSincronizar = (page: Page) => page.getByTestId("sincronizar-agora");

async function sessaoCarregada(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
  await pularContexto(page);
  await expect(
    page.getByRole("heading", { name: "Escreva a pergunta" })
  ).toBeVisible();
}

/**
 * `iniciarConversaPorOpcoes` (option-conversation-helpers.ts) cria o CAMINHO
 * assim que o cuidador clica "Conversa por opções" — e isso, se a rede
 * estiver no ar naquele instante, é uma criação ONLINE, não uma operação na
 * fila. Para testar a DEPENDÊNCIA path→node offline, a rede precisa cair
 * ANTES desse clique — é o que esta versão faz.
 */
async function conversaPorOpcoesOffline(page: Page, context: BrowserContext) {
  await sessaoCarregada(page);
  await context.setOffline(true);
  await page.getByRole("button", { name: "Conversa por opções" }).click();
  await expect(
    page.getByRole("heading", { name: /Criar o primeiro nível/ })
  ).toBeVisible();
}

/** A sessão ATIVA do paciente semeado — direto da API, não da tela. */
async function sessaoAtivaNoServidor(page: Page): Promise<string> {
  const r = await page.request.get(
    `${RTQ}/sessions?patientId=${dados.pacienteId}`
  );
  const j = await r.json();
  const ativa = j.sessions.find(
    (s: { status: string }) => s.status === "ACTIVE" || s.status === "PAUSED"
  );
  expect(ativa, "precisa haver uma sessão ativa no servidor").toBeTruthy();
  return ativa.id;
}

async function turnosNoServidor(page: Page, sessionId: string) {
  const r = await page.request.get(
    `${RTQ}/turns?patientId=${dados.pacienteId}&sessionId=${sessionId}`
  );
  return (await r.json()).turns as Array<{ id: string; reviewedText: string }>;
}

async function eventosNoServidor(page: Page, sessionId: string, extra = "") {
  const r = await page.request.get(
    `${RTQ}/events?patientId=${dados.pacienteId}&sessionId=${sessionId}${extra}`
  );
  return (await r.json()).events as Array<{ eventType: string }>;
}

/**
 * Todas as operações guardadas, DECIFRADAS — o registro cru no IndexedDB é
 * `{id, escopo, iv, dados}` (lib/offline/db.ts); `dados` é AES-GCM, com a
 * MESMA chave não-extraível e o MESMO AAD (`escopo|operacoes|id`) que
 * lib/offline/crypto.ts usa. Replicar isso aqui é o único jeito de um teste
 * de fora ver o conteúdo — e é também, por construção, a prova de que a
 * cifra funciona: se o AAD ou a chave estivessem errados, `decrypt` lançaria.
 */
interface OperacaoLida {
  id: string;
  operationType: string;
  status: string;
  retryCount: number;
  idempotencyKey: string;
  remoteEntityId: string | null;
  remoteConfirmedAt: string | null;
  lastError: { kind: string; message: string } | null;
  sequence: number;
  dependsOn: number[];
  createdEntityId: string | null;
}

function operacoes(page: Page): Promise<OperacaoLida[]> {
  return page.evaluate(async () => {
    const bancos = await indexedDB.databases?.();
    if (bancos && !bancos.some((b) => b.name === "helo-offline")) return [];
    const banco = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("helo-offline");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!banco.objectStoreNames.contains("operacoes")) return [];

    const brutos = await new Promise<
      Array<{ id: string; escopo: string; iv: Uint8Array<ArrayBuffer>; dados: ArrayBuffer }>
    >((res) => {
      const r = banco.transaction("operacoes", "readonly").objectStore("operacoes").getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => res([]);
    });
    if (brutos.length === 0) return [];

    const chavesPorEscopo = new Map<string, CryptoKey>();
    const obterChave = async (escopo: string) => {
      const emCache = chavesPorEscopo.get(escopo);
      if (emCache) return emCache;
      const registro = await new Promise<{ chave: CryptoKey } | undefined>((res) => {
        const r = banco.transaction("chaves", "readonly").objectStore("chaves").get(escopo);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(undefined);
      });
      if (registro?.chave) chavesPorEscopo.set(escopo, registro.chave);
      return registro?.chave ?? null;
    };

    const saida: OperacaoLida[] = [];
    for (const bruto of brutos) {
      const chave = await obterChave(bruto.escopo);
      if (!chave) continue;
      try {
        const aberto = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: bruto.iv,
            additionalData: new TextEncoder().encode(`${bruto.escopo}|operacoes|${bruto.id}`),
          },
          chave,
          bruto.dados
        );
        saida.push(JSON.parse(new TextDecoder().decode(aberto)) as OperacaoLida);
      } catch {
        // Registro ilegível — mesma regra do produto: descarta, não inventa.
      }
    }
    return saida;
  });
}

async function statusDe(page: Page, operationType: string) {
  const ops = await operacoes(page);
  return ops.filter((o) => o.operationType === operationType);
}

/**
 * Espera a gravação no IndexedDB terminar — ela é assíncrona (debounce +
 * cifra), e ler logo depois de um clique é uma corrida real, não só no teste:
 * a MESMA folga existe em produção entre "o cuidador clicou" e "está no
 * disco".
 */
async function esperaOperacao(page: Page, operationType: string) {
  await expect
    .poll(async () => (await statusDe(page, operationType)).length, {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
  return (await statusDe(page, operationType))[0];
}

async function esperaEstadoDaFila(
  page: Page,
  operationType: string,
  status: string,
  opts: { timeout?: number } = {}
) {
  await expect
    .poll(
      async () => (await statusDe(page, operationType))[0]?.status,
      { timeout: opts.timeout ?? 15_000 }
    )
    .toBe(status);
}

/**
 * Volta a rede DE VERDADE e espera o gatilho automático (evento `online`)
 * levar a fila a `estadoFinal`. Não clica em nada — é isso que prova que o
 * disparo é automático (requisito 1).
 */
async function voltarOnlineEsperar(
  context: BrowserContext,
  page: Page,
  operationType: string,
  estadoFinal: string,
  opts: { timeout?: number } = {}
) {
  await context.setOffline(false);
  await esperaEstadoDaFila(page, operationType, estadoFinal, opts);
}

test.describe("Motor de sincronização", () => {
  test("1. operação criada offline, ao voltar online, é persistida e confirmada no servidor", async ({
    page,
    context,
  }) => {
    await sessaoCarregada(page);
    const sessionId = await sessaoAtivaNoServidor(page);

    await context.setOffline(true);
    await campoDaPergunta(page).fill("O senhor está com fome?");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(chip(page)).toBeVisible();

    const antes = await esperaOperacao(page, "createTurn");
    expect(antes.status).toBe("PENDING");
    const idLocal = antes.createdEntityId;

    // Gatilho automático — nenhum clique aqui (requisito 1).
    await voltarOnlineEsperar(context, page, "createTurn", "SYNCED");

    const depois = (await statusDe(page, "createTurn"))[0];
    expect(depois.remoteEntityId).toBe(idLocal);
    expect(depois.remoteConfirmedAt).toBeTruthy();

    // O servidor TEM o registro — não só a tela dizendo que sim.
    const turnos = await turnosNoServidor(page, sessionId);
    expect(turnos.some((t) => t.id === idLocal && t.reviewedText === "O senhor está com fome?")).toBe(
      true
    );
  });

  test("2. resposta perdida DEPOIS de persistir: retry não duplica", async ({
    page,
    context,
  }) => {
    await sessaoCarregada(page);
    const sessionId = await sessaoAtivaNoServidor(page);

    await context.setOffline(true);
    await campoDaPergunta(page).fill("Pergunta cuja resposta se perde");
    await page.getByRole("button", { name: "Continuar" }).click();
    const idLocal = (await esperaOperacao(page, "createTurn")).createdEntityId;

    // A requisição ACONTECE de verdade (persiste no servidor); só a
    // RESPOSTA nunca chega ao navegador — como um cabo que cai bem depois de
    // o servidor já ter gravado e respondido.
    let interceptado = 0;
    await page.route(`**${RTQ}/turns`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      interceptado++;
      await route.fetch(); // a requisição real acontece — o servidor grava
      await route.abort("connectionreset"); // o navegador nunca vê a resposta
    });

    await context.setOffline(false);
    // A "primeira tentativa" falha (resposta perdida) → PENDING de novo, com
    // backoff. Espera esse ciclo primeiro.
    await expect
      .poll(async () => (await statusDe(page, "createTurn"))[0]?.retryCount, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    // Agora deixa a rede normal (sem intercepção) para o retry automático
    // chegar — e ele vai encontrar, no ledger, que ESTA clientRequestId já
    // foi aplicada.
    await page.unroute(`**${RTQ}/turns`);
    await expect
      .poll(async () => (await statusDe(page, "createTurn"))[0]?.status, {
        timeout: 15_000,
      })
      .toBe("SYNCED");

    expect(interceptado).toBeGreaterThan(0);
    const turnos = await turnosNoServidor(page, sessionId);
    const iguais = turnos.filter((t) => t.reviewedText === "Pergunta cuja resposta se perde");
    expect(iguais).toHaveLength(1); // NÃO dois
    expect(iguais[0].id).toBe(idLocal);
    const eventos = await eventosNoServidor(page, sessionId, `&turnId=${idLocal}`);
    expect(eventos.filter((e) => e.eventType === "QUESTION_CREATED")).toHaveLength(1);
  });

  test("3. dois disparos da mesma operação não mandam duas requisições", async ({
    page,
    context,
  }) => {
    await sessaoCarregada(page);
    await context.setOffline(true);
    await campoDaPergunta(page).fill("Pergunta com dois disparos de sync");
    await page.getByRole("button", { name: "Continuar" }).click();
    await esperaOperacao(page, "createTurn");

    // Segura a PRIMEIRA requisição em voo — abre uma janela controlada para
    // tentar um segundo disparo ENQUANTO o primeiro ainda não terminou, em
    // vez de torcer para dois eventos coincidirem no mesmo milissegundo.
    let chamadas = 0;
    let liberar!: () => void;
    const segura = new Promise<void>((res) => (liberar = res));
    await page.route(`**${RTQ}/turns`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      chamadas++;
      await segura;
      await route.continue();
    });

    await context.setOffline(false);
    // Gatilho 1 (evento `online`) já deve ter disparado o primeiro envio.
    await esperaEstadoDaFila(page, "createTurn", "SYNCING");

    // Um segundo disparo — o mesmo evento `online` de novo — enquanto o
    // primeiro ainda está preso. A guarda de concorrência do motor
    // (emVooPorEscopo) precisa recusar silenciosamente este segundo.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(300);
    // E, se o botão manual estiver à vista, um terceiro disparo por aí.
    await botaoSincronizar(page)
      .click({ timeout: 500 })
      .catch(() => {});

    liberar();
    await esperaEstadoDaFila(page, "createTurn", "SYNCED", { timeout: 15_000 });

    expect(chamadas).toBe(1);
  });

  test("4. ordem causal: o nível só é enviado depois do caminho que ele pertence", async ({
    page,
    context,
  }) => {
    await conversaPorOpcoesOffline(page, context);
    await criarNivel(page, {
      titulo: "Onde dói?",
      opcoes: ["Cabeça", "Barriga"],
    });

    const path = await esperaOperacao(page, "createPath");
    const node = await esperaOperacao(page, "createNode");
    expect(path.status).toBe("PENDING");
    expect(node.status).toBe("PENDING");
    expect(node.dependsOn).toContain(path.sequence);

    const ordemDeChegada: string[] = [];
    await page.route(`**${RTQ}/paths`, async (route) => {
      if (route.request().method() === "POST") ordemDeChegada.push("path");
      await route.continue();
    });
    await page.route(`**${RTQ}/nodes`, async (route) => {
      if (route.request().method() === "POST") ordemDeChegada.push("node");
      await route.continue();
    });

    await context.setOffline(false);
    await esperaEstadoDaFila(page, "createNode", "SYNCED", { timeout: 20_000 });

    expect(ordemDeChegada).toEqual(["path", "node"]);
  });

  test("5. dependência ainda não sincronizada: o nível espera, não é enviado antes da hora", async ({
    page,
    context,
  }) => {
    await conversaPorOpcoesOffline(page, context);
    await criarNivel(page, {
      titulo: "Quer trocar de posição?",
      opcoes: ["Sim", "Não"],
    });

    await esperaOperacao(page, "createPath");
    const nodeAntes = await esperaOperacao(page, "createNode");
    expect(nodeAntes.status).toBe("PENDING");
    expect(nodeAntes.retryCount).toBe(0);

    // O caminho fica preso (nunca recebe resposta) — o nível NUNCA deveria
    // ser tentado enquanto o caminho não estiver SYNCED.
    await page.route(`**${RTQ}/paths`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.abort("connectionreset");
    });

    await context.setOffline(false);
    // Prova que o motor REALMENTE tentou o caminho e falhou — não que
    // simplesmente não tentou nada ainda.
    await expect
      .poll(async () => (await statusDe(page, "createPath"))[0]?.retryCount, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    // O nível continua parado, e retryCount dele continua ZERO: ele nunca
    // chegou a ser tentado — só o caminho tentou e falhou.
    const node = (await statusDe(page, "createNode"))[0];
    expect(node.status).toBe("PENDING");
    expect(node.retryCount).toBe(0);
  });

  test("6. falha temporária e retry: recupera sozinho quando a rede volta de vez", async ({
    page,
    context,
  }) => {
    await sessaoCarregada(page);
    await context.setOffline(true);
    await campoDaPergunta(page).fill("Pergunta com falha temporária");
    await page.getByRole("button", { name: "Continuar" }).click();

    let primeiraTentativa = true;
    await page.route(`**${RTQ}/turns`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      if (primeiraTentativa) {
        primeiraTentativa = false;
        await route.abort("connectionreset");
        return;
      }
      await route.continue();
    });

    await context.setOffline(false);
    // Depois da primeira falha, o motor agenda um novo `nextRetryAt` —
    // aguarda ele mesmo, sem clique manual.
    await esperaEstadoDaFila(page, "createTurn", "SYNCED", { timeout: 30_000 });
    const op = (await statusDe(page, "createTurn"))[0];
    expect(op.retryCount).toBeGreaterThan(0);
  });

  test("7. refresh durante SYNCING não perde nem duplica a operação", async ({
    page,
    context,
  }) => {
    await sessaoCarregada(page);
    const sessionId = await sessaoAtivaNoServidor(page);
    await context.setOffline(true);
    await campoDaPergunta(page).fill("Pergunta interrompida por um refresh");
    await page.getByRole("button", { name: "Continuar" }).click();
    const idLocal = (await esperaOperacao(page, "createTurn")).createdEntityId;

    // Segura a requisição em voo — dá tempo do teste recarregar a página
    // enquanto o status ainda é SYNCING.
    let liberar!: () => void;
    const segura = new Promise<void>((res) => (liberar = res));
    await page.route(`**${RTQ}/turns`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await segura;
      await route.continue();
    });

    await context.setOffline(false);
    await esperaEstadoDaFila(page, "createTurn", "SYNCING");

    await page.reload({ waitUntil: "domcontentloaded" });
    // `restoreOperation` (lib/offline/queue.ts) devolve SYNCING → PENDING na
    // leitura: ninguém está "em voo" logo após um refresh. Mas o gatilho de
    // "abriu com pendência e rede" (requisito 1) pode tentar de novo quase
    // imediatamente — e como a rota ainda está presa, veria SYNCING outra
    // vez. As DUAS leituras são corretas; o que NUNCA pode acontecer é uma
    // SEGUNDA operação aparecer.
    await expect
      .poll(async () => (await statusDe(page, "createTurn"))[0]?.status)
      .toMatch(/PENDING|SYNCING/);
    const apenasUma = await statusDe(page, "createTurn");
    expect(apenasUma).toHaveLength(1);
    expect(apenasUma[0].createdEntityId).toBe(idLocal);

    liberar();
    // A requisição original, que ainda estava presa, agora responde — e o
    // servidor já tinha (ou está prestes a) processá-la. O ledger garante
    // que o retry pós-refresh não duplica.
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: /Retomar sessão de/ }).click().catch(() => {});
    await esperaEstadoDaFila(page, "createTurn", "SYNCED", { timeout: 20_000 });

    const turnos = await turnosNoServidor(page, sessionId);
    const iguais = turnos.filter((t) => t.reviewedText === "Pergunta interrompida por um refresh");
    expect(iguais).toHaveLength(1);
    expect(iguais[0].id).toBe(idLocal);
  });

  test("8. servidor indisponível: a conectividade real é confirmada, mas o envio falha com segurança", async ({
    page,
    context,
  }) => {
    await sessaoCarregada(page);
    await context.setOffline(true);
    await campoDaPergunta(page).fill("Pergunta com servidor indisponível");
    await page.getByRole("button", { name: "Continuar" }).click();

    // A REDE volta (o navegador alcança o servidor — `/api/auth/me`
    // responde), mas as rotas de escrita da fila ficam fora do ar. Distingue
    // "sem rede" de "servidor com problema".
    await page.route(`**${RTQ}/**`, (route) => route.abort("connectionreset"));
    await context.setOffline(false);

    // Poll direto no retryCount — não só no status: PENDING é alcançado na
    // MESMA escrita que incrementa o retry, mas ler os dois em passos
    // separados deixa uma janela (a leitura seguinte pode pegar um instante
    // ainda mais cedo do que o poll observou). Uma condição só evita isso.
    await expect
      .poll(
        async () => (await statusDe(page, "createTurn"))[0]?.retryCount ?? 0,
        { timeout: 15_000 }
      )
      .toBeGreaterThan(0);
    const op = (await statusDe(page, "createTurn"))[0];
    expect(op.status).toBe("PENDING");
    expect(op.lastError?.kind).toBe("offline");
    // Nunca apagada, nunca marcada como se tivesse ido.
    await expect(chip(page)).toBeVisible();
  });

  test("9. resposta inválida do servidor não é tratada como sucesso", async ({
    page,
    context,
  }) => {
    await sessaoCarregada(page);
    await context.setOffline(true);
    await campoDaPergunta(page).fill("Pergunta com resposta inválida");
    await page.getByRole("button", { name: "Continuar" }).click();

    await page.route(`**${RTQ}/turns`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "isto não é um json válido {{{",
      });
    });

    await context.setOffline(false);
    await expect
      .poll(async () => (await statusDe(page, "createTurn"))[0]?.status, {
        timeout: 15_000,
      })
      .toBe("FAILED");
    const op = (await statusDe(page, "createTurn"))[0];
    expect(op.lastError?.kind).toBe("unknown");
  });

  test("10. conflito remoto (id já em uso) é marcado CONFLICT, nunca aplicado por cima", async ({
    page,
    context,
  }) => {
    await sessaoCarregada(page);
    await context.setOffline(true);
    await campoDaPergunta(page).fill("Pergunta que vai colidir");
    await page.getByRole("button", { name: "Continuar" }).click();

    // Simula o servidor recusando por divergência (409 — mesma chave que a
    // Fase B usa para "mesma clientRequestId, payload diferente").
    await page.route(`**${RTQ}/turns`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "mesma chave de idempotência usada para uma intenção diferente" }),
      });
    });

    await context.setOffline(false);
    await expect
      .poll(async () => (await statusDe(page, "createTurn"))[0]?.status, {
        timeout: 15_000,
      })
      .toBe("CONFLICT");
    const op = (await statusDe(page, "createTurn"))[0];
    expect(op.lastError?.kind).toBe("conflict");
    // A fila PARA: nada depois de um conflito é enviado sem decisão.
    await expect(chip(page)).toContainText("sua decisão");
  });

  test("11. 401 e 403 preservam a fila — nunca fingem sincronização", async ({
    page,
    context,
  }) => {
    await sessaoCarregada(page);
    await context.setOffline(true);
    await campoDaPergunta(page).fill("Pergunta sem autorização");
    await page.getByRole("button", { name: "Continuar" }).click();

    await page.route(`**${RTQ}/turns`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
    });

    await context.setOffline(false);
    await expect
      .poll(async () => (await statusDe(page, "createTurn"))[0]?.status, {
        timeout: 15_000,
      })
      .toBe("FAILED");
    const op = (await statusDe(page, "createTurn"))[0];
    expect(op.lastError?.kind).toBe("unauthorized");
    await expect(chip(page)).toContainText("Entre novamente");

    // A operação continua na fila — não sumiu, não virou "enviada".
    expect(await statusDe(page, "createTurn")).toHaveLength(1);
  });

  test("12. retomada após reautenticação: 'Sincronizar agora' reenfileira e envia", async ({
    page,
    context,
  }) => {
    await sessaoCarregada(page);
    const sessionId = await sessaoAtivaNoServidor(page);
    await context.setOffline(true);
    await campoDaPergunta(page).fill("Pergunta retomada após reautenticação");
    await page.getByRole("button", { name: "Continuar" }).click();
    const idLocal = (await esperaOperacao(page, "createTurn")).createdEntityId;

    let bloquear = true;
    await page.route(`**${RTQ}/turns`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      if (bloquear) {
        await route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
        return;
      }
      await route.continue();
    });

    await context.setOffline(false);
    await esperaEstadoDaFila(page, "createTurn", "FAILED", { timeout: 15_000 });
    await expect(chip(page)).toContainText("Entre novamente");

    // "Reautenticar" aqui: a sessão de Claudia nunca expirou de verdade — o
    // 401 foi simulado. Reautenticação real já tem cobertura própria
    // (scripts/test-access.mjs); o que ESTE teste prova é que, uma vez que a
    // causa passou, o clique do cuidador retoma o envio sem duplicar.
    bloquear = false;
    await botaoSincronizar(page).click();
    await esperaEstadoDaFila(page, "createTurn", "SYNCED", { timeout: 15_000 });

    const turnos = await turnosNoServidor(page, sessionId);
    const iguais = turnos.filter((t) => t.reviewedText === "Pergunta retomada após reautenticação");
    expect(iguais).toHaveLength(1);
    expect(iguais[0].id).toBe(idLocal);
  });

  test("13. isolamento: sincronizar a fila de um paciente não toca a de outro", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await entrarComo(pageA, dados.assistente.email);
    await abrirModo(pageA, dados.pacienteId);
    await pageA.getByRole("button", { name: "Iniciar nova sessão" }).click();
    await pularContexto(pageA);

    await entrarComo(pageB, dados.outroAssistente.email);
    await abrirModo(pageB, dados.outroPacienteId);
    await pageB.getByRole("button", { name: "Iniciar nova sessão" }).click();
    await pularContexto(pageB);

    await ctxA.setOffline(true);
    await ctxB.setOffline(true);
    await pageA
      .getByLabel("Pergunta para o paciente")
      .fill("Pergunta do paciente A, do assistente Claudia");
    await pageA.getByRole("button", { name: "Continuar" }).click();
    await pageB
      .getByLabel("Pergunta para o paciente")
      .fill("Pergunta do paciente B, do assistente Marcos");
    await pageB.getByRole("button", { name: "Continuar" }).click();

    // Só A volta. B continua sem rede.
    await ctxA.setOffline(false);
    await expect
      .poll(async () => (await statusDe(pageA, "createTurn"))[0]?.status, {
        timeout: 15_000,
      })
      .toBe("SYNCED");

    // A fila de B não foi tocada: continua PENDING, sem tentativa nenhuma.
    const opB = await esperaOperacao(pageB, "createTurn");
    expect(opB.status).toBe("PENDING");
    expect(opB.retryCount).toBe(0);

    // E o servidor do paciente B não recebeu nada de A.
    const rA = await pageA.request.get(
      `${RTQ}/sessions?patientId=${dados.pacienteId}`
    );
    const sessoesA = (await rA.json()).sessions;
    const sessionIdA = sessoesA.find(
      (s: { status: string }) => s.status === "ACTIVE"
    ).id;
    const turnosDeA = await turnosNoServidor(pageA, sessionIdA);
    expect(
      turnosDeA.some((t) => t.reviewedText.includes("paciente B"))
    ).toBe(false);

    await ctxA.close();
    await ctxB.close();
  });
});
