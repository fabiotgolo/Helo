// ——— O que entra no endpoint e o que volta do provedor ———
//
//   npm run test:dictation:content
//
// Duas conferências que a Fase 5.2A não tinha, e que são simétricas: uma olha o
// que CHEGA, outra olha o que VOLTA.
//
// A que chega: até aqui o servidor acreditava no `Content-Type` que a parte do
// multipart declarava. Esse campo é texto escrito pelo cliente. Um cliente que
// não seja o Helo escreve `audio/webm` e envia o que quiser — e o que ele
// enviar sai daqui para a ElevenLabs com a chave do Helo. A assinatura do
// contêiner não é escrita pelo cliente: ou os bytes são um WebM, ou não são.
//
// A que volta: um 200 não garante um corpo. Um provedor com defeito, uma
// resposta de outro endpoint, uma página de erro de um proxy no meio do
// caminho — todos podem chegar como 200, e nenhum deles pode virar
// `[object Object]` dentro de uma pergunta que um paciente vai ler.
//
// Roda o código de produção. Nenhuma chamada real, nenhum crédito gasto.

import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { detectaContainer, containerCombinaComTipo, verificaContainer, BYTES_DE_ASSINATURA } =
  await import("../lib/voice/audio-container.ts");
const {
  PRAZO_TRANSCRICAO_MS,
  TAMANHO_MAXIMO_BYTES,
  TAMANHO_MAXIMO_TRANSCRICAO,
  tipoDeAudioAceito,
  validaTranscricao,
} = await import("../lib/voice/dictation.ts");
const { transcreve } = await import("../lib/voice/dictation-server.ts");

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
function secao(titulo) {
  console.log(`\n${titulo}`);
}

// ——— Amostras mínimas de cada contêiner ———
//
// Não são arquivos tocáveis, e não precisam ser: o que o servidor lê são os
// primeiros bytes, e é exatamente isso que está aqui. Um MP4 de verdade
// continuaria com `moov`, `mdat` e o áudio; nada disso muda o veredicto.
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x23]);
const OGG = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const MP4 = Uint8Array.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
const RUIDO = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
const VAZIO = new Uint8Array(0);
// Um `<!DOCTYPE html>` — a página de erro que um proxy devolve com status 200.
const HTML = new TextEncoder().encode("<!DOCTYPE html><html><body>4");

// ==========================================================================
secao("§12 · O contêiner é lido nos bytes, não no que o cliente diz");
// ==========================================================================

check("EBML → webm", detectaContainer(WEBM) === "webm");
check("OggS → ogg", detectaContainer(OGG) === "ogg");
check("ftyp no byte 4 → mp4", detectaContainer(MP4) === "mp4");
check("bytes aleatórios → nada", detectaContainer(RUIDO) === null);
check("arquivo vazio → nada", detectaContainer(VAZIO) === null);
check("HTML disfarçado de áudio → nada", detectaContainer(HTML) === null);
check("três bytes não bastam para decidir", detectaContainer(WEBM.slice(0, 3)) === null);
check("nem cinco, para o mp4", detectaContainer(MP4.slice(0, 5)) === null);
check("doze bytes é tudo que se lê", BYTES_DE_ASSINATURA === 12);

// O ftyp precisa estar EXATAMENTE no byte 4. Um arquivo que só contém "ftyp"
// em algum lugar no meio não é um MP4.
check(
  "ftyp fora do lugar não conta",
  detectaContainer(new TextEncoder().encode("xxxxxftypM4A ")) === null
);

check("webm combina com audio/webm", containerCombinaComTipo("webm", "audio/webm"));
check("ogg combina com audio/ogg", containerCombinaComTipo("ogg", "audio/ogg"));
check("mp4 combina com audio/mp4", containerCombinaComTipo("mp4", "audio/mp4"));
check("webm NÃO combina com audio/ogg", !containerCombinaComTipo("webm", "audio/ogg"));
check("mp4 NÃO combina com audio/webm", !containerCombinaComTipo("mp4", "audio/webm"));

