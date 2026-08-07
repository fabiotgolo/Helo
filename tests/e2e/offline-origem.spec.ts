// ——— A origem da operação, do clique até a trilha (Fase 4.9.5) ———
//
// A Fase E encontrou a lacuna: a §3.5 e o item 7 da §7 da auditoria prometiam
// que o servidor marcaria, na trilha, que a operação nasceu offline e a que
// horas o cuidador agiu — e os dois nomes só existiam no documento.
//
// As suítes de domínio e HTTP provam as pontas: que a fila cunha a origem uma
// vez, e que a trilha grava o que o corpo mandou. O que só aqui se prova é o
// MEIO: que a origem gravada corresponde ao que de fato aconteceu com o
// cuidador. Um teste HTTP pode mandar `offlineQueued: true` de dentro de um
// terminal com rede perfeita; só o navegador com `context.setOffline(true)`
// prova que o app marca offline porque estava offline.
//
// A distinção que se defende aqui, em uma frase: uma conversa conduzida sem
// rede não pode aparecer na trilha como se tivesse acontecido no minuto em
// que a conexão voltou.

import { expect, test, type Page } from "@playwright/test";
import { abrirModo, entrarComo, pularContexto, semear, type Semente } from "./helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

const RTQ = "/api/realtime-questions";
const campoDaPergunta = (page: Page) => page.getByLabel("Pergunta para o paciente");

interface EventoLido {
  eventType: string;
  createdAt: string;
  metadata: { offlineQueued?: boolean; intendedAt?: string } | null;
}

async function sessaoCarregada(page: Page): Promise<string> {
  await abrirModo(page, dados.pacienteId);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
  await pularContexto(page);
  await expect(
    page.getByRole("heading", { name: "Escreva a pergunta" })
  ).toBeVisible();
  // Mesmo caminho de offline-sync.spec.ts: a sessão ativa vem do SERVIDOR, e
  // não de um palpite sobre a URL.
  const r = await page.request.get(`${RTQ}/sessions?patientId=${dados.pacienteId}`);
  const j = await r.json();
  const ativa = j.sessions.find(
    (s: { status: string }) => s.status === "ACTIVE" || s.status === "PAUSED"
  );
  expect(ativa, "precisa haver uma sessão ativa no servidor").toBeTruthy();
  return ativa.id as string;
}

/** A trilha da sessão, lida pela rota de leitura — a mesma que o app usa. */
async function trilha(page: Page, sessionId: string): Promise<EventoLido[]> {
  const r = await page.request.get(
    `${RTQ}/events?patientId=${dados.pacienteId}&sessionId=${sessionId}`
  );
  if (!r.ok()) return [];
  const j = (await r.json()) as { events: EventoLido[] };
  return j.events;
}

/** Operações guardadas, DECIFRADAS — mesmo esquema de offline-sync.spec.ts. */
function operacoes(
  page: Page
): Promise<Array<{ operationType: string; status: string; offlineQueued: boolean; createdAt: string }>> {
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
    const chaves = new Map<string, CryptoKey>();
    const obterChave = async (escopo: string) => {
      if (chaves.has(escopo)) return chaves.get(escopo)!;
      const reg = await new Promise<{ chave: CryptoKey } | undefined>((res) => {
        const r = banco.transaction("chaves", "readonly").objectStore("chaves").get(escopo);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(undefined);
      });
      if (reg?.chave) chaves.set(escopo, reg.chave);
      return reg?.chave ?? null;
    };
    const saida = [];
    for (const bruto of brutos) {
      const chave = await obterChave(bruto.escopo);
      if (!chave) continue;
      try {
        const aberto = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: bruto.iv,
            additionalData: new TextEncoder().encode(
              `${bruto.escopo}|operacoes|${bruto.id}`
            ),
          },
          chave,
          bruto.dados
        );
        saida.push(JSON.parse(new TextDecoder().decode(aberto)));
      } catch {
        /* ilegível — descarta, não inventa */
      }
    }
    return saida;
  });
}

