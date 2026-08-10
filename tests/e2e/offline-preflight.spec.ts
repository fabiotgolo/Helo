// ——— Revalidação pré-envio (requisito 7, complemento 4.9.4) ———
//
// A Fase D reconheceu uma lacuna: "401 antes do envio" só existia
// REATIVAMENTE — a fila tentava escrever, o servidor recusava, e só ENTÃO o
// motor descobria que a sessão tinha expirado ou o acesso tinha sumido.
//
// Este arquivo prova a metade que faltava: que o motor pergunta ANTES —
// pela rota `/api/realtime-questions/preflight` — e que a resposta a essa
// pergunta chega a tempo de impedir a escrita, não só de explicá-la depois.
//
// A prova central de cada teste é NEGATIVA: conta quantas vezes a rota de
// ESCRITA (`turns`) foi chamada. Zero é a única resposta certa quando o
// preflight já sabia que a escrita seria recusada — qualquer coisa acima de
// zero significaria que o motor gastou uma tentativa real só para descobrir
// o que já podia saber de graça.

import { expect, test, type Page } from "@playwright/test";
import { abrirModo, entrarComo, iniciarNovaSessao, pularContexto, semear, type Semente } from "./helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

const RTQ = "/api/realtime-questions";
const chip = (page: Page) => page.getByTestId("offline-chip");
const campoDaPergunta = (page: Page) =>
  page.getByLabel("Pergunta para o paciente");

async function sessaoCarregada(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await iniciarNovaSessao(page);
  await pularContexto(page);
  await expect(
    page.getByRole("heading", { name: "Escreva a pergunta" })
  ).toBeVisible();
}

interface OperacaoLida {
  id: string;
  operationType: string;
  status: string;
  idempotencyKey: string;
  lastError: { kind: string; message: string } | null;
}

/** Todas as operações guardadas, DECIFRADAS — mesmo esquema de offline-sync.spec.ts. */
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
        // Ilegível — mesma regra do produto: descarta, não inventa.
      }
    }
    return saida;
  });
}

/**
 * Conta chamadas a `caminho` desde este ponto em diante. Devolve uma função
 * que lê o total atual — chamar antes E depois do gatilho de sincronização é
 * o que prova "zero escritas", não um `expect` solto no meio do teste.
 */
function contador(page: Page, caminho: string): () => number {
  let n = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === caminho) n += 1;
  });
  return () => n;
}

