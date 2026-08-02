// ——— Interface: aprofundamento e frase final (§37) ———
// Cobre os fluxos 1–5 e 10–13, mais a regra que define este modo: durante um
// nível, os rótulos SIM/TALVEZ/NÃO NÃO existem na tela, e os gestos físicos do
// paciente continuam exatamente os mesmos.

import { expect, test } from "@playwright/test";
import { entrarComo, semear, type Semente } from "./helpers";
import {
  confirmarOpcao,
  criarNivel,
  iniciarConversaPorOpcoes,
  opcao,
  resposta,
} from "./option-conversation-helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

// ════ 1–2. Iniciar e criar o primeiro nível ════

test("1. inicia a conversa por opções dentro da sessão", async ({ page }) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  // O modo ativo é explícito, e diz o que os sinais significam agora (§3).
  await expect(page.getByText("Escolha entre opções")).toBeVisible();
  await expect(
    page.getByText(/significam opção 1, opção 2 e opção 3/)
  ).toBeVisible();
});

test("2. cria FAMÍLIA, SAÚDE e ROTINA e apresenta ao paciente", async ({
  page,
}) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });
  await expect(
    page.getByRole("heading", { name: "Sobre qual assunto deseja conversar?" })
  ).toBeVisible();
  for (const label of ["FAMÍLIA", "SAÚDE", "ROTINA"]) {
    await expect(opcao(page, label)).toBeVisible();
  }
});

test("2b. os rótulos SIM, TALVEZ e NÃO NÃO aparecem durante um nível", async ({
  page,
}) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });

  const grupo = page.getByRole("group", {
    name: "Opções apresentadas ao paciente",
  });
  // Nem em texto visível…
  await expect(grupo).not.toContainText("SIM");
  await expect(grupo).not.toContainText("TALVEZ");
  await expect(grupo).not.toContainText("NÃO");
  // …nem no rótulo acessível de nenhum dos três botões.
  const rotulos = await grupo
    .getByRole("button")
    .evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label") ?? ""));
  expect(rotulos).toHaveLength(3);
  for (const r of rotulos) {
    expect(r).not.toMatch(/\bSIM\b|\bTALVEZ\b|\bNÃO\b/);
  }
  expect(rotulos[0]).toMatch(/^FAMÍLIA:/);
  expect(rotulos[1]).toMatch(/^SAÚDE:/);
  expect(rotulos[2]).toMatch(/^ROTINA:/);
});

test("2c. os gestos físicos e os emojis são os mesmos da pergunta fechada", async ({
  page,
}) => {
  // Emojis das três âncoras no modo de pergunta fechada.
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });
  const grupoOpcoes = page.getByRole("group", {
    name: "Opções apresentadas ao paciente",
  });
  await expect(grupoOpcoes.getByRole("button")).toHaveCount(3);
  const naConversa = await grupoOpcoes
    .getByRole("button")
    .evaluateAll((bs) =>
      bs.map((b) => b.querySelector("[aria-hidden='true']")?.textContent ?? "")
    );

  // Mesma sessão, pergunta fechada: as âncoras precisam ser idênticas e na
  // mesma ordem — o paciente não reaprende gesto nenhum.
  await page.getByRole("button", { name: "Sair da conversa por opções" }).click();
  await page.getByRole("button", { name: "Fazer nova pergunta" }).click();
  await page.getByLabel("Pergunta para o paciente").fill("O senhor está bem?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  const grupoRespostas = page.getByRole("group", {
    name: "Respostas possíveis do paciente",
  });
  await expect(grupoRespostas.getByRole("button")).toHaveCount(3);
  const naPerguntaFechada = await grupoRespostas
    .getByRole("button")
    .evaluateAll((bs) =>
      bs.map((b) => b.querySelector("[aria-hidden='true']")?.textContent ?? "")
    );

  expect(naConversa).toEqual(naPerguntaFechada);
  // Confirma que são de fato as âncoras físicas do paciente, e não vazios.
  expect(naConversa).toHaveLength(3);
  expect(naConversa.every((e) => e.trim().length > 0)).toBe(true);
});

// ════ 3–5. Seleção, confirmação e aprofundamento ════

test("3. seleciona SAÚDE e confirma a correspondência com o gesto", async ({
  page,
}) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });

  await opcao(page, "SAÚDE").click();
  // A seleção NÃO avança sozinha: ela pede conferência.
  await expect(page.getByText("Opção observada: SAÚDE")).toBeVisible();
  await expect(
    page.getByText(/Confirmar que esta opção corresponde ao gesto observado/)
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sobre qual assunto deseja conversar?" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  // Depois de confirmar, o próximo nível é pedido — nunca preenchido sozinho.
  await expect(
    page.getByRole("heading", { name: "Criar o próximo nível" })
  ).toBeVisible();
});