async function sincronizarAgora(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

test.describe("Origem da operação — offline chega marcado à trilha", () => {
  test("1. o que foi feito SEM rede chega à trilha marcado, com o horário do aparelho", async ({
    page,
    context,
  }) => {
    const sessionId = await sessaoCarregada(page);

    // A rede cai de verdade. O cuidador continua trabalhando.
    await context.setOffline(true);
    const antesDoClique = Date.now();
    await campoDaPergunta(page).fill("Está sentindo dor agora?");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect.poll(() => operacoes(page).then((o) => o.length)).toBeGreaterThan(0);
    const depoisDoClique = Date.now();

    // A fila já sabe a origem, antes de qualquer servidor opinar.
    const naFila = await operacoes(page);
    expect(naFila[0].offlineQueued, "a fila registrou origem offline").toBe(true);
    const intencao = Date.parse(naFila[0].createdAt);
    expect(intencao).toBeGreaterThanOrEqual(antesDoClique - 1000);
    expect(intencao).toBeLessThanOrEqual(depoisDoClique + 1000);

    // A rede volta e a fila sobe.
    await context.setOffline(false);
    await sincronizarAgora(page);
    await expect
      .poll(async () => (await operacoes(page))[0]?.status, { timeout: 20_000 })
      .toBe("SYNCED");

    const eventos = await trilha(page, sessionId);
    const doTurno = eventos.filter((e) => e.metadata?.offlineQueued === true);
    expect(doTurno.length, "há evento marcado como offline").toBeGreaterThan(0);

    const evento = doTurno[0];
    expect(evento.metadata?.intendedAt, "o horário do aparelho está lá").toBeTruthy();
    expect(
      Date.parse(evento.metadata!.intendedAt!),
      "e é o instante do clique, não o da sincronização"
    ).toBeLessThanOrEqual(depoisDoClique + 1000);

    // O ponto da fase: os dois horários existem, e são DIFERENTES.
    expect(
      Date.parse(evento.createdAt),
      "createdAt é do servidor, e veio DEPOIS da intenção"
    ).toBeGreaterThanOrEqual(Date.parse(evento.metadata!.intendedAt!));
    expect(
      evento.createdAt,
      "o horário do servidor não foi substituído pelo do aparelho"
    ).not.toBe(evento.metadata!.intendedAt);
  });

  test("2. o que foi feito COM rede não é marcado como offline", async ({ page }) => {
    const sessionId = await sessaoCarregada(page);

    // Sem nunca cair a rede.
    await campoDaPergunta(page).fill("Quer água?");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();

    // A operação some da fila ao ser confirmada (`pruneSynced`), então quem
    // diz que ela chegou é a TRILHA — não um status que deixou de existir.
    await expect
      .poll(async () => (await trilha(page, sessionId)).length, { timeout: 25_000 })
      .toBeGreaterThan(1);

    const naFila = await operacoes(page);
    expect(
      naFila.every((o) => o.offlineQueued === false),
      "nada que sobrou na fila nasceu offline"
    ).toBe(true);

    const eventos = await trilha(page, sessionId);
    expect(
      eventos.every((e) => e.metadata?.offlineQueued !== true),
      "nenhum evento da trilha foi classificado como offline"
    ).toBe(true);
    expect(
      eventos.every((e) => !e.metadata?.intendedAt),
      "e nenhum ganhou um intendedAt que ninguém informou"
    ).toBe(true);
  });

  test("3. fechar o navegador e reabrir não apaga a origem nem muda a intenção", async ({
    page,
    context,
  }) => {
    const sessionId = await sessaoCarregada(page);

    await context.setOffline(true);
    await campoDaPergunta(page).fill("Consegue me ouvir bem?");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect.poll(() => operacoes(page).then((o) => o.length)).toBeGreaterThan(0);

    const antes = (await operacoes(page))[0];
    expect(antes.offlineQueued).toBe(true);
    const intencaoOriginal = antes.createdAt;

    // Fecha e reabre. Em `next dev` não há Service Worker (ver
    // offline-app-shell.spec.ts), então recarregar exige a rede de volta — e
    // é justamente por isso que a prova abaixo é a forte: depois do refresh,
    // a operação foi RECONSTRUÍDA a partir do disco, e o único lugar de onde
    // o horário original pode ter vindo é o registro cifrado que sobreviveu.
    // Se o refresh tivesse perdido ou reescrito a intenção, a trilha traria o
    // horário do recarregamento — e o `toBe` abaixo falharia.
    await context.setOffline(false);
    await page.reload();

    // Reabrir o app cai na lista de sessões, não dentro da conversa — e o
    // motor de sincronização vive DENTRO dela. O cuidador retoma; o teste
    // também. É o percurso real de quem fechou o navegador no meio.
    await page.getByRole("button", { name: /Retomar sessão/ }).click();

    // A operação some da fila ao ser confirmada; quem prova a chegada é a
    // trilha — e o que se espera não é "algum evento", é o evento MARCADO.
    await expect
      .poll(
        async () => {
          await sincronizarAgora(page);
          const evs = await trilha(page, sessionId);
          return evs.filter((e) => e.metadata?.offlineQueued === true).length;
        },
        { timeout: 30_000, intervals: [1000] }
      )
      .toBeGreaterThan(0);

    const eventos = await trilha(page, sessionId);
    const marcados = eventos.filter((e) => e.metadata?.offlineQueued === true);
    expect(marcados.length, "a trilha recebeu a operação de antes do refresh").toBeGreaterThan(0);
    expect(
      marcados.every((e) => e.metadata?.intendedAt === intencaoOriginal),
      "com a intenção ORIGINAL, não o horário do recarregamento nem o do envio"
    ).toBe(true);
  });

  test("4. rede ativa mas servidor mudo TAMBÉM é origem offline", async ({ page }) => {
    // O caso que `navigator.onLine` não vê, e que a política de conectividade
    // da fase nomeia desde a 4.9.2: portal cativo, Wi-Fi sem rota, VPN caída,
    // servidor fora do ar. O navegador jura que há conexão; não há.
    //
    // Aqui está o valor deste teste: com `context.setOffline(true)` o
    // navegador dispara o evento `offline` e o estado já chega certo ao
    // clique. Sem esse evento, quem descobre a queda é a REQUISIÇÃO — e a
    // descoberta acontece no mesmo passo em que a operação é enfileirada.
    // Se a conectividade efetiva não valesse no mesmo instante em que é
    // observada, esta operação entraria na fila marcada como nascida ONLINE.
    const sessionId = await sessaoCarregada(page);

    // A rede segue ativa. O que some é o SERVIDOR.
    await page.route(`**${RTQ}/**`, (rota) => rota.abort());

    await campoDaPergunta(page).fill("O servidor sumiu, e agora?");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect.poll(() => operacoes(page).then((o) => o.length)).toBeGreaterThan(0);

    const naFila = await operacoes(page);
    expect(
      naFila[0].offlineQueued,
      "servidor inalcançável é origem offline, mesmo com o navegador se dizendo conectado"
    ).toBe(true);

    // E a trilha recebe isso quando o servidor volta.
    await page.unroute(`**${RTQ}/**`);
    await expect
      .poll(
        async () => {
          await sincronizarAgora(page);
          const evs = await trilha(page, sessionId);
          return evs.filter((e) => e.metadata?.offlineQueued === true).length;
        },
        { timeout: 30_000, intervals: [1000] }
      )
      .toBeGreaterThan(0);
  });
});
