// ——— A guarda que impede uma suíte de gastar crédito sozinha ———
//
//   npm run test:eleven-guard
//
// Isto existe por causa de um erro concreto, e o teste é a forma de ele não se
// repetir: subi um dev server para rodar as suítes HTTP sem neutralizar
// `ELEVENLABS_API_KEY`. O `next dev` lê o `.env`, o `.env` deste projeto tem a
// chave de produção, e `test-voice-authorization` — a suíte que existe para
// provar que uma fala não autorizada é recusada — atravessou a autorização nos
// casos legítimos e sintetizou quatro frases de verdade.
//
// O que torna esse erro fácil é que a chave não vem de quem roda o teste. Ela
// vem de um arquivo que o framework lê sozinho, e nenhum comando de teste a
// menciona. Não dá para lembrar de neutralizar o que não se vê — então a
// decisão passou a ser tomada num lugar só, e este arquivo conduz esse lugar.
//
// Nenhum teste aqui abre processo, sobe servidor ou toca a rede. A guarda é
// lógica sobre um objeto de ambiente, e é assim que ela é exercitada — provar
// que ela funciona não pode exigir a chamada real que ela existe para impedir.

import { readFileSync } from "node:fs";
import {
  VARIAVEL_DA_CHAVE,
  VARIAVEL_DE_OPT_IN,
  ambienteSemProvedorReal,
  assertSemChaveRealNoShell,
  chaveEhDeTeste,
  provedorRealLiberado,
} from "./eleven-guard.mjs";

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

// Uma chave com a CARA de uma real, para os cenários. Não é uma chave: são
// hexadecimais inventados, e nunca sai deste arquivo.
const PARECE_REAL = "sk_0123456789abcdef0123456789abcdef0123456789abcdef";

// ==========================================================================
secao("1 · Chave real presente + suíte comum → neutralizada");
// ==========================================================================

const herdado = { CAMINHO: "/x", [VARIAVEL_DA_CHAVE]: PARECE_REAL };
const semProvedor = ambienteSemProvedorReal(herdado, {}, "suíte de teste");

check("a chave herdada é zerada", semProvedor[VARIAVEL_DA_CHAVE] === "");
check("…e zerada quer dizer falsa para o produto", !semProvedor[VARIAVEL_DA_CHAVE]);
check("o resto do ambiente atravessa intacto", semProvedor.CAMINHO === "/x");
check(
  "a chave real não sobrevive em nenhum outro campo",
  !JSON.stringify(semProvedor).includes(PARECE_REAL)
);

// A neutralização é por STRING VAZIA e não por remoção — é o que faz o `.env`
// ser ignorado, porque `@next/env` só preenche o que ainda não existe.
check(
  "a variável continua existindo, vazia",
  Object.prototype.hasOwnProperty.call(semProvedor, VARIAVEL_DA_CHAVE)
);
check("…e não foi apagada do objeto", semProvedor[VARIAVEL_DA_CHAVE] !== undefined);

// ==========================================================================
secao("2 · Chave ausente → a suíte roda normalmente");
// ==========================================================================

const semNada = ambienteSemProvedorReal({ CAMINHO: "/x" }, {}, "suíte de teste");
check("nada explode", semNada.CAMINHO === "/x");
check("e a chave continua vazia", semNada[VARIAVEL_DA_CHAVE] === "");

const vazia = ambienteSemProvedorReal({ [VARIAVEL_DA_CHAVE]: "" }, {}, "suíte");
check("chave já vazia segue vazia", vazia[VARIAVEL_DA_CHAVE] === "");

// ==========================================================================
secao("3 · Provedor local/mockado → normal");
// ==========================================================================

// O lote `voz-ditado` precisa de uma chave para `ditadoDisponivel()` ser
// verdadeiro. Ela é falsa, o POST é interceptado, e nada sai para a rede.
const comFalsa = ambienteSemProvedorReal(
  { [VARIAVEL_DA_CHAVE]: PARECE_REAL },
  { [VARIAVEL_DA_CHAVE]: "chave-invalida-de-teste-5-2a", HELO_VOICE_DICTATION_ENABLED: "true" },
  "lote voz-ditado"
);
check(
  "a chave declarada pelo lote vence a herdada",
  comFalsa[VARIAVEL_DA_CHAVE] === "chave-invalida-de-teste-5-2a"
);
check("…e a real não sobra em lugar nenhum", !JSON.stringify(comFalsa).includes(PARECE_REAL));
check("o resto do que o lote declarou passa", comFalsa.HELO_VOICE_DICTATION_ENABLED === "true");

const comBaseLocal = ambienteSemProvedorReal(
  { [VARIAVEL_DA_CHAVE]: PARECE_REAL },
  {
    [VARIAVEL_DA_CHAVE]: "chave-de-teste-sem-valor",
    HELO_DICTATION_PROVIDER_BASE: "http://127.0.0.1:4599/v1/speech-to-text",
  },
  "suíte do endpoint de ditado"
);
check(
  "provedor apontado para o servidor de mentira passa",
  comBaseLocal.HELO_DICTATION_PROVIDER_BASE.startsWith("http://127.0.0.1:")
);
check("…com chave falsa", comBaseLocal[VARIAVEL_DA_CHAVE] === "chave-de-teste-sem-valor");

