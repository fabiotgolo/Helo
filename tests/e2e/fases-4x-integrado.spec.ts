// ——— Validação integrada das Fases 4.2, 4.7 e 4.8 (Etapa 2) ———
//
// Os testes por fase provam cada peça isolada. Estas jornadas provam o que
// nenhuma delas alcança: que as peças CONVIVEM na mesma sessão sem se
// atrapalhar — contexto, pergunta fechada, conversa por opções, interpretação
// do cuidador, controles do paciente, histórico, pausa e retomada.
//
// São as sete jornadas A–G do briefing, na ordem dele. Cada uma percorre um
// caminho que atravessa pelo menos duas fases.

import { expect, test, type Page } from "@playwright/test";
import { abrirModo, entrarComo, semear, type Semente } from "./helpers";
import { confirmarOpcao, criarNivel } from "./option-conversation-helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

const painel = (page: Page) =>
  page.getByRole("dialog", { name: "Controles do paciente" });
const comando = (page: Page, nome: string) =>
  page.getByRole("button", { name: new RegExp(`^${nome}:`) });
const resposta = (page: Page, nome: string) =>
  page.getByRole("button", { name: new RegExp(`^${nome}:`) });

async function novaSessao(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
}

/** Preenche o contexto e entra na conversa (Fase 4.8). */
async function comContexto(page: Page, campos: { intencao?: string; ambiente?: string; assunto?: string }) {
  await novaSessao(page);
  await expect(
    page.getByRole("heading", { name: "Contexto da conversa (opcional)" })
  ).toBeVisible();
  if (campos.intencao) {
    await page.getByRole("textbox", { name: "Intenção da conversa" }).fill(campos.intencao);
  }
  if (campos.ambiente) {
    await page.getByRole("textbox", { name: "Ambiente" }).fill(campos.ambiente);
  }
  if (campos.assunto) {
    await page.getByLabel("Assunto inicial").fill(campos.assunto);
  }
  await page.getByRole("button", { name: "Salvar e começar" }).click();
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
}

async function perguntaApresentada(page: Page, texto: string) {
  await page.getByLabel("Pergunta para o paciente").fill(texto);
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await expect(page.getByRole("group", { name: /Respostas possíveis/ })).toBeVisible();
}

async function abrirControles(page: Page) {
  await page.getByRole("button", { name: "Controles do paciente" }).click();
  await expect(painel(page)).toBeVisible();
}

/** Leva o painel do paciente até um comando confirmado. */
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

async function registrarInterpretacao(page: Page, texto: string) {
  await page.getByRole("button", { name: "Registrar o que entendi" }).click();
  await page.getByLabel("Interpretação do cuidador").fill(texto);
  await page.getByRole("button", { name: "Registrar interpretação" }).click();
  await expect(
    page.getByRole("heading", { name: "Interpretação registrada pelo cuidador" })
  ).toBeVisible();
}

// ═══════════════════════════════════════════════════════════════════════
// JORNADA A — contexto → pergunta fechada → controles → repetir → responder
// ═══════════════════════════════════════════════════════════════════════

test("A: contexto, pergunta fechada, pedido de repetição e conclusão do turno", async ({ page }) => {
  await comContexto(page, { intencao: "Explicar um desconforto", ambiente: "Consulta" });
  await expect(page.getByText(/Explicar um desconforto · Consulta/)).toBeVisible();

  await perguntaApresentada(page, "O senhor está com dor?");

  // O paciente pede para repetir — sem sair da pergunta em curso.
  await abrirControles(page);
  await ateConfirmar(page, "REPETIR");
  await page.getByRole("button", { name: "REPETIR", exact: true }).click();
  await expect(painel(page)).toBeHidden();

  // A MESMA pergunta continua no ar, e agora ele responde.
  await expect(page.getByText("O senhor está com dor?").first()).toBeVisible();
  await resposta(page, "SIM").click();
  await expect(page.getByText("Resposta observada: SIM")).toBeVisible();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(page.getByText("Resposta confirmada: SIM")).toBeVisible();

  // O contexto atravessou a jornada inteira.
  await expect(page.getByText(/Explicar um desconforto · Consulta/)).toBeVisible();
});

// ═══════════════════════════════════════════════════════════════════════
// JORNADA B — contexto de consulta → conversa por opções → frase → TALVEZ
//             → ajustar → SIM
// ═══════════════════════════════════════════════════════════════════════

