// ——— App shell e rascunhos locais (Fase 4.9.2, complemento) ———
//
// A suíte anterior (offline-continuidade.spec.ts) provou a continuidade com o
// SERVIDOR fora e a página já carregada. Ela não conseguia provar o caso mais
// duro — recarregar com a rede INTEIRA fora — porque sem Service Worker o
// navegador não tem de onde tirar o HTML.
//
// É esse caso que se prova aqui, junto do terceiro estatuto do armazenamento
// local: o rascunho, que não é fato nem intenção.
//
// `context.setOffline(true)` derruba a rede de verdade. Quando um teste daqui
// recarrega a página nesse estado e ela abre, quem a serviu foi o cache do
// Service Worker — não há outra explicação possível.
//
// ——— ESTA SUÍTE EXIGE UM BUILD DE PRODUÇÃO ———
//
//   NEXT_DIST_DIR=.next-shell npm run build
//   NEXT_DIST_DIR=.next-shell npx next start -p 3480
//   FIRESTORE_DATABASE_ID=helo-db HELO_BASE_URL=http://localhost:3480 \
//     npm run test:ui:shell
//
// Não é preciosismo. Contra o `next dev`, recarregar sem rede faz o cliente de
// HMR não alcançar o servidor e recarregar a página em LAÇO — a tela pisca
// para sempre e nenhum teste conclui. É comportamento do servidor de
// desenvolvimento, não do produto: em produção não existe HMR, e os pedaços da
// rota vêm todos no HTML inicial em vez de por importação dinâmica.
//
// Foi por isso que esta suíte saiu do lote `offline` do runner de lotes, que
// roda em dev. As jornadas que funcionam em dev — servidor inalcançável com a
// página carregada — continuam lá, em offline-continuidade.spec.ts.

import { expect, test, type Page } from "@playwright/test";
import {
  abrirModo,
  entrarComo,
  pularContexto,
  selecionarPaciente,
  semear,
  type Semente,
} from "./helpers";
import {
  confirmarOpcao,
  criarNivel,
  degrau,
  iniciarConversaPorOpcoes,
  opcao,
} from "./option-conversation-helpers";

let dados: Semente;

/**
 * Recusa rodar contra um servidor de desenvolvimento, com a explicação — em
 * vez de deixar o próximo leitor descobrir sozinho, depois de dez minutos, por
 * que a tela pisca em laço.
 */
test.beforeAll(async ({ request }) => {
  const html = await (await request.get("/login")).text();
  const ehDev =
    html.includes("__next_hmr") ||
    html.includes("webpack-hmr") ||
    html.includes("react-refresh");
  expect(
    ehDev,
    "esta suíte precisa de um build de produção — veja o cabeçalho do arquivo"
  ).toBeFalsy();
});

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

const chip = (page: Page) => page.getByTestId("offline-chip");
const marcaDeRascunho = (page: Page) => page.getByTestId("rascunho-local");
const campoDaPergunta = (page: Page) =>
  page.getByLabel("Pergunta para o paciente");

/**
 * Um SEGUNDO paciente do mesmo cuidador.
 *
 * `dados.outroPacienteId` do fixture pertence a outro assistente — ele existe
 * para provar que Claudia NÃO o alcança. Aqui precisamos do oposto: dois
 * pacientes que ela alcança, para que a troca entre eles seja legítima e o que
 * se prove seja o isolamento do armazenamento, não a falta de vínculo.
 */
async function segundoPacienteDela(page: Page): Promise<number> {
  const r = await page.request.post("/api/patients", {
    data: { name: "Sra. Helena" },
  });
  expect(r.ok(), "criar o segundo paciente").toBeTruthy();
  return (await r.json()).patient.id as number;
}

/**
 * Troca o paciente ativo. Precisa passar por `selecionarPaciente`: o helper
 * instala um init script que reescreve `helo.patientId` a CADA navegação, e um
 * `localStorage.setItem` solto seria desfeito na primeira `goto`.
 */
async function trocarDePaciente(page: Page, patientId: number) {
  await selecionarPaciente(page, patientId);
  await page.goto("/conversa/perguntas", { waitUntil: "domcontentloaded" });
}

/** Sessão aberta e carregada, com a rede no ar. */
async function sessaoCarregada(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
  await pularContexto(page);
  await expect(
    page.getByRole("heading", { name: "Escreva a pergunta" })
  ).toBeVisible();
}