// ==========================================================================
secao("§12 · Declaração e conteúdo têm de concordar");
// ==========================================================================

check("webm declarado como webm passa", verificaContainer(WEBM, "audio/webm").ok);
check("ogg declarado como ogg passa", verificaContainer(OGG, "audio/ogg").ok);
check("mp4 declarado como mp4 passa", verificaContainer(MP4, "audio/mp4").ok);

const mentira = verificaContainer(WEBM, "audio/mp4");
check("webm declarado como mp4 é recusado", !mentira.ok);
check("…e o log sabe que é incoerência, não formato novo", mentira.motivo === "incoerente");
check("…identificando o que ele era de verdade", mentira.container === "webm");

const ruidoDeclarado = verificaContainer(RUIDO, "audio/webm");
check("ruído declarado como webm é recusado", !ruidoDeclarado.ok);
check("…como desconhecido, que é outro diagnóstico", ruidoDeclarado.motivo === "desconhecido");

check("HTML declarado como webm é recusado", !verificaContainer(HTML, "audio/webm").ok);
check("vazio declarado como qualquer coisa é recusado", !verificaContainer(VAZIO, "audio/mp4").ok);

// ==========================================================================
secao("§11 · A allowlist de tipos continua de pé");
// ==========================================================================

check("audio/webm passa", tipoDeAudioAceito("audio/webm") === "audio/webm");
check("com codecs, passa", tipoDeAudioAceito("audio/webm;codecs=opus") === "audio/webm");
check("audio/ogg com codecs, passa", tipoDeAudioAceito("audio/ogg; codecs=opus") === "audio/ogg");
check("audio/mp4 passa", tipoDeAudioAceito("audio/mp4") === "audio/mp4");
check("audio/wav não passa", tipoDeAudioAceito("audio/wav") === null);
check("parâmetro desconhecido não passa", tipoDeAudioAceito("audio/webm;boundary=x") === null);
check("vazio não passa", tipoDeAudioAceito("") === null);
check("nada não passa", tipoDeAudioAceito(undefined) === null);

// ==========================================================================
secao("§13 · O teto de bytes é o real, não o declarado");
// ==========================================================================

check("o teto continua em 2 MiB", TAMANHO_MAXIMO_BYTES === 2 * 1024 * 1024);
// A aritmética que sustenta o número: 60s de opus a 32 kbps mono ≈ 240 KB;
// o Safari entrega AAC a ~64 kbps ≈ 480 KB. O teto é ~4× o pior caso real.
check("…o que é folga larga sobre o pior caso real", TAMANHO_MAXIMO_BYTES > 480 * 1024 * 4);
check("…e ainda assim um limite de verdade", TAMANHO_MAXIMO_BYTES < 8 * 1024 * 1024);

// ==========================================================================
secao("§16 · A resposta do provedor é conferida como estrutura");
// ==========================================================================

check("string vira transcrição", validaTranscricao("o senhor está com dor?") === "o senhor está com dor?");
check("string vazia é transcrição vazia, não erro", validaTranscricao("") === "");
check("só espaço vira vazio", validaTranscricao("   \n  ") === "");
check("quebras de linha viram espaço", validaTranscricao("linha um\nlinha dois") === "linha um linha dois");
check("objeto não é transcrição", validaTranscricao({ text: "oi" }) === null);
check("array não é transcrição", validaTranscricao(["oi"]) === null);
check("número não é transcrição", validaTranscricao(42) === null);
check("null não é transcrição", validaTranscricao(null) === null);
check("undefined não é transcrição", validaTranscricao(undefined) === null);
check(
  "texto gigante não é transcrição",
  validaTranscricao("a".repeat(TAMANHO_MAXIMO_TRANSCRICAO + 1)) === null
);
check(
  "no limite exato ainda é",
  validaTranscricao("a".repeat(TAMANHO_MAXIMO_TRANSCRICAO)) !== null
);
check(
  "o teto é folgado para um minuto de fala (~900 caracteres)",
  TAMANHO_MAXIMO_TRANSCRICAO >= 4000
);

