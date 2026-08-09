// ——— A build que as jornadas longas usam ———
//
//   npm run test:ui:build            constrói em .next-e2e-prod
//   npm run test:ui:build -- --dist X
//
// Por que existe: as specs de conversa por opções atravessam o fluxo inteiro —
// vários níveis, apresentação ao paciente, gesto, confirmação. Medidas contra
// `next dev`, uma delas gasta ~60s em 68 ações de interface, sem gargalo: o
// custo está espalhado, e boa parte dele é o compilador sob demanda respondendo
// no meio do caminho. Um teto de 90s por teste não é apertado para a jornada;
// é apertado para a jornada MAIS o compilador.
//
// A build é feita UMA vez por rodada e reaproveitada pelos quatro lotes. O que
// não se reaproveita é o processo: cada spec recebe um `next start` novo.
//
// O distDir é isolado de propósito. O preview do usuário e os outros lotes têm
// os seus, e nenhum deles pode ser sobrescrito por uma rodada de regressão.

import { spawn } from "node:child_process";
import { ambienteSemProvedorReal, VARIAVEL_DA_CHAVE } from "./eleven-guard.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argumento(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

export const DIST_PRODUCAO = argumento("dist", ".next-e2e-prod");

// Nada de teste é incorporado ao bundle: o único `NEXT_PUBLIC_` do produto é a
// URL de geração de música, e Firestore, emulador e provedor de voz são lidos
// pelo SERVIDOR em tempo de execução. Por isso a mesma build serve os quatro
// lotes — e por isso a build não precisa de nenhuma variável de teste. Ainda
// assim ela passa pela guarda: uma build não deve nem ter a chave por perto.
const ambiente = {
  ...ambienteSemProvedorReal(process.env, {}, "build de regressão E2E"),
  NEXT_DIST_DIR: DIST_PRODUCAO,
  NEXT_TELEMETRY_DISABLED: "1",
};

if (process.argv[1] && process.argv[1].endsWith("e2e-build-producao.mjs")) {
  console.log(
    `build de regressão · distDir ${DIST_PRODUCAO} · ` +
      `provedor ElevenLabs: ${ambiente[VARIAVEL_DA_CHAVE] ? "chave de teste" : "NEUTRALIZADO"}`
  );
  const proc = spawn(
    "bash",
    ["-lc", "node scripts/gen-version.mjs && npx next build"],
    { cwd: RAIZ, env: ambiente, stdio: "inherit" }
  );
  proc.on("exit", (codigo) => process.exit(codigo ?? 0));
}
