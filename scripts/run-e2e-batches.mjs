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

import { assertEmuladorDescartavel } from "./emulator-guard.mjs";
import { ambienteSemProvedorReal } from "./eleven-guard.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
// Guarda: esta suíte apaga o banco inteiro. Ver scripts/emulator-guard.mjs.
assertEmuladorDescartavel(EMU, BANCO, "run-e2e-batches.mjs");
const PORTA = Number(process.env.HELO_E2E_PORT ?? 3210);
const DIST = process.env.HELO_E2E_DIST_DIR ?? ".next-e2e";
// ——— Dois distDir, porque são dois modos ———
//
// Um lote em `next dev` COMPILA dentro do seu distDir. Se ele usasse o mesmo
// diretório da build, o lote seguinte que roda em `next start` encontraria
// aquele diretório remexido — e a corrupção apareceria como falha de teste,
// longe da causa. São dois diretórios porque são dois artefatos de naturezas
// diferentes: um é cache de compilação viva, o outro é uma build imutável.
const DIST_PRODUCAO = process.env.HELO_E2E_PROD_DIST_DIR ?? ".next-e2e-prod";
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
  // ——— A conversa por opções: um servidor por spec, e sobre uma BUILD ———
  //
  // Era um lote só, com os 32 testes dos quatro arquivos, contra `next dev`.
  // Falhava sob carga, e nunca por asserção: sempre por tempo. Duas medições
  // explicam o porquê, e cada uma levou a uma das duas decisões abaixo.
  //
  // 1. GRANULARIDADE. Os 32 juntos mantinham um único servidor no ar por 30 a
  //    40 minutos — exatamente o arranjo que este runner existe para evitar, e
  //    acima do teto de ~30 testes por lote que ele mesmo declara. A divisão é
  //    uma spec por lote, a fronteira que as próprias specs já desenham. Não é
  //    distribuição por quem falhou: as falhas apareceram nos quatro arquivos.
  //
  // 2. MODO DE EXECUÇÃO. A jornada mais longa gasta ~60s em 68 ações de
  //    interface com a máquina quase ociosa, contra um teto de 90s por teste.
  //    O trace não mostra gargalo: a ação mais cara são 4,2s, o resto são
  //    dezenas de passos de ~1s. Contra `next dev`, parte de cada passo é o
  //    compilador respondendo sob demanda — e sob carga essa parcela cresce em
  //    todos os passos ao mesmo tempo, até a soma passar dos 90s.
  //
  //    Por isso estes quatro rodam sobre `next start`, com uma build feita uma
  //    vez por rodada. Não é para "fazer o teste passar": é o modo mais próximo
  //    do que o cuidador usa, e o único em que o tempo medido pela suíte é o
  //    custo do produto e não o do compilador.
  //
  // Nenhum teste foi alterado, removido, duplicado ou pulado; nenhuma jornada
  // encurtada; nenhum orçamento aumentado; nenhuma asserção mexida.
  {
    nome: "conversa-por-opcoes-flow",
    titulo: "Conversa por opções: fluxo principal e aprofundamento",
    arquivos: ["tests/e2e/option-conversation-flow.spec.ts"],
    producao: true,
  },
  {
    nome: "conversa-por-opcoes-navigation",
    titulo: "Conversa por opções: breadcrumb, troca de ramo e reinício",
    arquivos: ["tests/e2e/option-conversation-navigation.spec.ts"],
    producao: true,
  },
  {
    nome: "conversa-por-opcoes-editing-history",
    titulo: "Conversa por opções: histórico, reutilização e edição",
    arquivos: ["tests/e2e/option-conversation-editing-history.spec.ts"],
    producao: true,
  },
  {
    nome: "conversa-por-opcoes-recovery",
    titulo: "Conversa por opções: recuperação e persistência",
    arquivos: ["tests/e2e/option-conversation-recovery.spec.ts"],
    producao: true,
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
    nome: "voz-robustez",
    titulo: "Ciclo de vida do áudio, cancelamento e recuperação da voz (5.1B)",
    // Lote próprio, e não uma adição a outro: esta suíte intercepta /api/tts
    // para a aba inteira. Compartilhar o lote faria a interceptação alcançar
    // testes que esperam o comportamento normal da voz.
    arquivos: ["tests/e2e/voz-robustez.spec.ts"],
  },
  {
    nome: "voz-ditado",
    titulo:
      "Ditado do cuidador: rascunho, e um dono do microfone de cada vez (5.2A/5.2B)",
    arquivos: ["tests/e2e/voz-ditado.spec.ts"],
    // O ditado nasce DESLIGADO — é assim que ele vai para produção enquanto o
    // workspace da ElevenLabs não suportar retenção zero. Aqui ele é ligado de
    // propósito, para que o `GET /api/voice/dictation` percorra o código real
    // do servidor e devolva `available: true`.
    //
    // A chave é intencionalmente inválida: `POST /api/voice/dictation` é
    // interceptado na aba pelo próprio teste e nunca chega ao servidor. Se
    // algum dia chegar, a chamada morre num 401 da ElevenLabs — sem custo, e
    // com o teste falhando, que é o que se quer.
    env: {
      HELO_VOICE_DICTATION_ENABLED: "true",
      ELEVENLABS_API_KEY: "chave-invalida-de-teste-5-2a",
    },
  },
  {
    nome: "voz-ditado-integrado",
    titulo: "Ditado do cuidador: as travessias — paciente, sessão, conta (5.2C)",
    arquivos: ["tests/e2e/voz-ditado-integrado.spec.ts"],
    // Sobre BUILD, e não sobre o dev server: uma destas travessias desce um
    // nível inteiro da conversa por opções até o compositor, e a 5.2B mediu
    // que é o compilador sob demanda que estoura o orçamento desse caminho.
    // A contrapartida é que `__heloAudio` não existe aqui — é dev-only —, e
    // por isso nenhum teste desta spec depende dele.
    producao: true,
    env: {
      HELO_VOICE_DICTATION_ENABLED: "true",
      ELEVENLABS_API_KEY: "chave-invalida-de-teste-5-2a",
    },
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
      "tests/e2e/offline-preflight.spec.ts",
      "tests/e2e/offline-origem.spec.ts",
    ],
  },
  {
    nome: "offline-conflitos",
    titulo: "Conflitos de fila, decisão do cuidador e armazenamento sob pressão",
    // Lote próprio pelo mesmo motivo que tirou o `offline-app-shell` do lote
    // acima, e com a mesma evidência: o HMR do `next dev` decide, sozinho, um
    // «performing full reload» — e se isso cai no instante em que o teste está
    // com a rede desligada, a página recarrega, não busca nada e nunca volta.
    // O trace da falha registra os três eventos em sequência:
    //
    //   [Fast Refresh] rebuilding
    //   [Fast Refresh] performing full reload
    //   Failed to load resource: net::ERR_INTERNET_DISCONNECTED
    //
    // Não é o produto: em produção um recarregamento sem rede é servido pelo
    // app shell, que é exatamente para isso que ele existe. É o servidor de
    // desenvolvimento. Medido: o teste sozinho passa, a spec inteira passa
    // 13/13, e só falha quando divide o servidor com os outros cinco arquivos.
    arquivos: ["tests/e2e/offline-conflitos.spec.ts"],
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

function ambienteDoServidor(extra = {}) {
  // ——— O provedor real nunca entra num servidor de teste ———
  //
  // A chave não vem de quem roda o teste: o `next dev` lê o `.env`, e o `.env`
  // deste projeto tem a chave de produção. Nenhum comando de teste a menciona,
  // então não há nada para lembrar de neutralizar — foi assim que uma suíte
  // automatizada sintetizou quatro frases de verdade. A decisão passa a ser
  // tomada aqui, uma vez, antes de qualquer processo nascer. O porquê e o
  // mecanismo estão em scripts/eleven-guard.mjs.
  const base = ambienteSemProvedorReal(process.env, extra, "runner de lotes Playwright");
  return {
    ...base,
    PORT: String(PORTA),
    NEXT_DIST_DIR: DIST,
    FIRESTORE_EMULATOR_HOST: EMU,
    FIRESTORE_DATABASE_ID: BANCO,
    GCLOUD_PROJECT: PROJETO,
    // O runner é a única voz no terminal; o dev server fala pelo arquivo de log.
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

/**
 * O mesmo ambiente, para um servidor que roda em modo produção.
 *
 * Modo produção muda três coisas que importam aqui, e todas as três são
 * conferidas em vez de presumidas:
 *
 *  1. Sem `FIRESTORE_EMULATOR_HOST`, o Admin SDK cai em credencial padrão e
 *     fala com o Firestore DE VERDADE. Em `next dev` isso já seria ruim; num
 *     servidor que se anuncia como produção é um acidente esperando acontecer.
 *     Aqui a ausência é erro, não omissão silenciosa.
 *  2. `HELO_SPEECH_GRANT_SECRET` passa a ser obrigatório (lib/voice/speech-grant.ts):
 *     fora de produção o processo usa chave efêmera, em produção exige a
 *     configurada. Damos uma de teste, explícita no nome — é configurar o
 *     servidor corretamente, não contornar a regra.
 *  3. O app shell registra o Service Worker, que em `next dev` não registra.
 *     Isso é comportamento de produção legítimo e fica ligado.
 */
function ambienteDeProducao(extra = {}) {
  const base = ambienteDoServidor(extra);
  if (!base.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "servidor de regressão em modo produção sem FIRESTORE_EMULATOR_HOST: " +
        "sem ele o Admin SDK usaria credencial padrão e falaria com o " +
        "Firestore real. Recusando subir."
    );
  }
  return {
    ...base,
    NEXT_DIST_DIR: DIST_PRODUCAO,
    NODE_ENV: "production",
    // ≥32 caracteres, e o nome diz o que é. Nunca sai daqui para lugar nenhum.
    HELO_SPEECH_GRANT_SECRET:
      base.HELO_SPEECH_GRANT_SECRET ??
      "segredo-de-teste-sem-valor-para-a-regressao-e2e",
  };
}

/**
 * `extra` são variáveis do LOTE. Existe porque a 5.2A precisa de um servidor
 * com o ditado ligado, e ligá-lo para a suíte inteira mudaria o comportamento
 * de lotes que não têm nada a ver com isso.
 */
async function subirServidor(extra, producao = false) {
  if (await alcancavel(BASE_URL, 1500)) {
    throw new Error(
      `a porta ${PORTA} já está ocupada. Cada lote precisa de um dev server ` +
        `novo — encerre quem está lá ou aponte HELO_E2E_PORT para outra porta.`
    );
  }

  const ambiente = producao
    ? ambienteDeProducao(extra)
    : ambienteDoServidor(extra);

  if (producao && !existsSync(resolve(RAIZ, DIST_PRODUCAO, "BUILD_ID"))) {
    throw new Error(
      `não há build em ${DIST_PRODUCAO}. Rode \`npm run test:ui:build\` antes — a build ` +
        `é feita uma vez e reaproveitada pelos lotes que rodam em produção.`
    );
  }

  // detached: o `next dev` gera um next-server filho. Sem grupo próprio, o
  // filho sobrevive ao pai e a porta fica presa para o lote seguinte.
  const proc = spawn(
    "npx",
    producao
      ? ["next", "start", "-p", String(PORTA)]
      : ["next", "dev", "--webpack"],
    {
      cwd: RAIZ,
      env: ambiente,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

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
        // O Playwright não fala com a ElevenLabs — quem fala é o dev server,
        // já protegido acima. Mas o ambiente passa pela mesma guarda mesmo
        // assim: um único caminho que monte ambiente por fora dela é um
        // caminho que alguém copia amanhã para levantar um servidor.
        env: {
          ...ambienteSemProvedorReal(process.env, {}, "processo do Playwright"),
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
  const servidor = await subirServidor(lote.env, lote.producao === true);
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
