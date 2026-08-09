// ——— O domínio do ditado: limites, formatos e o texto que entra no campo ———
//
//   npm run test:dictation:domain
//
// Roda o CÓDIGO DE PRODUÇÃO de lib/voice/dictation.ts — as mesmas funções que
// o endpoint e o hook executam. Aqui não há microfone nem rede: o que está
// sendo provado é a aritmética e as regras que não dependem de nenhum dos dois.
//
// A parte que mais importa é `aplicaTranscricao`. Ela decide o que acontece com
// o que o cuidador já tinha digitado, e errar ali significa apagar, sem aviso,
// uma frase que alguém escreveu no meio de um atendimento.

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const {
  AVISO_LIMITE_DE_TEMPO,
  BITRATE_ALVO,
  DURACAO_MAXIMA_MS,
  IDIOMA_SCRIBE,
  MODELO_SCRIBE,
  PRAZO_TRANSCRICAO_MS,
  TAMANHO_MAXIMO_BYTES,
  TIPOS_DE_AUDIO_ACEITOS,
  aplicaTranscricao,
  classificaErroDeCaptura,
  classificaRespostaDoDitado,
  limpaTranscricao,
  mensagemDoDitado,
  tipoDeAudioAceito,
  urlDoScribe,
} = await import("../lib/voice/dictation.ts");

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

console.log("\n— Limites: explícitos, configuráveis e coerentes entre si —");
{
  check("a captura tem teto de 60 segundos", DURACAO_MAXIMA_MS === 60_000);
  check(
    "o teto de bytes existe e é independente do cronômetro",
    TAMANHO_MAXIMO_BYTES === 2 * 1024 * 1024,
    `— ${TAMANHO_MAXIMO_BYTES}`
  );
  // A folga é o que impede o teto de bytes de virar uma recusa arbitrária no
  // meio de uma captura legítima. 60s a 32 kbps ≈ 240 KB.
  const piorCasoBytes = (DURACAO_MAXIMA_MS / 1000) * (BITRATE_ALVO / 8);
  check(
    "o teto de bytes comporta uma captura inteira com folga",
    TAMANHO_MAXIMO_BYTES > piorCasoBytes * 3,
    `— ${TAMANHO_MAXIMO_BYTES} contra ${piorCasoBytes} do pior caso`
  );
  check("há prazo para a chamada ao provedor", PRAZO_TRANSCRICAO_MS > 0);
  check(
    "o prazo cobre uma captura cheia sendo transcrita",
    PRAZO_TRANSCRICAO_MS >= 20_000,
    `— ${PRAZO_TRANSCRICAO_MS}ms`
  );
  check("o aviso de limite de tempo existe e é legível", /limite|máximo/i.test(AVISO_LIMITE_DE_TEMPO));
}

console.log("\n— Retenção zero vai na URL, sempre —");
{
  const url = urlDoScribe();
  check("a URL do provedor exige enable_logging=false", url.includes("enable_logging=false"), `— ${url}`);
  check("…e é o endpoint de speech-to-text", url.startsWith("https://api.elevenlabs.io/v1/speech-to-text"), `— ${url}`);
  // Nenhuma sobrecarga, nenhum parâmetro, nenhum jeito de a função devolver a
  // URL sem a exigência. Se alguém acrescentar um, este teste cai.
  check(
    "não existe forma de montar a URL sem a exigência",
    urlDoScribe("https://exemplo.invalido/v1/speech-to-text").includes("enable_logging=false")
  );
}

console.log("\n— Só áudio → texto: nenhum recurso extra do Scribe —");
{
  check("o modelo é o de transcrição", MODELO_SCRIBE === "scribe_v2");
  check("o idioma é português explícito, não autodetecção", IDIOMA_SCRIBE === "por");

  // Os recursos que a fase proíbe não podem aparecer como constante em lugar
  // nenhum do módulo — é assim que um "só para testar" vira produção.
  const fonte = await import("node:fs").then((fs) =>
    fs.readFileSync("lib/voice/dictation-server.ts", "utf8")
  );
  const corpo = fonte.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const proibido of [
    "diarize",
    "num_speakers",
    "speaker",
    "entity_detection",
    "keyterms",
    "translate",
    "summar",
  ]) {
    check(
      `o servidor não pede "${proibido}" ao provedor`,
      !new RegExp(proibido, "i").test(corpo)
    );
  }
}

console.log("\n— Formatos: só o que os navegadores suportados produzem —");
{
  check("webm, ogg e mp4 — e nada além", TIPOS_DE_AUDIO_ACEITOS.length === 3);
  for (const bom of [
    "audio/webm",
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/mp4",
    "AUDIO/WEBM",
  ]) {
    check(`aceita ${bom}`, tipoDeAudioAceito(bom) !== null);
  }
  for (const ruim of [
    "audio/wav",
    "audio/mpeg",
    "application/octet-stream",
    "text/plain",
    "audio/webm; boundary=--x",
    "",
    null,
    undefined,
    42,
    "audio/webm;codecs",
  ]) {
    check(`recusa ${JSON.stringify(ruim)}`, tipoDeAudioAceito(ruim) === null);
  }
  check(
    "o tipo devolvido é o base, sem parâmetros",
    tipoDeAudioAceito("audio/webm;codecs=opus") === "audio/webm"
  );
}

console.log("\n— Limpeza da transcrição —");
{
  check("tira espaço das pontas", limpaTranscricao("  olá  ") === "olá");
  check("colapsa quebras de linha", limpaTranscricao("a\n\nb") === "a b");
  check("não inventa texto a partir de nada", limpaTranscricao(null) === "");
  check("não aceita objeto como texto", limpaTranscricao({ text: "x" }) === "");
  // Não "corrigimos" o que a pessoa disse.
  check(
    "não mexe em pontuação nem em maiúsculas",
    limpaTranscricao("você está com dor") === "você está com dor"
  );
}

