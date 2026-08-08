// ——— Nenhuma chamada à ElevenLabs fica pendurada (R-10) ———
//
//   npm run test:voice:timeout
//
// Roda o CÓDIGO DE PRODUÇÃO: `chamaElevenLabsJson` e `chamaElevenLabsStream`,
// de lib/voice/eleven-fetch.ts — as funções que /api/tts, o token do Agent e a
// validação de voz do Admin executam. Simulado é o `fetch` global, trocado por
// um que demora o que este teste mandar.
//
// Os prazos reais são de segundos; aqui eles são de milissegundos. O que está
// sendo provado é a MECÂNICA (aborta, classifica, não confunde categorias),
// não a duração — e uma suíte que espera 15 segundos para provar um timeout
// não é rodada por ninguém.
//
// A parte que mais importa é a classificação. Um timeout que se apresenta como
// 401 manda quem opera procurar uma credencial que está perfeitamente boa.

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const {
  chamaElevenLabsJson,
  chamaElevenLabsStream,
  classificaStatus,
  statusParaCliente,
  PRAZOS_ELEVENLABS,
} = await import("../lib/voice/eleven-fetch.ts");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

const fetchOriginal = globalThis.fetch;
/** Captura o que foi para o console.error durante uma chamada. */
function capturandoLogs(fn) {
  const original = console.error;
  const linhas = [];
  console.error = (...args) => linhas.push(args);
  return fn().finally(() => {
    console.error = original;
  });
}

/** Um fetch que responde depois de `atrasoMs`, respeitando o signal. */
function fetchLento(atrasoMs, resposta) {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const id = setTimeout(() => resolve(resposta), atrasoMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(id);
        const erro = new Error("abortado");
        erro.name = "AbortError";
        reject(erro);
      });
    });
}

function respostaJson(dados, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => dados,
    text: async () => JSON.stringify(dados),
  };
}

function respostaStream(status = 200) {
  return { ok: status >= 200 && status < 300, status, body: "«fluxo de áudio»" };
}

console.log("\n— Os prazos existem e são explícitos —");
{
  check("há prazo para o TTS", PRAZOS_ELEVENLABS.tts > 0);
  check("há prazo para o token da conversa", PRAZOS_ELEVENLABS.conversationToken > 0);
  check("há prazo para a consulta de voz", PRAZOS_ELEVENLABS.voiceLookup > 0);
  check(
    "todos entre 1s e 60s",
    Object.values(PRAZOS_ELEVENLABS).every((ms) => ms >= 1000 && ms <= 60_000),
    `— ${JSON.stringify(PRAZOS_ELEVENLABS)}`
  );
}

console.log("\n— JSON: estoura o prazo e vira timeout —");
{
  globalThis.fetch = fetchLento(500, respostaJson({ token: "t" }));
  const inicio = Date.now();
  const r = await capturandoLogs(() =>
    chamaElevenLabsJson("https://api.elevenlabs.io/x", {}, { prazoMs: 40, rotulo: "teste" })
  );
  const decorrido = Date.now() - inicio;
  check("a chamada falha", r.ok === false);
  check("classificada como timeout", r.ok === false && r.falha === "timeout");
  check("e NÃO como unauthorized", r.ok === false && r.falha !== "unauthorized");
  check("sem status HTTP (não houve resposta)", r.ok === false && r.status === null);
  check(
    "e devolve rápido, sem esperar o servidor",
    decorrido < 300,
    `— ${decorrido}ms; sem prazo a requisição prenderia o handler`
  );
}

console.log("\n— Stream: o mesmo prazo, até os cabeçalhos —");
{
  globalThis.fetch = fetchLento(500, respostaStream());
  const r = await capturandoLogs(() =>
    chamaElevenLabsStream("https://api.elevenlabs.io/x", {}, { prazoMs: 40, rotulo: "tts" })
  );
  check("a chamada falha", r.ok === false);
  check("classificada como timeout", r.ok === false && r.falha === "timeout");
}