// ==========================================================================
secao("4 · Uma chave que pode ser real dentro de um lote é RECUSADA");
// ==========================================================================

function recusa(declarado) {
  try {
    ambienteSemProvedorReal({}, declarado, "lote inventado");
    return null;
  } catch (e) {
    return String(e.message);
  }
}

const erro = recusa({ [VARIAVEL_DA_CHAVE]: PARECE_REAL });
check("lançou antes de qualquer processo nascer", erro !== null);
check("…dizendo qual variável é", erro?.includes(VARIAVEL_DA_CHAVE));
check("…e como destravar de propósito", erro?.includes(VARIAVEL_DE_OPT_IN));
check("…sem imprimir a chave", !erro?.includes(PARECE_REAL));

check("uma chave curta sem marca também é recusada", recusa({ [VARIAVEL_DA_CHAVE]: "abc123" }) !== null);

// ==========================================================================
secao("5 · O opt-in existe, é explícito, e só ele libera");
// ==========================================================================

check("sem a variável, não libera", provedorRealLiberado({}) === false);
check('com "false", não libera', provedorRealLiberado({ [VARIAVEL_DE_OPT_IN]: "false" }) === false);
check('com "1", não libera', provedorRealLiberado({ [VARIAVEL_DE_OPT_IN]: "1" }) === false);
check('só "true" exato libera', provedorRealLiberado({ [VARIAVEL_DE_OPT_IN]: "true" }) === true);

const liberado = ambienteSemProvedorReal(
  { [VARIAVEL_DA_CHAVE]: PARECE_REAL, [VARIAVEL_DE_OPT_IN]: "true" },
  {},
  "smoke test real"
);
check("com opt-in, a chave real atravessa", liberado[VARIAVEL_DA_CHAVE] === PARECE_REAL);

// ==========================================================================
secao("6 · Reconhecimento de chave de teste");
// ==========================================================================

for (const valor of [
  undefined,
  null,
  "",
  "chave-invalida-de-teste-5-2a",
  "chave-de-teste-sem-valor",
  "fake-key",
  "dummy",
  "placeholder",
  "xxx",
]) {
  check(`${JSON.stringify(valor)} conta como de teste`, chaveEhDeTeste(valor) === true);
}
for (const valor of [PARECE_REAL, "abc123", "sk_deadbeef"]) {
  check(`${JSON.stringify(valor).slice(0, 20)}… NÃO conta como de teste`, chaveEhDeTeste(valor) === false);
}

// ==========================================================================
secao("7 · A guarda do shell, para quem exporta a chave antes de rodar");
// ==========================================================================

const originalChave = process.env[VARIAVEL_DA_CHAVE];
const originalOptIn = process.env[VARIAVEL_DE_OPT_IN];

process.env[VARIAVEL_DA_CHAVE] = PARECE_REAL;
delete process.env[VARIAVEL_DE_OPT_IN];
let lancou = false;
try {
  assertSemChaveRealNoShell("suíte X");
} catch {
  lancou = true;
}
check("chave real exportada no shell → recusa", lancou);

process.env[VARIAVEL_DA_CHAVE] = "";
lancou = false;
try {
  assertSemChaveRealNoShell("suíte X");
} catch {
  lancou = true;
}
check("chave vazia → passa", !lancou);

process.env[VARIAVEL_DA_CHAVE] = PARECE_REAL;
process.env[VARIAVEL_DE_OPT_IN] = "true";
lancou = false;
try {
  assertSemChaveRealNoShell("smoke real");
} catch {
  lancou = true;
}
check("com opt-in explícito → passa", !lancou);

if (originalChave === undefined) delete process.env[VARIAVEL_DA_CHAVE];
else process.env[VARIAVEL_DA_CHAVE] = originalChave;
if (originalOptIn === undefined) delete process.env[VARIAVEL_DE_OPT_IN];
else process.env[VARIAVEL_DE_OPT_IN] = originalOptIn;

// ==========================================================================
secao("8 · A guarda está ligada onde os servidores nascem");
// ==========================================================================

function fonte(caminho) {
  return readFileSync(new URL(`../${caminho}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const runner = fonte("scripts/run-e2e-batches.mjs");
check("o runner de lotes importa a guarda", /from "\.\/eleven-guard\.mjs"/.test(runner));
check(
  "…e o ambiente do dev server passa por ela",
  /ambienteSemProvedorReal\(process\.env, extra/.test(runner)
);
check(
  "…sem nenhum caminho que monte o ambiente por fora",
  (runner.match(/\.\.\.process\.env/g) ?? []).length === 0
);

const launcher = fonte("scripts/dev-server-de-teste.mjs");
check("o launcher das suítes HTTP também passa", /ambienteSemProvedorReal\(process\.env/.test(launcher));
check("…e recusa o banco de trabalho", /helo-db/.test(launcher));

// O `npm run dev` do usuário NÃO foi tocado: ele é o preview manual, roda com
// a chave real de propósito, e não é assunto da guarda.
const pacote = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
check(
  "o `dev` manual do usuário não passa pela guarda — é o preview dele",
  /next dev/.test(pacote.scripts.dev) && !/eleven-guard|dev-server-de-teste/.test(pacote.scripts.dev)
);
check("existe um `dev:teste` separado", pacote.scripts["dev:teste"]?.includes("dev-server-de-teste"));

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam`);
process.exit(failed === 0 ? 0 : 1);
