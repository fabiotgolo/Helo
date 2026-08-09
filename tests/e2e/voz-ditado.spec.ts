// ——— Ditado do cuidador: a camada que só o navegador prova (Fase 5.2A) ———
//
// As regras de domínio já estão em scripts/test-dictation-*.mjs e não se
// repetem aqui. O que só esta camada consegue mostrar:
//
//   • a transcrição chega ao campo, e ao MESMO campo que o teclado usa;
//   • nada anda sozinho depois disso — nem apresentar, nem salvar, nem
//     confirmar. O botão manual continua sendo o único gatilho;
//   • "sim", "talvez" e "não" ditados continuam sendo palavras;
//   • com o recurso indisponível, o botão não existe e o campo é o de sempre.
//
// Nenhuma chamada real à ElevenLabs: `POST /api/voice/dictation` é interceptado
// na aba inteira. O `GET` do mesmo endereço NÃO é — ele percorre o servidor de
// verdade, com a flag ligada no lote, e é assim que a disponibilidade é provada.
//
// O microfone também é simulado. Não existe `getUserMedia` de verdade num
// Chromium headless com áudio previsível, e o que está sendo testado não é a
// captura: é o que o produto faz com o texto que volta. `MediaRecorder` e
// `mediaDevices` são substituídos por dublês no `addInitScript`, e é a única
// coisa falsificada — o resto do caminho é o código de produção.

import { expect, test, type Page } from "@playwright/test";
import { abrirModo, entrarComo, pularContexto, semear, type Semente } from "./helpers";

let dados: Semente;

/**
 * Dublês de microfone. Instalados ANTES de qualquer script da página para que
 * o hook encontre um `MediaRecorder` que existe e um `getUserMedia` que resolve.
 *
 * `__ditado` guarda o que aconteceu com o dispositivo — é por ele que o teste
 * prova que as trilhas foram paradas, que é a única forma de a luz do microfone
 * apagar.
 */
async function instalarMicrofone(page: Page, opcoes: { permitir?: boolean } = {}) {
  await page.addInitScript((permitir: boolean) => {
    const espiao = {
      streamsAbertos: 0,
      trilhasParadas: 0,
      gravadoresCriados: 0,
      permissaoPedida: 0,
    };
    (window as unknown as Record<string, unknown>).__ditado = espiao;

    class TrilhaFalsa {
      kind = "audio";
      enabled = true;
      readyState = "live";
      onended: (() => void) | null = null;
      stop() {
        if (this.readyState === "ended") return;
        this.readyState = "ended";
        espiao.trilhasParadas += 1;
      }
    }

    class StreamFalso {
      private trilhas = [new TrilhaFalsa()];
      getTracks() {
        return this.trilhas;
      }
      getAudioTracks() {
        return this.trilhas;
      }
    }

    class MediaRecorderFalso {
      static isTypeSupported() {
        return true;
      }
      state = "inactive";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        espiao.gravadoresCriados += 1;
      }
      start() {
        this.state = "recording";
      }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        // Um pedaço de áudio plausível: o produto só precisa de bytes.
        this.ondataavailable?.({ data: new Blob([new Uint8Array(1024)], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }

    (window as unknown as Record<string, unknown>).MediaRecorder = MediaRecorderFalso;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          espiao.permissaoPedida += 1;
          if (!permitir) {
            const erro = new Error("permissão negada");
            erro.name = "NotAllowedError";
            throw erro;
          }
          espiao.streamsAbertos += 1;
          return new StreamFalso();
        },
      },
    });
  }, opcoes.permitir !== false);
}

/** Intercepta só o POST. O GET continua sendo respondido pelo servidor real. */
async function interceptarTranscricao(
  page: Page,
  responder: (n: number) => { status: number; body: unknown }
) {
  const chamadas: string[] = [];
  await page.route("**/api/voice/dictation", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    chamadas.push(route.request().url());
    const r = responder(chamadas.length);
    await route.fulfill({
      status: r.status,
      contentType: "application/json",
      body: JSON.stringify(r.body),
    });
  });
  return chamadas;
}

/** Faz o servidor declarar o ditado indisponível, sem mexer no ambiente. */
async function declararIndisponivel(page: Page) {
  await page.route("**/api/voice/dictation", async (route) => {
    if (route.request().method() !== "GET") {
      // Um POST aqui seria justamente o defeito: capturar com o recurso
      // desligado. Deixamos passar para o teste conseguir contá-lo.
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: false }),
    });
  });
}

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await instalarMicrofone(page);
  await entrarComo(page, dados.assistente.email);
});

async function sessaoAberta(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await page.getByRole("button", { name: "Iniciar nova sessão" }).click();
  await pularContexto(page);
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
}

const botaoDitar = (page: Page) => page.getByRole("button", { name: /Ditar a pergunta por voz/ });
const campoPergunta = (page: Page) => page.getByLabel("Pergunta para o paciente");

/** Um ciclo completo: abre o microfone, fala, para e espera o texto chegar. */
async function ditar(page: Page) {
  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();
  await page.getByRole("button", { name: /Parar de ditar/ }).click();
}

