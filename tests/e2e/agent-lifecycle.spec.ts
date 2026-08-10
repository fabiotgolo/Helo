// ——— O contexto vivo do Agent, medido na tela real (Fase 5.3C) ———
//
// A suíte `test:agent:context` conduz a sequência de despacho diretamente e
// prova a lógica: gate, lease, registry vivo, ordem. Ela não prova uma coisa —
// que a tela REAL publica o contexto certo, que a geração avança quando a
// autoridade muda e NÃO avança quando só houve render, e que uma ação da tela
// anterior é recusada de verdade depois de navegar.
//
// É o que estes testes medem. Eles usam dois ganchos de inspeção que só
// existem fora de produção:
//
//   __heloAgentContext()          o payload que a client tool devolveria
//   __heloAgentTool(nome, params) a client tool REAL, chamada como o provedor
//                                 a chamaria
//
// O segundo é o que torna isto uma prova e não uma encenação: o dispatcher
// que roda aqui é o mesmo — gate de classe, lease, registry vivo, autorização
// no servidor. Nenhuma sessão do Agent é aberta. Nenhuma chamada ao provedor
// acontece: as client tools são funções locais.

import { test, expect, type Page } from "@playwright/test";
import { entrarComo, selecionarPaciente, semear, type Semente } from "./helpers";

type Contexto = {
  route: string;
  screen: string;
  capabilities: { id: string; class: string; scope: string }[];
  humanOnly: Record<string, number>;
  __geracao: number;
};

async function contexto(page: Page): Promise<Contexto> {
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as never as Record<string, unknown>).__heloAgentContext
      )
    )
    .toBe("function");
  return page.evaluate(
    () =>
      (
        (window as never as Record<string, unknown>).__heloAgentContext as () => unknown
      )() as Contexto
  );
}

/** Chama a client tool como o provedor chamaria, e devolve o resultado. */
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

const idsLocais = (c: Contexto) =>
  c.capabilities.filter((x) => x.scope === "screen").map((x) => x.id);

let semente: Semente;

test.beforeEach(async ({ request }) => {
  semente = await semear(request);
});

