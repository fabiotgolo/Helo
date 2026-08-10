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
import { abrirModo, entrarComo, iniciarNovaSessao, pularContexto, semear, type Semente } from "./helpers";
import {
  botaoDitar,
  declararIndisponivel,
  ditar,
  espiao,
  instalarMicrofone,
  interceptarTranscricao,
} from "./dictation-helpers";

let dados: Semente;

test.beforeEach(async ({ page, request }) => {
  dados = await semear(request);
  await instalarMicrofone(page);
  await entrarComo(page, dados.assistente.email);
});

async function sessaoAberta(page: Page) {
  await abrirModo(page, dados.pacienteId);
  await iniciarNovaSessao(page);
  await pularContexto(page);
  await expect(page.getByRole("heading", { name: "Escreva a pergunta" })).toBeVisible();
}

const campoPergunta = (page: Page) => page.getByLabel("Pergunta para o paciente");

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

// ══════════════════════════════════════════════════════════════════════════
// Fase 5.2B — concorrência, lifecycle e arbitragem
//
// Daqui para baixo, o assunto deixa de ser "o texto chega ao campo" e passa a
// ser "o que acontece quando duas coisas disputam o microfone, ou quando uma
// resposta chega depois que o mundo mudou". São defeitos que só existem no
// navegador, com tempo real passando entre os passos — nenhuma suíte de
// domínio consegue produzi-los.
//
// A posse do microfone é encenada por `window.__heloAudio`, que só existe fora
// de produção. Nenhuma sessão da ElevenLabs é aberta; o que se toma é a
// concessão, que é exatamente o que o Agente tomaria.
// ══════════════════════════════════════════════════════════════════════════

/** O objeto de inspeção do coordenador, exposto só em desenvolvimento. */
type CoordenadorDeTeste = {
  donoDoMicrofone: () => string;
  adquireMicrofone: (dono: string) => { id: number } | null;
  liberaMicrofone: (c: { id: number }) => boolean;
  setPlatformSpeaking: (token: object, tocando: boolean) => void;
  canPlatformSpeak: () => { ok: boolean; reason?: string };
  beginPatientVoiceOverride: () => void;
  endPatientVoiceOverride: () => void;
};
const coordenador = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __heloAudio: CoordenadorDeTeste }).__heloAudio !== undefined
  );

async function tomarMicrofone(page: Page, dono: string) {
  await page.evaluate((d) => {
    const c = (window as unknown as { __heloAudio: CoordenadorDeTeste }).__heloAudio;
    (window as unknown as Record<string, unknown>).__concessaoDeTeste = c.adquireMicrofone(d);
  }, dono);
}

async function devolverMicrofone(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __heloAudio: CoordenadorDeTeste; __concessaoDeTeste?: { id: number } };
    if (w.__concessaoDeTeste) w.__heloAudio.liberaMicrofone(w.__concessaoDeTeste);
  });
}

const donoAtual = (page: Page) =>
  page.evaluate(() => (window as unknown as { __heloAudio: CoordenadorDeTeste }).__heloAudio.donoDoMicrofone());

test("o objeto de inspeção do coordenador existe neste ambiente", async ({ page }) => {
  await sessaoAberta(page);
  expect(await coordenador(page)).toBe(true);
});

test("duplo clique no microfone abre UMA captura, não duas", async ({ page }) => {
  const chamadas = await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "uma vez só" },
  }));
  await sessaoAberta(page);

  // Dois cliques no MESMO tique — não dois cliques rápidos. É a diferença que
  // importa: entre eles não há render, e a guarda por `estado` (que só chega no
  // render seguinte) via "IDLE" nas duas vezes. Por isso os dois são
  // despachados de dentro da página, sem devolver o controle ao navegador.
  await expect(botaoDitar(page)).toBeVisible();
  await page.evaluate(() => {
    const alvo = [...document.querySelectorAll("button")].find((b) =>
      /Ditar a pergunta por voz/.test(b.getAttribute("aria-label") ?? "")
    );
    alvo?.click();
    alvo?.click();
  });
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();

  const estado = await espiao(page);
  expect(estado.streamsAbertos).toBe(1);
  expect(estado.gravadoresCriados).toBe(1);
  expect(estado.permissaoPedida).toBe(1);

  await page.getByRole("button", { name: /Parar de ditar/ }).click();
  await expect(campoPergunta(page)).toHaveValue("uma vez só");
  expect(chamadas).toHaveLength(1);
});

