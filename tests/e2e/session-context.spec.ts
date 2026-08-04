// ——— Contexto da conversa (Fase 4.8) ———
// As jornadas que só a interface prova: pular num clique, preencher e começar,
// editar durante a sessão criando versão nova, e — a mais importante — o
// contexto NUNCA aparecer no palco do paciente.
//
// As regras de domínio (versionamento, auditoria, isolamento, duplicação) já
// estão cobertas por scripts/test-session-context.mjs e não se repetem aqui.

import { expect, test, type Page } from "@playwright/test";
import { abrirModo, entrarComo, pularContexto, semear, type Semente } from "./helpers";
import { confirmarOpcao, criarNivel, resposta } from "./option-conversation-helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

async function novaSessao(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
}

/** Sessão já com contexto gravado — ponto de partida de quem testa a barra. */
async function sessaoComContexto(page: Page, assunto = "dor no joelho") {
  await novaSessao(page);
  await page.getByLabel("Assunto inicial").fill(assunto);
  await page.getByRole("button", { name: "Salvar e começar" }).click();
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
}

const barraDoContexto = (page: Page) =>
  page.getByRole("button", { name: "Editar o contexto da conversa" });

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
  await sessaoComContexto(page);

  await page.getByLabel("Pergunta para o paciente").fill("O senhor está com dor?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();

  // Com a pergunta no palco, o resumo do contexto sai de cena: é anotação do
  // cuidador, e o paciente não deve lê-la junto com a pergunta.
  await expect(page.getByRole("group", { name: /Respostas possíveis/ })).toBeVisible();
  await expect(page.getByText("dor no joelho")).toBeHidden();
  await expect(barraDoContexto(page)).toBeHidden();
});

// ——— O contexto durante um caminho aberto ———
//
// A regra é uma só, e vale para a conversa por opções e para a interpretação:
// enquanto o caminho é do CUIDADOR — compor, revisar, navegar — o contexto
// fica ao alcance; no instante em que o caminho vira do PACIENTE — as opções
// no palco, a frase aguardando o SIM — ele sai de cena.

test("o contexto acompanha o cuidador enquanto ele compõe e navega o caminho", async ({
  page,
}) => {
  await sessaoComContexto(page);
  await page.getByRole("button", { name: "Conversa por opções" }).click();
  await expect(page.getByRole("heading", { name: /Criar o primeiro nível/ })).toBeVisible();

  // Compondo o primeiro nível: a tela é do cuidador.
  await expect(barraDoContexto(page)).toBeVisible();

  await criarNivel(page, { titulo: "O que o senhor quer?", opcoes: ["Água", "Descansar"] });
  // Opções no palco: some.
  await expect(barraDoContexto(page)).toBeHidden();

  await confirmarOpcao(page, "Água");
  // Segundo nível, de volta ao cuidador: reaparece — sem sair do caminho.
  await expect(page.getByRole("heading", { name: /Criar o.*nível/ })).toBeVisible();
  await expect(barraDoContexto(page)).toBeVisible();
});

test("o contexto sai de cena enquanto a frase aguarda o SIM do paciente", async ({
  page,
}) => {
  await sessaoComContexto(page);
  await page.getByRole("button", { name: "Conversa por opções" }).click();
  await criarNivel(page, {
    titulo: "O que o senhor quer?",
    opcoes: ["Água", "Descansar"],
    terminal: 0,
    fraseFinal: "Quero água.",
  });
  await confirmarOpcao(page, "Água");

  // Mensagem em construção: ainda é o cuidador quem está na tela.
  await expect(page.getByText("Mensagem em construção", { exact: true })).toBeVisible();
  await expect(barraDoContexto(page)).toBeVisible();
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();

  // Frase apresentada, aguardando o gesto: o contexto não divide a tela com ela.
  await expect(resposta(page, "SIM")).toBeVisible();
  await expect(barraDoContexto(page)).toBeHidden();
  await expect(page.getByText("dor no joelho")).toBeHidden();
});

test("consultar o contexto no meio do caminho não mexe em nada do fluxo", async ({
  page,
}) => {
  await sessaoComContexto(page);
  await page.getByRole("button", { name: "Conversa por opções" }).click();
  await criarNivel(page, { titulo: "O que o senhor quer?", opcoes: ["Água", "Descansar"] });
  await confirmarOpcao(page, "Água");

  // Segundo nível: um rascunho digitado e o breadcrumb do nível anterior.
  const titulo = page.getByLabel("Título ou pergunta do nível");
  await titulo.fill("Qual água?");
  await page.getByLabel(/^Opção 1/).fill("Gelada");
  const migalha = page.getByRole("button", { name: /^Voltar para O que o senhor quer/ });
  await expect(migalha).toBeVisible();

  // Abrir o contexto sobrepõe: o caminho continua montado por baixo.
  await page.getByRole("button", { name: /dor no joelho/ }).click();
  await expect(page.getByRole("heading", { name: "Contexto da conversa" })).toBeVisible();
  await page.getByRole("button", { name: "Fechar" }).click();

  // Ao fechar, a interação volta exatamente como estava — nada concluído,
  // nada cancelado, nada reescrito.
  await expect(page.getByRole("heading", { name: "Contexto da conversa" })).toBeHidden();
  await expect(titulo).toHaveValue("Qual água?");
  await expect(page.getByLabel(/^Opção 1/)).toHaveValue("Gelada");
  await expect(migalha).toBeVisible();
});

test("editar o contexto no meio do caminho preserva a seleção provisória", async ({
  page,
}) => {
  await sessaoComContexto(page);
  await page.getByRole("button", { name: "Conversa por opções" }).click();
  await criarNivel(page, { titulo: "O que o senhor quer?", opcoes: ["Água", "Descansar"] });

  // Gesto observado, ainda por conferir: o estado mais frágil que existe aqui.
  await page.getByRole("button", { name: /^Água:/ }).click();
  await expect(page.getByText("Opção observada: Água")).toBeVisible();
  // Com o paciente na tela a barra some — a edição do contexto passa a ser
  // alcançada pelo caminho normal, e não por cima da escolha dele.
  await expect(barraDoContexto(page)).toBeHidden();

  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(barraDoContexto(page)).toBeVisible();

  await barraDoContexto(page).click();
  await page.getByLabel("Assunto inicial").fill("dor no ombro");
  await page.getByRole("button", { name: "Salvar nova versão" }).click();

  // Versão nova gravada, e o cuidador continua no mesmo nível do mesmo caminho.
  await expect(page.getByText(/versão 2/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /Criar o.*nível/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Voltar para O que o senhor quer/ })
  ).toBeVisible();
});

test("o contexto acompanha a interpretação até ela ir para o paciente", async ({
  page,
}) => {
  await sessaoComContexto(page);
  await page.getByRole("button", { name: "Registrar o que entendi" }).click();
  await page
    .getByLabel("Interpretação do cuidador")
    .fill("O senhor quer trocar de posição.");
  await page.getByRole("button", { name: "Registrar interpretação" }).click();

  // Revisão da interpretação: é tela do cuidador, o contexto fica ao alcance.
  await expect(
    page.getByRole("heading", { name: "Interpretação registrada pelo cuidador" })
  ).toBeVisible();
  await expect(barraDoContexto(page)).toBeVisible();

  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  // Aguardando o SIM: some, como em qualquer caminho.
  await expect(resposta(page, "SIM")).toBeVisible();
  await expect(barraDoContexto(page)).toBeHidden();
});
