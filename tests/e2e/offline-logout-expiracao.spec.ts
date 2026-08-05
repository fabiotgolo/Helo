// ——— Logout e expiração do rascunho local (Fase 4.9.2, formalização) ———
//
// Estes dois casos já eram comportamento do produto — descritos em
// lib/offline/limpeza.ts e em lib/offline/types.ts (`isExpired`) — mas não
// tinham teste de ponta a ponta próprio. Este arquivo não muda política
// nenhuma: só prova, pela interface, o que o código já faz.
//
// Não precisa de build de produção (ao contrário de offline-app-shell.spec.ts):
// nenhum teste aqui recarrega a página com a rede REALMENTE fora, então o HMR
// do `next dev` não entra em laço. Por isso este arquivo roda no lote
// "offline" do runner (scripts/run-e2e-batches.mjs), junto de
// offline-continuidade.spec.ts.

import { expect, test, type Page } from "@playwright/test";
import { abrirModo, entrarComo, pularContexto, semear, type Semente } from "./helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

const chip = (page: Page) => page.getByTestId("offline-chip");
const marcaDeRascunho = (page: Page) => page.getByTestId("rascunho-local");
const campoDaPergunta = (page: Page) =>
  page.getByLabel("Pergunta para o paciente");
// Por nome, não por texto "Sair": a tela pausada tem um SEGUNDO botão de
// mesmo texto (encerrar o MODO, via ExitModal — não a autenticação). Só o
// botão global do cabeçalho tem este rótulo acessível, de components/ui.tsx.
const botaoSair = (page: Page) =>
  page.getByRole("button", { name: /encerrar a sessão de/i });

/** Sessão aberta e carregada — o ponto de partida obrigatório da fase. */
async function sessaoCarregada(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
  await pularContexto(page);
  await expect(
    page.getByRole("heading", { name: "Escreva a pergunta" })
  ).toBeVisible();
}

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
    const bancos = await indexedDB.databases?.();
    if (bancos && !bancos.some((b) => b.name === "helo-offline")) return 0;
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

/** Os escopos (`usuário::paciente`) presentes no banco agora. */
function escoposGuardados(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const bancos = await indexedDB.databases?.();
    if (bancos && !bancos.some((b) => b.name === "helo-offline")) return [];
    const banco = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("helo-offline");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!banco.objectStoreNames.contains("chaves")) return [];
    return new Promise<string[]>((res) => {
      const r = banco.transaction("chaves", "readonly").objectStore("chaves").getAllKeys();
      r.onsuccess = () => res(r.result.map(String));
      r.onerror = () => res([]);
    });
  });
}

// ════ Logout ════
//
// lib/offline/limpeza.ts documenta a política: logout explícito apaga tudo,
// mas PERGUNTA antes quando há intenção pendente (§8 — nunca em silêncio). Um
// rascunho sozinho não é "intenção" para esse fim: ele não entra na contagem
// de `contarPendenciasOffline` (só operações contam), então não dispara o
// diálogo — e é apagado direto, porque logout sem pendência nenhuma não tem o
// que preservar. Os dois testes a seguir cobrem os dois ramos da política.

test("logout sem pendência apaga o rascunho — e o próximo usuário não vê nada", async ({
  page,
}) => {
  await sessaoCarregada(page);

  await campoDaPergunta(page).fill("Ele está com dor?");
  await expect(marcaDeRascunho(page)).toBeVisible();
  await expect.poll(() => rascunhosGuardados(page)).toBeGreaterThan(0);
  // Um rascunho, sozinho, não é intenção: nada foi enfileirado.
  expect(await operacoesGuardadas(page)).toBe(0);

  // Sem pendência, o logout não pergunta nada — se perguntasse, o teste
  // travaria aqui esperando um diálogo que ninguém responde.
  let dialogApareceu = false;
  page.on("dialog", (d) => {
    dialogApareceu = true;
    void d.dismiss();
  });

  await botaoSair(page).click();
  await page.waitForURL("**/login");
  expect(dialogApareceu).toBe(false);

  // limparArmazenamentoOffline() é fire-and-forget antes do redirecionamento
  // (lib/use-auth.ts) — esperamos ela terminar antes de seguir em frente.
  await expect.poll(() => escoposGuardados(page)).toHaveLength(0);
  expect(await rascunhosGuardados(page)).toBe(0);

  // Um usuário DIFERENTE entra na mesma máquina, no mesmo navegador.
  await entrarComo(page, dados.outroAssistente.email);
  await abrirModo(page, dados.outroPacienteId);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
  await pularContexto(page);
  await expect(
    page.getByRole("heading", { name: "Escreva a pergunta" })
  ).toBeVisible();

  // Nada do cuidador anterior atravessa: nem na tela, nem no banco.
  await expect(campoDaPergunta(page)).toHaveValue("");
  await expect(marcaDeRascunho(page)).toBeHidden();
  const escopos = await escoposGuardados(page);
  expect(escopos.every((e) => !e.startsWith(`${dados.assistente.id}::`))).toBe(
    true
  );
});

