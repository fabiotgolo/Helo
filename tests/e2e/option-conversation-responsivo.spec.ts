// ——— Interface: breadcrumb e opções em celular, tablet e desktop (§35) ———
// O modo é operado à beira do leito, em telas muito diferentes. O que precisa
// valer em todas: as três opções com alvos amplos e o MESMO peso visual, o
// breadcrumb ocupando pouco espaço, e nada de rolagem lateral.

import { expect, test, type Page } from "@playwright/test";
import { entrarComo, semear, type Semente } from "./helpers";
import {
  confirmarOpcao,
  criarNivel,
  iniciarConversaPorOpcoes,
  opcao,
} from "./option-conversation-helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

async function ateSegundoNivel(page: Page, patientId: number) {
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
}

const TELAS = [
  { nome: "celular", width: 390, height: 844 },
  { nome: "tablet retrato", width: 810, height: 1080 },
  { nome: "tablet paisagem", width: 1080, height: 810 },
  { nome: "desktop", width: 1280, height: 800 },
];

for (const tela of TELAS) {
  test(`${tela.nome}: opções amplas e iguais, breadcrumb discreto, sem rolagem lateral`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: tela.width, height: tela.height });
    await ateSegundoNivel(page, dados.pacienteId);

    // Sem rolagem lateral em nenhuma largura.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    );
    expect(overflow, "a página não pode rolar lateralmente").toBe(false);

    // As três opções: alvos amplos e do MESMO tamanho — nenhuma pode parecer
    // mais recomendada que outra (§4, §35).
    const caixas = await Promise.all(
      ["DOR", "MEDICAÇÃO", "CONSULTA"].map((l) =>
        opcao(page, l).boundingBox()
      )
    );
    for (const caixa of caixas) {
      expect(caixa).not.toBeNull();
      expect(caixa!.height).toBeGreaterThanOrEqual(44);
      expect(caixa!.width).toBeGreaterThanOrEqual(44);
    }
    const larguras = caixas.map((c) => Math.round(c!.width));
    const alturas = caixas.map((c) => Math.round(c!.height));
    expect(Math.max(...larguras) - Math.min(...larguras)).toBeLessThanOrEqual(2);
    expect(Math.max(...alturas) - Math.min(...alturas)).toBeLessThanOrEqual(2);

    // O breadcrumb existe e é discreto: nunca domina a tela do paciente.
    const trilha = page.getByRole("navigation", { name: "Caminho da conversa" });
    await expect(trilha).toBeVisible();
    const caixaTrilha = await trilha.boundingBox();
    expect(caixaTrilha!.height).toBeLessThan(tela.height * 0.25);
  });
}

test("as três opções são alcançáveis e operáveis por teclado", async ({
  page,
}) => {
  await ateSegundoNivel(page, dados.pacienteId);

  const primeira = opcao(page, "DOR");
  await primeira.focus();
  await expect(primeira).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(opcao(page, "MEDICAÇÃO")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(opcao(page, "CONSULTA")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByText("Opção observada: CONSULTA")).toBeVisible();
});

test("os atalhos 1/2/3 escolhem OPÇÃO 1, 2 e 3 — não SIM, TALVEZ e NÃO", async ({
  page,
}) => {
  await ateSegundoNivel(page, dados.pacienteId);
  // A segunda tecla escolhe a SEGUNDA OPÇÃO. Se ela ainda significasse
  // TALVEZ, este teste registraria outra coisa.
  await page.keyboard.press("2");
  await expect(page.getByText("Opção observada: MEDICAÇÃO")).toBeVisible();
});

test("a seleção não depende só de cor", async ({ page }) => {
  await ateSegundoNivel(page, dados.pacienteId);
  await opcao(page, "DOR").click();
  await expect(page.getByText("Opção observada: DOR")).toBeVisible();

  // Além do anel, uma marca textual e o estado ARIA.
  await expect(opcao(page, "DOR")).toHaveAttribute("aria-pressed", "true");
  await expect(opcao(page, "MEDICAÇÃO")).toHaveAttribute("aria-pressed", "false");
  await expect(opcao(page, "DOR").locator("text=✓")).toBeVisible();
});
