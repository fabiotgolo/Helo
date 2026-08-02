import { defineConfig, devices } from "@playwright/test";

// Testes de interface do Helo. Rodam contra o dev server + emulador do
// Firestore, NUNCA contra produção — o setup limpa o banco do emulador.
//
//   npm run emu                 (terminal 1)
//   npm run dev                 (terminal 2)
//   npm run test:ui             (terminal 3)
//
// A URL do app e a do emulador são configuráveis por variável de ambiente,
// para acompanhar a porta que o dev server estiver usando.

const BASE_URL = process.env.HELO_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  // O estado vive no emulador: dois arquivos em paralelo disputariam o mesmo
  // banco. Serial é a única forma honesta de testar persistência aqui.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "line" : [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Tablet: o modo é operado à beira do leito. Rodamos sobre o mesmo
      // Chromium (viewport + toque de tablet) em vez do perfil WebKit do
      // iPad — um motor a menos para baixar, e o que se testa aqui é
      // layout e alvo de toque, não diferença de engine.
      name: "tablet",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 810, height: 1080 },
        hasTouch: true,
        isMobile: false,
      },
      testMatch: /responsivo\.spec\.ts/,
    },
  ],
});
