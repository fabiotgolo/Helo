// ——— Continuidade sem conexão (Fase 4.9.2) ———
//
// As jornadas que só a interface prova. As regras de domínio — ordem da fila,
// dependências, duplicação, expiração, e a garantia de que salvar localmente
// não confirma nada — já estão em scripts/test-offline-queue.mjs e
// scripts/test-offline-projection.mjs, e não se repetem aqui.
//
// O que se prova AQUI é o que aqueles testes não alcançam: que a conversa
// continua na tela quando a rede cai, que ela volta depois de um refresh SEM
// rede, e que a contabilidade do aparelho nunca aparece no palco do paciente.
//
// `context.setOffline(true)` derruba a rede de verdade no navegador — não é um
// mock de fetch. O dev server continua no ar; quem não o alcança é a página.

import { expect, test, type Page } from "@playwright/test";
import { abrirModo, entrarComo, pularContexto, semear, type Semente } from "./helpers";
import {
  criarNivel,
  iniciarConversaPorOpcoes,
  opcao,
} from "./option-conversation-helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

const chip = (page: Page) => page.getByTestId("offline-chip");

/** Sessão aberta e carregada — o ponto de partida obrigatório da fase. */
async function sessaoCarregada(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
  await pularContexto(page);
  await expect(
    page.getByRole("heading", { name: "Escreva a pergunta" })
  ).toBeVisible();
}

test("sem pendência, a faixa do aparelho não aparece", async ({ page }) => {
  await sessaoCarregada(page);
  await expect(chip(page)).toBeHidden();
});

test("a conexão cai e a pergunta continua sendo registrada", async ({
  page,
  context,
}) => {
  await sessaoCarregada(page);
  await context.setOffline(true);

  await page.getByLabel("Pergunta para o paciente").fill("Você está com dor?");
  await page.getByRole("button", { name: "Continuar" }).click();

  // A tela avança: a pergunta existe, com o id que o próprio aparelho cunhou.
  await expect(page.getByRole("blockquote")).toHaveText("Você está com dor?");

  // E a faixa diz a verdade — guardado aqui, não enviado.
  await expect(chip(page)).toBeVisible();
  await expect(chip(page)).toHaveAttribute("data-estado", "AGUARDANDO_CONEXAO");
  await expect(chip(page)).toContainText("Aguardando conexão");
  await expect(chip(page)).toContainText("neste aparelho");
});

test("a faixa nunca diz 'Sincronizado'", async ({ page, context }) => {
  await sessaoCarregada(page);
  await context.setOffline(true);
  await page.getByLabel("Pergunta para o paciente").fill("Está com sede?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(chip(page)).toBeVisible();

  // Nada foi confirmado remotamente nesta fase. Um selo de "tudo certo" faria
  // o cuidador parar de se preocupar com registros que ainda podem se perder.
  await expect(chip(page)).not.toContainText(/Sincronizado/i);

  // Nem quando a conexão volta: o envio é da 4.9.3.
  await context.setOffline(false);
  await expect(chip(page)).not.toContainText(/Sincronizado/i);
});

/**
 * Servidor inalcançável, documento ainda servido.
 *
 * Esta é a metade da moeda que roda contra o `next dev`: a página carrega e o
 * servidor não responde — API fora do ar, backend reiniciando, rede que deixa
 * o CDN passar e o backend não.
 *
 * A outra metade — rede INTEIRA fora, com o app shell servindo o HTML — vive
 * em offline-app-shell.spec.ts, que precisa de um build de produção porque o
 * cliente de HMR do `next dev` recarrega a página em laço quando não alcança o
 * servidor. Duas suítes, dois ambientes, pelo mesmo motivo: cada uma prova o
 * que o ambiente dela consegue provar de verdade.
 */
async function servidorInalcancavel(page: Page) {
  await page.route("**/api/**", (route) => route.abort("failed"));
}

test("atualizar a página com o servidor fora volta para a conversa", async ({
  page,
}) => {
  await sessaoCarregada(page);
  await page.getByLabel("Pergunta para o paciente").fill("Quer descansar?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("blockquote")).toHaveText("Quer descansar?");

  // A tela reage na hora; o snapshot vai para o IndexedDB logo depois. Sem
  // esta folga o teste derruba a rede no meio dessa gravação e recupera o
  // estado ANTERIOR — sincronização do teste, não defeito do produto.
  await page.waitForTimeout(1200);

  await servidorInalcancavel(page);
  await page.reload();

  // A lista de sessões do servidor não chega — e é exatamente aqui que a fase
  // aparece. Sem ela, a tela seria um erro e tudo o que o aparelho guardou
  // ficaria inalcançável.
  await expect(page.getByTestId("retomada-local")).toBeVisible();
  await expect(page.getByTestId("retomada-local")).toContainText(
    "guardada neste aparelho"
  );

  // Começar conversa nova exige conexão: nada de identidade nova offline.
  await expect(
    page.getByRole("button", { name: "Iniciar nova sessão" })
  ).toBeDisabled();

  await page.getByRole("button", { name: /Retomar sessão de/ }).click();
  await expect(page.getByRole("blockquote")).toHaveText("Quer descansar?");
});

test("sair da página e voltar com o servidor fora preserva a conversa", async ({
  page,
}) => {
  await sessaoCarregada(page);
  await page.getByLabel("Pergunta para o paciente").fill("Está confortável?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("blockquote")).toHaveText("Está confortável?");

  // A tela reage na hora; o snapshot vai para o IndexedDB logo depois. Sem
  // esta folga o teste derruba a rede no meio dessa gravação e recupera o
  // estado ANTERIOR — sincronização do teste, não defeito do produto.
  await page.waitForTimeout(1200);

  await servidorInalcancavel(page);
  // Sai da rota e volta — o IndexedDB é da origem, não da página, então isto
  // exercita a mesma persistência de fechar e reabrir o navegador.
  await page.goto("about:blank");
  await page.goto("/conversa/perguntas");

  await expect(page.getByRole("button", { name: /Retomar sessão de/ })).toBeVisible();
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();
  await expect(page.getByRole("blockquote")).toHaveText("Está confortável?");
});

test("a faixa do aparelho não aparece no palco do paciente", async ({
  page,
  context,
}) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Onde dói?",
    opcoes: ["Cabeça", "Barriga", "Perna"],
  });

  // `criarNivel` já apresenta: a tela agora é do paciente.
  await expect(
    page.getByRole("group", { name: "Opções apresentadas ao paciente" })
  ).toBeVisible();

  await context.setOffline(true);

  // Registrar a opção observada é uma escrita — vai para a fila. E o nível
  // segue em PROVISIONAL_SELECTION, que `telaDerivada` mapeia para STAGE: o
  // paciente CONTINUA olhando, agora com uma pendência guardada no aparelho.
  //
  // É este o caso que importa. Um teste que só checasse a faixa escondida sem
  // pendência nenhuma não provaria nada — ela estaria escondida de qualquer
  // jeito.
  await opcao(page, "Cabeça").click();
  await expect(page.getByText("Opção observada: Cabeça")).toBeVisible();
  await expect(chip(page)).toBeHidden();

  // Conferida a correspondência com o gesto, a tela volta a ser do cuidador —
  // e só então a faixa aparece, com a pendência que já existia antes.
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(chip(page)).toBeVisible();
  await expect(chip(page)).toHaveAttribute("data-estado", "AGUARDANDO_CONEXAO");
});