test("logout com fila pendente: recusar preserva rascunho e fila; confirmar apaga os dois", async ({
  page,
  context,
}) => {
  await sessaoCarregada(page);

  // Um texto ainda não submetido — só rascunho, ANTES de qualquer intenção.
  await campoDaPergunta(page).fill("Rascunho ainda não enviado");
  await expect(marcaDeRascunho(page)).toBeVisible();
  await expect.poll(() => rascunhosGuardados(page)).toBeGreaterThan(0);
  const rascunhosAntes = await rascunhosGuardados(page);
  expect(await operacoesGuardadas(page)).toBe(0);

  // Uma intenção DE VERDADE, sem rede. "Pausar sessão" é ação de SESSÃO, não
  // de turno — fica no rodapé em qualquer tela e não consome o rascunho
  // acima, que é estado do compositor (currentTurn continua null).
  await context.setOffline(true);
  await page.getByRole("button", { name: /Pausar sessão/ }).click();
  await expect(chip(page)).toBeVisible();
  await expect.poll(() => operacoesGuardadas(page)).toBeGreaterThan(0);
  const operacoesAntes = await operacoesGuardadas(page);
  await context.setOffline(false);

  // §8: recusar preserva TUDO — nada foi apagado, o logout inteiro aborta.
  let mensagem = "";
  page.once("dialog", (d) => {
    mensagem = d.message();
    void d.dismiss();
  });
  await botaoSair(page).click();
  await expect.poll(() => mensagem).toContain("neste aparelho");

  expect(await operacoesGuardadas(page)).toBe(operacoesAntes);
  expect(await rascunhosGuardados(page)).toBe(rascunhosAntes);
  await expect(page).toHaveURL(/\/conversa\/perguntas/);

  // Confirmar agora: a política aprovada é apagar tudo de uma vez — fila
  // pendente inclusive — porque o cuidador foi avisado, pelo NÚMERO de
  // registros ainda não enviados, e decidiu sair mesmo assim. Isso não é o
  // apagamento silencioso que o §8 proíbe: é apagamento avisado e aceito.
  page.once("dialog", (d) => void d.accept());
  await botaoSair(page).click();
  await page.waitForURL("**/login");

  await expect.poll(() => escoposGuardados(page)).toHaveLength(0);
  expect(await operacoesGuardadas(page)).toBe(0);
  expect(await rascunhosGuardados(page)).toBe(0);
});

// ════ Expiração do rascunho ════
//
// lib/offline/types.ts define OFFLINE_TTL_MS = 7 dias para conteúdo comum
// (RASCUNHO_PERGUNTA não é sensível). store.ts aplica isExpired() a cada
// rascunho NA LEITURA — carregar() simplesmente não devolve o que já expirou.
// Isso já tinha teste unitário da função pura (scripts/test-offline-queue.mjs,
// nos limites de 6/7 dias e 23h/24h); o que faltava era provar que a
// INTEGRAÇÃO se comporta assim de ponta a ponta: um rascunho velho não volta
// para a tela, e nada foi criado no caminho.
//
// `page.clock.setFixedTime` muda só o que `Date.now()`/`new Date()` devolvem
// — mantém setTimeout, rede e animações reais. É o oposto de `install()` +
// `fastForward()`: nada no produto (debounce de 300ms do rascunho, HMR,
// requisições) fica congelado esperando um timer que nunca dispara.

const OFFLINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

test("rascunho expirado não volta depois do prazo — e nada foi criado no caminho", async ({
  page,
}) => {
  await sessaoCarregada(page);

  await campoDaPergunta(page).fill("Ele quer água ou suco?");
  await expect(marcaDeRascunho(page)).toBeVisible();
  await expect.poll(() => rascunhosGuardados(page)).toBeGreaterThan(0);
  expect(await operacoesGuardadas(page)).toBe(0);

  // Passa do prazo de 7 dias, com uma folga, a partir do relógio real da
  // própria página — não do relógio do processo de teste.
  const agora = await page.evaluate(() => Date.now());
  await page.clock.setFixedTime(agora + OFFLINE_TTL_MS + 60_000);

  // Recarregar volta primeiro ao seletor de modo — com um snapshot local
  // presente, ele abre pedindo "Retomar", não a compor direto. Mesmo caminho
  // usado em offline-app-shell.spec.ts para o mesmo reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();
  await expect(
    page.getByRole("heading", { name: "Escreva a pergunta" })
  ).toBeVisible();

  // O rascunho não volta: nem no campo, nem no aviso.
  await expect(campoDaPergunta(page)).toHaveValue("");
  await expect(marcaDeRascunho(page)).toBeHidden();

  // E nada do que ele poderia ter virado existe: nenhuma operação, nenhuma
  // fala apresentada ao paciente.
  expect(await operacoesGuardadas(page)).toBe(0);
  await expect(page.getByRole("blockquote")).toHaveCount(0);
});
