// ——— A tela onde o cuidador decide (Fase 4.9.3-C.2, §10 e §11) ———
//
// Os conflitos aqui são REAIS: a sessão é encerrada por outra via (a API,
// fazendo o papel do "outro aparelho"), a rede cai, o cuidador registra algo,
// a rede volta — e o servidor recusa de verdade. Nada é simulado com `route`
// para produzir o conflito em si; `route` só aparece onde é preciso IMPEDIR
// que a fila ande antes da hora.
//
// O que este arquivo protege, e que nenhum teste de unidade alcança:
//
//   • a tela NÃO abre sozinha (§11: um conflito espera, não interrompe);
//   • ela nunca aparece sobre o palco do paciente;
//   • descartar mostra a CADEIA antes, e leva ela junto;
//   • "decidir depois" não descarta nada;
//   • a decisão sobrevive a um refresh — porque o conflito é campo da
//     operação, não estado da aba.

import { expect, test, type Page, type BrowserContext } from "@playwright/test";
import { abrirModo, entrarComo, pularContexto, semear, type Semente } from "./helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await entrarComo(page, dados.assistente.email);
});

const RTQ = "/api/realtime-questions";
const chip = (page: Page) => page.getByTestId("offline-chip");
const tela = (page: Page) => page.getByTestId("tela-de-conflito");
const botaoDecidir = (page: Page) => page.getByTestId("decidir-conflito");
const campoDaPergunta = (page: Page) =>
  page.getByLabel("Pergunta para o paciente");

async function sessaoCarregada(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
  await pularContexto(page);
  await expect(
    page.getByRole("heading", { name: "Escreva a pergunta" })
  ).toBeVisible();
}

async function sessaoAtivaNoServidor(page: Page): Promise<string> {
  const r = await page.request.get(
    `${RTQ}/sessions?patientId=${dados.pacienteId}`
  );
  const j = await r.json();
  const ativa = j.sessions.find(
    (s: { status: string }) => s.status === "ACTIVE" || s.status === "PAUSED"
  );
  expect(ativa, "precisa haver uma sessão ativa no servidor").toBeTruthy();
  return ativa.id;
}

/** Quantas operações estão guardadas — sem decifrar, só a contagem. */
function operacoesGuardadas(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const bancos = await indexedDB.databases?.();
    if (bancos && !bancos.some((b) => b.name === "helo-offline")) return 0;
    const banco = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("helo-offline");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!banco.objectStoreNames.contains("operacoes")) return 0;
    return new Promise<number>((res) => {
      const r = banco
        .transaction("operacoes", "readonly")
        .objectStore("operacoes")
        .count();
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(-1);
    });
  });
}

/**
 * As operações em CONFLICT, DECIFRADAS — quantas são, ou o número do caso de
 * cada uma.
 *
 * Lê do banco e não da tela de propósito: é a única forma de provar que o
 * conflito sobreviveu ao refresh MESMO quando a tela em que ele caiu é a do
 * paciente, onde o chip (corretamente) não aparece. O registro cru é
 * `{id, escopo, iv, dados}` com AES-GCM e AAD `escopo|operacoes|id`
 * (lib/offline/crypto.ts); decifrar aqui é, de quebra, a prova de que a cifra
 * está de pé.
 */
function conflitosGuardados(page: Page, casos: true): Promise<number[]>;
function conflitosGuardados(page: Page): Promise<number>;
function conflitosGuardados(
  page: Page,
  casos?: true
): Promise<number | number[]> {
  return page.evaluate(async (querCasos) => {
    const bancos = await indexedDB.databases?.();
    if (bancos && !bancos.some((b) => b.name === "helo-offline")) {
      return querCasos ? [] : 0;
    }
    const banco = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("helo-offline");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!banco.objectStoreNames.contains("operacoes")) return querCasos ? [] : 0;

    const brutos = await new Promise<
      Array<{ id: string; escopo: string; iv: Uint8Array<ArrayBuffer>; dados: ArrayBuffer }>
    >((res) => {
      const r = banco.transaction("operacoes", "readonly").objectStore("operacoes").getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => res([]);
    });

    const casosEncontrados: number[] = [];
    for (const bruto of brutos) {
      const registro = await new Promise<{ chave: CryptoKey } | undefined>((res) => {
        const r = banco.transaction("chaves", "readonly").objectStore("chaves").get(bruto.escopo);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(undefined);
      });
      if (!registro?.chave) continue;
      try {
        const aberto = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: bruto.iv,
            additionalData: new TextEncoder().encode(
              `${bruto.escopo}|operacoes|${bruto.id}`
            ),
          },
          registro.chave,
          bruto.dados
        );
        const op = JSON.parse(new TextDecoder().decode(aberto)) as {
          status: string;
          conflict?: { caso?: number } | null;
        };
        if (op.status === "CONFLICT") casosEncontrados.push(op.conflict?.caso ?? -1);
      } catch {
        // Ilegível — mesma regra do produto: descarta, não inventa.
      }
    }
    return querCasos ? casosEncontrados : casosEncontrados.length;
  }, casos);
}

