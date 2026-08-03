// ——— Controles diretos do paciente (Fase 4.7) ———
// As jornadas que só a interface prova: que o painel está ao alcance em todos
// os contextos, que abrir e fechar NÃO mexem na conversa, e que encerrar exige
// o SIM do paciente.
//
// As regras de domínio (execução de cada comando, auditoria, isolamento,
// duplicação, pausa) já estão cobertas por scripts/test-patient-controls.mjs.

import { expect, test, type Page } from "@playwright/test";
import { abrirModo, entrarComo, pularContexto, semear, type Semente } from "./helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

const painel = (page: Page) =>
  page.getByRole("dialog", { name: "Controles do paciente" });

const comando = (page: Page, nome: string) =>
  page.getByRole("button", { name: new RegExp(`^${nome}:`) });

async function sessaoAberta(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
  await pularContexto(page);
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
}

async function perguntaApresentada(page: Page, texto = "O senhor está com sede?") {
  await sessaoAberta(page);
  await page.getByLabel("Pergunta para o paciente").fill(texto);
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await expect(page.getByRole("group", { name: /Respostas possíveis/ })).toBeVisible();
}

async function abrirPainel(page: Page) {
  await page.getByRole("button", { name: "Controles do paciente" }).click();
  await expect(painel(page)).toBeVisible();
}

/** Leva o painel até um comando confirmado. */
async function ateConfirmar(page: Page, nome: string, nivel2 = false) {
  await page.getByRole("button", { name: "Apresentar os controles" }).click();
  if (nivel2) {
    await page.getByRole("button", { name: "Aguardar o gesto do paciente" }).click();
    await comando(page, "MAIS CONTROLES").click();
    await page.getByRole("button", { name: "Confirmar comando observado" }).click();
    await page.getByRole("button", { name: "Mostrar mais controles" }).click();
  }
  await page.getByRole("button", { name: "Aguardar o gesto do paciente" }).click();
  await comando(page, nome).click();
  await page.getByRole("button", { name: "Confirmar comando observado" }).click();
}

