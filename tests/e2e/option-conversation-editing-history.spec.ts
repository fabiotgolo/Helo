// ——— Interface: histórico, reutilização e versionamento (§37) ———
// Cobre os fluxos 16–26.

import { expect, test, type Page } from "@playwright/test";
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

/** Abre o painel recolhido do histórico. */
async function abrirHistorico(page: Page) {
  const resumo = page.getByText(/Histórico da sessão \(/);
  await expect(resumo).toBeVisible();
  await resumo.click();
}

/** Uma conversa concluída, com a frase confirmada. */
async function conversaConcluida(page: Page, patientId: number) {
  await iniciarConversaPorOpcoes(page, patientId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
    terminal: 1,
    fraseFinal: "Quero falar sobre saúde.",
  });
  await confirmarOpcao(page, "SAÚDE");
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await resposta(page, "SIM").click();
  await page.getByRole("button", { name: "Confirmar a frase" }).click();
  await expect(
    page.getByRole("heading", { name: "Mensagem confirmada" })
  ).toBeVisible();
}

// ════ 16–18. Histórico clicável ════

test("16. o histórico lista perguntas fechadas e conversas por opções", async ({
  page,
}) => {
  await conversaConcluida(page, dados.pacienteId);
  await abrirHistorico(page);
  await expect(
    page.getByRole("button", { name: /Abrir conversa por opções/ })
  ).toBeVisible();
});

test("17. clicar num item EM ANDAMENTO recupera a tela dele", async ({ page }) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });
  await opcao(page, "SAÚDE").click();
  await expect(page.getByText("Opção observada: SAÚDE")).toBeVisible();

  // Sai do modo e volta pelo histórico.
  await page.getByRole("button", { name: "Sair da conversa por opções" }).click();
  await expect(
    page.getByRole("button", { name: "Fazer nova pergunta" })
  ).toBeVisible();

  await abrirHistorico(page);
  await page.getByRole("button", { name: /Retomar conversa por opções/ }).click();

  // O estado volta como estava: a seleção provisória continua PROVISÓRIA.
  await expect(page.getByText("Opção observada: SAÚDE")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Caminho da conversa" })
  ).toBeVisible();
});

