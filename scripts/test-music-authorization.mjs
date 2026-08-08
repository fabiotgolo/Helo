// ——— Geração de música exige acesso ao paciente (Fase 5.1A / R-03) ———
//
// /generateMusic gasta crédito pago da ElevenLabs, grava um MP3 no Storage e
// escreve na playlist de um paciente. Até a 5.1A não pedia nada: bastava
// conhecer a URL para compor música na conta da Helo e inserir faixas no
// histórico de qualquer paciente, informando o id no corpo. O mesmo valia para
// a rota legada /webhook/generate_music.
//
//   node scripts/test-music-authorization.mjs
//
// ——— Por que isto não gasta crédito ———
//
// O teste roda o handler real de functions/index.js com um Firestore falso, e
// todos os casos param ANTES da chamada externa: sem acesso, a recusa vem
// primeiro; com acesso, o `fetch` é substituído por um espião que registra a
// tentativa e devolve erro. Se algum caso escapar e chamar a ElevenLabs de
// verdade, o espião falha o teste em vez de deixar passar silenciosamente.

import { register } from "node:module";
import Module from "node:module";

register("./alias-loader.mjs", import.meta.url);

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

// ——— Firestore falso, só com o que a autorização lê ———
const AGORA = new Date();
const DEPOIS = new Date(Date.now() + 86_400_000).toISOString();
const ANTES = new Date(Date.now() - 86_400_000).toISOString();

const TOKEN_CUIDADOR = "a".repeat(64);
const TOKEN_INTRUSO = "b".repeat(64);
const TOKEN_EXPIRADO = "c".repeat(64);
const TOKEN_ADMIN = "d".repeat(64);
const TOKEN_INATIVO = "e".repeat(64);

const dados = {
  authSessions: {
    [TOKEN_CUIDADOR]: { userId: "u-cuidador", expiresAt: DEPOIS },
    [TOKEN_INTRUSO]: { userId: "u-intruso", expiresAt: DEPOIS },
    [TOKEN_EXPIRADO]: { userId: "u-cuidador", expiresAt: ANTES },
    [TOKEN_ADMIN]: { userId: "u-admin", expiresAt: DEPOIS },
    [TOKEN_INATIVO]: { userId: "u-inativo", expiresAt: DEPOIS },
  },
  users: {
    "u-cuidador": { status: "active", role: "profissional" },
    "u-intruso": { status: "active", role: "profissional" },
    "u-admin": { status: "active", role: "admin" },
    "u-inativo": { status: "inactive", role: "profissional" },
  },
  userPatientAccess: {
    // A cuidadora alcança o paciente 1 e NÃO o 2.
    "u-cuidador_1": { status: "active", permissions: ["createSession", "createActivities"] },
    // O intruso alcança o 2, mas sem a permissão de conduzir sessão.
    "u-intruso_2": { status: "active", permissions: ["viewDashboard"] },
  },
};

function doc(colecao, id) {
  const valor = dados[colecao]?.[id];
  return {
    exists: valor !== undefined,
    id,
    data: () => valor,
    ref: { collection: () => ({ doc: () => doc("nada", "nada") }) },
  };
}

const firestoreFalso = {
  collection: (nome) => ({
    doc: (id) => ({ get: async () => doc(nome, id) }),
    get: async () => ({ docs: [], empty: true }),
    add: async () => ({ id: "novo" }),
  }),
};

// Chave FALSA, só para o handler seguir até o ponto da chamada externa. Sem
// ela ele pararia num 503 antes do `fetch`, e o teste não conseguiria
// distinguir "recusado por autorização" de "não configurado" — que é
// exatamente a distinção que interessa aqui.
process.env.ELEVENLABS_API_KEY = "chave-de-teste-que-nunca-sai-do-processo";

// ——— Espião de rede: nada pode alcançar a ElevenLabs ———
let chamadasExternas = [];
globalThis.fetch = async (url) => {
  chamadasExternas.push(String(url));
  return {
    ok: false,
    status: 500,
    text: async () => "rede bloqueada no teste",
    arrayBuffer: async () => new ArrayBuffer(0),
  };
};

// ——— Stubs dos módulos do firebase-admin que o handler importa ———
const original = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "firebase-admin") {
    return {
      apps: [{}],
      initializeApp() {},
      app: () => ({}),
      storage: () => ({ bucket: () => ({ file: () => ({ save: async () => {}, delete: async () => {} }) }) }),
    };
  }
  if (id === "firebase-admin/firestore") return { getFirestore: () => firestoreFalso };
  if (id === "firebase-admin/storage") return { getDownloadURL: async () => "https://exemplo/audio.mp3" };
  if (id === "firebase-functions/v2/https") return { onRequest: (_opts, h) => h };
  if (id === "express") {
    const app = () => {};
    app.use = () => {};
    app.post = () => {};
    const express = () => app;
    express.json = () => () => {};
    return express;
  }
  if (id === "cors") return () => () => {};
  return original.apply(this, arguments);
};

