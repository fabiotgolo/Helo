// ——— Nada da conversa vaza para um log (Fase 5.4C — A-09) ———
//
//   npm run emu:test                                          (terminal 1)
//   npm run test:logs:agente                                  (terminal 2)
//
// Esta suíte sobe o PRÓPRIO servidor, numa porta e num banco só dela, para
// poder capturar stdout e stderr do processo. É a diferença entre "o código
// parece não registrar isso" e "mandei o segredo pela porta da frente e ele
// não apareceu em lugar nenhum".
//
// ——— As duas metades, e por que são duas ———
//
// **Servidor** — executável, e é a metade que mais importa: o que sai por aqui
// vai para o Cloud Logging, fica retido, e é lido por quem opera. A prova é
// direta: marcadores sintéticos entram por endpoints reais e são procurados no
// que o processo escreveu.
//
// **Navegador** — os logs do Agent vivem num componente React que só existe
// dentro de uma sessão WebRTC com o provedor, e abrir uma dessas para testar
// log seria pagar uma chamada real para provar uma ausência. A prova aqui é
// estrutural: cada `console.*` dos caminhos do Agent é extraído por contagem
// de parênteses e os ARGUMENTOS são conferidos contra uma lista do que é
// proibido passar. É o mesmo extrator que a 5.4B escreveu depois de a versão
// por expressão regular produzir três falsos positivos.
//
// ——— O que a 5.4A tinha encontrado ———
//
// Sete linhas no navegador: o objeto de parâmetros que o Agent mandou, a
// chamada de tool não reconhecida inteira, o id de conversa do provedor, o
// objeto de desconexão do SDK, o par mensagem+contexto de erro do provedor, e
// objetos de erro despejados em três `catch`. Nenhuma delas registrava
// transcrição — a fronteira do R-09 segurou —, mas todas carregavam mais do
// que o necessário, e uma delas carregava texto escrito por terceiro.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8090";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "suite-logs-a09";
const PORTA = process.env.HELO_LOGS_PORTA ?? "3512";
const BASE = `http://127.0.0.1:${PORTA}`;

assertEmuladorDescartavel(EMU, DB, "test-logs-agente.mjs");

let passed = 0;
let failed = 0;
function check(nome, cond, detalhe = "") {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${nome}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${nome} ${detalhe}`);
  }
}
function secao(titulo) {
  console.log(`\n${titulo}`);
}

const codigoDe = (caminho) => readFileSync(resolve(RAIZ, caminho), "utf8");

/**
 * A fonte sem comentários.
 *
 * Esta suíte nasceu com o mesmo defeito que a 5.4B já tinha registrado duas
 * vezes: a asserção "`response.text()` não existe mais" reprovava por causa do
 * COMENTÁRIO que explica que ele foi removido. Uma nota sobre a ausência de
 * algo não é a presença desse algo.
 */
function semComentarios(texto) {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((linha) => linha.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * Cada `console.*` da fonte, com os argumentos inteiros.
 *
 * Por contagem de parênteses, e não por expressão regular. A 5.4B registrou o
 * motivo depois de três falsos positivos: uma regex gulosa atravessa o fim da
 * chamada e engole as instruções seguintes; uma preguiçosa para no primeiro
 * `)` e perde tudo o que veio depois de um parêntese aninhado.
 */
function chamadasDeConsole(fonte) {
  const encontradas = [];
  const inicio = /console\.(log|warn|error|info|debug)\(/g;
  let m;
  while ((m = inicio.exec(fonte)) != null) {
    let profundidade = 1;
    let i = m.index + m[0].length;
    while (i < fonte.length && profundidade > 0) {
      if (fonte[i] === "(") profundidade += 1;
      else if (fonte[i] === ")") profundidade -= 1;
      i += 1;
    }
    encontradas.push(fonte.slice(m.index, i));
  }
  return encontradas;
}

// ═════════════════════════════════════════════════════════════════════════
// METADE 1 — o navegador, por estrutura
// ═════════════════════════════════════════════════════════════════════════

secao("1. Nenhum log do Agent recebe objeto de terceiro");
{
  const provider = codigoDe("components/helo-agent-provider.tsx");
  const chamadas = chamadasDeConsole(provider);
  check("há logs a conferir no provider do Agent", chamadas.length > 10, `— ${chamadas.length}`);

  // Os nomes que, se aparecerem como ARGUMENTO de um log, significam que algo
  // de fora está sendo despejado no console. Cada um custou uma linha da
  // auditoria da 5.4A.
  const PROIBIDOS = [
    ["parameters", "o objeto que o Agent montou — o Helo não escolhe o que vem dentro"],
    ["call", "a chamada de tool inteira, com os parâmetros"],
    ["context", "o contexto de erro do SDK do provedor"],
    ["caught", "o objeto de erro, inteiro"],
    ["conversationId", "o identificador da conversa do lado do provedor"],
    ["transcript", "transcrição"],
    ["patientName", "o nome da pessoa"],
    ["audioUrl", "endereço de mídia"],
    ["storagePath", "caminho de mídia"],
    ["grant", "autorização de fala"],
    ["conversationToken", "credencial do provedor"],
  ];

  for (const [nome, porque] of PROIBIDOS) {
    // Só os ARGUMENTOS: o rótulo do log pode citar o nome sem carregá-lo.
    const culpadas = chamadas.filter((c) => {
      const argumentos = c.slice(c.indexOf("(") + 1);
      return new RegExp(`(^|[\\s,{[(])${nome}([\\s,}\\])]|$)`).test(argumentos);
    });
    check(
      `nenhum log carrega \`${nome}\` (${porque})`,
      culpadas.length === 0,
      `— ${culpadas.map((c) => c.split("\n")[0]).join(" | ")}`
    );
  }

  // `details` é o objeto de desconexão do SDK. Ele pode ficar, mas só pelo
  // campo de vocabulário fechado que o Helo já usa para decidir o que fazer.
  const comDetails = chamadas.filter((c) => /\bdetails\b/.test(c.slice(c.indexOf("(") + 1)));
  check(
    "o objeto de desconexão do SDK só entra pelo motivo",
    comDetails.every((c) => /details\.reason/.test(c)),
    `— ${comDetails.map((c) => c.split("\n")[0]).join(" | ")}`
  );

  // O `message` do provedor não pode voltar nem para o log nem para a tela.
  check(
    "a mensagem de erro do provedor não é registrada",
    !chamadas.some((c) => /agent error/.test(c) && /\bmessage\b/.test(c.slice(c.indexOf("(") + 1)))
  );
  check(
    "…nem mostrada ao cuidador — o texto é sempre escrito pela Helo",
    !/onError\(message \|\|/.test(provider),
    "— `onError(message || …)` devolve à tela o texto que o provedor escreveu"
  );
}

