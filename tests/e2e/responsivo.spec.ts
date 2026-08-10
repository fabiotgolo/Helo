// ——— Responsividade e acessibilidade em tablet ———
// O modo é operado à beira do leito, em tablet, nas duas orientações. A
// leitura da pergunta e os alvos de toque não podem depender do desktop.

import { expect, test } from "@playwright/test";
import { abrirModo, entrarComo, iniciarNovaSessao, pularContexto, semear, type Semente } from "./helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

async function apresentarPergunta(page: import("@playwright/test").Page) {
  await abrirModo(page, dados.pacienteId);
  await iniciarNovaSessao(page);
  await pularContexto(page);
  await page.getByLabel("Pergunta para o paciente").fill("O senhor está com sede?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await expect(
    page.getByRole("group", { name: "Respostas possíveis do paciente" })
  ).toBeVisible();
}

for (const [nome, largura, altura] of [
  ["retrato", 810, 1080],
  ["paisagem", 1080, 810],
] as const) {
  test(`tablet em ${nome}: pergunta legível, alvos amplos, sem rolagem lateral`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: largura, height: altura });
    await apresentarPergunta(page);

    // Nada transborda na horizontal.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow, "a página não pode rolar na horizontal").toBe(false);

    // As três respostas têm alvo confortável e o MESMO tamanho — nenhuma
    // ganha destaque por dimensão.
    const caixas = [];
    for (const rotulo of ["SIM", "TALVEZ", "NÃO"]) {
      const botao = page.getByRole("button", { name: new RegExp(`^${rotulo}:`) });
      const caixa = await botao.boundingBox();
      expect(caixa, `${rotulo} precisa estar visível`).not.toBeNull();
      expect(caixa!.height).toBeGreaterThanOrEqual(44);
      expect(caixa!.width).toBeGreaterThanOrEqual(44);
      caixas.push(caixa!);
    }
    const larguras = caixas.map((c) => Math.round(c.width));
    expect(Math.max(...larguras) - Math.min(...larguras)).toBeLessThanOrEqual(2);

    // A pergunta é o elemento dominante da tela.
    const tamanho = await page
      .getByRole("heading", { name: "O senhor está com sede?" })
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(tamanho).toBeGreaterThanOrEqual(30);
  });
}

test("as três respostas são alcançáveis e operáveis por teclado", async ({ page }) => {
  await apresentarPergunta(page);
  const sim = page.getByRole("button", { name: /^SIM:/ });
  // Chegar por Tab (e não por focus programático) é o que ativa
  // :focus-visible — é assim que o operador de teclado realmente navega.
  for (let i = 0; i < 40 && !(await sim.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(sim).toBeFocused();
  const contorno = await sim.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(contorno, "o foco precisa ser visível").not.toBe("none");

  await page.keyboard.press("Enter");
  await expect(page.getByText("Resposta observada: SIM")).toBeVisible();
});

test("os atalhos 1/2/3 registram a resposta observada", async ({ page }) => {
  await apresentarPergunta(page);
  await page.keyboard.press("2");
  await expect(page.getByText("Resposta observada: TALVEZ")).toBeVisible();
});

test("a seleção não depende só de cor", async ({ page }) => {
  await apresentarPergunta(page);
  const sim = page.getByRole("button", { name: /^SIM:/ });
  await sim.click();
  // Estado exposto na semântica, além do visual.
  await expect(sim).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^NÃO:/ })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
});