// ==========================================================================
secao("§16 · E o que não serve não chega ao campo");
// ==========================================================================

const fetchOriginal = globalThis.fetch;
const CHAVE = "sk-chave-de-teste-que-nunca-pode-vazar";

function respondeCom(corpo) {
  const chamadas = [];
  globalThis.fetch = async (url, init) => {
    chamadas.push({ url: String(url), init });
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return chamadas;
}

const audio = new Blob([WEBM], { type: "audio/webm" });
process.env.ELEVENLABS_API_KEY = CHAVE;

for (const [rotulo, corpo] of [
  ["objeto no lugar do texto", { text: { valor: "oi" } }],
  ["array no lugar do texto", { text: ["oi"] }],
  ["número no lugar do texto", { text: 7 }],
  ["campo ausente", { language_probability: 0.9 }],
  ["corpo vazio", {}],
  ["texto absurdamente longo", { text: "a".repeat(TAMANHO_MAXIMO_TRANSCRICAO + 100) }],
]) {
  const chamadas = respondeCom(corpo);
  const r = await transcreve(audio);
  check(`${rotulo} → falha, não texto`, r.ok === false && r.falha === "badResponse");
  check(`${rotulo} → uma única chamada`, chamadas.length === 1);
}

const chamadasOk = respondeCom({ text: "  o senhor  está\ncom dor?  ", language_probability: 0.99 });
const bom = await transcreve(audio);
check("resposta boa vira texto limpo", bom.ok === true && bom.transcript === "o senhor está com dor?");
check("…numa chamada só", chamadasOk.length === 1);
check(
  "…e a exigência de retenção zero foi junto",
  chamadasOk[0].url.includes("enable_logging=false")
);

const chamadasSilencio = respondeCom({ text: "" });
const silencio = await transcreve(audio);
check("silêncio é sucesso com texto vazio", silencio.ok === true && silencio.transcript === "");
check("…e também numa chamada só", chamadasSilencio.length === 1);

globalThis.fetch = fetchOriginal;
delete process.env.ELEVENLABS_API_KEY;

// ==========================================================================
secao("§14 · O prazo cobre o corpo, não só os cabeçalhos");
// ==========================================================================

function fonte(caminho) {
  return readFileSync(new URL(`../${caminho}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const servidorDoDitado = fonte("lib/voice/dictation-server.ts");
const buscaElevenLabs = fonte("lib/voice/eleven-fetch.ts");

check("a transcrição usa a chamada de prazo TOTAL", /chamaElevenLabsJson/.test(servidorDoDitado));
check(
  "…e não a de prazo até os cabeçalhos, que é do TTS",
  !/chamaElevenLabsStream/.test(servidorDoDitado)
);
check(
  "…e o prazo total realmente envolve a leitura do JSON",
  /const resposta = await fetch\(url, \{ \.\.\.init, signal: prazo\.signal \}\)[\s\S]*?await resposta\.json\(\)[\s\S]*?finally \{[\s\S]*?prazo\.encerra\(\)/.test(
    buscaElevenLabs
  )
);
check("o prazo do ditado são 30 s", PRAZO_TRANSCRICAO_MS === 30_000);

// ==========================================================================
secao("§26 · Nada disso alcança uma superfície do paciente");
// ==========================================================================

// As telas que o PACIENTE olha não conhecem o ditado — nem para desabilitá-lo.
// É uma ausência de importação, que é mais forte que uma condição de render.
for (const arquivo of [
  "components/realtime-questions/question-stage.tsx",
  "components/realtime-questions/patient-controls.tsx",
]) {
  const texto = fonte(arquivo);
  check(
    `${arquivo.split("/").pop()} não importa nada do ditado`,
    !/use-dictation|dictation-button|DictationButton|useDictationField/.test(texto)
  );
  check(
    `${arquivo.split("/").pop()} não mostra estado técnico de STT`,
    !/(transcri|Transcrevendo|enable_logging|scribe|ZRM|Enterprise)/i.test(texto)
  );
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam`);
process.exit(failed === 0 ? 0 : 1);
