// ——— O efeito que chega depois que o mundo mudou (L1, L2, L3 — Fase 5.3C) ———
//
// A auditoria final das 25 ações executáveis pelo Agent encontrou três
// handlers que esperam POR DENTRO. O dispatcher protege até o COMEÇO do
// efeito; o que acontece depois de um `await` interno só o handler alcança, e
// nenhum dos três perguntava:
//
//   L1  conversa.comecar     → cria a sessão, e só então GRAVA e FALA
//   L2  routine.open.*       → garante a sessão, e só então GRAVA
//   L3  atividades.iniciar.* → cria a execução, e só então ABRE O PLAYER
//
// A suíte `test:agent:stale` prova o mecanismo compartilhado e a estrutura dos
// três handlers. O que ela não alcança é a tela: que a troca de paciente REAL,
// feita pelo seletor que o cuidador usa, derrube de fato a continuação — e que
// o produto continue funcionando quando ninguém troca nada.
//
// ——— Determinismo ———
//
// Nenhum destes testes tenta ganhar a corrida na sorte. A resposta do servidor
// é INTERCEPTADA e segurada: a requisição sai, o servidor responde, e a
// resposta fica presa até o teste soltá-la. A sequência é sempre a mesma:
//
//   1. o handler começa      2. a resposta fica pendente
//   3. o contexto muda       4. a resposta é liberada
//   5. asserção sobre o efeito tardio
//
// Cada cenário tem o seu controle positivo — o mesmo caminho sem a troca —
// porque uma correção que simplesmente matasse as três funcionalidades também
// passaria em todas as asserções negativas.

import { test, expect, type APIRequestContext, type Page, type Request } from "@playwright/test";
import { entrarComo, selecionarPaciente, semear, type Semente } from "./helpers";

const PERMISSOES_COM_ATIVIDADES = [
  "viewDashboard",
  "viewSessions",
  "viewMetrics",
  "createSession",
  "editGestures",
  "viewActivities",
  "runActivities",
];

let semente: Semente;

/**
 * Uma resposta presa. `chegou()` diz que a requisição já saiu e a continuação
 * está pendente; `liberar()` deixa a resposta chegar ao handler.
 */
function represa(page: Page, rota: string) {
  let solta: () => void = () => {};
  const preso = new Promise<void>((r) => {
    solta = r;
  });
  let vezes = 0;
  const instalada = page.route(rota, async (route) => {
    vezes += 1;
    // A requisição VAI ao servidor e volta: o efeito remoto acontece de
    // verdade, como aconteceria em produção. O que fica preso é só a entrega
    // ao handler — que é exatamente onde mora a janela.
    const resposta = await route.fetch();
    await preso;
    try {
      await route.fulfill({ response: resposta });
    } catch {
      // A página pode ter ido embora enquanto a resposta esperava (é o caso do
      // logout). Entregar a quem não existe mais não é erro do produto.
    }
  });
  return {
    instalada,
    chegou: () => vezes > 0,
    liberar: () => solta(),
  };
}

/** Espera a requisição sair, sem depender de tempo fixo. */
async function esperaPendente(barragem: { chegou: () => boolean }) {
  await expect.poll(() => barragem.chegou(), { timeout: 15_000 }).toBeTruthy();
}

/** Troca o paciente ativo pelo MESMO caminho da interface, sem sair da tela. */
async function trocaDePacienteNaTela(page: Page, nome: string) {
  await page.getByRole("button", { name: "Selecionar paciente" }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(nome) }).click();
}

/** O paciente ativo já chegou ao provider? É o que `authorizeTool` exige. */
async function esperaPacienteAtivo(page: Page): Promise<void> {
  await expect(
    page
      .getByText(/^Paciente: /)
      .or(page.getByRole("button", { name: "Selecionar paciente" }))
  ).toBeVisible();
}

