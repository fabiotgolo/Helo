// ——— Preparo dos testes de interface ———
// Mesma abordagem dos scripts scripts/test-*.mjs: limpa o emulador e semeia
// admin, assistente, pacientes e vínculos pelas rotas de API. A autenticação
// é feita por requisição (nunca digitando senha em formulário), e o cookie
// resultante é injetado no contexto do navegador.

import { expect, type APIRequestContext, type Page } from "@playwright/test";

const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";

export const SENHA = "senha-e2e-123";

export interface Semente {
  assistente: { id: string; email: string };
  outroAssistente: { id: string; email: string };
  /** Autenticado, porém sem vínculo com nenhum paciente. */
  semVinculo: { id: string; email: string };
  pacienteId: number;
  outroPacienteId: number;
}

const PERMISSOES = [
  "viewDashboard",
  "viewSessions",
  "viewMetrics",
  "createSession",
  "editGestures",
];

/** Limpa o emulador. Falhar aqui aborta: nunca rodamos sobre dado alheio. */
export async function limparEmulador(api: APIRequestContext): Promise<void> {
  const r = await api.delete(
    `http://${EMU}/emulator/v1/projects/${PROJECT}/databases/${DB}/documents`
  );
  expect(r.ok(), "emulador do Firestore precisa estar no ar").toBeTruthy();
}

export async function semear(api: APIRequestContext): Promise<Semente> {
  await limparEmulador(api);

  await api.post("/api/auth/bootstrap", {
    data: { name: "Admin", email: "admin@helo.e2e", password: "senha-admin-e2e" },
  });

  const criarUsuario = async (name: string, email: string) => {
    const r = await api.post("/api/admin/users", {
      data: {
        name,
        email,
        password: SENHA,
        role: "profissional",
        professionalType: "fonoaudiologo",
      },
    });
    expect(r.ok(), `criar usuário ${name}`).toBeTruthy();
    return (await r.json()).user as { id: string };
  };

  const claudia = await criarUsuario("Claudia", "claudia@helo.e2e");
  const marcos = await criarUsuario("Marcos", "marcos@helo.e2e");
  const sofia = await criarUsuario("Sofia", "sofia@helo.e2e");

  const criarPaciente = async (name: string) => {
    const r = await api.post("/api/patients", { data: { name } });
    expect(r.ok(), `criar paciente ${name}`).toBeTruthy();
    return (await r.json()).patient.id as number;
  };
  const pacienteId = await criarPaciente("Dr. Fábio");
  // ids derivam de Date.now(): um respiro evita colisão.
  await new Promise((r) => setTimeout(r, 8));
  const outroPacienteId = await criarPaciente("Sr. Roberto");

  for (const [user, patientId] of [
    [claudia, pacienteId],
    [marcos, outroPacienteId],
  ] as const) {
    const r = await api.post("/api/admin/access", {
      data: { userId: user.id, patientId, permissions: PERMISSOES },
    });
    expect(r.ok(), "criar vínculo").toBeTruthy();
  }

  return {
    assistente: { id: claudia.id, email: "claudia@helo.e2e" },
    outroAssistente: { id: marcos.id, email: "marcos@helo.e2e" },
    // Sofia fica sem nenhum vínculo de propósito: é ela quem prova que o
    // modo não inicia sem paciente definido.
    semVinculo: { id: sofia.id, email: "sofia@helo.e2e" },
    pacienteId,
    outroPacienteId,
  };
}

/**
 * Autentica pela rota de login e injeta o cookie de sessão no navegador.
 * Nenhuma senha é digitada em formulário — o teste exercita o recurso, não a
 * tela de login (que já tem cobertura própria em scripts/test-access.mjs).
 */
export async function entrarComo(page: Page, email: string): Promise<void> {
  const resposta = await page.request.post("/api/auth/login", {
    data: { email, password: SENHA },
  });
  expect(resposta.ok(), `login de ${email}`).toBeTruthy();
  const cookies = await page.request.storageState();
  await page.context().addCookies(cookies.cookies);
}

/** Garante que o paciente ativo do provider é o do teste. */
export async function selecionarPaciente(
  page: Page,
  patientId: number
): Promise<void> {
  // ACTIVE_PATIENT_KEY, de lib/patient.tsx — o provider lê daqui na montagem.
  await page.addInitScript((id) => {
    window.localStorage.setItem("helo.patientId", String(id));
  }, patientId);
}

/** Abre o modo já autenticado e com o paciente ativo definido. */
export async function abrirModo(
  page: Page,
  patientId: number
): Promise<void> {
  await selecionarPaciente(page, patientId);
  await page.goto("/conversa/perguntas");
  await expect(
    page.getByRole("heading", { name: "Perguntas em tempo real" })
  ).toBeVisible();
}

/**
 * Pula o contexto da conversa (Fase 4.8).
 *
 * O contexto é uma etapa opcional que antecede a sessão: preencher ou começar
 * sem. A maior parte dos testes não é sobre ele, e "Começar sem contexto" é o
 * caminho de um clique que uma conversa urgente usaria — então é o que estes
 * testes percorrem. Quem testa o contexto em si o preenche explicitamente.
 */
export async function pularContexto(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Contexto da conversa (opcional)" })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Começar sem contexto" })
    .first()
    .click();
}
