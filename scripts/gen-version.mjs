// Gera lib/version.ts no build. A versão é derivada automaticamente:
//   major.minor  → vêm do package.json (bump manual em releases significativas)
//   patch        → nº de commits além do BASELINE → sobe +1 a cada deploy
// Sem git disponível (build isolado), cai para o patch do package.json.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Commits na main até o ponto em que definimos v0.9.0. Ajuste se rebaselinar.
const BASELINE = 13;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const [major, minor, pkgPatch = "0"] = pkg.version.split(".");

let patch = pkgPatch;
let commit = "";
try {
  const count = Number(
    execSync("git rev-list --count HEAD", { cwd: root }).toString().trim()
  );
  patch = String(Math.max(0, count - BASELINE));
  commit = execSync("git rev-parse --short HEAD", { cwd: root })
    .toString()
    .trim();
} catch {
  // sem git no ambiente de build — mantém o patch do package.json
}

const version = `${major}.${minor}.${patch}`;
const out = `// GERADO no build por scripts/gen-version.mjs — não editar à mão.
export const APP_VERSION = ${JSON.stringify(version)};
export const APP_COMMIT = ${JSON.stringify(commit)};
export const APP_BUILT_AT = ${JSON.stringify(new Date().toISOString())};
`;
writeFileSync(join(root, "lib", "version.ts"), out);
console.log(`[version] v${version}${commit ? ` (${commit})` : ""}`);
