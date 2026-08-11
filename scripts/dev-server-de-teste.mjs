// ——— O servidor que as suítes HTTP usam ———
//
//   npm run dev:teste
//   npm run dev:teste -- --porta 3510 --banco suite-x --dist .next-suite-x
//
// As suítes `.mjs` que falam HTTP (`test-realtime-questions`, `test-access`,
// `test-voice-authorization`, …) recebem uma URL e assumem que alguém já
// levantou um servidor. Até aqui esse "alguém" era um `npx next dev` digitado à
// mão — e foi exatamente daí que veio o incidente: o `next dev` lê o `.env`, o
// `.env` tem a chave de PRODUÇÃO da ElevenLabs, e a suíte de autorização de voz
// sintetizou quatro frases de verdade sem ninguém ter pedido.
//
// Este script existe para que não haja mais um comando digitado à mão. Ele sobe
// o mesmo `next dev`, com o mesmo emulador, e com uma diferença: passa pela
// guarda de `scripts/eleven-guard.mjs` antes de o processo nascer. Sem opt-in
// explícito, o servidor sobe SEM provedor — que é o estado em que as suítes
// foram escritas para rodar (`test-voice-authorization` distingue o 403 da
// recusa de autoria do 503 de "sem chave", e é essa distinção que ela prova).
//
// O `npm run dev` normal continua intocado. Ele é o preview do usuário, roda
// com a chave real de propósito, e não é assunto deste arquivo. Um `npx next
// dev` digitado à mão também não passa por aqui — a guarda vive DENTRO deste
// launcher e do runner de lotes, não no framework. Por isso a regra é de
// processo: servidor de regressão sobe por um destes dois comandos.

import { spawn } from "node:child_process";
import { ambienteSemProvedorReal, VARIAVEL_DA_CHAVE } from "./eleven-guard.mjs";

function argumento(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const PORTA = argumento("porta", "3510");
const BANCO = argumento("banco", "suite-http");
const DIST = argumento("dist", ".next-suite-http");
const EMULADOR = argumento("emulador", "127.0.0.1:8090");
const PROJETO = argumento("projeto", "helo-app-7fbf8");

// Variáveis que ESTA execução declara. Um lote de ditado pode acrescentar aqui
// uma chave falsa (`--ditado`), e a guarda a aceita justamente por ela se
// anunciar como de teste.
const declarado = {
  PORT: PORTA,
  NEXT_DIST_DIR: DIST,
  FIRESTORE_EMULATOR_HOST: EMULADOR,
  FIRESTORE_DATABASE_ID: BANCO,
  GCLOUD_PROJECT: PROJETO,
  NEXT_TELEMETRY_DISABLED: "1",
};

if (process.argv.includes("--ditado")) {
  // Para a suíte do endpoint de ditado: o recurso precisa estar ligado e
  // precisa existir uma chave, senão `ditadoDisponivel()` é falso e o endpoint
  // recusa antes de qualquer conferência. A chave é falsa e o provedor aponta
  // para o servidor de mentira que a própria suíte levanta.
  declarado.HELO_VOICE_DICTATION_ENABLED = "true";
  declarado.ELEVENLABS_API_KEY = "chave-de-teste-sem-valor";
  declarado.HELO_DICTATION_PROVIDER_BASE =
    argumento("provedor", "http://127.0.0.1:4599/v1/speech-to-text");
}

if (process.argv.includes("--storage")) {
  // Para `test:midia:autorizacao` (Fase 5.4B): o servidor precisa LER objetos
  // do Storage para entregar o áudio da frase. Sem esta variável o Admin SDK
  // procuraria o bucket de produção — e a suíte, que grava no emulador, veria
  // 404 em tudo e passaria por motivo errado.
  //
  // O emulador de Storage é o de `firebase.test.json` (porta 9199).
  //
  // `--storage` é uma CHAVE, não uma opção com valor: o endereço, quando
  // precisa ser outro, vem em `--storage-host`. Ler o valor logo depois de
  // `--storage` com o helper de opção fazia `STORAGE_EMULATOR_HOST` virar
  // "--banco" quando os dois vinham juntos na linha — e o servidor então
  // procurava os objetos num endereço que não existe, respondendo 404 a tudo.
  declarado.STORAGE_EMULATOR_HOST = argumento("storage-host", "http://127.0.0.1:9199");
  declarado.FIREBASE_STORAGE_BUCKET = argumento("balde", "helo-app-7fbf8.firebasestorage.app");
}

const ambiente = ambienteSemProvedorReal(process.env, declarado, "servidor de suítes HTTP");

if (BANCO === "helo-db") {
  console.error(
    "recusando subir contra o banco de trabalho `helo-db`. Use um banco descartável."
  );
  process.exit(1);
}

console.log(
  `servidor de teste · porta ${PORTA} · emulador ${EMULADOR} · banco ${BANCO}\n` +
    `storage: ${ambiente.STORAGE_EMULATOR_HOST ?? "produção (nenhum objeto será lido)"}\n` +
    `provedor ElevenLabs: ${ambiente[VARIAVEL_DA_CHAVE] ? "chave de teste declarada" : "NEUTRALIZADO"}`
);

const proc = spawn("npx", ["next", "dev", "--webpack"], {
  env: ambiente,
  stdio: "inherit",
});
proc.on("exit", (codigo) => process.exit(codigo ?? 0));
