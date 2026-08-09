// ——— A política de retenção zero é invariável ———
//
//   npm run test:dictation:retention
//
// O workspace ElevenLabs do Helo está no Grant Tier 2. Retenção zero é recurso
// Enterprise, e a ElevenLabs confirmou que uma requisição com
// `enable_logging=false` NÃO será aceita no plano atual. O ditado, portanto,
// nasce desligado em produção.
//
// O risco não é o recurso ficar desligado. É alguém — de boa-fé, às duas da
// manhã, com um cuidador reclamando que "o microfone não funciona" — tirar o
// parâmetro para destravar. A partir daí o Helo passaria a enviar a voz de um
// cuidador falando sobre dor, medicação e despedida para um histórico que
// ninguém decidiu criar, e nada na tela mudaria.
//
// Então a regra é uma só, e é esta suíte que a segura:
//
//     DITADO HABILITADO = RETENÇÃO ZERO OBRIGATÓRIA.
//
// Sem alternativa configurável, sem fallback, sem segunda tentativa. Se o
// provedor recusar, o ditado fica indisponível e a digitação segue intacta.
//
// Roda o código de produção (`lib/voice/dictation-server.ts`) com o `fetch`
// global trocado. Nenhuma chamada real, nenhum crédito gasto.

import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { TAMANHO_MAXIMO_BYTES } = await import("../lib/voice/dictation.ts");
const { ditadoDisponivel, ditadoHabilitado, provedorConfigurado, transcreve } =
  await import("../lib/voice/dictation-server.ts");

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
const CHAVE = "sk-chave-de-teste-que-nunca-pode-vazar";

/** Registra TODA chamada que sair — inclusive as que não deveriam existir. */
function espiao(responder) {
  const chamadas = [];
  globalThis.fetch = async (url, init) => {
    chamadas.push({ url: String(url), init });
    return responder(chamadas.length);
  };
  return chamadas;
}

function resposta(status, dados) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => dados,
    text: async () => JSON.stringify(dados),
  };
}

function capturandoErros(fn) {
  const original = console.error;
  const linhas = [];
  console.error = (...args) => linhas.push(args.map((a) => JSON.stringify(a)).join(" "));
  return fn().finally(() => {
    console.error = original;
  });
}

const audio = () => new Blob([new Uint8Array(2048)], { type: "audio/webm" });