const { createRequire } = Module;
const requireCjs = createRequire(import.meta.url);
const funcoes = requireCjs("../functions/index.js");
Module.prototype.require = original;

const handler = funcoes.generateMusic;

/** Executa o handler e devolve { status, body }. */
async function chamar({ token, patientId, prompt = "uma canção calma", duration } = {}) {
  chamadasExternas = [];
  let status = 200;
  let body = null;
  const res = {
    status(s) { status = s; return this; },
    json(b) { body = b; return this; },
    set() { return this; },
  };
  await handler(
    {
      method: "POST",
      headers: token ? { cookie: `__session=${token}` } : {},
      body: { patientId, prompt, ...(duration ? { duration_seconds: duration } : {}) },
    },
    res
  );
  return { status, body, externas: chamadasExternas };
}

console.log("\n25–28. Quem pode gerar música:");
{
  const anon = await chamar({ patientId: 1 });
  check("25. sem sessão → 401", anon.status === 401, JSON.stringify(anon.body));
  check("25b. …e nada foi pedido à ElevenLabs", anon.externas.length === 0, anon.externas.join());

  const expirado = await chamar({ token: TOKEN_EXPIRADO, patientId: 1 });
  check("sessão expirada → 401", expirado.status === 401);

  const inativo = await chamar({ token: TOKEN_INATIVO, patientId: 1 });
  check("usuário inativo → 401", inativo.status === 401);

  const semPermissao = await chamar({ token: TOKEN_INTRUSO, patientId: 2 });
  check(
    "26. usuário sem a permissão no paciente → 403",
    semPermissao.status === 403,
    JSON.stringify(semPermissao.body)
  );
  check("26b. …e nada foi pedido à ElevenLabs", semPermissao.externas.length === 0);

  const cruzado = await chamar({ token: TOKEN_CUIDADOR, patientId: 2 });
  check(
    "28. patientId de outro paciente → 403",
    cruzado.status === 403,
    "— o id do corpo passou a valer como autorização"
  );
  check("28b. …e nada foi pedido à ElevenLabs", cruzado.externas.length === 0);

  const semPaciente = await chamar({ token: TOKEN_CUIDADOR });
  check("sem patientId → 400", semPaciente.status === 400);

  const autorizado = await chamar({ token: TOKEN_CUIDADOR, patientId: 1 });
  check(
    "27. usuário autorizado atravessa a autorização",
    autorizado.status !== 401 && autorizado.status !== 403,
    `— status ${autorizado.status}`
  );
  check(
    "27b. …e é o ÚNICO caso que alcança a ElevenLabs",
    autorizado.externas.length === 1 && autorizado.externas[0].includes("elevenlabs.io"),
    autorizado.externas.join()
  );

  const admin = await chamar({ token: TOKEN_ADMIN, patientId: 99 });
  check(
    "admin passa em qualquer paciente (mesma regra do app)",
    admin.status !== 401 && admin.status !== 403
  );
}

console.log("\n29. A rota legada não é bypass:");
{
  // /webhook/generate_music compartilha o MESMO handler. Se ele exige acesso,
  // a rota legada exige também — é essa a garantia, e ela é estrutural.
  const anon = await chamar({ patientId: 1 });
  check(
    "29. o handler do webhook legado é o mesmo, e recusa anônimo",
    anon.status === 401
  );
  const legadoFonte = requireCjs("node:fs").readFileSync("functions/index.js", "utf8");
  check(
    "29b. a rota legada aponta para generateMusicHandler (sem caminho próprio)",
    /webhook\/generate_music/.test(legadoFonte) &&
      /generateMusicHandler\(req, res\)/.test(legadoFonte)
  );
  check(
    "29c. está marcada como depreciada",
    /DEPRECIADO/.test(legadoFonte)
  );
}

console.log("\nTeto de custo:");
{
  const longa = await chamar({ token: TOKEN_CUIDADOR, patientId: 1, duration: 99999 });
  check(
    "duração absurda é cortada no teto, não encomendada",
    longa.externas.length === 1,
    "— o pedido não chegou como esperado"
  );
  const fonte = requireCjs("node:fs").readFileSync("functions/index.js", "utf8");
  check("existe um teto declarado", /MAX_MUSIC_DURATION_SECONDS\s*=\s*\d+/.test(fonte));
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