// ═════════════════════════════════════════════════════════════════════════
secao("2. O servidor não registra conteúdo — em nenhum arquivo do produto");
{
  const ignorar = new Set(["node_modules", ".next", ".git"]);
  const fontes = [];
  const anda = (dir) => {
    for (const entrada of readdirSync(resolve(RAIZ, dir))) {
      if (ignorar.has(entrada)) continue;
      const completo = join(dir, entrada);
      if (statSync(resolve(RAIZ, completo)).isDirectory()) anda(completo);
      else if (/\.(tsx?|js)$/.test(entrada)) fontes.push(completo);
    }
  };
  // O app INTEIRO, não uma lista de arquivos suspeitos. Foi assim que esta
  // suíte encontrou `[HELO ROUTINE] selected answer text` — um log com o texto
  // da resposta clínica do paciente, numa tela que a auditoria da 5.4A não
  // varreu porque estava atrás dos caminhos do Agent.
  for (const raiz of ["app", "lib", "components"]) anda(raiz);
  fontes.push("functions/index.js");

  /** Nomes que, como ARGUMENTO de um log, são conteúdo e não diagnóstico. */
  const CONTEUDO = [
    "responseText", "requestedText", "compositionPrompt", "spokenText",
    "resolved.text", "body.text", "req.body?.prompt", "phrase.text",
    "transcript", "displayText", "item.phrase",
  ];
  const culpados = [];
  for (const arquivo of fontes) {
    for (const chamada of chamadasDeConsole(codigoDe(arquivo))) {
      const argumentos = chamada.slice(chamada.indexOf("(") + 1);
      if (CONTEUDO.some((nome) => argumentos.includes(nome))) {
        culpados.push(`${arquivo}: ${chamada.split("\n")[0]}`);
      }
    }
  }
  check(
    "nenhum log do produto recebe texto do cuidador ou do paciente",
    culpados.length === 0,
    `— ${culpados.join(" | ")}`
  );

  // O corpo do provedor não é sequer lido (R-07b, fechado na 5.4B). Sobre a
  // fonte SEM comentários: a nota que explica a remoção cita o que removeu.
  const comProviderText = fontes.filter((f) =>
    /(elevenLabsResponse|eleven|resposta)\.text\(\)/i.test(semComentarios(codigoDe(f)))
  );
  check(
    "`response.text()` continua não existindo em caminho de provedor",
    comProviderText.length === 0,
    `— ${comProviderText.join(", ")}`
  );
}

