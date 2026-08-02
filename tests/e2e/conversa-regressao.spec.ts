// ——— Caso 30: a tela Conversar atual continua funcionando ———
// O modo novo é uma rota irmã; o fluxo guiado não pode ter mudado de
// comportamento — em especial, o segundo gesto continua significando
// REFORMULAR fora do modo Perguntas em tempo real.

import { expect, test } from "@playwright/test";
import { entrarComo, semear, selecionarPaciente, type Semente } from "./helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
  await selecionarPaciente(page, dados.pacienteId);
});

test("30. a conversa guiada segue íntegra, com o significado antigo do 2º gesto", async ({
  page,
}) => {
  await page.goto("/conversa");

  // Intro original, com identificação de operador e paciente.
  const intro = page.getByLabel("Conversa guiada");
  await expect(page.getByRole("heading", { name: "Iniciar conversa" })).toBeVisible();
  await expect(intro.getByText("Claudia")).toBeVisible();
  await expect(intro.getByText("Dr. Fábio")).toBeVisible();

  await page.getByRole("button", { name: "Começar" }).click();

  // A árvore curada abre com a pergunta inicial e no máximo 3 opções.
  await expect(
    page.getByRole("heading", { name: "O que você quer comunicar?" })
  ).toBeVisible();

  // O segundo gesto continua sendo "Talvez / Não é bem assim" — nunca
  // redefinido para o MAYBE do modo novo.
  const talvez = page
    .getByRole("button", { name: /^Talvez:/ })
    .first();
  await expect(talvez).toHaveAccessibleName(/Talvez: Não é bem assim/);

  // Registrar um gesto avança a conversa e cria sessão + evento no servidor.
  await page.getByRole("button", { name: /^Sim:/ }).first().click();

  const sessoes = await page.request
    .get(`/api/sessions?patientId=${dados.pacienteId}`)
    .then((r) => r.json());
  expect(sessoes.sessions.length).toBeGreaterThan(0);

  // Os controles clássicos do rodapé seguem no lugar.
  for (const acao of ["🔊 Repetir", "❓ Gesto incerto", "⏸ Pausar"]) {
    await expect(page.getByRole("button", { name: acao })).toBeVisible();
  }
});

test("30b. o modo não inicia sem paciente definido", async ({ page }) => {
  // Sofia está autenticada, mas não tem vínculo com nenhum paciente.
  await entrarComo(page, dados.semVinculo.email);
  await page.goto("/conversa/perguntas");
  await expect(page.getByText(/Selecione um paciente no/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Iniciar nova sessão" })
  ).toBeDisabled();
});