console.log("\n— A transcrição no campo: acrescenta, nunca destrói —");
{
  const vazio = aplicaTranscricao("", "você está com dor?", 500);
  check("campo vazio recebe o texto", vazio.texto === "você está com dor?" && vazio.mudou);

  const comTexto = aplicaTranscricao("Dona Ana,", "a senhora está com dor?", 500);
  check(
    "campo com texto digitado NÃO é apagado",
    comTexto.texto === "Dona Ana, a senhora está com dor?",
    `— "${comTexto.texto}"`
  );

  const doisDitados = aplicaTranscricao("primeira frase.", "segunda frase.", 500);
  check("ditar de novo acrescenta", doisDitados.texto === "primeira frase. segunda frase.");

  const vazia = aplicaTranscricao("o que eu escrevi", "", 500);
  check("transcrição vazia não encosta no campo", vazia.texto === "o que eu escrevi" && !vazia.mudou);
  const soEspaco = aplicaTranscricao("o que eu escrevi", "   ", 500);
  check("…nem quando vem só espaço", soEspaco.texto === "o que eu escrevi" && !soEspaco.mudou);

  // ——— O que não cabe não entra (5.2B, §22) ———
  //
  // A 5.2A cortava no limite e avisava. Cortar produz uma pergunta que termina
  // no meio, apresentada a alguém que só pode responder SIM ou NÃO — e o corte
  // só aparece depois do botão "Continuar", porque quem ditou estava olhando
  // para o paciente. Agora nada é escrito e o campo fica intacto.
  const naoCoube = aplicaTranscricao("", "a".repeat(40), 10);
  check("o que não cabe não é cortado, é recusado", naoCoube.mudou === false);
  check("…e o campo fica exatamente como estava", naoCoube.texto === "");
  check("…com o aviso ligado", naoCoube.naoCoube === true);

  const naoApaga = aplicaTranscricao("texto que o cuidador digitou", "b".repeat(40), 30);
  check(
    "o texto que já existia sobrevive à recusa",
    naoApaga.texto === "texto que o cuidador digitou" && !naoApaga.mudou && naoApaga.naoCoube
  );
  check("cabendo, não avisa", aplicaTranscricao("", "curto", 500).naoCoube === false);
  check("no limite exato, entra", aplicaTranscricao("", "abcde", 5).mudou === true);

  // O separador não pode duplicar espaço nem colar palavras.
  check(
    "não gera espaço duplo",
    aplicaTranscricao("frase ", "outra", 500).texto === "frase outra"
  );
}

console.log("\n— Erros: categoria certa, mensagem sem jargão —");
{
  const casos = [
    ["NotAllowedError", "PERMISSION_DENIED"],
    ["SecurityError", "PERMISSION_DENIED"],
    ["NotFoundError", "NO_DEVICE"],
    ["NotReadableError", "NO_DEVICE"],
    ["OverconstrainedError", "NO_DEVICE"],
    ["AbortError", "CANCELLED"],
    ["TypeError", "UNSUPPORTED"],
    ["QuotaExceededError", "UNKNOWN"],
  ];
  for (const [nome, esperado] of casos) {
    check(
      `${nome} → ${esperado}`,
      classificaErroDeCaptura({ name: nome }) === esperado,
      `— veio ${classificaErroDeCaptura({ name: nome })}`
    );
  }
  check("erro sem nome não quebra", classificaErroDeCaptura(null) === "UNKNOWN");

  check("504 é timeout", classificaRespostaDoDitado(504) === "TIMEOUT");
  check("503 é indisponibilidade", classificaRespostaDoDitado(503) === "PROVIDER_UNAVAILABLE");
  check("403 não vira erro do cuidador", classificaRespostaDoDitado(403) === "PROVIDER_UNAVAILABLE");
  check("415 também não", classificaRespostaDoDitado(415) === "PROVIDER_UNAVAILABLE");

  // O vocabulário proibido: nada disto pode chegar a quem está ao lado do
  // paciente. "Enterprise", "retenção", status HTTP e nome de provedor
  // descrevem a nossa configuração, não o que a pessoa deve fazer.
  const proibido = /(enterprise|retenç|zero.?retention|elevenlabs|scribe|http|4\d\d|5\d\d|token|api|multipart|mime|flag)/i;
  const falhas = [
    "PERMISSION_DENIED",
    "NO_DEVICE",
    "UNSUPPORTED",
    "OFFLINE",
    "TIMEOUT",
    "PROVIDER_UNAVAILABLE",
    "EMPTY_TRANSCRIPT",
    "CANCELLED",
    "UNKNOWN",
  ];
  for (const falha of falhas) {
    const mensagem = mensagemDoDitado(falha);
    check(`${falha} tem mensagem própria`, mensagem.length > 10);
    check(`${falha} fala a língua do cuidador`, !proibido.test(mensagem), `— "${mensagem}"`);
  }
  // Quase toda falha precisa dizer que dá para digitar — é a informação que
  // desbloqueia a pessoa. As exceções são as que não bloqueiam nada.
  for (const falha of falhas.filter((f) => !["CANCELLED", "EMPTY_TRANSCRIPT", "OFFLINE", "TIMEOUT"].includes(f))) {
    check(
      `${falha} lembra que a digitação continua`,
      /digitar/i.test(mensagemDoDitado(falha)),
      `— "${mensagemDoDitado(falha)}"`
    );
  }
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