// ═════════════════════════════════════════════════════════════════════════
// METADE 2 — o servidor, por execução
// ═════════════════════════════════════════════════════════════════════════

// Marcadores sintéticos. Nada de dado real: se um deles aparecer no log, o
// caminho por onde ele entrou registra conteúdo, e o marcador diz qual é.
const MARCADORES = {
  frase: "SEGREDO_A09_FRASE_X1",
  observacao: "SEGREDO_A09_TRANSCRIPT_X2",
  paciente: "SEGREDO_A09_PACIENTE_X3",
  ferramenta: "SEGREDO_A09_TOOL_X4",
};

function cliente() {
  let cookie = "";
  return {
    async post(path, body) {
      const r = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
      const setCookie = r.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      let json = null;
      try {
        json = await r.json();
      } catch {}
      return { status: r.status, json };
    },
  };
}

async function main() {
  const limpou = await fetch(
    `http://${EMU}/emulator/v1/projects/${PROJECT}/databases/${DB}/documents`,
    { method: "DELETE" }
  ).catch(() => null);
  if (!limpou?.ok) {
    console.error(`\nemulador não responde em ${EMU} — \`npm run emu:test\` primeiro.`);
    process.exit(1);
  }

  secao(`3. Marcadores entram pela porta da frente (servidor próprio na ${PORTA})`);
  const servidor = spawn(
    "node",
    [
      "scripts/dev-server-de-teste.mjs",
      "--porta", PORTA,
      "--banco", DB,
      "--dist", ".next-suite-logs",
      "--emulador", EMU,
    ],
    { cwd: RAIZ, detached: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  let saida = "";
  servidor.stdout.on("data", (d) => (saida += d));
  servidor.stderr.on("data", (d) => (saida += d));

  const encerra = () => {
    try {
      process.kill(-servidor.pid, "SIGTERM");
    } catch {}
  };

  try {
    const limite = Date.now() + 120_000;
    let noAr = false;
    while (Date.now() < limite && !noAr) {
      await new Promise((r) => setTimeout(r, 1000));
      noAr = await fetch(`${BASE}/api/auth/me`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false);
    }
    if (!noAr) {
      console.error(`servidor não subiu na ${PORTA}:\n${saida.slice(-800)}`);
      encerra();
      process.exit(1);
    }
    check("o servidor de teste subiu", true);
    check(
      "…e subiu sem provedor real",
      /NEUTRALIZADO/.test(saida),
      "— a guarda de scripts/eleven-guard.mjs não anunciou a neutralização"
    );

    const admin = cliente();
    await admin.post("/api/auth/bootstrap", {
      name: "Admin", email: "admin@helo.test", password: "senha-admin-123",
    });
    const p = (await admin.post("/api/patients", { name: MARCADORES.paciente })).json;
    const pid = p.id ?? p.patient?.id;

    // Cada marcador entra pelo caminho que a auditoria apontou como capaz de
    // registrá-lo.
    await admin.post("/api/favorite-phrases", { patientId: pid, text: MARCADORES.frase });
    await admin.post("/api/tts", {
      text: MARCADORES.frase, speakerRole: "patient", patientId: pid, grant: "invalido",
    });
    await admin.post("/api/voice/grant", {
      patientId: pid, source: { kind: "favoritePhrase", phraseId: MARCADORES.ferramenta },
    });
    await admin.post("/api/helo/client-tools", {
      patientId: pid, action: "navigateHeloArea", area: MARCADORES.ferramenta,
    });
    await admin.post("/api/helo/conversation-token", { patientId: pid });
    await admin.post(`/api/patients/${pid}/observations`, { text: MARCADORES.observacao });

    // Um instante para o que estiver em voo terminar de escrever.
    await new Promise((r) => setTimeout(r, 1500));

    secao("4. E não saem em lugar nenhum do log");
    for (const [onde, marcador] of Object.entries(MARCADORES)) {
      check(
        `o marcador de ${onde} não aparece em stdout/stderr`,
        !saida.includes(marcador),
        `— ${saida.split("\n").filter((l) => l.includes(marcador)).slice(0, 2).join(" | ")}`
      );
    }
    check(
      "o log registrou ALGUMA coisa — a suíte não está lendo um arquivo vazio",
      saida.length > 200,
      `— ${saida.length} bytes`
    );
    check(
      "e a recusa de fala do paciente foi registrada só pela categoria",
      !/\[VOZ\] fala do paciente recusada:.*SEGREDO/.test(saida)
    );
  } finally {
    encerra();
  }

  console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((erro) => {
  console.error(erro);
  process.exit(1);
});
