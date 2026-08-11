// ——— A superfície que fala com a ElevenLabs não cresce sozinha (Fase 5.4A) ———
//
//   npm run test:5.4a:superficie
//
// A 5.4A é uma AUDITORIA: ela não corrige nada. Mas uma auditoria só vale
// enquanto o código auditado for o mesmo, e este arquivo é o que amarra as
// duas coisas. Ele NÃO julga se um risco residual foi resolvido — isso é da
// 5.4B e da 5.4C. Ele congela o que a auditoria encontrou CERTO, para que a
// correção dos outros itens não desfaça, de passagem, o que já estava de pé.
//
// Quatro perguntas, e só elas:
//
//   1. CENSO — quais arquivos falam com api.elevenlabs.io? Um endereço novo
//      num arquivo não declarado aqui é uma porta que a auditoria não viu.
//
//   2. SEGREDOS — a chave do provedor e o segredo do SpeechGrant vivem só do
//      lado servidor? Nenhuma variável `NEXT_PUBLIC_` carrega segredo?
//
//   3. RETENÇÃO E FAIL-CLOSED — o Scribe só é alcançável por uma URL que
//      carrega `enable_logging=false`, e o ditado continua desligado por
//      omissão (qualquer valor que não seja exatamente "true").
//
//   4. URL DURÁVEL — `getDownloadURL` (o token de download que ignora as
//      Storage Rules) só existe nas Cloud Functions. Se ele aparecer no app
//      Next, uma segunda fonte de URL pública nasceu sem passar pela 5.4B.
//
// Mais o inventário de NOMES das client tools: a 5.3A registrou cinco aliases
// mantidos porque o contrato do painel não é conhecido. Enquanto ele não for,
// acrescentar um sexto tem de ser uma decisão escrita, não um acréscimo.
//
// Todo comentário é removido antes de qualquer busca: este arquivo fala em
// prosa dos mesmos nomes que procura.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let ok = 0;
let mau = 0;

function checa(nome, condicao, detalhe = "") {
  if (condicao) {
    ok += 1;
    console.log(`  ✓ ${nome}`);
  } else {
    mau += 1;
    console.error(`  ✗ ${nome} ${detalhe}`);
  }
}

function secao(titulo) {
  console.log(`\n${titulo}`);
}