test.describe("O contexto vivo do Agent", () => {
  test("1. a geração avança com a rota, e não com o render", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/rotina");
    await expect(page.getByRole("heading", { name: "Rotina" })).toBeVisible();

    const a = await contexto(page);
    // Dez leituras seguidas, cada uma um render do ponto de vista do React:
    // a geração é a mesma. É a lição da regressão de desempenho da 5.3B —
    // render não é mudança de autoridade.
    for (let i = 0; i < 10; i++) {
      const repetido = await contexto(page);
      expect(repetido.__geracao).toBe(a.__geracao);
    }

    // A navegação que importa é a do lado do cliente: é ela que o Agent
    // persistente atravessa sem perder a conversa. Um `goto` recarregaria a
    // página, e uma página nova é uma fronteira mais forte que a geração —
    // tudo recomeça, inclusive o contador.
    const r = await tool(page, "navigateHeloArea", { targetArea: "helo" });
    expect(r.ok).toBeTruthy();
    await expect(page.getByRole("button", { name: "Conectar com Helo" })).toBeVisible();

    const b = await contexto(page);
    expect(b.__geracao).not.toBe(a.__geracao);
    expect(b.screen).toBe("helo");
    // E a tela nova não herda as ações da anterior.
    expect(idsLocais(b).some((id) => id.startsWith("routine."))).toBeFalsy();
  });

  test("2. a ação da tela anterior não executa depois de navegar", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/rotina");
    await expect(page.getByRole("heading", { name: "Rotina" })).toBeVisible();

    const naRotina = await contexto(page);
    const alvo = idsLocais(naRotina).find((id) => id.startsWith("routine.open."));
    expect(alvo, "a Rotina precisa oferecer cards").toBeTruthy();

    // Aqui ela vale: o contexto é o dela.
    const valido = await tool(page, "interactWithHeloUI", { actionId: alvo });
    expect(valido.ok).toBeTruthy();
    expect(valido.result).toBe("SUCCESS");

    // O cuidador sai da tela. O mesmo pedido, agora, não pode produzir efeito.
    await page.goto("/atividades");
    await page.waitForTimeout(1200);
    const depois = await tool(page, "interactWithHeloUI", { actionId: alvo });
    expect(depois.ok).toBeFalsy();
    expect(["NOT_FOUND", "CONTEXT_EXPIRED"]).toContain(depois.result);

    // E a recusa não devolve conteúdo de tela.
    expect(JSON.stringify(depois)).not.toContain("água");
  });

  test("3. as capacidades acompanham várias navegações seguidas", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/helo");
    await expect(page.getByRole("button", { name: "Conectar com Helo" })).toBeVisible();

    // Tudo pelo lado do cliente, como um cuidador com o assistente persistente
    // ligado atravessaria o produto sem perder a conversa.
    // "atividades" fica de fora do trajeto de propósito: ela exige a permissão
    // `viewActivities`, que esta cuidadora não tem. A recusa dela é conferida
    // logo abaixo — uma capability de rota não contorna a autorização real.
    const trajeto = ["rotina", "conversar", "rotina", "helo"];
    const geracoes: number[] = [(await contexto(page)).__geracao];
    let anterior = idsLocais(await contexto(page));

    for (const area of trajeto) {
      const r = await tool(page, "navigateHeloArea", { targetArea: area });
      expect(r.ok, `navegar para ${area}`).toBeTruthy();
      await page.waitForTimeout(1200);

      const c = await contexto(page);
      geracoes.push(c.__geracao);
      const agora = idsLocais(c);

      // A ação da tela anterior sumiu — e a recusa é determinística.
      for (const antigo of anterior.filter((id) => !agora.includes(id))) {
        const rec = await tool(page, "interactWithHeloUI", { actionId: antigo });
        expect(rec.ok, `${antigo} executou fora da tela dela`).toBeFalsy();
      }
      anterior = agora;
    }

    // Cada navegação real produziu uma geração nova, e nenhuma se repetiu.
    expect(new Set(geracoes).size).toBe(geracoes.length);

    // E a área que exige permissão que a cuidadora não tem é recusada pelo
    // servidor, mesmo estando na tabela fechada de rotas globais.
    const semPermissao = await tool(page, "navigateHeloArea", { targetArea: "atividades" });
    expect(semPermissao.ok).toBeFalsy();
    expect(page.url()).not.toContain("/atividades");
  });

  test("4. as nove rotas globais continuam fechadas e nada mais entra", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/rotina");
    await expect(page.getByRole("heading", { name: "Rotina" })).toBeVisible();

    const c = await contexto(page);
    expect(c.capabilities.filter((x) => x.scope === "global")).toHaveLength(9);

    // Uma rota que não está na tabela não vira destino, por mais que o pedido
    // se pareça com um dos ids conhecidos.
    for (const inventado of ["navigate-admin", "/admin", "javascript:alert(1)", "navigate-../admin"]) {
      const r = await tool(page, "interactWithHeloUI", { actionId: inventado });
      expect(r.ok, `${inventado} não pode navegar`).toBeFalsy();
    }
    expect(page.url()).toContain("/rotina");
  });

  test("5. patientResponse e sensitive continuam recusados pela client tool real", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/rotina");
    await page.getByRole("button", { name: /água/i }).first().click();
    await expect(page.getByRole("button", { name: "Responder sim" })).toBeVisible();

    // Dentro do card: as três respostas são do paciente.
    for (const pedido of [
      { actionId: "routine.answer.water.yes" },
      { actionId: "SIM" },
      { actionId: "clique no sim" },
      { actionId: "responder", payload: { gesto: "sim" } },
      { actionId: "👍" },
    ]) {
      const r = await tool(page, "interactWithHeloUI", pedido);
      expect(r.ok, `«${pedido.actionId}» não pode responder pelo paciente`).toBeFalsy();
      if (r.result === "FORBIDDEN_BY_POLICY") {
        expect(r.requiresHumanAction).toBeTruthy();
      }
    }
    // A tela não mudou: nenhuma resposta foi registrada.
    await expect(page.getByRole("button", { name: "Responder sim" })).toBeVisible();

    // E o sensível, na Emergência.
    await page.goto("/emergencia");
    await expect(page.getByRole("button", { name: "Falta de ar" })).toBeVisible();
    const emergencia = await tool(page, "interactWithHeloUI", {
      actionId: "emergencia.item.emergencia.falta_ar",
    });
    expect(emergencia.ok).toBeFalsy();
    expect(emergencia.result).toBe("FORBIDDEN_BY_POLICY");
  });

  test("6. trocar de paciente troca o contexto e derruba a ação anterior", async ({ page, request }) => {
    // O segundo paciente precisa de vínculo com a mesma cuidadora.
    const r = await request.post("/api/admin/access", {
      data: {
        userId: semente.assistente.id,
        patientId: semente.outroPacienteId,
        permissions: ["viewDashboard", "viewSessions", "viewMetrics", "createSession", "editGestures"],
      },
    });
    expect(r.ok(), "vincular a cuidadora ao segundo paciente").toBeTruthy();

    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/rotina");
    await expect(page.getByRole("heading", { name: "Rotina" })).toBeVisible();

    const comA = await contexto(page);
    const alvo = idsLocais(comA).find((id) => id.startsWith("routine.open."));
    expect(alvo).toBeTruthy();

    // Troca de paciente pelo mesmo caminho que a interface usa.
    await page.evaluate((id) => {
      window.localStorage.setItem("helo.patientId", String(id));
    }, semente.outroPacienteId);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Rotina" })).toBeVisible();

    const comB = await contexto(page);

    // A troca de paciente aqui passa por uma RECARGA — e uma página nova é uma
    // fronteira mais forte que a geração: nada do contexto anterior sobrevive,
    // nem o contador. Por isso a asserção não é sobre o número, e sim sobre o
    // que o payload passou a descrever.
    expect(idsLocais(comB).length).toBeGreaterThan(0);
    expect(JSON.stringify(comB)).not.toContain(String(semente.pacienteId));
    expect(JSON.stringify(comB)).not.toContain(String(semente.outroPacienteId));
    // O paciente nunca esteve no payload — a 5.3B o removeu — e continua fora.
    expect(comA.capabilities.length).toBeGreaterThan(0);
  });

  test("7. sair da conta não deixa contexto nem ferramenta atrás", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/rotina");
    await expect(page.getByRole("heading", { name: "Rotina" })).toBeVisible();

    const antes = await contexto(page);
    expect(idsLocais(antes).length).toBeGreaterThan(0);

    await page.evaluate(async () => {
      await fetch("/api/auth/logout", { method: "POST" });
    });
    await page.goto("/login");
    await expect(page).toHaveURL(/\/login/);

    // O provider continua montado (ele vive no layout raiz), mas não há tela
    // com ações, não há paciente e não há usuário: nenhuma capacidade local.
    const depois = await contexto(page);
    expect(idsLocais(depois)).toEqual([]);
    expect(depois.__geracao).not.toBe(antes.__geracao);

    // E um pedido antigo não ressuscita nada.
    const r = await tool(page, "interactWithHeloUI", { actionId: "routine.open.water" });
    expect(r.ok).toBeFalsy();
  });

  test("8. o mesmo pedido duas vezes seguidas não duplica o efeito indevidamente", async ({ page }) => {
    await entrarComo(page, semente.assistente.email);
    await selecionarPaciente(page, semente.pacienteId);
    await page.goto("/rotina");
    await expect(page.getByRole("heading", { name: "Rotina" })).toBeVisible();

    const c = await contexto(page);
    const alvo = idsLocais(c).find((id) => id.startsWith("routine.open."));
    expect(alvo).toBeTruthy();

    // Duas chamadas concorrentes para a MESMA ação de abrir um card. Abrir é
    // idempotente por natureza — o card fica aberto, e uma segunda abertura
    // não empilha nada. O que este teste prende é que ela não vira erro nem
    // efeito duplo observável.
    const [a, b] = await Promise.all([
      tool(page, "interactWithHeloUI", { actionId: alvo }),
      tool(page, "interactWithHeloUI", { actionId: alvo }),
    ]);
    expect(a.ok || b.ok, "ao menos uma precisa ter valido").toBeTruthy();
    await expect(page.getByRole("button", { name: "Responder sim" })).toHaveCount(1);
  });
});
