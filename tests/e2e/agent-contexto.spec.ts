// ——— O que sai do Helo para a ElevenLabs, medido na tela real (Fase 5.3B) ———
//
// A suíte `test:agent:capabilities` conduz `buildHeloContext` diretamente e
// prova a forma do payload. Ela não prova uma coisa: que a tela REAL, com
// conteúdo real digitado por um cuidador, produz esse payload.
//
// É o que estes testes medem. Eles leem o payload pelo hook de inspeção
// `window.__heloAgentContext`, que existe apenas em desenvolvimento e devolve
// o MESMO objeto que a client tool devolveria — a prova de que um texto
// clínico não atravessa a fronteira só vale se for lida do objeto que
// atravessaria.
//
// Nenhuma sessão do Agent é aberta. Nenhuma chamada ao provedor acontece: o
// payload é montado no cliente, e é o cliente que estamos medindo.

import { test, expect, type Page } from "@playwright/test";
import {
  abrirModo,
  entrarComo,
  iniciarNovaSessao,
  pularContexto,
  selecionarPaciente,
  semear,
  type Semente,
} from "./helpers";
import { criarNivel, iniciarConversaPorOpcoes } from "./option-conversation-helpers";

/** O marcador: se ele aparecer no payload, o R-09 voltou. */
const SEGREDO = "SEGREDO_CLINICO_R09_X7";

type Capability = { id: string; class: string; label: string; scope: string };
type Contexto = {
  ok: true;
  route: string;
  screen: string;
  capabilities: Capability[];
  humanOnly: Record<string, number>;
  diagnostic: string;
};

/** O payload exato que `getCurrentHeloActions` devolveria agora. */
async function contexto(page: Page): Promise<Contexto> {
  await expect
    .poll(() => page.evaluate(() => typeof (window as never as Record<string, unknown>).__heloAgentContext))
    .toBe("function");
  return page.evaluate(
    () =>
      (
        (window as never as Record<string, unknown>).__heloAgentContext as () => unknown
      )() as Contexto
  );
}

/** Todo o texto que está na tela agora — o que a versão anterior enviava. */
async function textoDaTela(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("button, a"))
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean)
  );
}

let semente: Semente;

test.beforeEach(async ({ request }) => {
  semente = await semear(request);
});