async function sincronizarAgora(page: Page) {
  // O mesmo gatilho que "Sincronizar agora" usa — dispara um ciclo real do
  // motor sem depender de o botão estar visível neste estado específico.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

test.describe("Preflight — revalidação antes do primeiro envio", () => {
  test("1. autenticação ausente é detectada pelo preflight — zero escritas tentadas", async ({
    page,
    context,
  }) => {
    await sessaoCarregada(page);
    await context.setOffline(true);
    await campoDaPergunta(page).fill("Pergunta sem sessão válida depois");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect.poll(() => operacoes(page).then((o) => o.length)).toBeGreaterThan(0);
    const antes = await operacoes(page);
    const idempotencyKeyAntes = antes[0].idempotencyKey;

    const escritas = contador(page, `${RTQ}/turns`);
    const preflights = contador(page, `${RTQ}/preflight`);

    // O cookie de sessão SOME — o cenário real é o TTL de 30 dias vencendo, ou
    // o navegador limpando cookies entre uma visita e outra.
    await context.clearCookies();
    await context.setOffline(false);

    await sincronizarAgora(page);
    await expect
      .poll(async () => (await operacoes(page))[0]?.status, { timeout: 15_000 })
      .toBe("FAILED");

    // A prova central: o preflight foi chamado, a escrita NÃO foi.
    expect(preflights(), "o preflight foi consultado").toBeGreaterThan(0);
    expect(escritas(), "nenhuma tentativa de escrita chegou a sair").toBe(0);

    // Fila e idempotência preservadas — nada foi perdido, nada foi trocado.
    const depois = await operacoes(page);
    expect(depois).toHaveLength(1);
    expect(depois[0].idempotencyKey).toBe(idempotencyKeyAntes);
    expect(depois[0].status).not.toBe("SYNCED");
    expect(depois[0].lastError?.kind).toBe("unauthorized");
    await expect(chip(page)).toContainText("Entre novamente");
  });

  test("2. acesso ao paciente revogado é detectado pelo preflight — zero escritas tentadas", async ({
    page,
    context,
    request,
  }) => {
    await sessaoCarregada(page);
    await context.setOffline(true);
    await campoDaPergunta(page).fill("Pergunta que perde o acesso depois");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect.poll(() => operacoes(page).then((o) => o.length)).toBeGreaterThan(0);
    const idempotencyKeyAntes = (await operacoes(page))[0].idempotencyKey;

    const escritas = contador(page, `${RTQ}/turns`);
    const preflights = contador(page, `${RTQ}/preflight`);

    // "Outro aparelho" (o admin) revoga o vínculo — pela API. `request` é o
    // mesmo objeto que `semear()` usou para o bootstrap do admin, e mantém a
    // sessão dele durante todo o teste — não precisa reautenticar.
    const links = await (await request.get("/api/admin/access")).json();
    const vinculo = links.links.find(
      (l: { userId: string; patientId: number }) =>
        l.userId === dados.assistente.id && l.patientId === dados.pacienteId
    );
    expect(vinculo, "precisa existir o vínculo a revogar").toBeTruthy();
    const revogou = await request.delete("/api/admin/access", {
      data: { id: vinculo.id },
    });
    expect(revogou.ok(), "a revogação precisa ter funcionado no servidor").toBeTruthy();

    await context.setOffline(false);
    await sincronizarAgora(page);
    await expect
      .poll(async () => (await operacoes(page))[0]?.status, { timeout: 15_000 })
      .toBe("FAILED");

    expect(preflights(), "o preflight foi consultado").toBeGreaterThan(0);
    expect(escritas(), "nenhuma tentativa de escrita chegou a sair").toBe(0);

    const depois = await operacoes(page);
    expect(depois).toHaveLength(1);
    expect(depois[0].idempotencyKey).toBe(idempotencyKeyAntes);
    expect(depois[0].status).not.toBe("SYNCED");
  });

  test("3. mudança ocorrida DEPOIS do preflight ainda é capturada pelo 401/403 do write", async ({
    page,
    context,
    request,
  }) => {
    // Este é o caso que uma checagem só-de-preflight NÃO fecha por
    // construção: o preflight responde "pode" e, no instante seguinte —
    // ainda dentro do mesmo ciclo — o acesso é revogado. O requisito exige
    // que o WRITE continue sendo a autoridade final, e é isso que este teste
    // prova: a operação termina recusada mesmo tendo passado no preflight.
    await sessaoCarregada(page);
    await campoDaPergunta(page).fill("Revogado no meio do ciclo");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();

    // Segura o preflight em voo — ele vai responder "pode", mas só depois
    // que a revogação abaixo já tiver acontecido no servidor.
    let liberar: () => void = () => {};
    const segura = new Promise<void>((res) => {
      liberar = res;
    });
    await page.route(`**${RTQ}/preflight*`, async (route) => {
      const resposta = await route.fetch();
      await segura;
      await route.fulfill({ response: resposta });
    });

    await context.setOffline(true);
    await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
    await expect.poll(() => operacoes(page).then((o) => o.length)).toBeGreaterThan(0);

    await context.setOffline(false);
    void sincronizarAgora(page);
    // Dá tempo do preflight realmente estar "em voo" (a rota já interceptou).
    await page.waitForTimeout(500);

    const links = await (await request.get("/api/admin/access")).json();
    const vinculo = links.links.find(
      (l: { userId: string; patientId: number }) =>
        l.userId === dados.assistente.id && l.patientId === dados.pacienteId
    );
    await request.delete("/api/admin/access", { data: { id: vinculo.id } });

    // Libera a resposta do preflight — que dizia "pode" — e deixa o motor
    // seguir para o write de verdade.
    liberar();

    await expect
      .poll(async () => (await operacoes(page))[0]?.status, { timeout: 15_000 })
      .toBe("FAILED");
    expect((await operacoes(page))[0].lastError?.kind).toBe("unauthorized");
  });
});
