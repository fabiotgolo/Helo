// ——— Contexto da conversa (Fase 4.8) ———
// As jornadas que só a interface prova: pular num clique, preencher e começar,
// editar durante a sessão criando versão nova, e — a mais importante — o
// contexto NUNCA aparecer no palco do paciente.
//
// As regras de domínio (versionamento, auditoria, isolamento, duplicação) já
// estão cobertas por scripts/test-session-context.mjs e não se repetem aqui.

import { expect, test, type Page } from "@playwright/test";
import { abrirModo, entrarComo, pularContexto, semear, type Semente } from "./helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

async function novaSessao(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
}

test("a etapa de contexto abre antes da conversa e é opcional", async ({ page }) => {
  await novaSessao(page);
  await expect(
    page.getByRole("heading", { name: "Contexto da conversa (opcional)" })
  ).toBeVisible();
  // A saída rápida existe ANTES do formulário: uma conversa urgente não pode
  // ficar atrás de campo nenhum.
  await expect(
    page.getByRole("button", { name: "Começar sem contexto" }).first()
  ).toBeVisible();
  await expect(page.getByText(/Não é fala do paciente/)).toBeVisible();
});

test("começar sem contexto leva direto à pergunta", async ({ page }) => {
  await novaSessao(page);
  await pularContexto(page);
  await expect(
    page.getByRole("heading", { name: "Escreva a pergunta" })
  ).toBeVisible();
});

test("a decisão de pular sobrevive a atualizar a página", async ({ page }) => {
  await novaSessao(page);
  await pularContexto(page);
  await page.reload();
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();
  // Não volta a perguntar: pular é um fato registrado, não a ausência dele.
  await expect(
    page.getByRole("heading", { name: "Contexto da conversa (opcional)" })
  ).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Escreva a pergunta" })
  ).toBeVisible();
});

test("preencher o contexto e começar", async ({ page }) => {
  await novaSessao(page);
  await page.getByRole("textbox", { name: "Intenção da conversa" }).fill("Explicar um desconforto");
  await page.getByRole("textbox", { name: "Ambiente" }).fill("Consulta");
  await page.getByLabel("Assunto inicial").fill("dor");
  await page.getByRole("button", { name: "Salvar e começar" }).click();

  await expect(
    page.getByRole("heading", { name: "Escreva a pergunta" })
  ).toBeVisible();
  // O resumo fica à mão do cuidador, sem roubar a tela.
  await expect(page.getByText(/Explicar um desconforto · Consulta · dor/)).toBeVisible();
});

test("os atalhos preenchem o campo sem limitá-lo", async ({ page }) => {
  await novaSessao(page);
  const atalho = page.getByRole("button", { name: "Pedir algo" });
  await atalho.click();
  await expect(atalho).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Intenção da conversa" })).toHaveValue("Pedir algo");
  // Continua sendo texto livre.
  await page.getByRole("textbox", { name: "Intenção da conversa" }).fill("outra coisa qualquer");
  await expect(atalho).toHaveAttribute("aria-pressed", "false");
});

test("editar durante a sessão cria uma versão nova e preserva a anterior", async ({ page }) => {
  await novaSessao(page);
  await page.getByLabel("Assunto inicial").fill("dor");
  await page.getByRole("button", { name: "Salvar e começar" }).click();
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();

  await page.getByRole("button", { name: "Editar o contexto da conversa" }).click();
  await expect(page.getByText(/cria a versão 2/)).toBeVisible();
  await page.getByLabel("Assunto inicial").fill("sono");
  await page.getByRole("button", { name: "Salvar nova versão" }).click();

  await expect(page.getByText(/versão 2/)).toBeVisible();
  // As duas versões continuam legíveis.
  await page.getByRole("button", { name: /sono/ }).click();
  await expect(page.getByRole("heading", { name: "Contexto da conversa" })).toBeVisible();
  // `exact`: a barra do contexto mostra "versão 2" em minúscula, e getByText
  // ignora caixa por padrão — sem isso, os dois casariam.
  await expect(page.getByText("Versão 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Versão 2", { exact: true })).toBeVisible();
});

test("o interlocutor livre avisa que não cria contato", async ({ page }) => {
  await novaSessao(page);
  await page.getByRole("radio", { name: "Outra pessoa (não cadastrada)" }).check();
  await expect(page.getByText(/Não cria um contato novo/)).toBeVisible();
});

test("o contexto NUNCA aparece no palco do paciente", async ({ page }) => {
  await novaSessao(page);
  await page.getByLabel("Assunto inicial").fill("dor no joelho");
  await page.getByRole("button", { name: "Salvar e começar" }).click();

  await page.getByLabel("Pergunta para o paciente").fill("O senhor está com dor?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();

  // Com a pergunta no palco, o resumo do contexto sai de cena: é anotação do
  // cuidador, e o paciente não deve lê-la junto com a pergunta.
  await expect(page.getByRole("group", { name: /Respostas possíveis/ })).toBeVisible();
  await expect(page.getByText("dor no joelho")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Editar o contexto da conversa" })
  ).toBeHidden();
});