test("o gatilho está sempre no rodapé, em todos os contextos", async ({ page }) => {
  await sessaoAberta(page);
  const gatilho = page.getByRole("button", { name: "Controles do paciente" });
  // Compositor.
  await expect(gatilho).toBeVisible();
  // Pergunta apresentada.
  await page.getByLabel("Pergunta para o paciente").fill("O senhor está com sede?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(gatilho).toBeVisible();
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await expect(gatilho).toBeVisible();
});

test("nos níveis, os comandos NUNCA aparecem como SIM/TALVEZ/NÃO", async ({ page }) => {
  await perguntaApresentada(page);
  await abrirPainel(page);
  await page.getByRole("button", { name: "Apresentar os controles" }).click();

  await expect(comando(page, "PAUSAR")).toBeVisible();
  await expect(comando(page, "REPETIR")).toBeVisible();
  await expect(comando(page, "MAIS CONTROLES")).toBeVisible();
  // O selo diz o que os sinais significam agora.
  await expect(
    painel(page).getByText(/significam opção 1, opção 2 e opção 3/)
  ).toBeVisible();
  // E nenhum comando carrega rótulo semântico.
  for (const semantico of ["SIM", "TALVEZ", "NÃO"]) {
    await expect(
      painel(page).getByRole("button", { name: new RegExp(`^${semantico}:`) })
    ).toBeHidden();
  }
});

test("MAIS CONTROLES leva ao segundo nível", async ({ page }) => {
  await perguntaApresentada(page);
  await abrirPainel(page);
  await ateConfirmar(page, "MAIS CONTROLES");
  await page.getByRole("button", { name: "Mostrar mais controles" }).click();
  await expect(comando(page, "NÃO ENTENDI")).toBeVisible();
  await expect(comando(page, "MUDAR DE ASSUNTO")).toBeVisible();
  await expect(comando(page, "ENCERRAR")).toBeVisible();
});

test("a seleção é provisória e passa por conferência", async ({ page }) => {
  await perguntaApresentada(page);
  await abrirPainel(page);
  await page.getByRole("button", { name: "Apresentar os controles" }).click();
  await page.getByRole("button", { name: "Aguardar o gesto do paciente" }).click();
  await comando(page, "PAUSAR").click();

  // Marcado sem depender de cor, e sem ter executado nada.
  await expect(comando(page, "PAUSAR")).toHaveAttribute("aria-pressed", "true");
  await expect(painel(page).getByText(/Comando observado:/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirmar comando observado" })
  ).toBeVisible();
  await expect(page.getByText("Sessão pausada")).toBeHidden();
});

test("abrir e voltar não altera a conversa nem o texto digitado", async ({ page }) => {
  await sessaoAberta(page);
  await page.getByLabel("Pergunta para o paciente").fill("O senhor quer água?");

  await abrirPainel(page);
  await page.getByRole("button", { name: "Voltar para a conversa" }).click();
  await expect(painel(page)).toBeHidden();

  // O texto digitado sobrevive: o painel sobrepõe, não substitui.
  await expect(page.getByLabel("Pergunta para o paciente")).toHaveValue(
    "O senhor quer água?"
  );
});

test("a seleção provisória da conversa sobrevive ao painel", async ({ page }) => {
  await perguntaApresentada(page);
  await page.getByRole("button", { name: /^TALVEZ:/ }).click();
  await expect(page.getByText("Resposta observada: TALVEZ")).toBeVisible();

  await abrirPainel(page);
  await page.getByRole("button", { name: "Voltar para a conversa" }).click();
  await expect(painel(page)).toBeHidden();
  await expect(page.getByText("Resposta observada: TALVEZ")).toBeVisible();
});

test("PAUSAR pausa a sessão sem concluir a pergunta", async ({ page }) => {
  await perguntaApresentada(page);
  await abrirPainel(page);
  await ateConfirmar(page, "PAUSAR");
  await page.getByRole("button", { name: "PAUSAR", exact: true }).click();
  await expect(page.getByText("Sessão pausada")).toBeVisible();
});

test("REPETIR reapresenta a mesma pergunta", async ({ page }) => {
  await perguntaApresentada(page, "O senhor está com frio?");
  await abrirPainel(page);
  await ateConfirmar(page, "REPETIR");
  await page.getByRole("button", { name: "REPETIR", exact: true }).click();

  await expect(painel(page)).toBeHidden();
  await expect(page.getByText("O senhor está com frio?").first()).toBeVisible();
  await expect(page.getByRole("group", { name: /Respostas possíveis/ })).toBeVisible();
});

test("NÃO ENTENDI não vira recusa e a decisão fica com o cuidador", async ({ page }) => {
  await perguntaApresentada(page);
  await abrirPainel(page);
  await ateConfirmar(page, "NÃO ENTENDI", true);
  await page.getByRole("button", { name: "NÃO ENTENDI", exact: true }).click();

  await expect(
    page.getByText("O paciente indicou que não entendeu.")
  ).toBeVisible();
  await expect(page.getByText(/não é uma recusa/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Repetir sem alterar" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Criar versão simplificada" })
  ).toBeVisible();
  // O Helo não escreve a versão simplificada.
  await expect(page.getByText(/A versão simplificada é escrita por você/)).toBeVisible();
  // E nada virou resposta.
  await expect(page.getByText("Resposta observada: NÃO")).toBeHidden();
});

test("ENCERRAR exige a confirmação final do paciente", async ({ page }) => {
  await perguntaApresentada(page);
  await abrirPainel(page);
  await ateConfirmar(page, "ENCERRAR", true);

  // A seleção sozinha não encerra: o painel oferece a pergunta fechada.
  await expect(page.getByText(/escolher “encerrar” não encerra sozinho/)).toBeVisible();
  await page.getByRole("button", { name: "Perguntar se deseja encerrar" }).click();

  await expect(painel(page).getByText("Deseja encerrar a conversa?")).toBeVisible();
  // Só aqui os rótulos semânticos voltam.
  await expect(painel(page).getByRole("button", { name: /^SIM:/ })).toBeVisible();
  await expect(painel(page).getByRole("button", { name: /^TALVEZ:/ })).toBeVisible();
  await expect(painel(page).getByRole("button", { name: /^NÃO:/ })).toBeVisible();
});

test("NÃO na confirmação final devolve a conversa", async ({ page }) => {
  await perguntaApresentada(page);
  await abrirPainel(page);
  await ateConfirmar(page, "ENCERRAR", true);
  await page.getByRole("button", { name: "Perguntar se deseja encerrar" }).click();
  await painel(page).getByRole("button", { name: /^NÃO:/ }).click();

  await expect(painel(page)).toBeHidden();
  // A conversa continua exatamente onde estava.
  await expect(page.getByRole("group", { name: /Respostas possíveis/ })).toBeVisible();
});

test("o painel aberto sobrevive a atualizar a página", async ({ page }) => {
  await perguntaApresentada(page);
  await abrirPainel(page);
  await page.getByRole("button", { name: "Apresentar os controles" }).click();
  await page.getByRole("button", { name: "Aguardar o gesto do paciente" }).click();
  await comando(page, "PAUSAR").click();

  await page.reload();
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();
  // O pedido continua vivo no servidor: reabrir devolve a seleção provisória.
  await page.getByRole("button", { name: "Controles do paciente" }).click();
  await expect(painel(page).getByText(/Comando observado:/)).toBeVisible();
});
