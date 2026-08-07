// ——— Suíte Playwright em lotes determinísticos ———
//
// Rodar os 138 testes de interface de uma vez, contra um único dev server que
// fica ~50 minutos no ar, produzia falhas que não eram do produto: o servidor
// degradava e testes variados quebravam ao *carregar a página*. Rodados por
// arquivo, os mesmos testes passavam. O problema era o arranjo, não o código.
//
// Este runner corta a suíte em lotes por domínio. Cada lote começa do zero:
//
//   banco de teste apagado · dev server novo · rotas pré-compiladas
//
// Nada de retries: uma falha aqui é uma falha, e aparece no relatório final.
// O que este arquivo NÃO faz é esconder instabilidade — se um lote falhar
// duas vezes seguidas com o mesmo teste, isso é defeito, não ruído.
//
//   npm run test:ui:lotes                  todos os lotes
//   npm run test:ui:lotes -- fases-4x      um lote (ou vários, por nome)
//   npm run test:ui:lotes -- --list        só lista os lotes
//
// Pré-requisito: o emulador do Firestore no ar (`npm run emu`). O runner sobe
// o dev server sozinho — não reaproveita nenhum que já esteja rodando, porque
// um servidor herdado é exatamente a variável que queremos eliminar.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- Onde e contra o quê rodamos ----------

// A raiz vem do próprio arquivo, nunca do diretório de onde o comando foi
// chamado: isso é o que garante que o runner opere sobre ESTA árvore.
const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJETO = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
/** Banco dedicado. NUNCA helo-db: o dev server do usuário vive lá. */
const BANCO = process.env.HELO_E2E_DATABASE_ID ?? "e2e-lotes";
const PORTA = Number(process.env.HELO_E2E_PORT ?? 3210);
const DIST = process.env.HELO_E2E_DIST_DIR ?? ".next-e2e";
const BASE_URL = `http://localhost:${PORTA}`;

const RELATORIOS = resolve(RAIZ, "test-results", "lotes");

// ---------- Os lotes ----------
//
// Agrupados por domínio, e não por tamanho: quando um lote falha, o nome já
// diz que parte do produto olhar. O teto de ~30 testes por lote é o que mantém
// cada dev server novo o suficiente para não degradar.

const LOTES = [
  {
    nome: "base",
    titulo: "Perguntas em tempo real e regressão da rota legada",
    arquivos: [
      "tests/e2e/realtime-questions.spec.ts",
      "tests/e2e/conversa-regressao.spec.ts",
    ],
  },
  {
    nome: "conversa-por-opcoes",
    titulo: "Conversa por opções: fluxo, navegação, edição e recuperação",
    arquivos: [
      "tests/e2e/option-conversation-flow.spec.ts",
      "tests/e2e/option-conversation-navigation.spec.ts",
      "tests/e2e/option-conversation-editing-history.spec.ts",
      "tests/e2e/option-conversation-recovery.spec.ts",
    ],
  },
  {
    nome: "fases-4x",
    titulo: "Contexto da sessão, interpretação do cuidador e jornadas integradas",
    arquivos: [
      "tests/e2e/session-context.spec.ts",
      "tests/e2e/caregiver-interpretation.spec.ts",
      "tests/e2e/fases-4x-integrado.spec.ts",
    ],
  },
  {
    nome: "controles-do-paciente",
    titulo: "Controles diretos do paciente",
    arquivos: ["tests/e2e/patient-controls.spec.ts"],
  },
  {
    nome: "offline",
    titulo: "Continuidade sem conexão e armazenamento local",
    // `offline-app-shell.spec.ts` NÃO entra aqui, e não é esquecimento: ele
    // recarrega a página com a rede inteira fora, e o HMR do `next dev`
    // reage a isso recarregando em laço. É comportamento do servidor de
    // desenvolvimento, não do produto — por isso aquela suíte roda contra um
    // build de produção, por `npm run test:ui:shell`.
    arquivos: [
      "tests/e2e/offline-continuidade.spec.ts",
      "tests/e2e/offline-logout-expiracao.spec.ts",
      "tests/e2e/offline-sync.spec.ts",
      "tests/e2e/offline-conflitos.spec.ts",
      "tests/e2e/offline-preflight.spec.ts",
    ],
  },
  {
    nome: "responsivo-base",
    titulo: "Tablet: pergunta fechada",
    arquivos: ["tests/e2e/responsivo.spec.ts"],
  },
  {
    nome: "responsivo-fases",
    titulo: "Tablet: conversa por opções e controles do paciente",
    arquivos: [
      "tests/e2e/option-conversation-responsivo.spec.ts",
      "tests/e2e/patient-controls-responsivo.spec.ts",
    ],
  },
];

/** Compiladas antes do primeiro teste — em dev, a primeira visita é lenta. */
const ROTAS_PARA_AQUECER = ["/login", "/", "/conversa/perguntas", "/dashboard"];

// ---------- Utilidades ----------