test("B: contexto de consulta, caminho por opções, ajuste após TALVEZ e confirmação", async ({ page }) => {
  // A jornada mais longa da suíte: contexto, dois níveis, frase, ajuste com
  // versão corrigida e nova confirmação. Sob a carga da suíte completa ela
  // ultrapassa os 45s padrão — é duração, não instabilidade.
  test.slow();
  await comContexto(page, { ambiente: "Consulta", assunto: "dor" });

  await page.getByRole("button", { name: "Conversa por opções" }).click();
  await expect(page.getByRole("heading", { name: /Criar o primeiro nível/ })).toBeVisible();

  // Saúde › Dor, com a última opção terminal — a mesma sequência das suítes
  // da conversa por opções, agora dentro de uma sessão COM contexto.
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
    page.getByRole("group", { name: "Respostas possíveis do paciente sobre esta frase" })
  ).toBeVisible();

  // TALVEZ não confirma — e oferece ajustar.
  await resposta(page, "TALVEZ").click();
  await expect(page.getByText("A frase não foi confirmada.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirmar a frase" })).toBeHidden();
  await page.getByRole("button", { name: "Ajustar frase" }).click();
  // Já apresentada, a frase NÃO é reescrita: o domínio exige uma versão nova,
  // e a interface confirma isso com o cuidador antes de criá-la.
  await expect(page.getByText("Esta frase já foi apresentada ao paciente.")).toBeVisible();
  await page.getByRole("button", { name: "Criar versão corrigida" }).click();

  // A versão corrigida exige nova apresentação e nova confirmação.
  await page.getByLabel("Frase que será apresentada ao paciente").fill("Estou sentindo dor no joelho.");
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await resposta(page, "SIM").click();
  await expect(page.getByText("Resposta observada: SIM")).toBeVisible();
  await page.getByRole("button", { name: "Confirmar a frase" }).click();

  await expect(page.getByRole("heading", { name: "Mensagem confirmada" })).toBeVisible();
  // Frase escolhida pelo paciente entre opções: o rótulo NÃO cita o cuidador.
  await expect(page.getByText(/texto formulado pelo cuidador/)).toBeHidden();
});

// ═══════════════════════════════════════════════════════════════════════
// JORNADA C — interpretação rejeitada → nova versão → confirmada
// ═══════════════════════════════════════════════════════════════════════

test("C: o paciente recusa a interpretação, o cuidador reescreve e ele confirma", async ({ page }) => {
  await comContexto(page, { assunto: "vontade de comer" });

  await registrarInterpretacao(page, "O senhor quer tomar sopa?");
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await expect(page.getByText("O cuidador entendeu:")).toBeVisible();

  // NÃO: rejeitada, e nunca tratada como comunicação confirmada.
  await resposta(page, "NÃO").click();
  await page.getByRole("button", { name: "Registrar como rejeitada" }).click();
  await expect(page.getByRole("heading", { name: "Interpretação rejeitada" })).toBeVisible();

  // O cuidador escreve outra — registro NOVO, sem herdar a rejeição.
  await page.getByRole("button", { name: "Voltar" }).click();
  await registrarInterpretacao(page, "O senhor quer comer churrasco?");
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await resposta(page, "SIM").click();
  await page.getByRole("button", { name: "Confirmar a frase" }).click();

  await expect(page.getByRole("heading", { name: "Interpretação confirmada" })).toBeVisible();
  // A autoria do texto sobrevive à confirmação.
  await expect(
    page.getByText(/Confirmada pelo paciente · texto formulado pelo cuidador/).first()
  ).toBeVisible();
});

// ═══════════════════════════════════════════════════════════════════════
// JORNADA D — "não entendi" → versão simplificada → nova apresentação
// ═══════════════════════════════════════════════════════════════════════

test("D: o paciente não entende, o cuidador simplifica e apresenta de novo", async ({ page }) => {
  await comContexto(page, {});
  await perguntaApresentada(page, "O senhor gostaria de reagendar a fisioterapia desta semana?");

  await abrirControles(page);
  await ateConfirmar(page, "NÃO ENTENDI", true);
  await page.getByRole("button", { name: "NÃO ENTENDI", exact: true }).click();

  // Não virou recusa, e a decisão é do cuidador.
  await expect(page.getByText("O paciente indicou que não entendeu.")).toBeVisible();
  await expect(page.getByText("Resposta observada: NÃO")).toBeHidden();
  await expect(page.getByText(/A versão simplificada é escrita por você/)).toBeVisible();

  // Ele escreve a versão simplificada — o Helo não gera texto.
  await page.getByRole("button", { name: "Criar versão simplificada" }).click();
  await perguntaApresentada(page, "Quer mudar o dia da fisioterapia?");
  await resposta(page, "SIM").click();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(page.getByText("Resposta confirmada: SIM")).toBeVisible();
});

// ═══════════════════════════════════════════════════════════════════════
// JORNADA E — mudar de assunto preserva o histórico
// ═══════════════════════════════════════════════════════════════════════

