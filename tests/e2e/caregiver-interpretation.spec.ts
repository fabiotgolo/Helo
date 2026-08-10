// ——— Interpretação digitada pelo cuidador (Fase 4.2) ———
// As jornadas que só a interface prova: que a tela NUNCA apresenta o texto
// como fala do paciente antes do SIM, que o prefixo diz de quem ele é, e que
// a autoria sobrevive à confirmação.
//
// As regras de domínio (TALVEZ/NÃO, versionamento, sensível, reutilização,
// isolamento, duplicação) já estão cobertas por
// scripts/test-caregiver-interpretation.mjs e não se repetem aqui.

import { expect, test, type Page } from "@playwright/test";
import { abrirModo, entrarComo, iniciarNovaSessao, pularContexto, semear, type Semente } from "./helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

async function sessaoAberta(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await iniciarNovaSessao(page);
  await pularContexto(page);
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
}

async function registrar(page: Page, texto: string) {
  await page.getByRole("button", { name: "Registrar o que entendi" }).click();
  await expect(
    page.getByRole("heading", { name: "O que você entendeu que o paciente disse?" })
  ).toBeVisible();
  await page.getByLabel("Interpretação do cuidador").fill(texto);
  await page.getByRole("button", { name: "Registrar interpretação" }).click();
  await expect(
    page.getByRole("heading", { name: "Interpretação registrada pelo cuidador" })
  ).toBeVisible();
}

async function apresentar(page: Page) {
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await expect(page.getByText("O cuidador entendeu:")).toBeVisible();
}

const responder = (page: Page, nome: string) =>
  page.getByRole("button", { name: new RegExp(`^${nome}:`) });

test("a revisão diz de quem é o texto e que ainda não é fala do paciente", async ({ page }) => {
  await sessaoAberta(page);
  await registrar(page, "Gostaria de falar sobre comer churrasco.");
  await expect(page.getByText("Ainda não é fala do paciente.")).toBeVisible();
  await expect(page.getByRole("blockquote")).toHaveText(
    "Gostaria de falar sobre comer churrasco."
  );
});

test("o selo de modo explica o que os sinais significam agora", async ({ page }) => {
  await sessaoAberta(page);
  await registrar(page, "O senhor quer sair da cama?");
  await expect(page.getByText("Interpretação do cuidador").first()).toBeVisible();
  await expect(
    page.getByText(/significam SIM, TALVEZ e NÃO sobre o que o cuidador entendeu/)
  ).toBeVisible();
});

test("apresentada, a tela diz que aguarda a confirmação do paciente", async ({ page }) => {
  await sessaoAberta(page);
  await registrar(page, "Quero ver a minha filha.");
  await apresentar(page);
  await expect(
    page.getByText("Interpretação aguardando confirmação do paciente.")
  ).toBeVisible();
  // As três respostas do paciente, com os mesmos gestos de sempre.
  for (const nome of ["SIM", "TALVEZ", "NÃO"]) {
    await expect(responder(page, nome)).toBeVisible();
  }
});

test("SIM confirma e a autoria do texto NÃO se perde", async ({ page }) => {
  await sessaoAberta(page);
  await registrar(page, "Gostaria de falar sobre comer churrasco.");
  await apresentar(page);
  await responder(page, "SIM").click();
  await expect(page.getByText("Resposta observada: SIM")).toBeVisible();
  await page.getByRole("button", { name: "Confirmar a frase" }).click();

  await expect(page.getByRole("heading", { name: "Interpretação confirmada" })).toBeVisible();
  // A frase que fecha a tela nunca omite quem formulou o texto.
  await expect(
    page.getByText(/Confirmada pelo paciente · texto formulado pelo cuidador/).first()
  ).toBeVisible();
});

test("TALVEZ não confirma e oferece ajustar", async ({ page }) => {
  await sessaoAberta(page);
  await registrar(page, "O senhor está com dor?");
  await apresentar(page);
  await responder(page, "TALVEZ").click();
  await expect(page.getByText("Resposta observada: TALVEZ")).toBeVisible();
  // Não existe caminho de confirmação a partir de TALVEZ.
  await expect(page.getByRole("button", { name: "Confirmar a frase" })).toBeHidden();
  // Em TALVEZ o caminho oferecido é ajustar — nunca confirmar.
  await expect(page.getByRole("button", { name: "Ajustar frase" })).toBeVisible();
});

test("NÃO rejeita sem tratar o texto como comunicação confirmada", async ({ page }) => {
  await sessaoAberta(page);
  await registrar(page, "O senhor quer dormir agora?");
  await apresentar(page);
  await responder(page, "NÃO").click();
  await expect(page.getByText("Resposta observada: NÃO")).toBeVisible();
  await page.getByRole("button", { name: "Registrar como rejeitada" }).click();
  await expect(page.getByRole("heading", { name: "Interpretação rejeitada" })).toBeVisible();
});

test("o lápis edita a interpretação antes de apresentar", async ({ page }) => {
  await sessaoAberta(page);
  await registrar(page, "Quero café.");
  await page.getByRole("button", { name: "Editar a interpretação" }).click();
  await page.getByLabel("Frase que será apresentada ao paciente").fill("Quero um café com leite.");
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await expect(page.getByText("Quero um café com leite.").first()).toBeVisible();
});

test("a interpretação aparece no histórico com estado próprio", async ({ page }) => {
  await sessaoAberta(page);
  await registrar(page, "Quero conversar com o meu irmão.");
  // O histórico nasce recolhido para não disputar a tela com o paciente.
  await page.getByText(/Histórico da sessão/).click();
  // O estado próprio da interpretação vem no rótulo acessível do item.
  await expect(
    page.getByRole("button", { name: /Interpretação em construção/ })
  ).toBeVisible();
});

test("atualizar a página devolve a mesma tela", async ({ page }) => {
  await sessaoAberta(page);
  await registrar(page, "Quero tomar sol.");
  await apresentar(page);
  await page.reload();
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();
  await expect(page.getByText("O cuidador entendeu:")).toBeVisible();
  await expect(page.getByText("Quero tomar sol.").first()).toBeVisible();
});
