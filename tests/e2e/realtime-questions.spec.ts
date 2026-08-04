// ——— Testes de interface: Perguntas em tempo real (seção 20) ———
// Cobrem os casos 1 a 29. O caso 30 (preservação da tela Conversar) fica em
// conversa-regressao.spec.ts.

import { expect, test, type Page } from "@playwright/test";
import {
  abrirModo,
  entrarComo,
  pularContexto,
  semear,
  type Semente,
} from "./helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

// ——— Atalhos de fluxo ———

async function iniciarSessao(page: Page, patientId: number) {
  await abrirModo(page, patientId);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
  await pularContexto(page);
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
}

async function escrever(page: Page, texto: string) {
  await page.getByLabel("Pergunta para o paciente").fill(texto);
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
}

async function apresentar(page: Page, opcoes?: { sensivel?: boolean }) {
  if (opcoes?.sensivel) {
    await page
      .getByRole("checkbox", { name: /assunto sensível/i })
      .check();
  }
  await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
  await expect(
    page.getByRole("group", { name: "Respostas possíveis do paciente" })
  ).toBeVisible();
}

const resposta = (page: Page, nome: "SIM" | "TALVEZ" | "NÃO") =>
  page.getByRole("button", { name: new RegExp(`^${nome}:`) });

async function perguntaApresentada(
  page: Page,
  patientId: number,
  texto = "O senhor está com sede?",
  opcoes?: { sensivel?: boolean }
) {
  await iniciarSessao(page, patientId);
  await escrever(page, texto);
  await apresentar(page, opcoes);
}

// ════ 1–3. Acesso, início e retomada ════

test("1. o modo é alcançável pela tela Conversar", async ({ page }) => {
  await page.addInitScript((id) => {
    window.localStorage.setItem("helo.patientId", String(id));
  }, dados.pacienteId);
  await page.goto("/conversa");
  const entrada = page.getByRole("link", { name: "Perguntas em tempo real" });
  await expect(entrada).toBeVisible();
  await entrada.click();
  await expect(
    page.getByRole("heading", { name: "Perguntas em tempo real" })
  ).toBeVisible();
  // O fluxo guiado continua existindo, não foi substituído.
  await page.goBack();
  await expect(page.getByRole("button", { name: "Começar" })).toBeVisible();
});

test("2. inicia uma sessão", async ({ page }) => {
  await iniciarSessao(page, dados.pacienteId);
  await expect(page.getByRole("button", { name: "⏸ Pausar sessão" })).toBeVisible();
});

test("3. retoma uma sessão pausada, com a resposta provisória ainda provisória", async ({
  page,
}) => {
  await perguntaApresentada(page, dados.pacienteId);
  await resposta(page, "SIM").click();
  await expect(page.getByText("Resposta observada: SIM")).toBeVisible();

  await page.getByRole("button", { name: "⏸ Pausar sessão" }).click();
  await expect(page.getByText("Sessão pausada")).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();

  // Volta como PROVISÓRIA: os botões de decisão continuam disponíveis.
  await expect(page.getByText("Resposta observada: SIM")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirmar" })).toBeVisible();
  await expect(page.getByText("Resposta confirmada")).toHaveCount(0);
});

// ════ 4–7. Pergunta: criar, revisar, cancelar, apresentar ════

test("4. cria a pergunta manualmente, com contador e bloqueio de vazio", async ({
  page,
}) => {
  await iniciarSessao(page, dados.pacienteId);
  const continuar = page.getByRole("button", { name: "Continuar" });
  await expect(continuar).toBeDisabled();
  await expect(page.getByText("0 / 500")).toBeVisible();

  // Só espaço em branco também é pergunta vazia.
  await page.getByLabel("Pergunta para o paciente").fill("    ");
  await expect(continuar).toBeDisabled();

  await page.getByLabel("Pergunta para o paciente").fill("O senhor está com dor?");
  await expect(page.getByText("22 / 500")).toBeVisible();
  await continuar.click();
  // Acentuação e pontuação preservadas.
  await expect(page.getByRole("blockquote")).toHaveText("O senhor está com dor?");
});

test("5. edita o texto durante a revisão", async ({ page }) => {
  await iniciarSessao(page, dados.pacienteId);
  await escrever(page, "O senhor está com sede?");
  // `exact`: a barra do contexto (Fase 4.8) traz o próprio lápis, com rótulo
  // "Editar o contexto da conversa". Aqui queremos o Editar DA REVISÃO.
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  await page.getByLabel("Pergunta para o paciente").fill("O senhor quer água?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("blockquote")).toHaveText("O senhor quer água?");
  await apresentar(page);
  await expect(
    page.getByRole("heading", { name: "O senhor quer água?" })
  ).toBeVisible();
});

test("6. cancela a pergunta antes de apresentar", async ({ page }) => {
  await iniciarSessao(page, dados.pacienteId);
  await escrever(page, "Pergunta a descartar");
  await page.getByRole("button", { name: "Cancelar pergunta" }).click();
  await page.getByRole("button", { name: "Cancelar pergunta" }).last().click();
  await expect(page.getByRole("button", { name: "Fazer nova pergunta" })).toBeVisible();
  await expect(page.getByText("Resultado: Pergunta cancelada")).toBeVisible();
});

test("7. apresenta a pergunta ao paciente", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId);
  await expect(
    page.getByRole("heading", { name: "O senhor está com sede?" })
  ).toBeVisible();
  // As três opções existem, com o mesmo papel e o mesmo peso.
  for (const nome of ["SIM", "TALVEZ", "NÃO"] as const) {
    await expect(resposta(page, nome)).toBeVisible();
  }
});