/**
 * Espera o app shell estar guardado: um Worker controlando a página, o HTML da
 * tela no cache e pedaços do aplicativo suficientes para ela montar.
 *
 * Sem esta espera os testes seriam corrida pura — a precarga é assíncrona, e
 * um `setOffline` chegando antes dela produziria falha que não é do produto.
 */
async function shellPronto(page: Page) {
  await page.waitForFunction(
    async () => {
      if (!navigator.serviceWorker?.controller) return false;
      const nomes = await caches.keys();
      const shell = nomes.find((n) => n.startsWith("helo-shell-"));
      if (!shell) return false;
      const cache = await caches.open(shell);
      const guardados = new Set(
        (await cache.keys()).map((r) => new URL(r.url).pathname)
      );
      if (!guardados.has("/conversa/perguntas")) return false;

      // A condição precisa é esta: TUDO o que a página buscou de
      // `/_next/static/` precisa estar guardado. Um número fixo de pedaços
      // ("pelo menos 4") passava com a lista incompleta, e a tela abria sem
      // rede mas sem hidratar — o pior desfecho possível, porque parece que
      // funcionou.
      const necessarios = performance
        .getEntriesByType("resource")
        .map((e) => {
          try {
            return new URL(e.name).pathname;
          } catch {
            return "";
          }
        })
        .filter((p) => p.startsWith("/_next/static/"));
      return (
        necessarios.length > 0 && necessarios.every((p) => guardados.has(p))
      );
    },
    null,
    { timeout: 60_000 }
  );
}

/** Quantas intenções estão guardadas no aparelho agora. */
function operacoesGuardadas(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const bancos = await indexedDB.databases?.();
    if (bancos && !bancos.some((b) => b.name === "helo-offline")) return 0;
    const banco = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("helo-offline");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!banco.objectStoreNames.contains("operacoes")) return 0;
    return new Promise<number>((res) => {
      const r = banco
        .transaction("operacoes", "readonly")
        .objectStore("operacoes")
        .count();
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(-1);
    });
  });
}

function rascunhosGuardados(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const banco = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("helo-offline");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!banco.objectStoreNames.contains("rascunhos")) return 0;
    return new Promise<number>((res) => {
      const r = banco
        .transaction("rascunhos", "readonly")
        .objectStore("rascunhos")
        .count();
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(-1);
    });
  });
}

// ════ O app shell ════

test("a tela abre com a rede inteira fora depois de uma visita com rede", async ({
  page,
  context,
}) => {
  await sessaoCarregada(page);
  await shellPronto(page);

  await campoDaPergunta(page).fill("O senhor está com dor?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("blockquote")).toHaveText("O senhor está com dor?");

  // Rede INTEIRA fora — não é só a API. Sem Service Worker, o `reload` abaixo
  // morre em ERR_INTERNET_DISCONNECTED antes de o Helo existir.
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(page.getByTestId("retomada-local")).toBeVisible();
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();
  await expect(page.getByRole("blockquote")).toHaveText("O senhor está com dor?");
});

test("fechar a tela e voltar, totalmente sem rede, devolve a conversa", async ({
  page,
  context,
}) => {
  await sessaoCarregada(page);
  await shellPronto(page);
  await campoDaPergunta(page).fill("Quer mudar de posição?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("blockquote")).toHaveText("Quer mudar de posição?");

  await context.setOffline(true);
  // Sair da origem e voltar: o IndexedDB e o cache são da origem, não da
  // página, então isto exercita a mesma persistência de fechar e reabrir.
  await page.goto("about:blank");
  await page.goto("/conversa/perguntas", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("button", { name: /Retomar sessão de/ })).toBeVisible();
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();
  await expect(page.getByRole("blockquote")).toHaveText("Quer mudar de posição?");
});

test("o cache do shell não guarda API, token nem segredo", async ({ page }) => {
  await sessaoCarregada(page);
  await shellPronto(page);

  const conteudo = await page.evaluate(async () => {
    const nomes = await caches.keys();
    const urls: string[] = [];
    let textoHtml = "";
    for (const nome of nomes) {
      const cache = await caches.open(nome);
      for (const req of await cache.keys()) {
        urls.push(new URL(req.url).pathname);
        if (new URL(req.url).pathname === "/conversa/perguntas") {
          const res = await cache.match(req);
          textoHtml = res ? await res.text() : "";
        }
      }
    }
    return { urls, textoHtml };
  });

  // A regra mais importante do Service Worker.
  expect(conteudo.urls.filter((u) => u.startsWith("/api/"))).toEqual([]);
  // E o login não é cacheado: entrar exige servidor.
  expect(conteudo.urls).not.toContain("/login");

  // O HTML guardado é o da tela, e não carrega dado de ninguém.
  expect(conteudo.textoHtml.length).toBeGreaterThan(0);
  for (const proibido of [
    "__session",
    "passwordHash",
    "sk_",
    "sk-ant",
    dados.assistente.email,
  ]) {
    expect(
      conteudo.textoHtml,
      `"${proibido}" não pode estar no HTML guardado`
    ).not.toContain(proibido);
  }
});

test("uma versão nova do Service Worker espera, e não leva a fila junto", async ({
  page,
  context,
}) => {
  await sessaoCarregada(page);
  await shellPronto(page);

  // Uma intenção guardada, para conferir que a troca não a toca.
  await context.setOffline(true);
  await campoDaPergunta(page).fill("Vai sobreviver à atualização?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("blockquote")).toHaveText(
    "Vai sobreviver à atualização?"
  );
  expect(await operacoesGuardadas(page)).toBeGreaterThan(0);
  const antes = await operacoesGuardadas(page);

  // Volta a rede e registra uma versão diferente — é o que um deploy faz.
  await context.setOffline(false);
  const resultado = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register("/sw.js?v=versao-de-teste", {
      scope: "/",
    });
    await new Promise((r) => setTimeout(r, 1500));
    await reg.update().catch(() => {});
    return {
      temEspera: !!reg.waiting || !!reg.installing,
      caches: await caches.keys(),
    };
  });

  // O Worker novo NÃO assume no meio da conversa: ele espera a aba fechar.
  expect(resultado.temEspera).toBeTruthy();
  // O cache da versão em uso continua lá — quem apaga o antigo é a ATIVAÇÃO
  // do novo, e ela ainda não aconteceu.
  expect(resultado.caches.some((n) => n.startsWith("helo-shell-"))).toBeTruthy();

  // E o que importa: a fila é do IndexedDB, que o Service Worker nem lê.
  expect(await operacoesGuardadas(page)).toBe(antes);
  await expect(chip(page)).toBeVisible();
});