function comAmbiente(vars, fn) {
  const antes = {};
  for (const [k, v] of Object.entries(vars)) {
    antes[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

console.log("\n— A flag: desligada por omissão, e só liga com \"true\" exato —");
{
  comAmbiente({ HELO_VOICE_DICTATION_ENABLED: undefined }, () => {
    check("variável AUSENTE → ditado indisponível", ditadoHabilitado() === false);
  });
  for (const valor of ["false", "", "0", "1", "yes", "sim", "TRUE", "True", " true"]) {
    comAmbiente({ HELO_VOICE_DICTATION_ENABLED: valor }, () => {
      check(`"${valor}" não habilita`, ditadoHabilitado() === false);
    });
  }
  comAmbiente({ HELO_VOICE_DICTATION_ENABLED: "true" }, () => {
    check('"true" habilita', ditadoHabilitado() === true);
  });

  comAmbiente({ HELO_VOICE_DICTATION_ENABLED: "true", ELEVENLABS_API_KEY: undefined }, () => {
    check("flag ligada sem chave → indisponível", ditadoDisponivel() === false);
    check("…e a ausência da chave é reconhecida", provedorConfigurado() === false);
  });
  comAmbiente({ HELO_VOICE_DICTATION_ENABLED: "false", ELEVENLABS_API_KEY: CHAVE }, () => {
    check("chave presente com flag desligada → indisponível", ditadoDisponivel() === false);
  });
  comAmbiente({ HELO_VOICE_DICTATION_ENABLED: "true", ELEVENLABS_API_KEY: CHAVE }, () => {
    check("flag ligada com chave → disponível", ditadoDisponivel() === true);
  });

  // A flag NÃO pode ser NEXT_PUBLIC: isso a mandaria para o navegador, onde
  // ela vira sugestão em vez de decisão.
  // Sem os comentários: o cabeçalho do módulo EXPLICA por que não se usa
  // NEXT_PUBLIC, e uma busca ingênua acusaria justamente a explicação. Foi o
  // que aconteceu duas vezes na 5.1B.
  const servidor = readFileSync("lib/voice/dictation-server.ts", "utf8")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  check(
    "a decisão não usa NEXT_PUBLIC",
    !/NEXT_PUBLIC/.test(servidor),
    "— a configuração iria para o bundle do navegador"
  );
  const rota = readFileSync("app/api/voice/dictation/route.ts", "utf8");
  check(
    "o cliente recebe estado derivado, não a configuração",
    /available:\s*ditadoDisponivel\(\)/.test(rota) &&
      !/HELO_VOICE_DICTATION_ENABLED/.test(rota),
    "— a rota não pode ecoar a variável"
  );
}

console.log("\n— Com o ditado desligado, nenhum áudio chega ao provedor —");
{
  const rota = readFileSync("app/api/voice/dictation/route.ts", "utf8");
  const posFlag = rota.indexOf("ditadoDisponivel()", rota.indexOf("export async function POST"));
  const posCorpo = rota.indexOf("request.formData()");
  check("o POST confere a disponibilidade", posFlag > 0);
  check(
    "…ANTES de ler o corpo da requisição",
    posFlag > 0 && posCorpo > 0 && posFlag < posCorpo,
    "— recusar depois de receber o áudio não é a mesma coisa que não recebê-lo"
  );
  const posAuth = rota.indexOf("requirePatientAccess");
  check(
    "…e depois de autorizar o vínculo com o paciente",
    posAuth > 0 && posAuth < posFlag
  );
  check(
    "o paciente vai por cabeçalho, não pela URL",
    /headers\.get\("x-helo-patient-id"\)/.test(rota),
    "— identificador em query string acaba em log de acesso"
  );
  check("a resposta é no-store", /Cache-Control": "no-store/.test(rota));
  check("há teto de bytes na rota", rota.includes("TAMANHO_MAXIMO_BYTES") && TAMANHO_MAXIMO_BYTES > 0);
  check("há allowlist de formato na rota", /tipoDeAudioAceito\(audio\.type\)/.test(rota));
  check(
    "o filename do multipart não é consultado",
    !/audio\.name/.test(rota),
    "— um nome de arquivo nunca foi evidência de formato"
  );
}

console.log("\n— Retenção zero acompanha TODA chamada —");
{
  await comAmbiente({ ELEVENLABS_API_KEY: CHAVE }, async () => {
    const chamadas = espiao(() => resposta(200, { text: "o senhor está com dor?" }));
    const r = await transcreve(audio());
    check("a transcrição chega ao produto", r.ok === true && r.transcript === "o senhor está com dor?");
    check("uma chamada, exatamente", chamadas.length === 1, `— foram ${chamadas.length}`);
    check(
      "com enable_logging=false na URL",
      chamadas[0].url.includes("enable_logging=false"),
      `— ${chamadas[0].url}`
    );
    check(
      "e enable_logging NÃO vai no multipart",
      !(chamadas[0].init.body instanceof FormData) || chamadas[0].init.body.get("enable_logging") === null
    );
    const corpo = chamadas[0].init.body;
    check("o corpo é multipart", corpo instanceof FormData);
    check("com o modelo de transcrição", corpo.get("model_id") === "scribe_v2");
    check("e com português explícito", corpo.get("language_code") === "por");
    check("a chave vai no cabeçalho", chamadas[0].init.headers["xi-api-key"] === CHAVE);
    check(
      "a chave NUNCA vai na URL",
      !chamadas[0].url.includes(CHAVE),
      "— URLs acabam em log de proxy"
    );
    // Nenhum recurso extra do Scribe entra pela porta dos fundos.
    for (const extra of ["diarize", "num_speakers", "entity_detection", "keyterms", "translate"]) {
      check(`o pedido não inclui "${extra}"`, corpo.get(extra) === null);
    }
  });
}

console.log("\n— Recusa do provedor: falha FECHADA, sem segunda chance —");
{
  // O caso conhecido: Grant Tier 2 recusando o modo de retenção zero.
  for (const status of [400, 401, 403, 422, 429, 500, 503]) {
    await comAmbiente({ ELEVENLABS_API_KEY: CHAVE }, async () => {
      const chamadas = espiao(() => resposta(status, { detail: "zero retention not available" }));
      const r = await capturandoErros(() => transcreve(audio()));
      check(`status ${status} → sem transcrição`, r.ok === false);
      check(
        `status ${status} → UMA única chamada`,
        chamadas.length === 1,
        `— foram ${chamadas.length}; qualquer repetição é uma segunda gravação do mesmo áudio`
      );
      check(
        `status ${status} → a única chamada exigiu retenção zero`,
        chamadas[0].url.includes("enable_logging=false")
      );
      check(
        `status ${status} → nenhuma chamada com enable_logging=true`,
        !chamadas.some((c) => /enable_logging=(?!false)/.test(c.url))
      );
      check(
        `status ${status} → nenhuma chamada sem o parâmetro`,
        !chamadas.some((c) => !c.url.includes("enable_logging=")),
        "— remover o parâmetro é exatamente o conserto proibido"
      );
    });
  }

  // Falha de rede: mesma regra. Não é "tente de novo mais tarde por conta
  // própria" — é "não deu, e o áudio já não existe mais".
  await comAmbiente({ ELEVENLABS_API_KEY: CHAVE }, async () => {
    const chamadas = espiao(() => {
      throw new TypeError("conexão recusada");
    });
    const r = await capturandoErros(() => transcreve(audio()));
    check("erro de rede → sem transcrição", r.ok === false);
    check("erro de rede → uma chamada só", chamadas.length === 1);
  });

  await comAmbiente({ ELEVENLABS_API_KEY: undefined }, async () => {
    const chamadas = espiao(() => resposta(200, { text: "não deveria acontecer" }));
    const r = await transcreve(audio());
    check("sem chave → nem sai da máquina", r.ok === false && chamadas.length === 0);
  });
}

console.log("\n— Não existe retentativa nem fila de áudio no código —");
{
  const arquivos = [
    "lib/voice/dictation.ts",
    "lib/voice/dictation-server.ts",
    "lib/voice/use-dictation.ts",
    "app/api/voice/dictation/route.ts",
    "components/voice/dictation-button.tsx",
  ];
  for (const arquivo of arquivos) {
    const fonte = readFileSync(arquivo, "utf8");
    const corpo = fonte.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

    // O áudio bruto não pode ser guardado em lugar nenhum. Nem "só enquanto a
    // rede não volta", que é como toda persistência indesejada começa.
    for (const deposito of [
      "indexedDB",
      "localStorage",
      "sessionStorage",
      "caches",
      "OfflineOperation",
      "registrar(",
      "gravarOperacao",
      "gravarRascunho",
      "createObjectURL",
    ]) {
      check(
        `${arquivo} não usa ${deposito}`,
        !corpo.includes(deposito),
        "— áudio bruto não é persistido, nem enfileirado, nem reproduzido"
      );
    }
    // Nada de laço de repetição sobre a chamada.
    check(
      `${arquivo} não tem laço de retentativa`,
      !/(while\s*\(|for\s*\(\s*let\s+tentativa|retry|reenvi)/i.test(corpo),
      "— uma retentativa é uma segunda gravação do mesmo áudio no provedor"
    );
  }
}

console.log("\n— Logs: status e categoria, nunca conteúdo —");
{
  await comAmbiente({ ELEVENLABS_API_KEY: CHAVE }, async () => {
    espiao(() => resposta(403, { detail: "o senhor está com dor na perna", text: "clinico" }));
    const linhas = [];
    const original = console.error;
    console.error = (...args) => linhas.push(args.map((a) => JSON.stringify(a)).join(" "));
    await transcreve(audio());
    console.error = original;

    const tudo = linhas.join("\n");
    check("houve registro da falha", linhas.length > 0);
    check("a chave não aparece no log", !tudo.includes(CHAVE));
    check(
      "o corpo devolvido pelo provedor não aparece",
      !tudo.includes("dor na perna"),
      `— ${tudo}`
    );
    check("o status aparece, que é o que serve para diagnosticar", tudo.includes("403"));
  });
}

globalThis.fetch = fetchOriginal;
console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