const espiao = (page: Page) =>
  page.evaluate(() => (window as unknown as Record<string, Record<string, number>>).__ditado);

test("o botão de ditar existe quando o servidor diz que o recurso existe", async ({ page }) => {
  await interceptarTranscricao(page, () => ({ status: 200, body: { transcript: "x" } }));
  await sessaoAberta(page);
  await expect(botaoDitar(page)).toBeVisible();
});

test("a transcrição entra no campo, e o campo continua editável", async ({ page }) => {
  await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "O senhor está sentindo dor?" },
  }));
  await sessaoAberta(page);
  await ditar(page);

  await expect(campoPergunta(page)).toHaveValue("O senhor está sentindo dor?");

  // Editável de verdade: o texto ditado não é especial nem protegido.
  await campoPergunta(page).fill("O senhor está sentindo dor na perna?");
  await expect(campoPergunta(page)).toHaveValue("O senhor está sentindo dor na perna?");
});

test("ditar não apresenta nada ao paciente e não avança o fluxo", async ({ page }) => {
  await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "O senhor quer água?" },
  }));
  await sessaoAberta(page);
  await ditar(page);
  await expect(campoPergunta(page)).toHaveValue("O senhor quer água?");

  // A tela é a MESMA de antes: continua sendo a de escrever a pergunta.
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
  await expect(page.getByText("Revisar antes de apresentar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^SIM:/ })).toHaveCount(0);

  // E só o botão manual de sempre faz o fluxo andar.
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
  await expect(page.getByRole("blockquote")).toHaveText("O senhor quer água?");
});

test("o texto já digitado não é apagado pelo ditado", async ({ page }) => {
  await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "a senhora está com dor?" },
  }));
  await sessaoAberta(page);
  await campoPergunta(page).fill("Dona Ana,");
  await ditar(page);
  await expect(campoPergunta(page)).toHaveValue("Dona Ana, a senhora está com dor?");
});

for (const palavra of ["sim", "talvez", "não"]) {
  test(`"${palavra}" ditado é texto, e não responde pelo paciente`, async ({ page }) => {
    await interceptarTranscricao(page, () => ({ status: 200, body: { transcript: palavra } }));
    await sessaoAberta(page);
    await ditar(page);

    await expect(campoPergunta(page)).toHaveValue(palavra);
    // Nenhuma das superfícies de resposta apareceu, e nada foi confirmado.
    await expect(page.getByRole("button", { name: /^SIM:/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^TALVEZ:/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^NÃO:/ })).toHaveCount(0);
    await expect(page.getByText(/Resposta observada/)).toHaveCount(0);
    await expect(page.getByText(/Confirmada pelo paciente/)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
  });
}

test("descartar não envia nada e não toca no campo", async ({ page }) => {
  const chamadas = await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "não deveria chegar" },
  }));
  await sessaoAberta(page);
  await campoPergunta(page).fill("texto digitado à mão");

  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();
  await page.getByRole("button", { name: "Descartar" }).click();

  await expect(botaoDitar(page)).toBeVisible();
  await expect(campoPergunta(page)).toHaveValue("texto digitado à mão");
  expect(chamadas).toHaveLength(0);

  // E o microfone fechou: sem isto o indicador de gravação fica aceso.
  await expect.poll(async () => (await espiao(page)).trilhasParadas).toBeGreaterThan(0);
});

test("as trilhas do microfone são paradas depois da transcrição", async ({ page }) => {
  await interceptarTranscricao(page, () => ({ status: 200, body: { transcript: "pronto" } }));
  await sessaoAberta(page);
  await ditar(page);
  await expect(campoPergunta(page)).toHaveValue("pronto");

  const estado = await espiao(page);
  expect(estado.streamsAbertos).toBe(1);
  expect(estado.trilhasParadas).toBeGreaterThanOrEqual(1);
});