/**
 * Produz um conflito de VERDADE (§10, caso 1):
 *
 *   1. o cuidador está numa sessão aberta;
 *   2. a rede cai e ele escreve uma pergunta — ela vai para a fila;
 *   3. "outro aparelho" (a API) conclui a sessão;
 *   4. a rede volta, a fila tenta enviar, e o servidor recusa com
 *      SESSION_COMPLETED.
 */
async function conflitoDeSessaoConcluida(page: Page, context: BrowserContext) {
  await sessaoCarregada(page);
  const sessionId = await sessaoAtivaNoServidor(page);

  await context.setOffline(true);
  await campoDaPergunta(page).fill("O senhor está com dor?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(chip(page)).toBeVisible();

  // O "outro aparelho". `page.request` não passa pelo `setOffline` do
  // contexto do navegador — é uma requisição do processo de teste.
  const r = await page.request.patch(`${RTQ}/sessions`, {
    data: { patientId: dados.pacienteId, sessionId, action: "COMPLETE" },
  });
  expect(r.ok(), "a sessão precisa ter sido concluída no servidor").toBeTruthy();

  await context.setOffline(false);
  await expect(chip(page)).toHaveAttribute("data-estado", "CONFLITO", {
    timeout: 20_000,
  });
  return sessionId;
}

test.describe("Decisão sobre conflitos", () => {
  test("1. o conflito espera: a tela NÃO abre sozinha", async ({ page, context }) => {
    await conflitoDeSessaoConcluida(page, context);

    // §11: "Nenhum som, nenhuma vibração, nenhum modal automático. Um
    // conflito espera; ele não interrompe uma conversa em curso."
    await expect(tela(page)).toBeHidden();
    // Mas o chip avisa, e oferece o caminho.
    await expect(chip(page)).toContainText(/precisa.*decisão/i);
    await expect(botaoDecidir(page)).toBeVisible();
  });

  test("2. o cuidador abre, e a tela diz o que houve e o que ele escreveu", async ({
    page,
    context,
  }) => {
    await conflitoDeSessaoConcluida(page, context);
    await botaoDecidir(page).click();

    await expect(tela(page)).toBeVisible();
    await expect(tela(page)).toHaveAttribute("data-caso", "1");
    await expect(tela(page)).toContainText(/encerrada em outro aparelho/i);

    // Os dois lados: o que ELE escreveu continua à vista. Perder isso de
    // vista no momento da decisão seria pedir uma decisão às cegas.
    await expect(page.getByTestId("conflito-meu-texto")).toContainText(
      "O senhor está com dor?"
    );
    await expect(page.getByTestId("conflito-meu-texto")).toContainText(
      /você escreveu, sem conexão/i
    );

    // As três saídas do caso 1, e nenhuma delas aplicada sozinha.
    await expect(page.getByTestId("conflito-opcao-VER_PENDENTES")).toBeVisible();
    await expect(
      page.getByTestId("conflito-opcao-REAPROVEITAR_COMO_RASCUNHO")
    ).toBeVisible();
    await expect(page.getByTestId("conflito-opcao-DESCARTAR")).toBeVisible();
  });

  test("3. 'decidir depois' fecha sem descartar nada", async ({ page, context }) => {
    await conflitoDeSessaoConcluida(page, context);
    const antes = await operacoesGuardadas(page);

    await botaoDecidir(page).click();
    await expect(tela(page)).toBeVisible();
    await page.getByTestId("conflito-decidir-depois").click();

    await expect(tela(page)).toBeHidden();
    expect(await operacoesGuardadas(page)).toBe(antes);
    // E o chip continua pedindo decisão: sair da tela não resolveu nada.
    await expect(chip(page)).toHaveAttribute("data-estado", "CONFLITO");
  });

  test("4. descartar remove o registro e o chip para de pedir decisão", async ({
    page,
    context,
  }) => {
    await conflitoDeSessaoConcluida(page, context);
    expect(await operacoesGuardadas(page)).toBeGreaterThan(0);

    await botaoDecidir(page).click();
    await page.getByTestId("conflito-opcao-DESCARTAR").click();

    await expect(tela(page)).toBeHidden();
    await expect(page.getByTestId("aviso-de-decisao")).toContainText(
      /descartamos/i
    );
    await expect.poll(() => operacoesGuardadas(page)).toBe(0);
    // A faixa some INTEIRA: sem pendência, o chip não tem o que dizer, e
    // continuar visível seria contabilidade do aparelho ocupando a tela de
    // quem já resolveu o que tinha para resolver.
    await expect(chip(page)).toBeHidden();
  });

  test("5. reaproveitar guarda o texto como rascunho — nunca como registro", async ({
    page,
    context,
  }) => {
    const sessionId = await conflitoDeSessaoConcluida(page, context);

    await botaoDecidir(page).click();
    await page.getByTestId("conflito-opcao-REAPROVEITAR_COMO_RASCUNHO").click();

    await expect(page.getByTestId("aviso-de-decisao")).toContainText(
      /não foi registrado nem apresentado/i
    );
    // A fila esvaziou: nada ficou para ser enviado.
    await expect.poll(() => operacoesGuardadas(page)).toBe(0);

    // E o servidor não ganhou nada — nem turno, nem evento. É a garantia que
    // separa "guardado como rascunho" de "registrado".
    const turnos = await page.request.get(
      `${RTQ}/turns?patientId=${dados.pacienteId}&sessionId=${sessionId}`
    );
    expect((await turnos.json()).turns).toHaveLength(0);
  });

  test("6. sessão pausada em outro aparelho: caso 2, e ele sobrevive ao refresh", async ({
    page,
    context,
  }) => {
    // Este cenário usa PAUSA, e não conclusão, por uma razão de produto: uma
    // sessão pausada continua retomável, então dá para recarregar, voltar
    // para ela e conferir que o conflito continua lá. Com a sessão CONCLUÍDA
    // não há para onde voltar — ver a nota ao fim do arquivo.
    await sessaoCarregada(page);
    const sessionId = await sessaoAtivaNoServidor(page);

    // Uma pergunta apresentada, para que a próxima ação seja das que a pausa
    // bloqueia (registrar resposta é ação voltada ao paciente).
    await campoDaPergunta(page).fill("O senhor está com dor?");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
    await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
    await expect(
      page.getByRole("group", { name: "Respostas possíveis do paciente" })
    ).toBeVisible();

    await context.setOffline(true);
    await page.getByRole("button", { name: "SIM" }).click();
    await page.getByRole("button", { name: "Confirmar", exact: true }).click();
    await expect(chip(page)).toBeVisible();

    // O "outro aparelho" pausa a conversa.
    const r = await page.request.patch(`${RTQ}/sessions`, {
      data: { patientId: dados.pacienteId, sessionId, action: "PAUSE" },
    });
    expect(r.ok(), "a sessão precisa ter sido pausada no servidor").toBeTruthy();

    await context.setOffline(false);
    await expect
      .poll(() => conflitosGuardados(page), { timeout: 20_000 })
      .toBe(1);

    // O caso certo, e a saída que só ele tem: retomar e continuar.
    expect((await conflitosGuardados(page, true))[0]).toBe(2);

    // Recarrega com a rota de envio bloqueada: sem isto, a fila tentaria de
    // novo ao montar e o teste provaria outra coisa.
    await page.route(`**${RTQ}/turns`, (route) => route.abort("connectionreset"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Retomar sessão de/ }).click();
    await expect(page.getByRole("heading", { name: /dor\?/ })).toBeVisible();

    // O conflito continua lá, com o MESMO caso e os MESMOS fatos: ele é campo
    // da operação, cifrado no aparelho, não estado da aba que acabou de
    // morrer. Lido do banco, e não da tela, porque nesta altura a tela é do
    // PACIENTE (a pergunta voltou aguardando resposta) — e ali, por regra, o
    // chip não aparece. As duas coisas são verdadeiras ao mesmo tempo: o
    // conflito sobreviveu, e continua invisível para o paciente.
    await expect
      .poll(() => conflitosGuardados(page), { timeout: 20_000 })
      .toBe(1);
    expect((await conflitosGuardados(page, true))[0]).toBe(2);
    await expect(chip(page)).toBeHidden();
  });

  test("7. a tela de conflito nunca aparece sobre o palco do paciente", async ({
    page,
  }) => {
    // Uma pergunta apresentada ao paciente ANTES de tudo: é ela que leva a
    // tela para o palco.
    await sessaoCarregada(page);
    await campoDaPergunta(page).fill("Você quer água?");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
    await page.getByRole("button", { name: "Apresentar ao paciente" }).click();
    await expect(
      page.getByRole("group", { name: "Respostas possíveis do paciente" })
    ).toBeVisible();

    // No palco, nem o chip nem a tela de conflito existem — a MESMA
    // fronteira, pela MESMA expressão (`pacienteEstaOlhando`).
    await expect(chip(page)).toBeHidden();
    await expect(tela(page)).toBeHidden();
    await expect(botaoDecidir(page)).toBeHidden();
  });
});