test("parar duas vezes envia um áudio só", async ({ page }) => {
  const chamadas = await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "pronto" },
  }));
  await sessaoAberta(page);
  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();
  // Também no mesmo tique: o segundo "parar" encontra um gravador que já não
  // está gravando, e o `onstop` só pode montar um Blob.
  await page.evaluate(() => {
    const alvo = [...document.querySelectorAll("button")].find((b) =>
      /Parar de ditar/.test(b.getAttribute("aria-label") ?? "")
    );
    alvo?.click();
    alvo?.click();
  });
  await expect(campoPergunta(page)).toHaveValue("pronto");
  await page.waitForTimeout(600);
  expect(chamadas).toHaveLength(1);
});

test("com o Agente CONECTANDO, o ditado não abre o microfone", async ({ page }) => {
  const chamadas = await interceptarTranscricao(page, () => ({ status: 200, body: { transcript: "x" } }));
  await sessaoAberta(page);
  await tomarMicrofone(page, "AGENT_CONNECTING");

  await botaoDitar(page).click();
  await expect(page.getByText(/Encerre a conversa com a Helo/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toHaveCount(0);

  const estado = await espiao(page);
  expect(estado.streamsAbertos).toBe(0);
  expect(estado.permissaoPedida).toBe(0);
  expect(chamadas).toHaveLength(0);
  expect(await donoAtual(page)).toBe("AGENT_CONNECTING");
});

test("com o Agente ATIVO, o ditado não abre o microfone", async ({ page }) => {
  await interceptarTranscricao(page, () => ({ status: 200, body: { transcript: "x" } }));
  await sessaoAberta(page);
  await tomarMicrofone(page, "AGENT_ACTIVE");

  await botaoDitar(page).click();
  await expect(page.getByText(/Encerre a conversa com a Helo/i)).toBeVisible();
  expect((await espiao(page)).streamsAbertos).toBe(0);

  // Encerrada a conversa, o ditado volta a funcionar — sem recarregar a tela.
  await devolverMicrofone(page);
  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();
  expect((await espiao(page)).streamsAbertos).toBe(1);
});

test("capturando, o Agente não consegue tomar o microfone", async ({ page }) => {
  await interceptarTranscricao(page, () => ({ status: 200, body: { transcript: "x" } }));
  await sessaoAberta(page);
  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();

  expect(await donoAtual(page)).toBe("DICTATION_LISTENING");
  const tomou = await page.evaluate(
    () => (window as unknown as { __heloAudio: CoordenadorDeTeste }).__heloAudio.adquireMicrofone("AGENT_CONNECTING")
  );
  expect(tomou).toBeNull();
});

test("transcrevendo, o Agente TAMBÉM não consegue — a resposta ainda vai mexer na tela", async ({ page }) => {
  let soltar: (() => void) | null = null;
  const espera = new Promise<void>((r) => (soltar = r));
  await page.route("**/api/voice/dictation", async (route) => {
    // `continue()` pode ser recusado se a página já saiu do ar no fim do
    // teste; não é o assunto de nenhum destes cenários.
    if (route.request().method() !== "POST") return route.continue().catch(() => {});
    await espera;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transcript: "chegou depois" }),
    });
  });
  await sessaoAberta(page);
  await ditar(page);

  await expect(page.getByText("Transcrevendo…")).toBeVisible();
  expect(await donoAtual(page)).toBe("DICTATION_PROCESSING");
  const tomou = await page.evaluate(
    () => (window as unknown as { __heloAudio: CoordenadorDeTeste }).__heloAudio.adquireMicrofone("AGENT_CONNECTING")
  );
  expect(tomou).toBeNull();

  soltar!();
  await expect(campoPergunta(page)).toHaveValue("chegou depois");
  // Terminou: a posse volta a ser de ninguém.
  await expect.poll(() => donoAtual(page)).toBe("NONE");
});