test("E: mudar de assunto interrompe sem apagar o que já foi confirmado", async ({ page }) => {
  await comContexto(page, { assunto: "sono" });

  // Um turno CONFIRMADO antes: ele precisa sobreviver.
  await perguntaApresentada(page, "O senhor dormiu bem?");
  await resposta(page, "SIM").click();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(page.getByText("Resposta confirmada: SIM")).toBeVisible();

  // Uma segunda pergunta, com resposta apenas provisória.
  await page.getByRole("button", { name: "Fazer nova pergunta" }).click();
  await perguntaApresentada(page, "O senhor quer trocar de travesseiro?");
  await resposta(page, "TALVEZ").click();
  await expect(page.getByText("Resposta observada: TALVEZ")).toBeVisible();

  await abrirControles(page);
  await ateConfirmar(page, "MUDAR DE ASSUNTO", true);
  await page.getByRole("button", { name: "MUDAR DE ASSUNTO", exact: true }).click();
  await expect(painel(page)).toBeHidden();

  // Uma interação nova começa, e o histórico anterior continua lá.
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
  await page.getByText(/Histórico da sessão/).click();
  await expect(page.getByRole("button", { name: /O senhor dormiu bem\?/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /O senhor quer trocar de travesseiro\?/ })
  ).toBeVisible();
});

// ═══════════════════════════════════════════════════════════════════════
// JORNADA F — interpretação em edição → pausa → refresh → retomada
// ═══════════════════════════════════════════════════════════════════════

test("F: pausar e atualizar a página restaura a interpretação e o contexto", async ({ page }) => {
  await comContexto(page, { intencao: "Falar sobre uma memória", assunto: "viagem" });
  await registrarInterpretacao(page, "O senhor lembrou da viagem a Santos?");

  // Pausa pelo rodapé, com a interpretação ainda em revisão.
  await page.getByRole("button", { name: "⏸ Pausar sessão" }).click();
  await expect(page.getByText("Sessão pausada")).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();

  // Volta exatamente onde estava: mesma interpretação, mesmo contexto.
  await expect(
    page.getByRole("heading", { name: "Interpretação registrada pelo cuidador" })
  ).toBeVisible();
  await expect(page.getByText("O senhor lembrou da viagem a Santos?").first()).toBeVisible();

  // O contexto sobreviveu à pausa e ao refresh. A barra fica oculta enquanto a
  // interpretação está aberta (o paciente pode estar olhando a tela), então
  // saímos dela para conferir.
  await page.getByRole("button", { name: "Sair da conversa por opções" }).click();
  await expect(page.getByText(/Falar sobre uma memória · viagem/)).toBeVisible();
});

// ═══════════════════════════════════════════════════════════════════════
// JORNADA G — pedido de encerrar recusado devolve a conversa
// ═══════════════════════════════════════════════════════════════════════

test("G: o paciente pede para encerrar, responde NÃO e a conversa é restaurada", async ({ page }) => {
  await comContexto(page, {});
  await perguntaApresentada(page, "O senhor quer continuar conversando?");
  await resposta(page, "TALVEZ").click();
  await expect(page.getByText("Resposta observada: TALVEZ")).toBeVisible();

  await abrirControles(page);
  await ateConfirmar(page, "ENCERRAR", true);
  await page.getByRole("button", { name: "Perguntar se deseja encerrar" }).click();
  await expect(painel(page).getByText("Deseja encerrar a conversa?")).toBeVisible();

  // NÃO: a conversa continua, com a seleção provisória intacta.
  await painel(page).getByRole("button", { name: /^NÃO:/ }).click();
  await expect(painel(page)).toBeHidden();
  await expect(page.getByText("Resposta observada: TALVEZ")).toBeVisible();
  await expect(page.getByText("Sessão pausada")).toBeHidden();
});

// ═══════════════════════════════════════════════════════════════════════
// Convivência: as três fases na MESMA sessão, sem se atrapalhar
// ═══════════════════════════════════════════════════════════════════════

test("as três fases convivem: contexto editado, interpretação e controles", async ({ page }) => {
  await comContexto(page, { assunto: "dor" });

  // 4.8 — editar o contexto no meio da sessão cria versão nova.
  await page.getByRole("button", { name: "Editar o contexto da conversa" }).click();
  await page.getByLabel("Assunto inicial").fill("dor no joelho");
  await page.getByRole("button", { name: "Salvar nova versão" }).click();
  await expect(page.getByText(/versão 2/)).toBeVisible();

  // 4.2 — a interpretação convive com o contexto editado.
  await registrarInterpretacao(page, "O senhor sente dor ao dobrar o joelho?");
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await expect(page.getByText("O cuidador entendeu:")).toBeVisible();

  // 4.7 — os controles alcançam a interpretação apresentada.
  await abrirControles(page);
  await page.getByRole("button", { name: "Apresentar os controles" }).click();
  await expect(comando(page, "PAUSAR")).toBeVisible();
  // E abrir NÃO alterou a interpretação em curso.
  await page.getByRole("button", { name: "Voltar para a conversa" }).click();
  await expect(painel(page)).toBeHidden();
  await expect(page.getByText("O cuidador entendeu:")).toBeVisible();
  await expect(
    page.getByText("O senhor sente dor ao dobrar o joelho?").first()
  ).toBeVisible();
});
