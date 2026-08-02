// ——— Interface: pausa, retomada e restauração (§37) ———
// Cobre os fluxos 14 e 15, e a exigência do §32: atualizar a página devolve
// modo, caminho, nível ativo, breadcrumb, seleção provisória e mensagem em
// construção — sem duplicar registro nenhum, e sem transformar uma seleção
// provisória em confirmada.

import { expect, test, type Page } from "@playwright/test";
import { entrarComo, semear, type Semente } from "./helpers";
import {
  confirmarOpcao,
  criarNivel,
  degrau,
  iniciarConversaPorOpcoes,
  opcao,
  resposta,
} from "./option-conversation-helpers";

/**
 * Atualizar a página devolve o assistente à abertura do modo — comportamento
 * das Fases 1–4, preservado: retomar uma sessão é um ato explícito. O que a
 * conversa por opções acrescenta é que, ao retomar, TUDO volta como estava.
 */
async function recarregarERetomar(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();
}

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

/** Assunto › Saúde, com o próximo nível apresentado e uma seleção provisória. */
async function comSelecaoProvisoria(page: Page, patientId: number) {
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
  await opcao(page, "DOR").click();
  await expect(page.getByText("Opção observada: DOR")).toBeVisible();
}

test("14. pausar a sessão bloqueia a seleção e retomar a libera", async ({
  page,
}) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });

  await page.getByRole("button", { name: "⏸ Pausar sessão" }).click();
  await expect(page.getByText("Sessão pausada")).toBeVisible();
  // Nada do paciente aparece enquanto a sessão está pausada.
  await expect(
    page.getByRole("group", { name: "Opções apresentadas ao paciente" })
  ).toBeHidden();

  await page.getByRole("button", { name: "▶ Retomar sessão" }).click();
  await expect(opcao(page, "SAÚDE")).toBeVisible();
  await confirmarOpcao(page, "SAÚDE");
  await expect(
    page.getByRole("heading", { name: "Criar o próximo nível" })
  ).toBeVisible();
});

test("15. atualizar a página restaura caminho, nível ativo e breadcrumb", async ({
  page,
}) => {
  await comSelecaoProvisoria(page, dados.pacienteId);
  await recarregarERetomar(page);

  // O modo volta explícito…
  await expect(page.getByText("Escolha entre opções")).toBeVisible();
  // …o breadcrumb volta inteiro: a escolha SAÚDE é o degrau atual, e o
  // título do primeiro nível continua clicável para voltar.
  const trilha = page.getByRole("navigation", { name: "Caminho da conversa" });
  await expect(trilha).toContainText("SAÚDE");
  await expect(trilha.locator("[aria-current='step']")).toContainText("SAÚDE");
  await expect(
    degrau(page, "Sobre qual assunto deseja conversar\\?")
  ).toBeVisible();
  // …o nível ativo volta com suas opções…
  await expect(page.getByRole("heading", { name: "Saúde" })).toBeVisible();
  await expect(opcao(page, "MEDICAÇÃO")).toBeVisible();
  // …e a seleção provisória continua PROVISÓRIA.
  await expect(page.getByText("Opção observada: DOR")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirmar", exact: true })
  ).toBeVisible();
});

test("15b. atualizar não duplica registros", async ({ page }) => {
  await comSelecaoProvisoria(page, dados.pacienteId);
  await recarregarERetomar(page);
  await expect(page.getByText("Opção observada: DOR")).toBeVisible();
  await recarregarERetomar(page);
  await expect(page.getByText("Opção observada: DOR")).toBeVisible();

  // Um caminho só no histórico, com os dois níveis criados — não quatro.
  await page.getByText(/Histórico da sessão \(/).click();
  await expect(page.getByText("Histórico da sessão (1 item)")).toBeVisible();
  await expect(page.getByText("2 níveis")).toBeVisible();
});

test("15c. a mensagem em construção sobrevive à atualização", async ({ page }) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
    terminal: 1,
    fraseFinal: "Quero falar sobre saúde.",
  });
  await confirmarOpcao(page, "SAÚDE");
  await expect(page.getByLabel(/Frase que será apresentada/)).toHaveValue(
    "Quero falar sobre saúde."
  );

  await recarregarERetomar(page);
  await expect(
    page.getByText("Mensagem em construção", { exact: true })
  ).toBeVisible();
  await expect(page.getByLabel(/Frase que será apresentada/)).toHaveValue(
    "Quero falar sobre saúde."
  );
  // O caminho escolhido reaparece no compositor.
  await expect(
    page.locator("main section").filter({ hasText: "Mensagem em construção" }).first()
  ).toContainText("SAÚDE");
});

test("15d. um rascunho de nível em edição volta preenchido", async ({ page }) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });
  // Uma versão corrigida deixa um rascunho aberto no servidor.
  await page
    .getByRole("button", { name: /Editar o nível: Sobre qual assunto/ })
    .click();
  await page.getByRole("button", { name: "Criar versão corrigida" }).click();
  await expect(
    page.getByRole("heading", { name: "Editar este nível" })
  ).toBeVisible();

  await recarregarERetomar(page);
  await expect(
    page.getByRole("heading", { name: "Editar este nível" })
  ).toBeVisible();
  await expect(page.getByLabel("Título ou pergunta do nível")).toHaveValue(
    "Sobre qual assunto deseja conversar?"
  );
  await expect(page.getByLabel(/^Opção 2/)).toHaveValue("SAÚDE");
});

test("15e. a frase apresentada volta em confirmação, sem resposta assumida", async ({
  page,
}) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
    terminal: 1,
    fraseFinal: "Quero falar sobre saúde.",
  });
  await confirmarOpcao(page, "SAÚDE");
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await resposta(page, "TALVEZ").click();
  await expect(page.getByText("A frase não foi confirmada.")).toBeVisible();

  await recarregarERetomar(page);
  // O modo volta a ser o da frase, e TALVEZ continua sem confirmar nada.
  await expect(page.getByText("Confirmação da frase")).toBeVisible();
  await expect(page.getByText("A frase não foi confirmada.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirmar a frase" })
  ).toBeHidden();
});
