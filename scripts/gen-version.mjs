// Gera lib/version.ts no build. A versão vem do package.json (fonte da
// verdade — confiável mesmo com o clone raso que o App Hosting faz no build).
// O commit curto é só informativo (tooltip) e funciona em clone raso.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;

let commit = "";
try {
  commit = execSync("git rev-parse --short HEAD", { cwd: root })
    .toString()
    .trim();
} catch {
  // sem git no ambiente de build — segue só com a versão do package.json
}

const out = `// GERADO no build por scripts/gen-version.mjs — não editar à mão.
export const APP_VERSION = ${JSON.stringify(version)};
export const APP_COMMIT = ${JSON.stringify(commit)};
export const APP_BUILT_AT = ${JSON.stringify(new Date().toISOString())};
`;
writeFileSync(join(root, "lib", "version.ts"), out);
console.log(`[version] v${version}${commit ? ` (${commit})` : ""}`);