test("4. abre DOR, MEDICAÇÃO e CONSULTA no nível seguinte", async ({ page }) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });
  await confirmarOpcao(page, "SAÚDE");
  await criarNivel(page, {
    titulo: "Saúde",
    opcoes: ["DOR", "MEDICAÇÃO", "CONSULTA"],
  });
  for (const label of ["DOR", "MEDICAÇÃO", "CONSULTA"]) {
    await expect(opcao(page, label)).toBeVisible();
  }
  // A confirmação anterior não é reaproveitada aqui.
  await expect(page.getByText(/Opção observada/)).toBeHidden();
});

test("5. aprofunda até PERNA e chega ao compositor", async ({ page }) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
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
    terminal: 1,
    fraseFinal: "Estou sentindo dor na perna.",
  });
  await confirmarOpcao(page, "PERNA");

  // A opção terminal abre a mensagem em construção (§17).
  await expect(
    page.getByText("Mensagem em construção", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(/aguardando confirmação do paciente/)
  ).toBeVisible();
  await expect(page.getByLabel(/Frase que será apresentada/)).toHaveValue(
    "Estou sentindo dor na perna."
  );
  await expect(page.getByText("Saúde › Dor › Perna")).toBeVisible();
});

// ════ 10–13. Frase final ════

/** Leva a conversa até a frase apresentada, pronta para confirmação. */
async function ateAFraseApresentada(page: import("@playwright/test").Page, patientId: number) {
  await iniciarConversaPorOpcoes(page, patientId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });
  await confirmarOpcao(page, "SAÚDE");
  await criarNivel(page, {
    titulo: "Saúde",
    opcoes: ["DOR", "MEDICAÇÃO", "CONSULTA"],
    terminal: 0,
    fraseFinal: "Estou sentindo dor na perna.",
  });
  await confirmarOpcao(page, "DOR");
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await expect(
    page.getByRole("group", {
      name: "Respostas possíveis do paciente sobre esta frase",
    })
  ).toBeVisible();
}

test("10. constrói a frase final e a apresenta em modo de confirmação", async ({
  page,
}) => {
  await ateAFraseApresentada(page, dados.pacienteId);
  // Aqui — e só aqui — SIM/TALVEZ/NÃO voltam a existir (§20).
  await expect(page.getByText("Confirmação da frase")).toBeVisible();
  await expect(resposta(page, "SIM")).toBeVisible();
  await expect(resposta(page, "TALVEZ")).toBeVisible();
  await expect(resposta(page, "NÃO")).toBeVisible();
  // As opções numéricas somem.
  await expect(
    page.getByRole("group", { name: "Opções apresentadas ao paciente" })
  ).toBeHidden();
});

test("11. confirma a frase com SIM e conclui o caminho", async ({ page }) => {
  await ateAFraseApresentada(page, dados.pacienteId);
  await resposta(page, "SIM").click();
  // Nem o SIM confirma sozinho: a conferência é um segundo ato.
  await expect(page.getByText("Resposta observada: SIM")).toBeVisible();
  await page.getByRole("button", { name: "Confirmar a frase" }).click();
  await expect(
    page.getByRole("heading", { name: "Mensagem confirmada" })
  ).toBeVisible();
});

test("12. TALVEZ não confirma e oferece os caminhos de ajuste", async ({
  page,
}) => {
  await ateAFraseApresentada(page, dados.pacienteId);
  await resposta(page, "TALVEZ").click();
  await expect(page.getByText("A frase não foi confirmada.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ajustar frase" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Aprofundar assunto" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancelar frase" })
  ).toBeVisible();
  // Não existe botão que confirme a partir de TALVEZ.
  await expect(
    page.getByRole("button", { name: "Confirmar a frase" })
  ).toBeHidden();
  await expect(page.getByText("Mensagem confirmada")).toBeHidden();
});

test("13. NÃO não confirma e registra a rejeição", async ({ page }) => {
  await ateAFraseApresentada(page, dados.pacienteId);
  await resposta(page, "NÃO").click();
  await expect(page.getByText("A frase não foi confirmada.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirmar a frase" })
  ).toBeHidden();

  await page.getByRole("button", { name: "Registrar como rejeitada" }).click();
  await expect(
    page.getByRole("heading", { name: "Frase rejeitada" })
  ).toBeVisible();
  await expect(
    page.getByText(/nunca será tratada como comunicação confirmada/)
  ).toBeVisible();
});