console.log("\n— Stream: o corpo NÃO é cortado pelo prazo —");
{
  // O ponto de projeto: os cabeçalhos chegam dentro do prazo, e o áudio segue
  // fluindo depois. Um prazo total cortaria a fala do paciente no meio de uma
  // frase — pareceria que a pessoa disse outra coisa.
  globalThis.fetch = fetchLento(10, respostaStream());
  const r = await chamaElevenLabsStream(
    "https://api.elevenlabs.io/x",
    {},
    { prazoMs: 60, rotulo: "tts" }
  );
  check("a resposta é devolvida", r.ok === true);
  check("com o corpo intacto para repassar", r.ok && r.resposta.body === "«fluxo de áudio»");
  // O relógio parou nos cabeçalhos: mesmo esperando muito mais que o prazo,
  // nada aborta o que já está fluindo.
  await new Promise((resolve) => setTimeout(resolve, 120));
  check(
    "e depois do prazo o corpo continua válido",
    r.ok && r.resposta.body === "«fluxo de áudio»",
    "— o relógio parou quando os cabeçalhos chegaram"
  );
}

console.log("\n— Cada categoria de falha é ela mesma —");
{
  const casos = [
    [401, "unauthorized", "credencial"],
    [403, "unauthorized", "credencial"],
    [429, "rateLimited", "cota"],
    [500, "serverError", "provedor"],
    [503, "serverError", "provedor"],
    [404, "rejected", "pedido"],
    [422, "rejected", "pedido"],
    [400, "rejected", "pedido"],
  ];
  for (const [status, esperado, sobre] of casos) {
    check(
      `${status} → ${esperado} (é sobre ${sobre})`,
      classificaStatus(status) === esperado,
      `— veio ${classificaStatus(status)}`
    );
  }
  check(
    "timeout não está entre as classificações por status",
    !casos.some(([status]) => classificaStatus(status) === "timeout"),
    "— timeout só existe quando NÃO houve resposta"
  );
}

console.log("\n— O status chega junto quando houve resposta —");
{
  globalThis.fetch = async () => respostaJson({ error: "nope" }, 401);
  const r = await capturandoLogs(() =>
    chamaElevenLabsJson("https://api.elevenlabs.io/x", {}, { prazoMs: 500, rotulo: "teste" })
  );
  check("falha classificada como unauthorized", r.ok === false && r.falha === "unauthorized");
  check("com o status preservado", r.ok === false && r.status === 401);
}

console.log("\n— Erro de rede é 'network', não 'timeout' —");
{
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const r = await capturandoLogs(() =>
    chamaElevenLabsJson("https://api.elevenlabs.io/x", {}, { prazoMs: 500, rotulo: "teste" })
  );
  check("classificada como network", r.ok === false && r.falha === "network");
  check(
    "distinta de timeout",
    r.ok === false && r.falha !== "timeout",
    "— 'não conseguimos conectar' e 'conectamos e não respondeu' são problemas diferentes"
  );
}

console.log("\n— O log não vaza nada —");
{
  const SEGREDO = "sk_chave_secreta_da_elevenlabs_123456";
  const TEXTO_CLINICO = "Estou com uma dor forte no peito desde ontem à noite.";
  const VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

  globalThis.fetch = async () =>
    respostaJson(
      { detail: `${TEXTO_CLINICO} (voice ${VOICE_ID})`, key: SEGREDO },
      500
    );
  const linhas = [];
  const original = console.error;
  console.error = (...args) => linhas.push(args);
  await chamaElevenLabsJson(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    { headers: { "xi-api-key": SEGREDO } },
    { prazoMs: 500, rotulo: "tts" }
  );
  console.error = original;

  const registrado = JSON.stringify(linhas);
  check("algo foi registrado (dá para diagnosticar)", linhas.length > 0);
  check("a chave da API não aparece", !registrado.includes(SEGREDO));
  check(
    "o texto da fala não aparece",
    !registrado.includes(TEXTO_CLINICO),
    "— o corpo devolvido pela ElevenLabs ecoa o texto enviado"
  );
  check("o voiceId não aparece", !registrado.includes(VOICE_ID));
  check("mas o status aparece", registrado.includes("500"));
  check("e a categoria também", registrado.includes("serverError"));
}