test("nenhum token, cookie ou segredo é gravado no aparelho", async ({
  page,
  context,
}) => {
  await sessaoCarregada(page);
  await context.setOffline(true);
  await page.getByLabel("Pergunta para o paciente").fill("Quer conversar?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(chip(page)).toBeVisible();

  // Lê o banco local CRU, sem passar pela camada que decifra: é o que um
  // curioso com o aparelho na mão conseguiria ver.
  const bruto = await page.evaluate(async () => {
    const abrir = () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("helo-offline");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const banco = await abrir();
    const nomes = [...banco.objectStoreNames];
    const tudo: Record<string, unknown[]> = {};
    for (const nome of nomes) {
      tudo[nome] = await new Promise((resolve) => {
        const req = banco.transaction(nome, "readonly").objectStore(nome).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve([]);
      });
    }
    return { nomes, json: JSON.stringify(tudo) };
  });

  expect(bruto.nomes).toContain("operacoes");
  expect(bruto.nomes).toContain("chaves");

  // O cookie de sessão é HttpOnly — JavaScript não o alcança, e é assim que
  // deve continuar. Este teste confere que ele também não chegou por outro
  // caminho, junto de qualquer outra credencial.
  for (const proibido of [
    "__session",
    "passwordHash",
    "apiKey",
    "authorization",
    "sk_",
    "sk-ant",
  ]) {
    expect(bruto.json, `"${proibido}" não pode estar no banco local`).not.toContain(
      proibido
    );
  }

  // E o conteúdo da conversa não está legível: o texto da pergunta que
  // acabamos de escrever não aparece em lugar nenhum do banco cru.
  expect(bruto.json).not.toContain("Quer conversar?");
});

test("o texto da conversa fica cifrado, mas o escopo fica legível", async ({
  page,
  context,
}) => {
  await sessaoCarregada(page);
  await context.setOffline(true);
  await page.getByLabel("Pergunta para o paciente").fill("Segredo clínico");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(chip(page)).toBeVisible();

  const escopos = await page.evaluate(async () => {
    const banco = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("helo-offline");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new Promise<string[]>((resolve) => {
      const req = banco
        .transaction("chaves", "readonly")
        .objectStore("chaves")
        .getAllKeys();
      req.onsuccess = () => resolve(req.result.map(String));
      req.onerror = () => resolve([]);
    });
  });

  // O escopo é a chave de consulta e NÃO é cifrado — está declarado em
  // lib/offline/db.ts e no documento de auditoria. Alguém com o aparelho
  // descobre QUE este usuário atendeu este paciente; não descobre uma linha
  // do que foi conversado.
  expect(escopos.length).toBe(1);
  expect(escopos[0]).toContain(`::${dados.pacienteId}`);
});

test("sair com registros pendentes avisa antes de descartar", async ({
  page,
  context,
}) => {
  await sessaoCarregada(page);
  await context.setOffline(true);
  await page.getByLabel("Pergunta para o paciente").fill("Vai se perder?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(chip(page)).toBeVisible();

  // §8: nunca apagar operação pendente em silêncio. O cuidador decide.
  let mensagem = "";
  page.on("dialog", (d) => {
    mensagem = d.message();
    void d.dismiss();
  });

  await context.setOffline(false);
  await page.getByRole("button", { name: "Sair" }).click();

  await expect.poll(() => mensagem).toContain("não");
  expect(mensagem).toContain("neste aparelho");
  // Recusar mantém tudo: continuamos na conversa, com a faixa no lugar.
  await expect(chip(page)).toBeVisible();
});
