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

/** A rota que nasce uma sessão. É por ela que a sincronização se ancora. */
export const ROTA_CRIAR_SESSAO = "/api/realtime-questions/sessions";

/**
 * Clica em "Iniciar nova sessão" e espera o request que isso dispara.
 *
 * Sincronizar aqui, e não na tela seguinte, é o ponto. O clique dispara
 * `startNew()`, que faz `POST /api/realtime-questions/sessions`; só quando essa
 * resposta volta é que o React monta a tela de contexto. Quem esperasse apenas
 * o heading aparecer estaria pagando, dentro do orçamento de 10s de um
 * `expect` visual, por quatro coisas de naturezas diferentes: a compilação sob
 * demanda do route handler em modo dev, o POST, o emulador e a renderização.
 * As três primeiras não são renderização — e eram elas que estouravam.
 *
 * A espera é registrada ANTES do clique de propósito: registrá-la depois seria
 * uma corrida, porque a resposta pode chegar antes de a espera existir.
 *
 * São DUAS fronteiras, e elas não se confundem:
 *
 *   BOTÃO HABILITADO  → o clique pode funcionar.
 *   POST RESPONDIDO   → a sessão foi criada de verdade.
 *
 * A primeira existe porque `/conversa/perguntas` é pré-renderizada: em build
 * de produção o HTML chega pronto, com o heading e com o botão, antes de o
 * React hidratar. Esperar o heading não prova nada — ele está no HTML estático.
 * O que prova é o botão HABILITADO: ele nasce `disabled` no HTML e só libera
 * quando o cliente já leu o paciente ativo, o que só acontece depois da
 * hidratação. É um sinal que a própria tela já dá; não foi preciso instrumentar
 * o produto para obtê-lo.
 *
 * Um clique só, e depois do sinal. Nunca clicar de novo "porque não veio o
 * POST": sob rede ou CPU incomuns isso criaria duas sessões.
 *
 * O que fica para o `expect` visual seguinte é só o que ele sabe medir: estado
 * de React e renderização. Nada de `networkidle`, nada de espera por tempo —
 * o que se espera é este request, identificado por método e caminho.
 */
export async function iniciarNovaSessao(page: Page): Promise<void> {
  const botao = page.getByRole("button", { name: "Iniciar nova sessão" });
  await expect(botao).toBeEnabled();

  const resposta = page.waitForResponse((r) => {
    if (r.request().method() !== "POST") return false;
    return new URL(r.url()).pathname === ROTA_CRIAR_SESSAO;
  });

  await botao.click();

  const r = await resposta;
  // Falhar aqui, e não depois em "o heading não apareceu": um 4xx/5xx é um
  // defeito de API, e o erro deve dizer isso. Método, caminho e status bastam
  // — nada do corpo entra na mensagem, que pode carregar dado clínico.
  expect(
    r.ok(),
    `POST ${ROTA_CRIAR_SESSAO} respondeu ${r.status()}`
  ).toBeTruthy();
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