console.log("\n— O timeout também não vaza —");
{
  const SEGREDO = "sk_outra_chave_secreta_987654";
  globalThis.fetch = fetchLento(500, respostaJson({}));
  const linhas = [];
  const original = console.error;
  console.error = (...args) => linhas.push(args);
  await chamaElevenLabsJson(
    "https://api.elevenlabs.io/v1/convai/conversation/token",
    { headers: { "xi-api-key": SEGREDO } },
    { prazoMs: 30, rotulo: "conversationToken" }
  );
  console.error = original;
  const registrado = JSON.stringify(linhas);
  check("a chave não aparece no log de timeout", !registrado.includes(SEGREDO));
  check("a categoria timeout aparece", registrado.includes("timeout"));
}

console.log("\n— A categoria vira o status certo para o cliente —");
{
  // 503 é o que o cliente reconhece como "temporário" e usa para abrir o prazo
  // de espera (lib/voice/eleven-availability.ts). 502 é "o provedor está no ar
  // e recusou" — insistir não adianta, e degradar seria diagnóstico falso.
  check("timeout → 503", statusParaCliente("timeout") === 503);
  check("serverError → 503", statusParaCliente("serverError") === 503);
  check("rateLimited → 503", statusParaCliente("rateLimited") === 503);
  check("network → 503", statusParaCliente("network") === 503);
  check(
    "unauthorized → 502",
    statusParaCliente("unauthorized") === 502,
    "— uma credencial recusada não pode desligar a voz da aba por 30 segundos"
  );
  check("rejected → 502", statusParaCliente("rejected") === 502);
}

console.log("\n— Os pontos de uso realmente passam pelo módulo —");
{
  const { readFileSync } = await import("node:fs");
  const alvos = [
    ["app/api/tts/route.ts", "chamaElevenLabsStream", "PRAZOS_ELEVENLABS.tts"],
    ["app/api/helo/conversation-token/route.ts", "chamaElevenLabsJson", "PRAZOS_ELEVENLABS.conversationToken"],
    ["lib/voice-catalog.ts", "chamaElevenLabsJson", "PRAZOS_ELEVENLABS.voiceLookup"],
  ];
  for (const [arquivo, funcao, prazo] of alvos) {
    const fonte = readFileSync(arquivo, "utf8");
    check(`${arquivo} usa ${funcao}`, fonte.includes(funcao));
    check(`${arquivo} declara o prazo`, fonte.includes(prazo));
    check(
      `${arquivo} não chama a ElevenLabs por fora`,
      !/\bfetch\(\s*[`"']https:\/\/api\.elevenlabs\.io/.test(fonte),
      "— uma chamada crua não tem prazo nenhum"
    );
  }
}

console.log("\n— O corpo cru da ElevenLabs não é mais registrado —");
{
  const { readFileSync } = await import("node:fs");
  const tts = readFileSync("app/api/tts/route.ts", "utf8");
  check(
    "/api/tts não lê nem loga o corpo de erro do provedor",
    !/await res\.text\(\)/.test(tts) && !/detail/.test(tts),
    "— ele ecoa o texto enviado, que numa fala do paciente é conteúdo clínico"
  );
  const functions = readFileSync("functions/index.js", "utf8");
  check(
    "a síntese de frase nas Functions também não",
    !/await eleven\.text\(\)/.test(functions)
  );
  check(
    "e a síntese de frase ganhou prazo",
    /PHRASE_TTS_TIMEOUT_MS/.test(functions) && /AbortSignal\.timeout/.test(functions)
  );
}

globalThis.fetch = fetchOriginal;

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