test("com áudio da Helo tocando, o microfone não abre — e a fala não é cortada", async ({ page }) => {
  await interceptarTranscricao(page, () => ({ status: 200, body: { transcript: "x" } }));
  await sessaoAberta(page);

  await page.evaluate(() => {
    const c = (window as unknown as { __heloAudio: CoordenadorDeTeste }).__heloAudio;
    (window as unknown as Record<string, unknown>).__tokenDeFala = {};
    c.setPlatformSpeaking(
      (window as unknown as Record<string, object>).__tokenDeFala,
      true
    );
  });

  await botaoDitar(page).click();
  await expect(page.getByText(/Espere o áudio da Helo terminar/i)).toBeVisible();
  expect((await espiao(page)).streamsAbertos).toBe(0);

  // Terminou de tocar: o ditado volta.
  await page.evaluate(() => {
    const c = (window as unknown as { __heloAudio: CoordenadorDeTeste }).__heloAudio;
    c.setPlatformSpeaking((window as unknown as Record<string, object>).__tokenDeFala, false);
  });
  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();
});

test("capturando, a plataforma não começa a falar", async ({ page }) => {
  await interceptarTranscricao(page, () => ({ status: 200, body: { transcript: "x" } }));
  await sessaoAberta(page);

  const antes = await page.evaluate(
    () => (window as unknown as { __heloAudio: CoordenadorDeTeste }).__heloAudio.canPlatformSpeak()
  );
  expect(antes.ok).toBe(true);

  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();

  const durante = await page.evaluate(
    () => (window as unknown as { __heloAudio: CoordenadorDeTeste }).__heloAudio.canPlatformSpeak()
  );
  expect(durante.ok).toBe(false);
  expect(durante.reason).toBe("dictation_capturing");
});

test("a emergência do paciente encerra a captura em vez de tocar por cima dela", async ({ page }) => {
  const chamadas = await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "não deveria chegar" },
  }));
  await sessaoAberta(page);
  await campoPergunta(page).fill("texto do cuidador");
  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();

  await page.evaluate(() =>
    (window as unknown as { __heloAudio: CoordenadorDeTeste }).__heloAudio.beginPatientVoiceOverride()
  );

  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toHaveCount(0);
  await expect(campoPergunta(page)).toHaveValue("texto do cuidador");
  expect(chamadas).toHaveLength(0);
  await expect.poll(async () => (await espiao(page)).trilhasParadas).toBeGreaterThan(0);

  await page.evaluate(() =>
    (window as unknown as { __heloAudio: CoordenadorDeTeste }).__heloAudio.endPatientVoiceOverride()
  );
});

