import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Resíduo de sincronização do iCloud: uma cópia de node_modules com nome
    // alterado. O ignore embutido do ESLint casa com "node_modules" exato, e
    // este nome escapa dele — sem esta linha, quase 10 mil arquivos de
    // dependência entram no lint e afogam os problemas do código real.
    // Espelha o que tsconfig.json já faz em "exclude".
    "**/node_modules.icloud-inacessivel/**",
  ]),
]);

export default eslintConfig;