// ════ 8–13. Seleção, confirmação, correção, cancelamento ════

for (const [n, nome] of [
  [8, "SIM"],
  [9, "TALVEZ"],
  [10, "NÃO"],
] as const) {
  test(`${n}. seleção provisória de ${nome} não confirma sozinha`, async ({ page }) => {
    await perguntaApresentada(page, dados.pacienteId);
    await resposta(page, nome).click();
    await expect(page.getByText(`Resposta observada: ${nome}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirmar" })).toBeVisible();
    await expect(page.getByText(/Resposta confirmada:/)).toHaveCount(0);
  });
}

test("11. confirma a resposta observada", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId);
  await resposta(page, "SIM").click();
  await page.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByText("Resposta confirmada: SIM")).toBeVisible();
  await expect(page.getByRole("button", { name: "Fazer nova pergunta" })).toBeVisible();
});

test("12. corrige a seleção e preserva a anterior no histórico", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId);
  await resposta(page, "SIM").click();
  await page.getByRole("button", { name: "Corrigir" }).click();
  await resposta(page, "NÃO").click();
  await expect(page.getByText("Resposta observada: NÃO")).toBeVisible();

  await page.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByText("Resposta confirmada: NÃO")).toBeVisible();

  await page.getByText(/Histórico da sessão/).click();
  await expect(page.getByText("1 correção")).toBeVisible();

  // A trilha guardou o valor anterior — nada foi sobrescrito.
  const eventos = await page.request
    .get(
      `/api/realtime-questions/events?patientId=${dados.pacienteId}&sessionId=${await sessionIdAtual(page)}`
    )
    .then((r) => r.json());
  const mudanca = eventos.events.find(
    (e: { eventType: string }) => e.eventType === "RESPONSE_CHANGED"
  );
  expect(mudanca?.previousValue?.provisionalResponse).toBe("YES");
  expect(mudanca?.newValue?.provisionalResponse).toBe("NO");
});

test("13. cancela a seleção e volta a aguardar resposta", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId);
  await resposta(page, "TALVEZ").click();
  await page.getByRole("button", { name: "Cancelar seleção" }).click();
  await expect(page.getByText(/Resposta observada:/)).toHaveCount(0);
  await expect(resposta(page, "SIM")).toBeEnabled();
});

// ════ 14–17. Gesto incerto, reapresentação, ausência ════

test("14. registra gesto incerto sem tratá-lo como resposta", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId);
  await page.getByRole("button", { name: "Não consegui identificar o gesto" }).click();
  await expect(page.getByText("Gesto incerto registrado")).toBeVisible();
  await expect(page.getByText(/Resposta observada:/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirmar" })).toHaveCount(0);
});

test("15. o gesto incerto volta a aguardar resposta", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId);
  await page.getByRole("button", { name: "Não consegui identificar o gesto" }).click();
  await page.getByRole("button", { name: "Aguardar novo gesto" }).click();
  await expect(resposta(page, "SIM")).toBeEnabled();
});

test("16. reapresenta a MESMA pergunta, no mesmo turno", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId);
  await page.getByRole("button", { name: "Reapresentar pergunta" }).click();
  await expect(
    page.getByRole("heading", { name: "O senhor está com sede?" })
  ).toBeVisible();
  await page.getByText(/Histórico da sessão/).click();
  // Uma única pergunta — reapresentar não cria outra.
  await expect(page.getByText("Histórico da sessão (1 pergunta)")).toBeVisible();
  await expect(page.getByText("1 reapresentação")).toBeVisible();
});

test("17. registra ausência de resposta, e ela nunca vira NÃO", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId);
  await page.getByRole("button", { name: "Registrar ausência de resposta" }).click();
  // Exige confirmação explícita do assistente.
  await expect(
    page.getByText(/não apresentou uma resposta identificável/)
  ).toBeVisible();
  await page.getByRole("button", { name: "Registrar ausência", exact: true }).click();

  await expect(page.getByText("Resultado: Sem resposta")).toBeVisible();
  await expect(page.getByText(/Resposta confirmada/)).toHaveCount(0);

  const turnos = await page.request
    .get(
      `/api/realtime-questions/turns?patientId=${dados.pacienteId}&sessionId=${await sessionIdAtual(page)}`
    )
    .then((r) => r.json());
  expect(turnos.turns[0].status).toBe("NO_RESPONSE");
  expect(turnos.turns[0].confirmedResponse).toBeNull();
});

// ════ 18–19. Pergunta sensível ════

test("18. pergunta sensível exige reconfirmação antes de confirmar", async ({
  page,
}) => {
  await perguntaApresentada(page, dados.pacienteId, "O senhor quer rever o testamento?", {
    sensivel: true,
  });
  await resposta(page, "SIM").click();
  await page.getByRole("button", { name: "Confirmar" }).click();

  // A confirmação do assistente NÃO conclui: entra a reconfirmação.
  await expect(page.getByText("Assunto sensível — reconfirmação")).toBeVisible();
  await expect(page.getByText("A resposta observada foi SIM.")).toBeVisible();
  await expect(page.getByText(/Resposta confirmada:/)).toHaveCount(0);
});

test("19. a reconfirmação conclui a pergunta sensível", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId, "O senhor quer rever o testamento?", {
    sensivel: true,
  });
  await resposta(page, "SIM").click();
  await page.getByRole("button", { name: "Confirmar" }).click();
  await page.getByRole("button", { name: "Resposta reconfirmada" }).click();
  await expect(page.getByText("Resposta confirmada: SIM")).toBeVisible();

  // "Não foi possível reconfirmar" NÃO confirma nada.
  await page.getByRole("button", { name: "Fazer nova pergunta" }).click();
  await escrever(page, "O senhor quer falar da herança?");
  await apresentar(page, { sensivel: true });
  await resposta(page, "TALVEZ").click();
  await page.getByRole("button", { name: "Confirmar" }).click();
  await page.getByRole("button", { name: "Não foi possível reconfirmar" }).click();
  await expect(page.getByText("Assunto sensível — reconfirmação")).toHaveCount(0);
  await expect(resposta(page, "SIM")).toBeEnabled();
});

// ════ 20–23. Pausa, retomada, conclusão, abandono ════

test("20. pausa bloqueia novas respostas", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId);
  await page.getByRole("button", { name: "⏸ Pausar sessão" }).click();
  await expect(page.getByText("Sessão pausada")).toBeVisible();
  await expect(resposta(page, "SIM")).toHaveCount(0);
});

test("21. retoma a sessão pausada e volta a aceitar resposta", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId);
  await page.getByRole("button", { name: "⏸ Pausar sessão" }).click();
  await page.getByRole("button", { name: "▶ Retomar sessão" }).click();
  await resposta(page, "SIM").click();
  await expect(page.getByText("Resposta observada: SIM")).toBeVisible();
});

test("22. conclui a sessão; pergunta aberta vira 'sem resposta', nunca NÃO", async ({
  page,
}) => {
  await perguntaApresentada(page, dados.pacienteId);
  await page.getByRole("button", { name: "Encerrar sessão" }).click();
  await page.getByRole("button", { name: "Concluir sessão" }).click();
  // A sessão encerrada mostra o resumo antes de o assistente voltar.
  await expect(page.getByText("Sessão concluída")).toBeVisible();

  const sessoes = await page.request
    .get(`/api/realtime-questions/sessions?patientId=${dados.pacienteId}`)
    .then((r) => r.json());
  expect(sessoes.sessions[0].status).toBe("COMPLETED");
  const turnos = await page.request
    .get(
      `/api/realtime-questions/turns?patientId=${dados.pacienteId}&sessionId=${sessoes.sessions[0].id}`
    )
    .then((r) => r.json());
  expect(turnos.turns[0].status).toBe("NO_RESPONSE");
  expect(turnos.turns[0].confirmedResponse).toBeNull();
});

test("23. abandona a sessão, com confirmação explícita, e ela não vira concluída", async ({
  page,
}) => {
  await perguntaApresentada(page, dados.pacienteId);
  await page.getByRole("button", { name: "Encerrar sessão" }).click();
  await page.getByRole("button", { name: "Abandonar sessão" }).click();
  // Segunda confirmação, explícita.
  await expect(page.getByText(/Abandonar a sessão\?/)).toBeVisible();
  await page.getByRole("button", { name: "Abandonar sessão" }).last().click();
  // Abandonada nunca é apresentada como concluída.
  await expect(page.getByText("Sessão abandonada")).toBeVisible();
  await expect(page.getByText("Sessão concluída")).toHaveCount(0);

  const sessoes = await page.request
    .get(`/api/realtime-questions/sessions?patientId=${dados.pacienteId}`)
    .then((r) => r.json());
  expect(sessoes.sessions[0].status).toBe("ABANDONED");
  // O turno aberto continua aberto — abandono não fecha nada.
  const turnos = await page.request
    .get(
      `/api/realtime-questions/turns?patientId=${dados.pacienteId}&sessionId=${sessoes.sessions[0].id}`
    )
    .then((r) => r.json());
  expect(turnos.turns[0].status).toBe("AWAITING_RESPONSE");
  expect(turnos.turns[0].confirmedResponse).toBeNull();
});

// ════ 24–25. Saída ════

test("24. sessão vazia sai sem modal e é descartada", async ({ page }) => {
  await iniciarSessao(page, dados.pacienteId);
  await page.getByRole("button", { name: "Encerrar sessão" }).click();
  // Sem nenhuma pergunta não há o que decidir — nenhum modal aparece.
  await expect(page.getByText("O que deseja fazer com esta sessão?")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Perguntas em tempo real" })
  ).toBeVisible();
  const sessoes = await page.request
    .get(`/api/realtime-questions/sessions?patientId=${dados.pacienteId}`)
    .then((r) => r.json());
  expect(sessoes.sessions[0].status).toBe("ABANDONED");
});

test("25. sair com sessão ativa oferece as quatro saídas", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId);
  await page.getByRole("button", { name: "Encerrar sessão" }).click();
  await expect(page.getByText("O que deseja fazer com esta sessão?")).toBeVisible();
  for (const acao of [
    "Continuar sessão",
    "Pausar para retomar depois",
    "Concluir sessão",
    "Abandonar sessão",
  ]) {
    await expect(page.getByRole("button", { name: acao })).toBeVisible();
  }
  // "Continuar sessão" apenas fecha o modal.
  await page.getByRole("button", { name: "Continuar sessão" }).click();
  await expect(page.getByText("O que deseja fazer com esta sessão?")).toHaveCount(0);
  await expect(resposta(page, "SIM")).toBeEnabled();
});

// ════ 26–28. Falhas ════

test("26. falha de persistência não cria resposta falsa e preserva o texto", async ({
  page,
}) => {
  await iniciarSessao(page, dados.pacienteId);
  await page.route("**/api/realtime-questions/turns", (route) =>
    route.fulfill({ status: 500, body: "{}" })
  );
  await page.getByLabel("Pergunta para o paciente").fill("Pergunta que não salva");
  await page.getByRole("button", { name: "Continuar" }).click();

  await expect(page.getByRole("alert").filter({ hasText: "⚠" })).toContainText("não foi concluído");
  // O texto digitado continua no campo.
  await expect(page.getByLabel("Pergunta para o paciente")).toHaveValue(
    "Pergunta que não salva"
  );
  // Nenhum código técnico na mensagem.
  await expect(page.getByRole("alert").filter({ hasText: "⚠" })).not.toContainText(/500|HTTP|Error/);

  // Restabelecida a rota, "Tentar novamente" conclui o registro.
  await page.unroute("**/api/realtime-questions/turns");
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
});

test("27. perda de conexão guarda no aparelho sem assumir que o servidor salvou", async ({
  page,
}) => {
  // Este teste MUDOU na Fase 4.9.2, e a mudança é o ponto da fase.
  //
  // Antes, uma resposta observada com a rede fora era PERDIDA, e a tela dizia
  // "Sem conexão. O registro não foi salvo." — verdade na época. Agora ela é
  // guardada neste aparelho, cifrada, e sobrevive a um refresh; dizer que não
  // foi salva passou a ser falso.
  //
  // O que NÃO mudou, e é o que este teste continua guardando: a resposta não é
  // tratada como confirmada. Salvar localmente não é confirmar pelo paciente.
  await perguntaApresentada(page, dados.pacienteId);
  await page.route("**/api/realtime-questions/turns", (route) => route.abort());
  await resposta(page, "SIM").click();

  // O gesto observado aparece — o cuidador registrou o que viu.
  await expect(page.getByText("Resposta observada: SIM")).toBeVisible();
  // A confirmação, não: ela depende do servidor.
  await expect(page.getByText(/Resposta confirmada/)).toHaveCount(0);

  // O registro está mesmo neste aparelho. Conferimos no banco local, e não pela
  // faixa: com a pergunta em PROVISIONAL_RESPONSE o palco ainda é do PACIENTE,
  // e a faixa é do cuidador — ela fica escondida aqui, e é isso que se espera.
  const guardadas = await page.evaluate(async () => {
    const banco = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("helo-offline");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<number>((res) => {
      const r = banco
        .transaction("operacoes", "readonly")
        .objectStore("operacoes")
        .count();
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(-1);
    });
  });
  expect(guardadas).toBeGreaterThan(0);
  await expect(page.getByTestId("offline-chip")).toBeHidden();
});

test("28. duplo clique em Confirmar registra uma única vez", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId);
  await resposta(page, "SIM").click();

  let chamadas = 0;
  await page.route("**/api/realtime-questions/turns", async (route) => {
    if (route.request().method() === "PATCH") chamadas += 1;
    await route.continue();
  });

  const confirmar = page.getByRole("button", { name: "Confirmar" });
  await Promise.all([
    confirmar.click({ force: true }),
    confirmar.click({ force: true }),
  ]);
  await expect(page.getByText("Resposta confirmada: SIM")).toBeVisible();
  expect(chamadas).toBe(1);
});

// ════ 29. Restauração após atualização da página ════

test("29. atualizar a página restaura a sessão e o turno em curso", async ({ page }) => {
  await perguntaApresentada(page, dados.pacienteId);
  await resposta(page, "TALVEZ").click();
  await expect(page.getByText("Resposta observada: TALVEZ")).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();

  await expect(
    page.getByRole("heading", { name: "O senhor está com sede?" })
  ).toBeVisible();
  await expect(page.getByText("Resposta observada: TALVEZ")).toBeVisible();
});

// ——— Utilitário ———

async function sessionIdAtual(page: Page): Promise<string> {
  const sessoes = await page.request
    .get(`/api/realtime-questions/sessions?patientId=${dados.pacienteId}`)
    .then((r) => r.json());
  return sessoes.sessions[0].id as string;
}