test("emergência durante a gravação: o fragmento não vira upload nem transcrição", async ({ page }) => {
  // O cenário exato do fechamento da 5.2B. A distinção que decide se um pedaço
  // de áudio clínico sai do aparelho:
  //
  //   parar pela mão do cuidador  → "terminei de falar" → transcreve
  //   interrupção por emergência  → "isto aqui acabou"  → descarta
  //
  // Meia frase gravada não é uma pergunta. Mandá-la ao provedor seria
  // transcrever um trecho que ninguém decidiu enviar — e devolvê-lo ao campo
  // depois, quando a emergência já passou, seria pior ainda.
  const chamadas = await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "fragmento que nunca deveria existir" },
  }));
  await sessaoAberta(page);
  await campoPergunta(page).fill("o que eu digitei");
  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();
  expect(await donoAtual(page)).toBe("DICTATION_LISTENING");

  await page.evaluate(() =>
    (window as unknown as { __heloAudio: CoordenadorDeTeste }).__heloAudio.beginPatientVoiceOverride()
  );

  // A captura acabou, e acabou de verdade: sem microfone aberto, sem posse.
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toHaveCount(0);
  await expect.poll(() => donoAtual(page)).toBe("NONE");
  await expect.poll(async () => (await espiao(page)).trilhasParadas).toBeGreaterThan(0);

  // ——— A callback atrasada, que é o ponto ———
  //
  // O `MediaRecorder` real entrega `ondataavailable` e `onstop` de forma
  // assíncrona: o teardown pede `stop()` e os eventos chegam DEPOIS. Aqui eles
  // são disparados à mão, já com a emergência em curso, que é a pior ordem
  // possível. Se a bandeira `encerrada` subisse depois do `stop()` em vez de
  // antes, é exatamente aqui que um upload apareceria.
  await page.evaluate(() => {
    const g = (window as unknown as { __ditado: { ultimoGravador: {
      ondataavailable: ((e: { data: Blob }) => void) | null;
      onstop: (() => void) | null;
    } | null } }).__ditado.ultimoGravador;
    g?.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: "audio/webm" }) });
    g?.onstop?.();
  });
  await page.waitForTimeout(1200);

  expect(chamadas).toHaveLength(0);
  await expect(campoPergunta(page)).toHaveValue("o que eu digitei");
  await expect(page.getByText("Transcrevendo…")).toHaveCount(0);
  await expect(page.getByText(/fragmento/)).toHaveCount(0);
  expect(await donoAtual(page)).toBe("NONE");

  // Terminada a emergência, o ditado volta a funcionar — sem recarregar nada.
  await page.evaluate(() =>
    (window as unknown as { __heloAudio: CoordenadorDeTeste }).__heloAudio.endPatientVoiceOverride()
  );
  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();
  await page.getByRole("button", { name: "Descartar" }).click();

  // E a pergunta que sobreviveu continua sendo a DIGITADA: a emergência não
  // deixou procedência de voz para trás.
  await expect(campoPergunta(page)).toHaveValue("o que eu digitei");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
  await expect(page.getByRole("blockquote")).toHaveText("o que eu digitei");
});

test("descartar durante a transcrição aborta, e o texto não chega", async ({ page }) => {
  let soltar: (() => void) | null = null;
  const espera = new Promise<void>((r) => (soltar = r));
  await page.route("**/api/voice/dictation", async (route) => {
    // `continue()` pode ser recusado se a página já saiu do ar no fim do
    // teste; não é o assunto de nenhum destes cenários.
    if (route.request().method() !== "POST") return route.continue().catch(() => {});
    await espera;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transcript: "resposta atrasada" }),
    });
  });
  await sessaoAberta(page);
  await campoPergunta(page).fill("o que eu digitei");
  await ditar(page);
  await expect(page.getByText("Transcrevendo…")).toBeVisible();

  await page.getByRole("button", { name: "Descartar" }).click();
  await expect(page.getByText("Transcrevendo…")).toHaveCount(0);
  await expect.poll(() => donoAtual(page)).toBe("NONE");

  soltar!();
  await page.waitForTimeout(800);
  // A resposta chegou tarde e não encostou no campo.
  await expect(campoPergunta(page)).toHaveValue("o que eu digitei");
});

test("trocar de campo antes da resposta: o texto não cai no campo novo", async ({ page }) => {
  let soltar: (() => void) | null = null;
  const espera = new Promise<void>((r) => (soltar = r));
  await page.route("**/api/voice/dictation", async (route) => {
    // `continue()` pode ser recusado se a página já saiu do ar no fim do
    // teste; não é o assunto de nenhum destes cenários.
    if (route.request().method() !== "POST") return route.continue().catch(() => {});
    await espera;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transcript: "texto da pergunta" }),
    });
  });
  await sessaoAberta(page);
  await ditar(page);
  await expect(page.getByText("Transcrevendo…")).toBeVisible();

  // Sai da composição da pergunta e vai para a interpretação: o hook da
  // pergunta desmonta, e com ele a execução inteira.
  await page.getByRole("button", { name: "Registrar o que entendi" }).click();
  await expect(
    page.getByRole("heading", { name: "O que você entendeu que o paciente disse?" })
  ).toBeVisible();

  soltar!();
  await page.waitForTimeout(800);
  await expect(page.getByLabel("Interpretação do cuidador")).toHaveValue("");
  await expect.poll(() => donoAtual(page)).toBe("NONE");
});