/** Chama a client tool como o provedor chamaria. */
async function tool(
  page: Page,
  nome: string,
  parametros: Record<string, unknown>
): Promise<Record<string, unknown>> {
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as never as Record<string, unknown>).__heloAgentTool)
    )
    .toBe("function");
  const cru = await page.evaluate(
    async ([n, p]) =>
      (await (
        (window as never as Record<string, unknown>).__heloAgentTool as (
          a: string,
          b: unknown
        ) => Promise<string>
      )(n as string, p)) as string,
    [nome, parametros] as const
  );
  return JSON.parse(cru) as Record<string, unknown>;
}

/** Os ids de capacidade local da tela montada agora. */
async function acoesLocais(page: Page): Promise<string[]> {
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as never as Record<string, unknown>).__heloAgentContext
      )
    )
    .toBe("function");
  return page.evaluate(() => {
    const c = (
      (window as never as Record<string, unknown>).__heloAgentContext as () => {
        capabilities: { id: string; scope: string }[];
      }
    )();
    return c.capabilities.filter((x) => x.scope === "screen").map((x) => x.id);
  });
}

/**
 * Grava o que o navegador diz. Nesta suíte é prova melhor que contar
 * requisições de TTS: no ambiente de teste a ElevenLabs está indisponível de
 * propósito (chave inválida), e depois da primeira falha o cliente entra em
 * espera — a ausência de `/api/tts` diria mais sobre a espera do que sobre o
 * produto. O que interessa é se a TENTATIVA de falar na voz do paciente
 * chegou a existir.
 */
function escuta(page: Page): string[] {
  const linhas: string[] = [];
  page.on("console", (m) => linhas.push(m.text()));
  return linhas;
}

/** Grava as requisições que interessam à prova. */
function espia(page: Page, teste: (r: Request) => boolean): Request[] {
  const vistas: Request[] = [];
  page.on("request", (r) => {
    if (teste(r)) vistas.push(r);
  });
  return vistas;
}

const eventos = (r: Request) =>
  r.method() === "POST" && r.url().includes("/api/events");

test.beforeEach(async ({ request }) => {
  semente = await semear(request);
  // A mesma cuidadora, nos dois pacientes — é o que torna a troca possível sem
  // sair da tela, e é a situação real de quem cuida de mais de uma pessoa.
  for (const patientId of [semente.pacienteId, semente.outroPacienteId]) {
    const r = await request.post("/api/admin/access", {
      data: {
        userId: semente.assistente.id,
        patientId,
        permissions: PERMISSOES_COM_ATIVIDADES,
      },
    });
    expect(r.ok(), "vincular a cuidadora aos dois pacientes").toBeTruthy();
  }
});

