// ——— Controles do paciente: responsividade e acessibilidade (Fase 4.7) ———
// O painel é operado à beira do leito, em tablet. Os três comandos são alvos
// de toque do PACIENTE — se um deles for menor, mais estreito ou depender de
// cor, o comando errado é registrado.
//
// O sufixo `responsivo.spec.ts` é o que faz este arquivo rodar também no
// projeto `tablet` (ver playwright.config.ts).

import { expect, test, type Page } from "@playwright/test";
import { abrirModo, entrarComo, iniciarNovaSessao, pularContexto, semear, type Semente } from "./helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

const painel = (page: Page) =>
  page.getByRole("dialog", { name: "Controles do paciente" });

const comando = (page: Page, nome: string) =>
  page.getByRole("button", { name: new RegExp(`^${nome}:`) });

async function painelApresentado(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await iniciarNovaSessao(page);
  await pularContexto(page);
  await page.getByLabel("Pergunta para o paciente").fill("O senhor está com sede?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await page.getByRole("button", { name: "Controles do paciente" }).click();
  await expect(painel(page)).toBeVisible();
  await page.getByRole("button", { name: "Apresentar os controles" }).click();
  await expect(comando(page, "PAUSAR")).toBeVisible();
}

const TAMANHOS = [
  { nome: "celular", width: 390, height: 844 },
  { nome: "tablet retrato", width: 810, height: 1080 },
  { nome: "tablet paisagem", width: 1080, height: 810 },
  { nome: "desktop", width: 1280, height: 800 },
];

for (const { nome, width, height } of TAMANHOS) {
  test(`${nome}: comandos amplos e iguais, sem rolagem lateral`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await painelApresentado(page);

    const caixas = [];
    for (const c of ["PAUSAR", "REPETIR", "MAIS CONTROLES"]) {
      const box = await comando(page, c).boundingBox();
      expect(box, `${c} precisa estar visível`).not.toBeNull();
      caixas.push(box!);
    }

    // WCAG: alvo de toque nunca abaixo de 44px.
    for (const box of caixas) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }

    // Os três comandos têm o MESMO peso visual: nenhum é mais fácil de acertar.
    const larguras = caixas.map((b) => b.width);
    const alturas = caixas.map((b) => b.height);
    expect(Math.max(...larguras) - Math.min(...larguras)).toBeLessThanOrEqual(2);
    expect(Math.max(...alturas) - Math.min(...alturas)).toBeLessThanOrEqual(2);

    const rolaLado = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    );
    expect(rolaLado).toBe(false);
  });
}

test("os comandos são alcançáveis e operáveis por teclado", async ({ page }) => {
  await painelApresentado(page);
  await page.getByRole("button", { name: "Aguardar o gesto do paciente" }).click();
  // Espera determinística: só depois que o painel confirma que aguarda o gesto
  // o foco para de ser roubado pelo re-render vindo do servidor.
  await expect(
    painel(page).getByText(/Toque no controle que corresponde ao gesto/)
  ).toBeVisible();

  await comando(page, "PAUSAR").focus();
  await expect(comando(page, "PAUSAR")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(comando(page, "REPETIR")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(comando(page, "MAIS CONTROLES")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(painel(page).getByText(/Comando observado:/)).toBeVisible();
});

test("a seleção não depende só de cor", async ({ page }) => {
  await painelApresentado(page);
  await page.getByRole("button", { name: "Aguardar o gesto do paciente" }).click();
  await comando(page, "REPETIR").click();

  // Estado no atributo E um marcador visível — nunca só a cor.
  await expect(comando(page, "REPETIR")).toHaveAttribute("aria-pressed", "true");
  await expect(comando(page, "PAUSAR")).toHaveAttribute("aria-pressed", "false");
  await expect(comando(page, "REPETIR")).toContainText("✓");
});

test("o painel não esconde permanentemente a conversa", async ({ page }) => {
  await page.setViewportSize({ width: 810, height: 1080 });
  await painelApresentado(page);
  // A pergunta do paciente continua legível com o painel aberto.
  await expect(page.getByText("O senhor está com sede?").first()).toBeVisible();
  const alturaPainel = (await painel(page).boundingBox())!.height;
  expect(alturaPainel).toBeLessThan(1080 * 0.75);
});