test("perder a rede durante a gravação cancela, e nada é enviado depois", async ({ page, context }) => {
  const chamadas = await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "não deveria chegar" },
  }));
  await sessaoAberta(page);
  await campoPergunta(page).fill("o que eu digitei");
  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));

  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toHaveCount(0);
  await expect(page.getByText(/conexão caiu e o ditado foi interrompido/i)).toBeVisible();
  await expect(campoPergunta(page)).toHaveValue("o que eu digitei");
  expect(chamadas).toHaveLength(0);
  await expect.poll(async () => (await espiao(page)).trilhasParadas).toBeGreaterThan(0);

  // Voltar a rede NÃO reenvia nada e NÃO retoma a gravação.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(botaoDitar(page)).toBeVisible();
  await page.waitForTimeout(900);
  expect(chamadas).toHaveLength(0);
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toHaveCount(0);
});

test("esconder a aba durante a gravação cancela e descarta o áudio", async ({ page }) => {
  const chamadas = await interceptarTranscricao(page, () => ({
    status: 200,
    body: { transcript: "não deveria chegar" },
  }));
  await sessaoAberta(page);
  await botaoDitar(page).click();
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toHaveCount(0);
  await expect(page.getByText(/saiu de vista/i)).toBeVisible();
  expect(chamadas).toHaveLength(0);
  await expect.poll(async () => (await espiao(page)).trilhasParadas).toBeGreaterThan(0);

  // Voltar não retoma sozinho: recomeçar é decisão do cuidador.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(500);
  await expect(page.getByRole("button", { name: /Parar de ditar/ })).toHaveCount(0);
  expect(chamadas).toHaveLength(0);
});

test("o que não cabe no campo não é cortado — nada muda e o cuidador é avisado", async ({ page }) => {
  // O campo aceita 500. Enchemos até 480 e ditamos 60 caracteres.
  const quaseCheio = "a".repeat(480);
  const longa = "b".repeat(60);
  await interceptarTranscricao(page, () => ({ status: 200, body: { transcript: longa } }));
  await sessaoAberta(page);
  await campoPergunta(page).fill(quaseCheio);
  await ditar(page);

  await expect(page.getByText(/não cabe no limite deste campo/i)).toBeVisible();
  await expect(campoPergunta(page)).toHaveValue(quaseCheio);
});

test("voz, edição manual e limpeza: o campo obedece sempre ao cuidador", async ({ page }) => {
  await interceptarTranscricao(page, (n) => ({
    status: 200,
    body: { transcript: n === 1 ? "o senhor esta com dor" : "o senhor quer água" },
  }));
  await sessaoAberta(page);

  await ditar(page);
  await expect(campoPergunta(page)).toHaveValue("o senhor esta com dor");

  // Revisar é o fluxo: o texto ditado não é protegido de nada.
  await campoPergunta(page).fill("O senhor está com dor?");
  await expect(campoPergunta(page)).toHaveValue("O senhor está com dor?");

  // Limpar e recomeçar por voz.
  await campoPergunta(page).fill("");
  await ditar(page);
  await expect(campoPergunta(page)).toHaveValue("o senhor quer água");

  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Revisar antes de apresentar")).toBeVisible();
  await expect(page.getByRole("blockquote")).toHaveText("o senhor quer água");
});

test("provedor lento: dá para esperar, e dá para desistir", async ({ page }) => {
  await page.route("**/api/voice/dictation", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transcript: "demorou mas chegou" }),
    });
  });
  await sessaoAberta(page);
  await ditar(page);

  await expect(page.getByText("Transcrevendo…")).toBeVisible();
  // Enquanto espera, o campo continua digitável — a tela não trava.
  await expect(campoPergunta(page)).toBeEditable();
  await expect(campoPergunta(page)).toHaveValue("demorou mas chegou", { timeout: 8000 });
});
