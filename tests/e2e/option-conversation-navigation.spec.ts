// ——— Interface: breadcrumb, ramificação e reinício (§37) ———
// Cobre os fluxos 6–9.

import { expect, test, type Page } from "@playwright/test";
import { entrarComo, semear, type Semente } from "./helpers";
import {
  confirmarOpcao,
  criarNivel,
  degrau,
  iniciarConversaPorOpcoes,
  opcao,
} from "./option-conversation-helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

/** Assunto › Saúde › Dor, com Dor aguardando seleção. */
async function ateDor(page: Page, patientId: number) {
  await iniciarConversaPorOpcoes(page, patientId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });
  await confirmarOpcao(page, "SAÚDE");
  await criarNivel(page, {
    titulo: "Saúde",
    opcoes: ["DOR", "MEDICAÇÃO", "CONSULTA"],
  });
  await confirmarOpcao(page, "DOR");
  await criarNivel(page, {
    titulo: "Dor",
    opcoes: ["CABEÇA", "PERNA", "OUTRO LOCAL"],
  });
}

test("6. o breadcrumb mostra o caminho ativo, com o nível atual destacado", async ({
  page,
}) => {
  await ateDor(page, dados.pacienteId);
  const trilha = page.getByRole("navigation", { name: "Caminho da conversa" });
  await expect(trilha).toBeVisible();

  // A trilha lê como uma frase: título do primeiro nível, depois cada escolha.
  await expect(trilha).toContainText("SAÚDE");
  await expect(trilha).toContainText("DOR");

  // Degraus anteriores são clicáveis…
  await expect(degrau(page, "SAÚDE")).toBeVisible();
  // …e o atual é destacado, sem ser botão.
  const atual = trilha.locator("[aria-current='step']");
  await expect(atual).toHaveCount(1);
  await expect(atual).toContainText("DOR");
  await expect(degrau(page, "DOR")).toHaveCount(0);

  // O rótulo acessível carrega o texto completo, mesmo truncado visualmente.
  await expect(degrau(page, "SAÚDE")).toHaveAttribute(
    "aria-label",
    /Sobre qual assunto deseja conversar\?: SAÚDE/
  );
  await expect(
    trilha.getByRole("button", { name: "← Voltar um nível" })
  ).toBeVisible();
  await expect(
    trilha.getByRole("button", { name: "Reiniciar conversa" })
  ).toBeVisible();
});

test("7. clicar em Saúde reapresenta DOR, MEDICAÇÃO e CONSULTA", async ({
  page,
}) => {
  await ateDor(page, dados.pacienteId);
  await degrau(page, "SAÚDE").click();

  await expect(page.getByRole("heading", { name: "Saúde" })).toBeVisible();
  for (const label of ["DOR", "MEDICAÇÃO", "CONSULTA"]) {
    await expect(opcao(page, label)).toBeVisible();
  }
  // A escolha anterior não volta marcada: é uma nova escolha a partir daqui.
  await expect(page.getByText(/Opção observada/)).toBeHidden();
  // A escolha DOR saiu do caminho ativo — a ramificação anterior ficou para trás.
  const trilha = page.getByRole("navigation", { name: "Caminho da conversa" });
  await expect(trilha).not.toContainText("DOR");
});

test("8. muda para MEDICAÇÃO e o breadcrumb acompanha a nova ramificação", async ({
  page,
}) => {
  await ateDor(page, dados.pacienteId);
  await degrau(page, "SAÚDE").click();
  await expect(opcao(page, "MEDICAÇÃO")).toBeVisible();
  await confirmarOpcao(page, "MEDICAÇÃO");

  const trilha = page.getByRole("navigation", { name: "Caminho da conversa" });
  await expect(trilha).toContainText("SAÚDE");
  await expect(trilha).toContainText("MEDICAÇÃO");
  // O caminho anterior não é transportado.
  await expect(trilha).not.toContainText("DOR");
});

test("9. reiniciar encerra o caminho e começa outro, com confirmação", async ({
  page,
}) => {
  await ateDor(page, dados.pacienteId);
  await page.getByRole("button", { name: "Reiniciar conversa" }).click();

  // Havendo escolhas confirmadas, o reinício pede confirmação (§16).
  await expect(
    page.getByText("Deseja reiniciar esta conversa?")
  ).toBeVisible();
  await expect(
    page.getByText(/permanecerá registrado/)
  ).toBeVisible();
  await page.getByRole("button", { name: "Reiniciar", exact: true }).click();

  // A conversa recomeça do zero, pedindo o primeiro nível.
  await expect(
    page.getByRole("heading", { name: "Criar o primeiro nível" })
  ).toBeVisible();
  const trilha = page.getByRole("navigation", { name: "Caminho da conversa" });
  await expect(trilha).not.toContainText("SAÚDE");
});

test("9b. reiniciar sem escolhas confirmadas não abre modal", async ({ page }) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });
  await page.getByRole("button", { name: "Reiniciar conversa" }).click();
  await expect(page.getByText("Deseja reiniciar esta conversa?")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Criar o primeiro nível" })
  ).toBeVisible();
});

test("27. duplo clique em Confirmar registra uma única vez", async ({ page }) => {
  const problemas: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problemas.push(m.text());
  });
  page.on("pageerror", (e) => problemas.push(String(e)));
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });
  await opcao(page, "SAÚDE").click();
  await expect(page.getByText("Opção observada: SAÚDE")).toBeVisible();

  // Conta as gravações que chegam ao servidor: o segundo clique não pode
  // virar uma segunda confirmação.
  let confirmacoes = 0;
  await page.route("**/api/realtime-questions/nodes", async (route) => {
    const body = route.request().postData() ?? "";
    if (route.request().method() === "PATCH" && body.includes("CONFIRM_OPTION")) {
      confirmacoes += 1;
    }
    await route.continue();
  });

  const confirmar = page.getByRole("button", { name: "Confirmar", exact: true });
  await Promise.all([
    confirmar.click({ force: true }),
    confirmar.click({ force: true }),
  ]);

  await expect(
    page.getByRole("heading", { name: "Criar o próximo nível" })
  ).toBeVisible();
  // Uma única confirmação chegou ao servidor, e a trilha tem exatamente dois
  // degraus (o título do nível e a escolha SAÚDE) — não três.
  const trilha = page.getByRole("navigation", { name: "Caminho da conversa" });
  await expect(trilha.getByRole("listitem")).toHaveCount(2);
  await expect(trilha).toContainText("SAÚDE");
  expect(confirmacoes).toBe(1);

  // Nenhuma faixa de erro do Helo: o clique acidental do cuidador não pode
  // virar uma mensagem de recusa na tela.
  await expect(
    page.getByText("O registro não foi concluído.")
  ).toHaveCount(0);
  // E nenhum aviso do React — chave duplicada aqui significaria degraus
  // colidindo no breadcrumb.
  expect(problemas.filter((p) => /same key|Warning:/i.test(p))).toEqual([]);
});