test("permissão negada não bloqueia a digitação", async ({ page, request }) => {
  // Uma aba nova: o dublê precisa nascer recusando.
  dados = await semear(request);
  await interceptarTranscricao(page, () => ({ status: 200, body: { transcript: "x" } }));
  await instalarMicrofone(page, { permitir: false });
  await entrarComo(page, dados.assistente.email);
  await sessaoAberta(page);

  await botaoDitar(page).click();
  await expect(page.getByText(/microfone não foi liberado/i)).toBeVisible();

  await campoPergunta(page).fill("O senhor está com sede?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
});

test("provedor indisponível: mensagem simples, campo intacto, sem segunda tentativa", async ({ page }) => {
  const chamadas = await interceptarTranscricao(page, () => ({
    status: 503,
    body: { error: "não foi possível transcrever", reason: "provedor" },
  }));
  await sessaoAberta(page);
  await campoPergunta(page).fill("meu texto");
  await ditar(page);

  await expect(page.getByText(/ditado está indisponível agora/i)).toBeVisible();
  await expect(campoPergunta(page)).toHaveValue("meu texto");

  // Falha FECHADA: uma chamada, e mais nenhuma sozinha.
  await page.waitForTimeout(1200);
  expect(chamadas).toHaveLength(1);

  // Nada de jargão na superfície.
  const corpo = (await page.locator("body").innerText()).toLowerCase();
  for (const jargao of ["enterprise", "zero retention", "elevenlabs", "503", "enable_logging"]) {
    expect(corpo).not.toContain(jargao);
  }

  // E dá para seguir digitando.
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
});

test("transcrição vazia não altera o campo", async ({ page }) => {
  await interceptarTranscricao(page, () => ({ status: 200, body: { transcript: "" } }));
  await sessaoAberta(page);
  await campoPergunta(page).fill("o que eu escrevi");
  await ditar(page);

  await expect(page.getByText(/não consegui entender/i)).toBeVisible();
  await expect(campoPergunta(page)).toHaveValue("o que eu escrevi");
});

test("com o recurso indisponível não há botão, e nenhum áudio é enviado", async ({ page }) => {
  const chamadas: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/voice/dictation") && r.method() === "POST") chamadas.push(r.url());
  });
  await declararIndisponivel(page);
  await sessaoAberta(page);

  await expect(botaoDitar(page)).toHaveCount(0);
  // O campo é exatamente o de sempre.
  await campoPergunta(page).fill("O senhor está com frio?");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
  expect(chamadas).toHaveLength(0);
});

test("sem conexão o ditado some, e o campo continua", async ({ page, context }) => {
  await interceptarTranscricao(page, () => ({ status: 200, body: { transcript: "x" } }));
  await sessaoAberta(page);
  await expect(botaoDitar(page)).toBeVisible();

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(botaoDitar(page)).toHaveCount(0);

  // Digitar continua funcionando com a rede fora — é o que a Fase 4.9 garante.
  await campoPergunta(page).fill("O senhor quer descansar?");
  await expect(campoPergunta(page)).toHaveValue("O senhor quer descansar?");

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(botaoDitar(page)).toBeVisible();
});

test("o texto ditado sobrevive ao refresh, como qualquer rascunho", async ({ page }) => {
  await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "O senhor quer ver a sua filha?" },
  }));
  await sessaoAberta(page);
  await ditar(page);
  await expect(campoPergunta(page)).toHaveValue("O senhor quer ver a sua filha?");

  // Recarregar volta ao seletor de modo: com snapshot local presente, ele
  // abre pedindo "Retomar". Mesmo caminho das suítes de continuidade.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Retomar sessão de/ }).click();
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
  await expect(campoPergunta(page)).toHaveValue("O senhor quer ver a sua filha?");
  // O que NÃO volta é o estado de captura: o microfone não reabre sozinho.
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toHaveCount(0);
  await expect(botaoDitar(page)).toBeVisible();
});

test("a transcrição não chega ao Agent Helo", async ({ page }) => {
  await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "conectar com a helo" },
  }));
  const doAgent: string[] = [];
  page.on("request", (r) => {
    if (/conversation-token|client-tools|elevenlabs\.io/.test(r.url())) doAgent.push(r.url());
  });

  await sessaoAberta(page);
  await ditar(page);
  await expect(campoPergunta(page)).toHaveValue("conectar com a helo");

  // O texto é um comando plausível; nada acontece porque não há ligação.
  await page.waitForTimeout(1000);
  expect(doAgent).toHaveLength(0);
});

test("nenhuma fala do paciente é produzida por ditar", async ({ page }) => {
  await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "estou sentindo dor" },
  }));
  const daVoz: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/tts|\/api\/voice\/grant/.test(r.url())) daVoz.push(r.url());
  });

  await sessaoAberta(page);
  await ditar(page);
  await expect(campoPergunta(page)).toHaveValue("estou sentindo dor");
  await page.waitForTimeout(1000);
  expect(daVoz).toHaveLength(0);
});

test("o ditado também preenche a interpretação do cuidador", async ({ page }) => {
  await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "ele quer falar com a irmã" },
  }));
  await sessaoAberta(page);
  await page.getByRole("button", { name: "Registrar o que entendi" }).click();
  await expect(
    page.getByRole("heading", { name: "O que você entendeu que o paciente disse?" })
  ).toBeVisible();

  await page.getByRole("button", { name: /Ditar a interpretação por voz/ }).click();
  await page.getByRole("button", { name: /Parar de ditar/ }).click();
  await expect(page.getByLabel("Interpretação do cuidador")).toHaveValue(
    "ele quer falar com a irmã"
  );

  // Continua sendo interpretação, e continua exigindo o botão manual.
  await expect(page.getByRole("heading", { name: "Interpretação registrada pelo cuidador" })).toHaveCount(0);
  await page.getByRole("button", { name: "Registrar interpretação" }).click();
  await expect(page.getByRole("heading", { name: "Interpretação registrada pelo cuidador" })).toBeVisible();
  await expect(page.getByText("Ainda não é fala do paciente.")).toBeVisible();
});