/** Sem comentários: só o código executável entra nas buscas. */
function codigoDe(caminho) {
  return readFileSync(resolve(RAIZ, caminho), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Todo o código do produto: app/, components/, lib/ e as Cloud Functions. */
function fontesDoProduto() {
  const achados = [];
  const ignorar = new Set(["node_modules", ".next", ".git"]);
  const anda = (dir) => {
    for (const entrada of readdirSync(resolve(RAIZ, dir))) {
      if (ignorar.has(entrada)) continue;
      const completo = join(dir, entrada);
      if (statSync(resolve(RAIZ, completo)).isDirectory()) anda(completo);
      else if (/\.(tsx?|js)$/.test(entrada)) achados.push(completo);
    }
  };
  for (const raiz of ["app", "components", "lib"]) anda(raiz);
  achados.push("functions/index.js");
  return achados.map((c) => relative(".", c));
}

const FONTES = fontesDoProduto();

// ——— 1. O censo da superfície ———
//
// Quem pode escrever `api.elevenlabs.io`. Cada linha aqui é uma porta para o
// provedor, e a auditoria da 5.4A descreve cada uma. Acrescentar um arquivo
// exige acrescentar a linha — e, com ela, a pergunta "isto precisa mesmo sair
// daqui?".
const CAMINHOS_ATE_O_PROVEDOR = new Set([
  "app/api/tts/route.ts",
  "app/api/helo/conversation-token/route.ts",
  "lib/voice/dictation.ts",
  "lib/voice-catalog.ts",
  "functions/index.js",
]);

secao("1. o censo da superfície ElevenLabs");
{
  const encontrados = FONTES.filter((f) => /api\.elevenlabs\.io/.test(codigoDe(f)));
  const intrusos = encontrados.filter((f) => !CAMINHOS_ATE_O_PROVEDOR.has(f));
  const sumidos = [...CAMINHOS_ATE_O_PROVEDOR].filter((f) => !encontrados.includes(f));
  checa(
    "nenhum arquivo novo fala com api.elevenlabs.io",
    intrusos.length === 0,
    `— fora do censo: ${intrusos.join(", ")}`
  );
  checa(
    "o censo não tem entrada morta",
    sumidos.length === 0,
    `— declarados e sem uso: ${sumidos.join(", ")}`
  );
  checa(
    "o cliente não fala direto com o provedor",
    !encontrados.some((f) => f.startsWith("components/")),
    "— um componente de navegador alcança a ElevenLabs"
  );
}

// ——— 2. Segredos ———
secao("2. segredos ficam do lado servidor");
{
  const leemAChave = FONTES.filter((f) => /process\.env\.ELEVENLABS_API_KEY/.test(codigoDe(f)));
  checa(
    "ELEVENLABS_API_KEY só é lida em rota, lib de servidor ou Function",
    leemAChave.every(
      (f) =>
        f.startsWith("app/api/") ||
        f.startsWith("lib/voice/") ||
        f === "lib/voice-catalog.ts" ||
        f === "functions/index.js"
    ),
    `— lida em ${leemAChave.filter((f) => f.startsWith("components/")).join(", ")}`
  );
  const leemOSegredo = FONTES.filter((f) =>
    /process\.env\.HELO_SPEECH_GRANT_SECRET/.test(codigoDe(f))
  );
  checa(
    "HELO_SPEECH_GRANT_SECRET só é lido em lib/voice/speech-grant.ts",
    leemOSegredo.length === 1 && leemOSegredo[0] === "lib/voice/speech-grant.ts",
    `— também em ${leemOSegredo.filter((f) => f !== "lib/voice/speech-grant.ts").join(", ")}`
  );

  // `NEXT_PUBLIC_` é inlinado no bundle pelo Next: o nome já denuncia a
  // intenção, e um segredo com esse prefixo chega ao navegador em texto claro.
  const publicas = new Set();
  for (const f of FONTES) {
    for (const m of codigoDe(f).matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) {
      publicas.add(m[1]);
    }
  }
  checa(
    "nenhuma variável NEXT_PUBLIC_ tem cara de segredo",
    ![...publicas].some((v) => /KEY|SECRET|TOKEN|GRANT|PASSWORD|CREDENTIAL/.test(v)),
    `— ${[...publicas].join(", ")}`
  );
  checa(
    "a única NEXT_PUBLIC_ do produto continua sendo a URL da música",
    publicas.size === 1 && publicas.has("NEXT_PUBLIC_GENERATE_MUSIC_URL"),
    `— ${[...publicas].join(", ")}`
  );
}

// ——— 3. Retenção do ditado e fail-closed ———
secao("3. ditado: retenção zero e desligado por omissão");
{
  const dominio = codigoDe("lib/voice/dictation.ts");
  checa(
    "urlDoScribe é a única forma de montar a URL, e ela leva enable_logging=false",
    /enable_logging=false/.test(dominio) &&
      (dominio.match(/speech-to-text/g) ?? []).length ===
        (dominio.match(/BASE_SCRIBE\s*=/g) ?? []).length,
    "— apareceu um segundo caminho até o Scribe"
  );
  const servidor = codigoDe("lib/voice/dictation-server.ts");
  checa(
    "o ditado exige exatamente \"true\" — ausente, vazio ou \"1\" não ligam nada",
    /HELO_VOICE_DICTATION_ENABLED === "true"/.test(servidor)
  );
  checa(
    "a base do provedor não é desviável em produção",
    /NODE_ENV === "production"\) return BASE_SCRIBE/.test(servidor)
  );
  const endpoint = codigoDe("app/api/voice/dictation/route.ts");
  checa(
    "o endpoint recusa antes de ler o corpo quando o ditado está indisponível",
    endpoint.indexOf("ditadoDisponivel()") < endpoint.indexOf("request.formData()")
  );
}

// ——— 4. URLs duráveis ———
//
// A 5.4B fechou o R-04 tirando `getDownloadURL` do produto inteiro. Ele não é
// mais "só nas Functions": ele não existe. Um reaparecimento seria a volta da
// URL pública por posse de token, e é isso que esta seção impede.
secao("4. nenhuma URL durável de Storage é emitida pelo produto");
{
  const geram = FONTES.filter((f) => /getDownloadURL|getSignedUrl|makePublic\(/.test(codigoDe(f)));
  checa(
    "ninguém emite download URL, signed URL ou torna objeto público",
    geram.length === 0,
    `— em ${geram.join(", ")}`
  );
  const frases = codigoDe("lib/favorite-phrases.ts");
  checa(
    "excluir uma frase apaga o áudio dela no Storage",
    /deleteFavoritePhrase[\s\S]*?descartaMidiaDaFrase/.test(frases)
  );
  checa(
    "o tipo devolvido ao cliente não carrega endereço, só um booleano",
    /hasAudio: boolean/.test(frases) && !/audioUrl:\s*string/.test(frases)
  );
}

// ——— 5. Cache-Control nas rotas que carregam autorização ou fala ———
secao("5. no-store onde a resposta não pode ser guardada");
{
  for (const rota of [
    "app/api/tts/route.ts",
    "app/api/voice/grant/route.ts",
    "app/api/voice/dictation/route.ts",
  ]) {
    checa(`${rota} responde no-store`, /"Cache-Control": "no-store"/.test(codigoDe(rota)));
  }
  // A voz clonada pré-sintetizada segue a mesma régua da voz sintetizada na
  // hora: `private, no-store`. A música aceita revalidação obrigatória em vez
  // disso, e a diferença é sobre tamanho de arquivo, não sobre sigilo.
  checa(
    "o áudio da frase do paciente é private, no-store",
    /cacheControl: "private, no-store"/.test(codigoDe("app/api/favorite-phrases/audio/route.ts"))
  );
  checa(
    "a música é private e revalidada, nunca public",
    /cacheControl: "private, max-age=0, must-revalidate"/.test(
      codigoDe("app/api/patients/[patientId]/playlist/audio/route.ts")
    )
  );
}

// ——— 6. Os nomes que o painel pode chamar ———
//
// Cinco aliases sobrevivem porque o contrato externo não foi verificado (A-11
// da 5.3A). Enquanto ele não for, esta lista é o contrato do NOSSO lado.
secao("6. o inventário de client tools está congelado");
{
  const provider = codigoDe("components/helo-agent-provider.tsx");
  const bloco = provider.slice(
    provider.indexOf("const clientTools = useMemo"),
    provider.indexOf("}, [authorizeTool, generateMusicClientTool")
  );
  const registradas = [...bloco.matchAll(/^ {4}([A-Za-z_][A-Za-z0-9_]*)[,:]/gm)].map((m) => m[1]);
  const ESPERADAS = [
    "navigateHeloArea",
    "openPatientSettings",
    "openRoutineMode",
    "openEmergencyMode",
    "openActivitiesMode",
    "showGestureChoices",
    "generate_and_play_music",
    "generate_music",
    "play_existing_music",
    "checkUserSilence",
    "getCurrentHeloActions",
    "getVisibleHeloActions",
    "interactWithHeloUI",
    "interactWithVisibleHeloUI",
    "executeHeloAction",
  ];
  checa(
    `são ${ESPERADAS.length} tools, nem uma a mais`,
    registradas.length === ESPERADAS.length,
    `— encontradas ${registradas.length}: ${registradas.join(", ")}`
  );
  checa(
    "e são exatamente as declaradas aqui",
    ESPERADAS.every((n) => registradas.includes(n)),
    `— faltam ${ESPERADAS.filter((n) => !registradas.includes(n)).join(", ")}`
  );
  // A execução de ação continua sendo o único ponto com alias de PARÂMETRO —
  // sete nomes aceitos porque a declaração no painel não é conhecida.
  const aliasesDeAcao = bloco.match(
    /parameters\.actionId[\s\S]{0,220}?parameters\.command/
  );
  checa("os aliases de parâmetro do actionId continuam num ponto só", Boolean(aliasesDeAcao));
}

// ——— 7. O que a 5.4B fechou, e o que continua aberto ———
//
// Metade desta seção mudou de sinal na 5.4B: o que era "o defeito ainda está
// aqui, e é por isso que o plano existe" virou "o defeito saiu, e é por isso
// que ele não pode voltar". A outra metade continua igual, porque pertence à
// 5.4C.
secao("7. o que a 5.4B fechou (e o que segue para a 5.4C)");
{
  const funcoes = codigoDe("functions/index.js");
  checa(
    "R-04: a Function grava caminho privado, não URL",
    /caminhoDeAudioDaFrase\(patientId, phraseId, audioId\)/.test(funcoes) &&
      !/getDownloadURL/.test(funcoes)
  );
  checa(
    "R-04b: o objeto novo nasce antes da troca, e some se a troca falhar",
    /catch \(falhaNoDocumento\)[\s\S]{0,200}?file\.delete/.test(funcoes)
  );
  // A varredura exaustiva dos logs — que sabe distinguir `prompt.length` de
  // `prompt` — vive em `test:midia:privada` §11, onde a contagem de parênteses
  // delimita cada chamada. Aqui basta o marco: a linha que despejava o payload
  // não existe mais, e o que ficou no lugar é medida.
  checa(
    "R-07a: o payload do pedido não vai mais para o log",
    !/Received music payload/.test(funcoes) && /caracteresNoPrompt: prompt\.length/.test(funcoes)
  );
  checa(
    "R-07b: o corpo do provedor não é lido nem registrado",
    !/elevenLabsResponse\.text\(\)/.test(funcoes) && /MUSIC_PROVIDER_REJECTED/.test(funcoes)
  );
  checa(
    "A-12: música nova nasce sob o paciente",
    /caminhoDeMusica\(patientId, trackRef\.id\)/.test(funcoes) &&
      !/`musics\/\$\{Date\.now\(\)\}/.test(funcoes)
  );
  checa(
    "R-14: o resultado da tool de música não carrega endereço",
    !/return \{[\s\S]{0,400}?audioUrl,/.test(codigoDe("components/helo-agent-provider.tsx"))
  );
  checa(
    "storage.rules está versionado e ligado às duas configurações",
    /"storage"/.test(readFileSync(resolve(RAIZ, "firebase.json"), "utf8")) &&
      /"storage"/.test(readFileSync(resolve(RAIZ, "firebase.test.json"), "utf8"))
  );

  // ——— o que a 5.4B NÃO absorveu, de propósito ———
  checa(
    "R-12: o override de voz do Agent continua morto (o pedido sempre desabilita)",
    /requestToken\(true\)/.test(codigoDe("lib/voice/agent-session-lifecycle.ts"))
  );
  // `rateLimited` (a CATEGORIA de falha do provedor, em eleven-fetch) não
  // conta: ela é o 429 que a ElevenLabs devolve, não um limite que o Helo
  // aplique. As fronteiras de palavra separam as duas coisas.
  checa(
    "A-10: nenhum limitador de taxa próprio existe no produto (5.4C)",
    !FONTES.some((f) => /\b(rateLimit|rateLimiter|throttle|limitaTaxa)\b/i.test(codigoDe(f)))
  );
}

console.log(`\n${mau === 0 ? "✓" : "✗"} ${ok} passaram, ${mau} falharam`);
process.exit(mau === 0 ? 0 : 1);