test("18. clicar num item CONCLUÍDO oferece detalhes e reutilização", async ({
  page,
}) => {
  await conversaConcluida(page, dados.pacienteId);
  await abrirHistorico(page);
  await page.getByRole("button", { name: /Abrir conversa por opções/ }).click();

  await expect(
    page.getByRole("heading", { name: "O que deseja fazer com este item?" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Visualizar detalhes" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reutilizar como novo" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Visualizar detalhes" }).click();
  const detalhe = page.getByRole("dialog", { name: "Detalhes do item" });
  await expect(detalhe.getByRole("heading", { name: "Detalhes" })).toBeVisible();
  await expect(detalhe.getByText("Caminho completo")).toBeVisible();
  await expect(detalhe.getByText("Opções apresentadas:")).toBeVisible();
  await expect(detalhe.getByText("Opção confirmada:")).toBeVisible();
  await expect(
    detalhe.getByText("Confirmada pelo paciente").first()
  ).toBeVisible();
});

// ════ 19–21. Reutilização ════

test("19. reutiliza uma pergunta fechada, criando um rascunho novo", async ({
  page,
}) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await page.getByRole("button", { name: "Sair da conversa por opções" }).click();
  await page.getByRole("button", { name: "Fazer nova pergunta" }).click();
  await page.getByLabel("Pergunta para o paciente").fill("O senhor está com sede?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await resposta(page, "SIM").click();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(page.getByText("Resposta confirmada: SIM")).toBeVisible();

  await abrirHistorico(page);
  await page.getByRole("button", { name: /Abrir pergunta fechada/ }).click();
  await page.getByRole("button", { name: "Reutilizar como novo" }).click();

  // O rascunho novo aparece para revisão, com o mesmo texto.
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
  await expect(page.getByRole("blockquote")).toHaveText(
    "O senhor está com sede?"
  );
});

test("20. reutiliza um nível concluído, criando uma conversa nova", async ({
  page,
}) => {
  await conversaConcluida(page, dados.pacienteId);
  await abrirHistorico(page);
  await page.getByRole("button", { name: /Abrir conversa por opções/ }).click();
  await page.getByRole("button", { name: "Visualizar detalhes" }).click();
  await page.getByRole("button", { name: "Reutilizar este nível" }).click();

  // Conversa nova, com o conteúdo copiado em rascunho.
  await expect(
    page.getByRole("heading", { name: /Criar o primeiro nível|Editar este nível/ })
  ).toBeVisible();
  await expect(page.getByLabel("Título ou pergunta do nível")).toHaveValue(
    "Sobre qual assunto deseja conversar?"
  );
});

test("21. reutiliza a frase confirmada, sem trazer a confirmação junto", async ({
  page,
}) => {
  await conversaConcluida(page, dados.pacienteId);
  await abrirHistorico(page);
  await page.getByRole("button", { name: /Abrir conversa por opções/ }).click();
  await page.getByRole("button", { name: "Visualizar detalhes" }).click();
  await page.getByRole("button", { name: "Reutilizar esta frase" }).click();

  // A frase reutilizada volta como mensagem EM CONSTRUÇÃO, não confirmada.
  await expect(page.getByLabel(/Frase que será apresentada/)).toHaveValue(
    "Quero falar sobre saúde."
  );
  await expect(
    page.getByText(/aguardando confirmação do paciente/)
  ).toBeVisible();
  // O compositor da conversa NOVA não mostra confirmação alguma — a do
  // original continua aparecendo no histórico, que é onde ela pertence.
  const compositor = page
    .locator("main section")
    .filter({ hasText: "Mensagem em construção" })
    .first();
  await expect(compositor).not.toContainText("Mensagem confirmada");
  await expect(compositor).not.toContainText("Confirmada pelo paciente");
});

// ════ 22–26. Edição e versionamento ════

test("22. edita a pergunta do nível ANTES da apresentação, no mesmo rascunho", async ({
  page,
}) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await page.getByLabel("Título ou pergunta do nível").fill("Sobre o que falar?");
  await page.getByLabel(/^Opção 1/).fill("FAMILIA");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();

  // O lápis volta à edição do MESMO registro.
  await page.getByRole("button", { name: "✎ Editar" }).click();
  await page
    .getByLabel("Título ou pergunta do nível")
    .fill("Sobre qual assunto deseja conversar?");
  await page.getByRole("button", { name: "Salvar alterações" }).click();

  await expect(page.getByRole("blockquote")).toHaveText(
    "Sobre qual assunto deseja conversar?"
  );
  // Sem modal de versão corrigida: nada foi apresentado ainda.
  await expect(
    page.getByText("Este conteúdo já foi apresentado ao paciente.")
  ).toBeHidden();
});

test("23–25. o lápis após a apresentação cria uma versão corrigida e preserva o original", async ({
  page,
}) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });

  // 23. o lápis está disponível sobre o nível apresentado…
  await page
    .getByRole("button", { name: /Editar o nível: Sobre qual assunto/ })
    .click();

  // 24. …e pede a criação de uma versão corrigida, sem sobrescrever nada.
  await expect(
    page.getByText("Este conteúdo já foi apresentado ao paciente.")
  ).toBeVisible();
  await expect(
    page.getByText(/Nenhuma resposta anterior passa para a nova versão/)
  ).toBeVisible();
  await page.getByRole("button", { name: "Criar versão corrigida" }).click();

  await expect(
    page.getByRole("heading", { name: "Editar este nível" })
  ).toBeVisible();
  await page.getByLabel(/^Opção 3/).fill("LAZER");
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
  await expect(page.getByText("LAZER")).toBeVisible();

  // 25. o original continua no histórico, com o texto que o paciente viu.
  await abrirHistorico(page);
  await page.getByRole("button", { name: /Retomar conversa por opções/ }).click();
  await abrirHistorico(page);
  await page.getByRole("button", { name: /conversa por opções/ }).first().click();
});

test("26. a versão corrigida não herda a resposta da original", async ({
  page,
}) => {
  await iniciarConversaPorOpcoes(page, dados.pacienteId);
  await criarNivel(page, {
    titulo: "Sobre qual assunto deseja conversar?",
    opcoes: ["FAMÍLIA", "SAÚDE", "ROTINA"],
  });
  // Uma seleção provisória na versão original…
  await opcao(page, "SAÚDE").click();
  await expect(page.getByText("Opção observada: SAÚDE")).toBeVisible();

  await page
    .getByRole("button", { name: /Editar o nível: Sobre qual assunto/ })
    .click();
  await page.getByRole("button", { name: "Criar versão corrigida" }).click();
  await page.getByRole("button", { name: "Salvar alterações" }).click();

  // …não atravessa para a versão corrigida: ela volta a exigir apresentação.
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
  await expect(page.getByText("Opção observada: SAÚDE")).toBeHidden();
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await expect(
    page.getByRole("group", { name: "Opções apresentadas ao paciente" })
  ).toBeVisible();
  await expect(page.getByText(/Opção observada/)).toBeHidden();
});