test.describe("O contexto enviado ao provedor", () => {
  test("1. é capacidade, não a tela: a Rotina anuncia ações e nenhum texto solto", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/rotina");
    await expect(page.getByRole("heading", { name: "Rotina" })).toBeVisible();

    const ctx = await contexto(page);
    const locais = ctx.capabilities.filter((c) => c.scope === "screen");

    expect(ctx.screen).toBe("routine_menu");
    expect(ctx.route).toBe("/rotina");
    // 15 cards, todos operacionais — a Rotina é a tela mais coberta do produto.
    expect(locais.length).toBeGreaterThan(10);
    expect(locais.every((c) => c.class === "operational")).toBeTruthy();

    // A tela tem MUITO mais texto do que o payload tem capacidade. A diferença
    // é exatamente o que deixou de sair.
    const naTela = await textoDaTela(page);
    const rotulos = new Set(ctx.capabilities.map((c) => c.label));
    const soNaTela = naTela.filter((t) => !rotulos.has(t));
    expect(soNaTela.length).toBeGreaterThan(0);
  });

  test("2. dentro do card da Rotina, as três respostas viram contagem — não rótulo", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/rotina");
    await page.getByRole("button", { name: /água/i }).first().click();
    await expect(page.getByRole("button", { name: "Responder sim" })).toBeVisible();

    const ctx = await contexto(page);
    const locais = ctx.capabilities.filter((c) => c.scope === "screen");

    expect(ctx.screen).toBe("routine_question");
    // Só "Voltar para as Rotinas" é do Agent aqui.
    expect(locais.map((c) => c.id)).toEqual(["routine.backToMenu"]);
    expect(ctx.humanOnly.patientResponse).toBe(3);

    // A pergunta do card saía no `extra` até a 5.3A. Não sai mais — e os
    // rótulos das três respostas nunca saíram, porque elas não são capacidade.
    const cru = JSON.stringify(ctx);
    expect(cru).not.toContain("água");
    expect(cru).not.toContain("👍");
  });

  test("3. a Emergência não oferece nada ao Agent, e não entrega os rótulos", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/emergencia");
    // Esperar o HEADING não basta: os itens de socorro vêm da API e o registry
    // só se enche quando eles renderizam. Ler o contexto antes disso mediria
    // uma tela que ainda não existe.
    await expect(page.getByRole("button", { name: "Falta de ar" })).toBeVisible();

    const ctx = await contexto(page);
    const locais = ctx.capabilities.filter((c) => c.scope === "screen");

    expect(locais).toEqual([]);
    expect(ctx.humanOnly.sensitive).toBeGreaterThan(0);

    // Os itens de socorro são texto do cuidador. A prova mais forte que a
    // ausência item a item: os ÚNICOS rótulos do payload são os das nove rotas
    // globais, que são do produto e iguais em toda tela.
    expect(ctx.capabilities.map((c) => c.label).sort()).toEqual(
      [
        "Ir para Ajustes",
        "Ir para Atividades",
        "Ir para Conversar",
        "Ir para Dashboard",
        "Ir para Emergência",
        "Ir para Helo",
        "Ir para Home",
        "Ir para Mensagens",
        "Ir para Rotina",
      ].sort()
    );
  });

  test("4. a conversa por opções: o conteúdo clínico não sai, e a capacidade nova sai", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await iniciarConversaPorOpcoes(page, semente.pacienteId);
    await criarNivel(page, {
      titulo: `Onde está doendo agora? ${SEGREDO}`,
      opcoes: [`Dor no peito ${SEGREDO}`, `Enjoo ${SEGREDO}`, `Falta de ar ${SEGREDO}`],
      terminal: 0,
      fraseFinal: `Preciso de ajuda ${SEGREDO}`,
    });

    const ctx = await contexto(page);
    const cru = JSON.stringify(ctx);

    // O ponto inteiro da fase: o marcador está na tela, em quatro lugares
    // diferentes, e não está no payload.
    const naTela = (await textoDaTela(page)).join(" | ");
    expect(naTela, "o marcador precisa estar na tela para o teste valer").toContain(SEGREDO);
    expect(cru, "o marcador clínico atravessou a fronteira").not.toContain(SEGREDO);

    // E a tela deixou de ser um vazio de capacidade: a 5.3B registrou ações.
    expect(ctx.screen).toBe("perguntas_conversa_por_opcoes");
    const ids = ctx.capabilities.filter((c) => c.scope === "screen").map((c) => c.id);
    expect(ids).toContain("perguntas.sairDaConversaPorOpcoes");
    expect(ids).toContain("perguntas.controlesDoPaciente");

    // As opções do paciente continuam do paciente.
    expect(ids.some((id) => id.startsWith("conversa.opcao"))).toBeFalsy();
  });

  test("5. a pergunta digitada pelo cuidador não vira contexto", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await abrirModo(page, semente.pacienteId);
    await iniciarNovaSessao(page);
    await pularContexto(page);
    await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();

    await page.getByRole("textbox").first().fill(`O senhor sente ${SEGREDO}?`);
    const ctx = await contexto(page);

    // Nem o texto do campo, nem o rascunho, nem nada dele.
    expect(JSON.stringify(ctx)).not.toContain(SEGREDO);
    expect(ctx.screen).toBe("perguntas_compor");
  });

  test("6. as capacidades acompanham a tela quando o cuidador navega", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);

    await page.goto("/rotina");
    await expect(page.getByRole("heading", { name: "Rotina" })).toBeVisible();
    const naRotina = await contexto(page);

    await page.goto("/helo");
    await expect(page.getByRole("button", { name: "Conectar com Helo" })).toBeVisible();
    const noHelo = await contexto(page);

    const idsRotina = naRotina.capabilities.filter((c) => c.scope === "screen").map((c) => c.id);
    const idsHelo = noHelo.capabilities.filter((c) => c.scope === "screen").map((c) => c.id);

    expect(idsRotina.some((id) => id.startsWith("routine.open."))).toBeTruthy();
    // Nenhuma ação da Rotina sobreviveu à navegação: o registry esvazia no
    // desmonte, e o payload é lido no momento da chamada.
    expect(idsHelo.some((id) => id.startsWith("routine."))).toBeFalsy();
    expect(idsHelo).toContain("helo.conectar");
    expect(noHelo.screen).toBe("helo");

    // As nove rotas globais são as mesmas em qualquer tela — tabela fechada.
    const globais = (c: Contexto) => c.capabilities.filter((x) => x.scope === "global").map((x) => x.id);
    expect(globais(naRotina)).toEqual(globais(noHelo));
    expect(globais(noHelo)).toHaveLength(9);
  });

  test("7. os controles do paciente e os gestos ficam com quem eles pertencem", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/helo");
    await expect(page.getByRole("button", { name: "Conectar com Helo" })).toBeVisible();

    const ctx = await contexto(page);
    const ids = ctx.capabilities.map((c) => c.id);

    // Estar na própria tela do Agent não muda a autoridade: SIM/TALVEZ/NÃO
    // continuam do paciente. (Aqui eles nem existem ainda — só nascem com a
    // conversa conectada — mas o que importa é que nunca são capability.)
    expect(ids.some((id) => id.startsWith("gesto."))).toBeFalsy();
    expect(ids).toContain("helo.conectar");
    // Encerrar é `sensitive`: o Agent pode chegar até a fronteira, não além.
    expect(ids).not.toContain("helo.encerrar");
  });
});