// ════ Rascunhos ════

test("o texto digitado sobrevive a recarregar sem rede — e não vira operação", async ({
  page,
  context,
}) => {
  await sessaoCarregada(page);
  await shellPronto(page);

  await campoDaPergunta(page).fill("O senhor quer que eu chame alguém?");
  await expect(marcaDeRascunho(page)).toBeVisible();
  await expect(marcaDeRascunho(page)).toContainText("ainda não enviado");

  // A regra que separa rascunho de intenção: digitar NÃO enfileira nada.
  await expect.poll(() => rascunhosGuardados(page)).toBeGreaterThan(0);
  expect(await operacoesGuardadas(page)).toBe(0);
  await expect(chip(page)).toBeHidden();

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();

  await expect(campoDaPergunta(page)).toHaveValue(
    "O senhor quer que eu chame alguém?"
  );
  await expect(marcaDeRascunho(page)).toBeVisible();
  // Continua não sendo intenção depois de voltar.
  expect(await operacoesGuardadas(page)).toBe(0);
});

test("o rascunho recuperado pode ser editado e então submetido", async ({
  page,
  context,
}) => {
  await sessaoCarregada(page);
  await shellPronto(page);
  await campoDaPergunta(page).fill("O senhor quer");
  await expect.poll(() => rascunhosGuardados(page)).toBeGreaterThan(0);

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();
  await expect(campoDaPergunta(page)).toHaveValue("O senhor quer");

  // Editar o que voltou.
  await campoDaPergunta(page).fill("O senhor quer água?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("blockquote")).toHaveText("O senhor quer água?");

  // Submetido: o rascunho cumpriu o papel e sai; a intenção toma o lugar dele.
  await expect.poll(() => rascunhosGuardados(page)).toBe(0);
  expect(await operacoesGuardadas(page)).toBeGreaterThan(0);
  await expect(marcaDeRascunho(page)).toBeHidden();
});

test("cancelar a interpretação apaga o rascunho do aparelho", async ({ page }) => {
  await sessaoCarregada(page);
  await shellPronto(page);

  await page.getByRole("button", { name: "Registrar o que entendi" }).click();
  const campo = page.getByRole("textbox", { name: /entendi|interpretação/i }).first();
  await campo.fill("Acho que ele quer descansar");
  await expect(marcaDeRascunho(page)).toBeVisible();
  await expect.poll(() => rascunhosGuardados(page)).toBeGreaterThan(0);
  // Escrever uma interpretação também não cria intenção nenhuma.
  expect(await operacoesGuardadas(page)).toBe(0);

  // Cancelamento EXPLÍCITO: aí sim o texto some do aparelho.
  await page.getByRole("button", { name: "Cancelar" }).click();
  await expect.poll(() => rascunhosGuardados(page)).toBe(0);
  expect(await operacoesGuardadas(page)).toBe(0);
});

test("o rascunho de um paciente não aparece na conversa de outro", async ({
  page,
}) => {
  await sessaoCarregada(page);
  await shellPronto(page);
  await campoDaPergunta(page).fill("Segredo do paciente A");
  await expect.poll(() => rascunhosGuardados(page)).toBeGreaterThan(0);

  // Troca o paciente ativo, como faz o Dashboard.
  const outro = await segundoPacienteDela(page);
  await trocarDePaciente(page, outro);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
  await pularContexto(page);

  // Nada do paciente anterior atravessa.
  await expect(campoDaPergunta(page)).toHaveValue("");
  await expect(marcaDeRascunho(page)).toBeHidden();

  // E a área do paciente anterior saiu do aparelho: ela não tinha pendência.
  const escopos = await page.evaluate(async () => {
    const banco = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("helo-offline");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<string[]>((res) => {
      const r = banco
        .transaction("chaves", "readonly")
        .objectStore("chaves")
        .getAllKeys();
      r.onsuccess = () => res(r.result.map(String));
      r.onerror = () => res([]);
    });
  });
  expect(escopos).toHaveLength(1);
  expect(escopos[0]).toContain(`::${outro}`);
});

test("trocar de paciente NÃO apaga a fila pendente do anterior — e avisa", async ({
  page,
  context,
}) => {
  await sessaoCarregada(page);
  await shellPronto(page);

  // Uma intenção de verdade do paciente A, sem rede.
  await context.setOffline(true);
  await campoDaPergunta(page).fill("Registro do paciente A");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(chip(page)).toBeVisible();
  expect(await operacoesGuardadas(page)).toBeGreaterThan(0);

  await context.setOffline(false);
  const outro = await segundoPacienteDela(page);
  await trocarDePaciente(page, outro);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
  await pularContexto(page);

  // A área do paciente A continua no aparelho — apagá-la seria o apagamento
  // silencioso que a fase proíbe —, e o cuidador é avisado de que ela existe.
  await expect(page.getByTestId("offline-outro-paciente")).toBeVisible();
  await expect(page.getByTestId("offline-outro-paciente")).toContainText(
    "aguardando conexão"
  );
  expect(await operacoesGuardadas(page)).toBeGreaterThan(0);
});

test("com a rede inteira fora, voltam o caminho, o breadcrumb e a seleção observada", async ({
  page,
  context,
}) => {
  // A conversa por opções é o estado mais frágil de recuperar: o caminho ativo,
  // a trilha de níveis anteriores e a opção que o cuidador observou vivem em
  // três lugares diferentes do domínio. Se algum não voltar, ele descobre no
  // pior momento — com o paciente esperando.
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await shellPronto(page);

  await criarNivel(page, {
    titulo: "Onde dói?",
    opcoes: ["Cabeça", "Barriga", "Perna"],
  });
  await confirmarOpcao(page, "Cabeça");

  // Segundo nível: é ele que faz o primeiro virar um degrau do breadcrumb.
  await criarNivel(page, { titulo: "Dói muito?", opcoes: ["Sim", "Mais ou menos"] });
  await expect(degrau(page, "Onde dói?")).toBeVisible();

  // A opção observada, ainda por conferir.
  await opcao(page, "Sim").click();
  await expect(page.getByText("Opção observada: Sim")).toBeVisible();

  // A tela reage na hora; o snapshot vai para o IndexedDB logo depois. Sem
  // esta folga o teste derrubava a rede no meio dessa gravação e recuperava o
  // estado ANTERIOR — falha de sincronização do teste, não do produto: online
  // o registro já está no servidor, e o que ficaria um passo atrás é só a
  // cópia local.
  await page.waitForTimeout(1500);

  await context.setOffline(true);
  await page.reload();
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();

  // O caminho reabre sozinho, com o nível atual…
  await expect(page.getByRole("heading", { name: "Dói muito?" })).toBeVisible();
  // …o degrau anterior de volta no breadcrumb…
  await expect(degrau(page, "Onde dói?")).toBeVisible();
  // …e a seleção provisória preservada, sem virar confirmação.
  await expect(page.getByText("Opção observada: Sim")).toBeVisible();
  await expect(page.getByText(/Resposta confirmada/)).toHaveCount(0);
});