// ————————————————————————————————————————————————————————————————
test.describe("L3 — a atividade do paciente anterior não abre no seguinte", () => {
  /** Uma atividade com um item, do paciente indicado. */
  async function criaAtividade(
    request: APIRequestContext,
    patientId: number,
    titulo: string
  ) {
    const r = await request.post("/api/activities", {
      data: {
        patientId,
        template: {
          title: titulo,
          category: "memorias",
          items: [{ title: "Primeiro", text: "Um item qualquer", question: "" }],
        },
      },
    });
    expect(r.ok(), `criar a atividade ${titulo}`).toBeTruthy();
  }

  test("1. trocar de paciente durante a criação da execução impede o player", async ({
    page,
    request,
  }) => {
    await criaAtividade(request, semente.pacienteId, "Memória do Dr. Fábio");

    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/atividades");
    await expect(page.getByRole("heading", { name: "Atividades" })).toBeVisible();
    await expect(page.getByText("Memória do Dr. Fábio")).toBeVisible();

    const barragem = represa(page, "**/api/activities/runs");
    await barragem.instalada;

    const alvo = (await acoesLocais(page)).find((id) => id.startsWith("atividades.iniciar."));
    expect(alvo, "a lista precisa oferecer a atividade").toBeTruthy();

    // 1 e 2: o handler começa e a resposta fica pendente.
    const pedido = tool(page, "interactWithHeloUI", { actionId: alvo });
    await esperaPendente(barragem);

    // 3: o cuidador troca de paciente, sem sair da tela.
    await trocaDePacienteNaTela(page, "Sr. Roberto");
    await expect(page.getByText("Memória do Dr. Fábio")).toBeHidden();

    // 4: a execução de A chega agora.
    barragem.liberar();
    await pedido;

    // 5: o player NÃO abre. A tela de B continua sendo a tela de B.
    await expect(page.getByRole("button", { name: "Menu de atividades" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Atividades" })).toBeVisible();
    // E nada do paciente anterior reaparece.
    await expect(page.getByText("Memória do Dr. Fábio")).toBeHidden();

    // Uma janela inteira depois, continua fechado: o efeito não estava só
    // atrasado.
    await page.waitForTimeout(1500);
    await expect(page.getByRole("button", { name: "Menu de atividades" })).toHaveCount(0);
  });

  test("2. controle positivo — sem troca, o player abre normalmente", async ({
    page,
    request,
  }) => {
    await criaAtividade(request, semente.pacienteId, "Memória do Dr. Fábio");

    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/atividades");
    await expect(page.getByText("Memória do Dr. Fábio")).toBeVisible();

    const barragem = represa(page, "**/api/activities/runs");
    await barragem.instalada;

    const alvo = (await acoesLocais(page)).find((id) => id.startsWith("atividades.iniciar."));
    const pedido = tool(page, "interactWithHeloUI", { actionId: alvo });
    await esperaPendente(barragem);

    // Mesmo caminho, mesma espera — só não muda o mundo.
    barragem.liberar();
    const r = await pedido;
    expect(r.ok).toBeTruthy();

    await expect(page.getByRole("button", { name: "Menu de atividades" })).toBeVisible();
  });

  test("3. o mesmo vale para o clique do cuidador", async ({ page, request }) => {
    // A corrida não é do Agent: ela é do tempo de rede, e o botão da tela
    // percorre exatamente o mesmo handler.
    await criaAtividade(request, semente.pacienteId, "Memória do Dr. Fábio");

    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/atividades");
    const cartao = page.getByRole("button", { name: /Memória do Dr\. Fábio/ }).first();
    await expect(cartao).toBeVisible();

    const barragem = represa(page, "**/api/activities/runs");
    await barragem.instalada;

    await cartao.click();
    await esperaPendente(barragem);

    await trocaDePacienteNaTela(page, "Sr. Roberto");
    barragem.liberar();
    await page.waitForTimeout(1500);

    await expect(page.getByRole("button", { name: "Menu de atividades" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Atividades" })).toBeVisible();
  });

  test("4. sair da conta durante a criação não deixa efeito atrás", async ({
    page,
    request,
  }) => {
    // O logout pedido no §8: a ação começa, a conta sai, a promessa é
    // liberada. Aqui a proteção não é a do lease — o logout leva a PÁGINA
    // inteira, e uma página nova é uma fronteira mais forte que a geração,
    // exatamente como a recarga em `agent-lifecycle`. O teste existe para
    // prender essa propriedade, não para atribuí-la ao mecanismo errado.
    await criaAtividade(request, semente.pacienteId, "Memória do Dr. Fábio");

    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/atividades");
    await expect(page.getByText("Memória do Dr. Fábio")).toBeVisible();

    const gravados = espia(page, eventos);
    const barragem = represa(page, "**/api/activities/runs");
    await barragem.instalada;

    const alvo = (await acoesLocais(page)).find((id) => id.startsWith("atividades.iniciar."));
    void tool(page, "interactWithHeloUI", { actionId: alvo }).catch(() => {});
    await esperaPendente(barragem);

    await page.getByRole("button", { name: /^Sair/ }).click();
    await expect(page).toHaveURL(/\/login/);

    barragem.liberar();
    await page.waitForTimeout(1500);

    await expect(page.getByRole("button", { name: "Menu de atividades" })).toHaveCount(0);
    expect(gravados, "nenhum registro depois da saída").toHaveLength(0);
  });
});

// ————————————————————————————————————————————————————————————————
test.describe("L1 — a conversa do paciente anterior não começa no seguinte", () => {
  test("5. trocar de paciente durante a criação da sessão não grava nem fala", async ({
    page,
  }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/conversa");
    // HABILITADO, não apenas visível: o botão só habilita quando o paciente
    // ativo chegou, e é esse o estado em que a ação existe para o Agent.
    await expect(page.getByRole("button", { name: "Começar" })).toBeEnabled();

    const gravados = espia(page, eventos);
    const dito = escuta(page);

    const barragem = represa(page, "**/api/sessions");
    await barragem.instalada;

    const pedido = tool(page, "interactWithHeloUI", { actionId: "conversa.comecar" });
    await esperaPendente(barragem);

    await trocaDePacienteNaTela(page, "Sr. Roberto");
    const marca = dito.length;
    barragem.liberar();
    await pedido;
    await page.waitForTimeout(1500);

    // Nada gravado, nada falado, e a tela não avançou de fase.
    expect(gravados, "nenhum evento tardio da conversa de A").toHaveLength(0);
    expect(
      dito.slice(marca).filter((l) => l.includes("platform speak requested")),
      "nenhuma fala tardia"
    ).toHaveLength(0);
    await expect(page.getByRole("button", { name: "Começar" })).toBeVisible();
  });

  test("6. controle positivo — sem troca, a conversa começa e registra", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/conversa");
    // HABILITADO, não apenas visível: o botão só habilita quando o paciente
    // ativo chegou, e é esse o estado em que a ação existe para o Agent.
    await expect(page.getByRole("button", { name: "Começar" })).toBeEnabled();

    const gravados = espia(page, eventos);

    const barragem = represa(page, "**/api/sessions");
    await barragem.instalada;
    const pedido = tool(page, "interactWithHeloUI", { actionId: "conversa.comecar" });
    await esperaPendente(barragem);
    barragem.liberar();
    const r = await pedido;
    expect(r.ok).toBeTruthy();

    // A conversa avançou: o botão de começar deu lugar à condução.
    await expect(page.getByRole("button", { name: "Começar" })).toBeHidden();
    await expect.poll(() => gravados.length, { timeout: 10_000 }).toBeGreaterThan(0);
  });
});

// ————————————————————————————————————————————————————————————————
test.describe("L2 — o card aberto para um paciente não registra no outro", () => {
  test("7. trocar de paciente durante a criação da sessão não grava", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/rotina");
    await expect(page.getByRole("heading", { name: "Rotina" })).toBeVisible();
    // O paciente ativo é a primeira exigência de `authorizeTool`, e a tela da
    // Rotina aparece antes dele. Esperar o seletor do cabeçalho é esperar
    // exatamente essa condição — nunca um tempo arbitrário.
    await esperaPacienteAtivo(page);

    const gravados = espia(page, eventos);

    const barragem = represa(page, "**/api/sessions");
    await barragem.instalada;

    const alvo = (await acoesLocais(page)).find((id) => id.startsWith("routine.open."));
    expect(alvo, "a Rotina precisa oferecer cards").toBeTruthy();

    const pedido = tool(page, "interactWithHeloUI", { actionId: alvo });
    await esperaPendente(barragem);

    await trocaDePacienteNaTela(page, "Sr. Roberto");
    barragem.liberar();
    await pedido;
    await page.waitForTimeout(1500);

    expect(gravados, "nenhum registro tardio do card de A").toHaveLength(0);
  });

  test("8. controle positivo — sem troca, abrir o card registra", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/rotina");
    await expect(page.getByRole("heading", { name: "Rotina" })).toBeVisible();
    // O paciente ativo é a primeira exigência de `authorizeTool`, e a tela da
    // Rotina aparece antes dele. Esperar o seletor do cabeçalho é esperar
    // exatamente essa condição — nunca um tempo arbitrário.
    await esperaPacienteAtivo(page);

    const gravados = espia(page, eventos);

    const barragem = represa(page, "**/api/sessions");
    await barragem.instalada;
    const alvo = (await acoesLocais(page)).find((id) => id.startsWith("routine.open."));
    const pedido = tool(page, "interactWithHeloUI", { actionId: alvo });
    await esperaPendente(barragem);
    barragem.liberar();
    const r = await pedido;
    expect(r.ok).toBeTruthy();

    await expect.poll(() => gravados.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Responder sim" })).toBeVisible();
  });

  test("9. a sessão de rotina não atravessa a troca de paciente", async ({ page }) => {
    // O defeito IRMÃO de L2, encontrado ao preparar o teste acima: `sessionRef`
    // é uma referência, e ela atravessava a troca. Com o contexto JÁ válido em
    // B, `ensureSession()` devolvia a sessão de A — nenhuma guarda de lease
    // pega isso, porque não há espera onde o mundo mude. A prova é a
    // requisição: abrir um card depois da troca precisa CRIAR uma sessão nova.
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/rotina");
    await expect(page.getByRole("heading", { name: "Rotina" })).toBeVisible();
    // O paciente ativo é a primeira exigência de `authorizeTool`, e a tela da
    // Rotina aparece antes dele. Esperar o seletor do cabeçalho é esperar
    // exatamente essa condição — nunca um tempo arbitrário.
    await esperaPacienteAtivo(page);

    const sessoes = espia(
      page,
      (r) => r.method() === "POST" && r.url().includes("/api/sessions")
    );

    const alvo = (await acoesLocais(page)).find((id) => id.startsWith("routine.open."));
    const primeiro = await tool(page, "interactWithHeloUI", { actionId: alvo });
    expect(primeiro.ok).toBeTruthy();
    await expect.poll(() => sessoes.length, { timeout: 10_000 }).toBe(1);

    await trocaDePacienteNaTela(page, "Sr. Roberto");
    // Volta ao menu para poder abrir outro card na tela do paciente novo.
    await tool(page, "interactWithHeloUI", { actionId: "routine.backToMenu" });

    const depois = (await acoesLocais(page)).find((id) => id.startsWith("routine.open."));
    expect(depois).toBeTruthy();
    const segundo = await tool(page, "interactWithHeloUI", { actionId: depois });
    expect(segundo.ok).toBeTruthy();

    // Sessão NOVA: a de B. Se a referência tivesse atravessado, esta segunda
    // requisição não existiria e o registro cairia na sessão de A.
    await expect
      .poll(() => sessoes.length, { timeout: 10_000 })
      .toBe(2);
  });
});

// ————————————————————————————————————————————————————————————————
// A conversa guiada pertence a UMA pessoa
//
// Diferente de L1/L2/L3, o defeito aqui não era uma janela pós-`await`: era
// estado de tela que simplesmente não dependia do paciente. A conversa de A —
// a fase, a pergunta, o contexto acumulado, a sessão, e a frase JÁ confirmada
// pronta para soar na voz do paciente — continuava apresentada com B na tela.
//
// A correção é a chave de remontagem, e por isso a prova é visual e por
// requisição: o que a tela mostra, e o que ela cria no servidor.
test.describe("A conversa não atravessa a troca de paciente", () => {
  const sessoesPost = (r: Request) =>
    r.method() === "POST" && r.url().includes("/api/sessions");
  const mensagens = (r: Request) =>
    r.method() === "POST" && r.url().includes("/api/messages");

  /** Entra em `/conversa` com A e começa a conversa. */
  async function conversaDeA(page: Page) {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/conversa");
    await expect(page.getByRole("heading", { name: "Iniciar conversa" })).toBeVisible();
    await expect(page.getByLabel("Conversa guiada").getByText("Dr. Fábio")).toBeVisible();
    await page.getByRole("button", { name: "Começar" }).click();
    await expect(
      page.getByRole("heading", { name: "O que você quer comunicar?" })
    ).toBeVisible();
  }

  test("10. trocar de paciente devolve a tela ao estado inicial do novo", async ({ page }) => {
    const sessoes = espia(page, sessoesPost);
    const criadas = espia(page, mensagens);
    const dito = escuta(page);

    await conversaDeA(page);
    await expect.poll(() => sessoes.length, { timeout: 10_000 }).toBe(1);

    // Aprofunda a conversa: agora existe contexto acumulado de A na tela.
    await page.getByRole("button", { name: /^Sim:/ }).first().click();
    await expect(
      page.getByRole("heading", { name: "Como você está se sentindo?" })
    ).toBeVisible();

    const antesDaTroca = dito.length;
    await trocaDePacienteNaTela(page, "Sr. Roberto");

    // A tela voltou ao estado inicial que ela já tinha — e é o de B.
    await expect(page.getByRole("heading", { name: "Iniciar conversa" })).toBeVisible();
    await expect(page.getByLabel("Conversa guiada").getByText("Sr. Roberto")).toBeVisible();
    await expect(page.getByLabel("Conversa guiada").getByText("Dr. Fábio")).toHaveCount(0);
    // Nada da conversa de A sobrou.
    await expect(
      page.getByRole("heading", { name: "Como você está se sentindo?" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "O que você quer comunicar?" })
    ).toHaveCount(0);
    // Nenhuma resposta foi criada, e nada tentou falar na voz do paciente.
    expect(criadas, "nenhuma mensagem persistida na troca").toHaveLength(0);
    expect(
      dito.slice(antesDaTroca).filter((l) => l.includes("[HELO VOICE] role patient")),
      "nenhuma fala do paciente depois da troca"
    ).toHaveLength(0);

    // B começa a conversa dele normalmente — e com uma sessão NOVA. Se o
    // sessionId de A tivesse atravessado, esta segunda criação não existiria.
    await page.getByRole("button", { name: "Começar" }).click();
    await expect(
      page.getByRole("heading", { name: "O que você quer comunicar?" })
    ).toBeVisible();
    await expect.poll(() => sessoes.length, { timeout: 10_000 }).toBe(2);
  });

  test("11. a gravação de A que chega depois da troca não faz a voz do paciente soar", async ({
    page,
  }) => {
    // O pior caso desta tela: a frase confirmada é registrada e SÓ ENTÃO
    // falada na voz do paciente (a ordem que a 5.1A inverteu de propósito).
    // Entre as duas coisas existe um round-trip — e é nele que o cuidador
    // pode trocar de paciente.
    const dito = escuta(page);
    const sessoes = espia(page, sessoesPost);

    await conversaDeA(page);
    // Até uma frase pronta: "Como estou me sentindo" → "Bem".
    await page.getByRole("button", { name: /^Sim:/ }).first().click();
    await expect(
      page.getByRole("heading", { name: "Como você está se sentindo?" })
    ).toBeVisible();

    const barragem = represa(page, "**/api/messages");
    await barragem.instalada;

    // "Bem" tem frase própria: a conversa chega à confirmação.
    await page.getByRole("button", { name: /^Sim:/ }).first().click();
    await expect(page.getByText("Estou me sentindo bem.")).toBeVisible();
    // O gesto de confirmação da pessoa: a partir daqui a gravação está em voo.
    await page.getByRole("button", { name: /^Sim:/ }).first().click();
    await esperaPendente(barragem);

    await trocaDePacienteNaTela(page, "Sr. Roberto");
    await expect(page.getByRole("heading", { name: "Iniciar conversa" })).toBeVisible();

    // A gravação de A chega agora.
    const marca = dito.length;
    barragem.liberar();
    await page.waitForTimeout(2000);
    const depois = dito.slice(marca);

    // A continuação nem TENTA falar: a guarda de contexto a para antes.
    expect(
      depois.filter((l) => l.includes("[HELO VOICE] role patient")),
      "nenhuma tentativa de falar na voz do paciente depois da troca"
    ).toHaveLength(0);
    // E a rede de segurança mais funda — a que já existia em `useSpeech`, e
    // que recusa fala do paciente fora do contexto ativo — não precisou
    // entrar em ação. Se um dia precisar, é porque a guarda de cima falhou.
    expect(
      depois.filter((l) => l.includes("fora do contexto ativo")),
      "a última linha de defesa não foi acionada"
    ).toHaveLength(0);
    // A tela não foi repovoada.
    await expect(page.getByRole("heading", { name: "Iniciar conversa" })).toBeVisible();
    await expect(page.getByLabel("Conversa guiada").getByText("Sr. Roberto")).toBeVisible();
    // E o estado de B é dele: a conversa dele nasce com sessão própria.
    const antes = sessoes.length;
    await page.getByRole("button", { name: "Começar" }).click();
    await expect(
      page.getByRole("heading", { name: "O que você quer comunicar?" })
    ).toBeVisible();
    await expect.poll(() => sessoes.length, { timeout: 10_000 }).toBe(antes + 1);
  });

  test("12. voltar para o primeiro paciente não mistura os dois", async ({ page }) => {
    const sessoes = espia(page, sessoesPost);

    await conversaDeA(page);
    await page.getByRole("button", { name: /^Sim:/ }).first().click();
    await expect(
      page.getByRole("heading", { name: "Como você está se sentindo?" })
    ).toBeVisible();

    await trocaDePacienteNaTela(page, "Sr. Roberto");
    await expect(page.getByRole("heading", { name: "Iniciar conversa" })).toBeVisible();
    await page.getByRole("button", { name: "Começar" }).click();
    await expect(
      page.getByRole("heading", { name: "O que você quer comunicar?" })
    ).toBeVisible();
    await page.getByRole("button", { name: /^Sim:/ }).first().click();
    await expect(
      page.getByRole("heading", { name: "Como você está se sentindo?" })
    ).toBeVisible();

    await trocaDePacienteNaTela(page, "Dr. Fábio");

    // A volta também é um começo limpo. Este teste NÃO exige retomada: o
    // produto não tem esse mecanismo hoje, e o requisito é isolamento, não
    // uma funcionalidade nova. O que ele exige é que nada de B esteja aqui.
    await expect(page.getByRole("heading", { name: "Iniciar conversa" })).toBeVisible();
    await expect(page.getByLabel("Conversa guiada").getByText("Dr. Fábio")).toBeVisible();
    await expect(page.getByLabel("Conversa guiada").getByText("Sr. Roberto")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Como você está se sentindo?" })
    ).toHaveCount(0);

    // E a conversa de A recomeça com sessão própria — a terceira.
    await page.getByRole("button", { name: "Começar" }).click();
    await expect(
      page.getByRole("heading", { name: "O que você quer comunicar?" })
    ).toBeVisible();
    await expect.poll(() => sessoes.length, { timeout: 10_000 }).toBe(3);

    // As sessões pertencem a quem as abriu: duas de A, uma de B.
    const deA = await page.request
      .get(`/api/sessions?patientId=${semente.pacienteId}`)
      .then((r) => r.json());
    const deB = await page.request
      .get(`/api/sessions?patientId=${semente.outroPacienteId}`)
      .then((r) => r.json());
    expect(deA.sessions.length, "as duas sessões de A continuam de A").toBe(2);
    expect(deB.sessions.length, "a sessão de B continua de B").toBe(1);
  });
});