const t0 = Date.now();
const agora = () => {
  const s = Math.round((Date.now() - t0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const log = (msg) => console.log(`[${agora()}] ${msg}`);

function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function alcancavel(url, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    await fetch(url, { signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Ambiente limpo: o banco do lote começa vazio, sempre. */
async function limparBanco() {
  const r = await fetch(
    `http://${EMU}/emulator/v1/projects/${PROJETO}/databases/${BANCO}/documents`,
    { method: "DELETE" }
  );
  if (!r.ok) {
    throw new Error(
      `não consegui limpar o banco ${BANCO} no emulador (HTTP ${r.status})`
    );
  }
}

// ---------- Dev server por lote ----------

function ambienteDoServidor() {
  return {
    ...process.env,
    PORT: String(PORTA),
    NEXT_DIST_DIR: DIST,
    FIRESTORE_EMULATOR_HOST: EMU,
    FIRESTORE_DATABASE_ID: BANCO,
    GCLOUD_PROJECT: PROJETO,
    // O runner é a única voz no terminal; o dev server fala pelo arquivo de log.
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

async function subirServidor() {
  if (await alcancavel(BASE_URL, 1500)) {
    throw new Error(
      `a porta ${PORTA} já está ocupada. Cada lote precisa de um dev server ` +
        `novo — encerre quem está lá ou aponte HELO_E2E_PORT para outra porta.`
    );
  }

  // detached: o `next dev` gera um next-server filho. Sem grupo próprio, o
  // filho sobrevive ao pai e a porta fica presa para o lote seguinte.
  const proc = spawn("npx", ["next", "dev", "--webpack"], {
    cwd: RAIZ,
    env: ambienteDoServidor(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let saida = "";
  proc.stdout.on("data", (d) => (saida += d));
  proc.stderr.on("data", (d) => (saida += d));

  let morreu = null;
  proc.on("exit", (code) => (morreu = code));

  for (let i = 0; i < 120; i += 1) {
    if (morreu !== null) {
      throw new Error(
        `o dev server morreu antes de subir (código ${morreu}):\n${saida.slice(-1500)}`
      );
    }
    if (await alcancavel(BASE_URL, 2000)) return proc;
    await dormir(1000);
  }
  await derrubarServidor(proc);
  throw new Error(`o dev server não respondeu em 120s:\n${saida.slice(-1500)}`);
}

async function aquecerRotas() {
  for (const rota of ROTAS_PARA_AQUECER) {
    // Compilar sob demanda pode passar de 30s na primeira visita; é justamente
    // essa espera que estourava o timeout do primeiro teste do lote.
    await alcancavel(`${BASE_URL}${rota}`, 90_000);
  }
}

async function derrubarServidor(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    /* já se foi */
  }
  for (let i = 0; i < 15; i += 1) {
    if (proc.exitCode !== null && !(await alcancavel(BASE_URL, 800))) return;
    await dormir(1000);
  }
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    /* já se foi */
  }
  await dormir(1500);
}

// ---------- Execução de um lote ----------

function rodarPlaywright(lote) {
  const jsonPath = resolve(RELATORIOS, `${lote.nome}.json`);
  return new Promise((resolveP) => {
    const proc = spawn(
      "npx",
      [
        "playwright",
        "test",
        ...lote.arquivos,
        // Uma falha é uma falha. Repetir até passar transformaria defeito
        // intermitente em silêncio — que é o oposto do que este runner é.
        "--retries=0",
        "--reporter=list,json",
        `--output=${resolve(RELATORIOS, lote.nome, "artefatos")}`,
      ],
      {
        cwd: RAIZ,
        env: {
          ...process.env,
          HELO_BASE_URL: BASE_URL,
          FIRESTORE_EMULATOR_HOST: EMU,
          FIRESTORE_DATABASE_ID: BANCO,
          GCLOUD_PROJECT: PROJETO,
          PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath,
          PLAYWRIGHT_HTML_OPEN: "never",
        },
        stdio: "inherit",
      }
    );
    proc.on("exit", (code) => resolveP({ code: code ?? 1, jsonPath }));
  });
}

function lerResultado(jsonPath, codigoSaida) {
  try {
    const relatorio = JSON.parse(readFileSync(jsonPath, "utf8"));
    const s = relatorio.stats ?? {};
    const falhas = [];
    const percorrer = (suites, trilha) => {
      for (const suite of suites ?? []) {
        const nome = [...trilha, suite.title].filter(Boolean);
        for (const spec of suite.specs ?? []) {
          const ok = (spec.tests ?? []).every(
            (t) => t.status === "expected" || t.status === "skipped"
          );
          if (!ok) falhas.push([...nome, spec.title].join(" › "));
        }
        percorrer(suite.suites, nome);
      }
    };
    percorrer(relatorio.suites, []);
    return {
      aprovados: s.expected ?? 0,
      falhos: s.unexpected ?? 0,
      ignorados: s.skipped ?? 0,
      instaveis: s.flaky ?? 0,
      falhas,
      codigoSaida,
    };
  } catch (e) {
    // Sem JSON legível não há como afirmar que o lote passou.
    return {
      aprovados: 0,
      falhos: 0,
      ignorados: 0,
      instaveis: 0,
      falhas: [`relatório ilegível: ${e.message}`],
      codigoSaida: codigoSaida || 1,
      semRelatorio: true,
    };
  }
}

async function rodarLote(lote) {
  log(`▶ lote "${lote.nome}" — ${lote.titulo}`);

  log("   limpando o banco de teste…");
  await limparBanco();

  log(`   subindo dev server novo em ${BASE_URL}…`);
  const servidor = await subirServidor();
  try {
    log("   pré-compilando rotas…");
    await aquecerRotas();

    log("   rodando testes…");
    const { code, jsonPath } = await rodarPlaywright(lote);
    const r = lerResultado(jsonPath, code);
    log(
      `   ${r.falhos || r.semRelatorio ? "✗" : "✓"} ${lote.nome}: ` +
        `${r.aprovados} aprovados, ${r.falhos} falhos, ${r.ignorados} ignorados`
    );
    return { ...lote, ...r };
  } finally {
    log("   encerrando o dev server…");
    await derrubarServidor(servidor);
  }
}

// ---------- Relatório agregado ----------

function relatorioFinal(resultados) {
  const somar = (chave) => resultados.reduce((a, r) => a + r[chave], 0);
  const aprovados = somar("aprovados");
  const falhos = somar("falhos");
  const ignorados = somar("ignorados");
  const instaveis = somar("instaveis");

  const largura = Math.max(...resultados.map((r) => r.nome.length), 6);
  console.log(`\n${"═".repeat(largura + 42)}`);
  console.log("RESULTADO AGREGADO DA SUÍTE PLAYWRIGHT");
  console.log("═".repeat(largura + 42));
  console.log(
    `${"lote".padEnd(largura)}  ${"aprov".padStart(6)} ${"falhos".padStart(6)} ` +
      `${"ignor".padStart(6)}  situação`
  );
  console.log("─".repeat(largura + 42));
  for (const r of resultados) {
    const ok = r.falhos === 0 && !r.semRelatorio && r.codigoSaida === 0;
    console.log(
      `${r.nome.padEnd(largura)}  ${String(r.aprovados).padStart(6)} ` +
        `${String(r.falhos).padStart(6)} ${String(r.ignorados).padStart(6)}  ` +
        `${ok ? "verde" : "FALHOU"}`
    );
  }
  console.log("─".repeat(largura + 42));
  console.log(
    `${"TOTAL".padEnd(largura)}  ${String(aprovados).padStart(6)} ` +
      `${String(falhos).padStart(6)} ${String(ignorados).padStart(6)}  ` +
      `${aprovados + falhos + ignorados} testes`
  );
  if (instaveis) console.log(`\ninstáveis relatados: ${instaveis}`);

  const comFalha = resultados.filter((r) => r.falhas.length);
  if (comFalha.length) {
    console.log("\nTestes que falharam:");
    for (const r of comFalha) {
      for (const f of r.falhas) console.log(`  · [${r.nome}] ${f}`);
    }
  }

  const verde = falhos === 0 && resultados.every((r) => r.codigoSaida === 0);
  console.log(
    `\n${verde ? "✓ suíte verde" : "✗ suíte vermelha"} — ${agora()} de execução\n`
  );
  return verde;
}

// ---------- Entrada ----------

async function principal() {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    for (const l of LOTES) {
      console.log(`${l.nome.padEnd(24)} ${l.arquivos.length} arquivo(s) — ${l.titulo}`);
    }
    return true;
  }

  if (BANCO === "helo-db") {
    throw new Error(
      "recuso rodar contra helo-db: os testes apagam o banco, e é nele que " +
        "vive o dev server do dia a dia. Use outro HELO_E2E_DATABASE_ID."
    );
  }
  if (RAIZ.includes("/Documents/Helo")) {
    throw new Error(`árvore errada: ${RAIZ}`);
  }
  if (!(await alcancavel(`http://${EMU}/`, 3000))) {
    throw new Error(
      `o emulador do Firestore não respondeu em ${EMU}. Suba com \`npm run emu\`.`
    );
  }

  const pedidos = args.filter((a) => !a.startsWith("--"));
  const escolhidos = pedidos.length
    ? pedidos.map((nome) => {
        const lote = LOTES.find((l) => l.nome === nome);
        if (!lote) throw new Error(`lote desconhecido: ${nome}`);
        return lote;
      })
    : LOTES;

  rmSync(RELATORIOS, { recursive: true, force: true });
  mkdirSync(RELATORIOS, { recursive: true });

  log(`raiz .......... ${RAIZ}`);
  log(`emulador ...... ${EMU}  ·  banco ${BANCO}`);
  log(`dev server .... ${BASE_URL}  ·  dist ${DIST}`);
  log(`lotes ......... ${escolhidos.map((l) => l.nome).join(", ")}\n`);

  const resultados = [];
  for (const lote of escolhidos) {
    resultados.push(await rodarLote(lote));
  }
  return relatorioFinal(resultados);
}

principal()
  .then((verde) => process.exit(verde ? 0 : 1))
  .catch((e) => {
    console.error(`\n✗ ${e.message}\n`);
    process.exit(1);
  });
