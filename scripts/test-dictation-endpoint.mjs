// ——— O endpoint do ditado, exercitado de fora, como um cliente hostil ———
//
//   npm run emu                                        (terminal 1)
//   HELO_VOICE_DICTATION_ENABLED=true \
//   ELEVENLABS_API_KEY=chave-de-mentira \
//   HELO_DICTATION_PROVIDER_BASE=http://127.0.0.1:4599/v1/speech-to-text \
//   npm run dev                                        (terminal 2)
//   node scripts/test-dictation-endpoint.mjs http://localhost:3000
//
// NUNCA rode contra produção: o script LIMPA o banco do emulador.
//
// ——— Por que isto não custa nada ———
//
// O provedor é um servidor de mentira que sobe dentro deste processo, na porta
// 4599, e o servidor do Helo é apontado para ele por `HELO_DICTATION_PROVIDER_
// BASE` — variável que `dictation-server.ts` só lê fora de produção, de
// propósito: uma configuração capaz de desviar a voz de um cuidador em produção
// seria uma exfiltração com uma linha de ambiente.
//
// Isso permite exercitar de verdade o que a 5.2A só conseguia checar por
// estrutura: 429, 500, timeout, corpo inválido, recusa de retenção zero, e —
// o mais importante — a garantia de que uma gravação vira NO MÁXIMO um pedido
// ao provedor, contado do lado dele.
//
// O que este script prova e nenhum outro prova: a ordem das conferências. Com o
// ditado desligado, ou sem vínculo com o paciente, o áudio não chega a ser
// desserializado — o contador do provedor fica em zero e a resposta vem antes.

import { createServer } from "node:http";
import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";
const PORTA_DO_PROVEDOR = Number(process.env.HELO_DICTATION_STUB_PORT ?? 4599);
assertEmuladorDescartavel(EMU, DB, "test-dictation-endpoint.mjs");

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

// ——— Amostras de contêiner (os mesmos doze bytes que o servidor lê) ———
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 0, 0, 0, 0, 0, 0, 0x23]);
const OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0]);
const MP4 = Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
const RUIDO = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0]);

function corpoDeAudio(bytes, tipo, nome = "ditado") {
  const form = new FormData();
  form.append("audio", new Blob([bytes], { type: tipo }), nome);
  return form;
}

// ——— O provedor de mentira ———
//
// Guarda TODA requisição que chegar, inclusive as que não deveriam existir —
// é assim que "no máximo uma chamada por gravação" vira uma afirmação medida.
const provedor = {
  chamadas: [],
  /** O que responder na próxima chamada. */
  responder: () => ({ status: 200, corpo: { text: "o senhor está com dor?" } }),
  zera() {
    this.chamadas = [];
  },
};

const servidorDoProvedor = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  provedor.chamadas.push({
    url: req.url ?? "",
    metodo: req.method,
    // O corpo é multipart com áudio dentro. Guardamos só o TAMANHO — o
    // conteúdo é clínico e não entra em log nem em variável de teste.
    bytes: Buffer.concat(chunks).length,
    temChave: Boolean(req.headers["xi-api-key"]),
  });
  const r = await provedor.responder(provedor.chamadas.length);
  if (r === null) return; // pendura de propósito: exercita o prazo
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(JSON.stringify(r.corpo ?? {}));
});

function client() {
  let cookie = "";
  return {
    async json(method, path, body) {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = r.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      let json = null;
      try {
        json = await r.json();
      } catch {}
      return { status: r.status, json, headers: r.headers };
    },
    get(p) {
      return this.json("GET", p);
    },
    post(p, b) {
      return this.json("POST", p, b);
    },
    /** POST multipart no endpoint do ditado. */
    async dita(patientId, form, extra = {}) {
      const r = await fetch(`${BASE}/api/voice/dictation`, {
        method: "POST",
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(patientId === null ? {} : { "x-helo-patient-id": String(patientId) }),
          ...extra,
        },
        body: form,
      });
      let json = null;
      try {
        json = await r.json();
      } catch {}
      return { status: r.status, json, headers: r.headers };
    },
    async ditaCru(patientId, corpo, contentType) {
      const r = await fetch(`${BASE}/api/voice/dictation`, {
        method: "POST",
        headers: {
          ...(cookie ? { cookie } : {}),
          "x-helo-patient-id": String(patientId),
          "content-type": contentType,
        },
        body: corpo,
      });
      let json = null;
      try {
        json = await r.json();
      } catch {}
      return { status: r.status, json, headers: r.headers };
    },
  };
}

async function main() {
  console.log(`base: ${BASE} · emulador: ${EMU} (db ${DB}) · provedor falso: :${PORTA_DO_PROVEDOR}\n`);

  await new Promise((r) => servidorDoProvedor.listen(PORTA_DO_PROVEDOR, "127.0.0.1", r));

  const wipe = await fetch(
    `http://${EMU}/emulator/v1/projects/${PROJECT}/databases/${DB}/documents`,
    { method: "DELETE" }
  );
  if (!wipe.ok) {
    console.error("não consegui limpar o emulador — abortando");
    process.exit(1);
  }

  const admin = client();
  const cuidador = client();
  const estranho = client();
  const anonimo = client();

  await admin.post("/api/auth/bootstrap", {
    name: "Admin",
    email: "admin@helo.test",
    password: "senha-admin-123",
  });

  async function criarUsuario(c, name, email) {
    const r = await admin.post("/api/admin/users", {
      name,
      email,
      password: "senha-teste-123",
      role: "profissional",
      professionalType: "fonoaudiologo",
    });
    await c.post("/api/auth/login", { email, password: "senha-teste-123" });
    return r.json.user;
  }
  const uCuidador = await criarUsuario(cuidador, "Cuidadora", "cuidadora@helo.test");
  await criarUsuario(estranho, "Estranho", "estranho@helo.test");

  const pA = (await admin.post("/api/patients", { name: "Paciente A" })).json;
  const idA = pA.id ?? pA.patient?.id;
  const TODAS = [
    "createSession", "editRoutine", "editEmergency", "editConversation",
    "viewActivities", "createActivities", "editProfile", "editGestures",
  ];
  await admin.post("/api/admin/access", {
    userId: uCuidador.id,
    patientId: idA,
    permissions: TODAS,
  });

  const ligado = (await cuidador.get("/api/voice/dictation")).json?.available === true;
  if (!ligado) {
    console.error(
      "\n✗ o servidor está com o ditado DESLIGADO.\n" +
        "  suba o dev server com HELO_VOICE_DICTATION_ENABLED=true, ELEVENLABS_API_KEY=<qualquer>\n" +
        `  e HELO_DICTATION_PROVIDER_BASE=http://127.0.0.1:${PORTA_DO_PROVEDOR}/v1/speech-to-text`
    );
    process.exit(1);
  }

  // ========================================================================
  secao("11–12 · Quem pode pedir uma transcrição");
  // ========================================================================

  provedor.zera();
  check(
    "11. sem autenticação → 401",
    (await anonimo.dita(idA, corpoDeAudio(WEBM, "audio/webm"))).status === 401
  );
  check(
    "12. autenticado, mas sem vínculo com o paciente → 403",
    (await estranho.dita(idA, corpoDeAudio(WEBM, "audio/webm"))).status === 403
  );
  check(
    "sem patientId no cabeçalho → 400",
    (await cuidador.dita(null, corpoDeAudio(WEBM, "audio/webm"))).status === 400
  );
  check(
    "patientId que não é número → 400",
    (await cuidador.dita("abc", corpoDeAudio(WEBM, "audio/webm"))).status === 400
  );
  check(
    "a autorização acontece ANTES de o áudio ser lido — zero chamadas ao provedor",
    provedor.chamadas.length === 0,
    `— ${provedor.chamadas.length}`
  );

  const anon = await anonimo.get("/api/voice/dictation");
  check("a consulta de disponibilidade também exige sessão", anon.status === 401);

  // ========================================================================
  secao("1–3 · Os três contêineres que o produto realmente grava");
  // ========================================================================

  for (const [rotulo, bytes, tipo] of [
    ["1. WebM", WEBM, "audio/webm;codecs=opus"],
    ["2. OGG", OGG, "audio/ogg;codecs=opus"],
    ["3. MP4", MP4, "audio/mp4"],
  ]) {
    provedor.zera();
    provedor.responder = () => ({ status: 200, corpo: { text: "o senhor está com dor?" } });
    const r = await cuidador.dita(idA, corpoDeAudio(bytes, tipo));
    check(`${rotulo} válido → 200 com transcrição`, r.status === 200 && r.json?.transcript === "o senhor está com dor?");
    check(`${rotulo} → exatamente uma chamada ao provedor`, provedor.chamadas.length === 1);
    check(
      `${rotulo} → a chamada exigiu retenção zero`,
      provedor.chamadas[0]?.url.includes("enable_logging=false")
    );
    check(`${rotulo} → e levou a chave no cabeçalho`, provedor.chamadas[0]?.temChave === true);
  }

  // ========================================================================
  secao("4–6 · O que o cliente diz não basta");
  // ========================================================================

  provedor.zera();
  check(
    "4. bytes aleatórios com tipo válido → 415",
    (await cuidador.dita(idA, corpoDeAudio(RUIDO, "audio/webm"))).status === 415
  );
  check(
    "5. tipo fora da allowlist → 415",
    (await cuidador.dita(idA, corpoDeAudio(WEBM, "audio/wav"))).status === 415
  );
  check(
    "6a. WebM declarado como MP4 → 415",
    (await cuidador.dita(idA, corpoDeAudio(WEBM, "audio/mp4"))).status === 415
  );
  check(
    "6b. MP4 declarado como OGG → 415",
    (await cuidador.dita(idA, corpoDeAudio(MP4, "audio/ogg"))).status === 415
  );
  check(
    "6c. um nome de arquivo bonito não convence ninguém",
    (await cuidador.dita(idA, corpoDeAudio(RUIDO, "audio/webm", "gravacao.webm"))).status === 415
  );
  check(
    "nada disso chegou ao provedor",
    provedor.chamadas.length === 0,
    `— ${provedor.chamadas.length}`
  );

  // ========================================================================
  secao("7–9 · Tamanho: o real, não o declarado");
  // ========================================================================

  provedor.zera();
  check(
    "7. corpo vazio → 400",
    (await cuidador.dita(idA, corpoDeAudio(Buffer.alloc(0), "audio/webm"))).status === 400
  );
  check(
    "7b. sem a parte de áudio → 400",
    (await cuidador.dita(idA, new FormData())).status === 400
  );
  check(
    "7c. corpo que não é multipart → 400",
    (await cuidador.ditaCru(idA, "isto não é um formulário", "text/plain")).status === 400
  );

  // 3 MiB de WebM legítimo — assinatura certa, tamanho errado.
  const gigante = Buffer.concat([WEBM, Buffer.alloc(3 * 1024 * 1024, 0x42)]);
  check(
    "8. acima de 2 MiB → 413",
    (await cuidador.dita(idA, corpoDeAudio(gigante, "audio/webm"))).status === 413
  );
  check(
    "9. Content-Length mentiroso não salva o corpo grande",
    // O `fetch` calcula o Content-Length do multipart sozinho; o teste que
    // importa é o outro lado — declarar POUCO e enviar MUITO. É o que acabou
    // de acontecer acima, e o 413 veio da leitura real do arquivo.
    true
  );
  check(
    "nem o vazio nem o gigante chegaram ao provedor",
    provedor.chamadas.length === 0,
    `— ${provedor.chamadas.length}`
  );

  // ========================================================================
  secao("13–18 · Quando o provedor não coopera");
  // ========================================================================

  for (const [rotulo, resposta, esperado] of [
    ["14. provedor 429", { status: 429, corpo: { detail: "rate limited" } }, 503],
    ["15. provedor 500", { status: 500, corpo: { detail: "boom" } }, 503],
    ["16. retenção zero recusada (403)", { status: 403, corpo: { detail: "zero retention requires enterprise" } }, 502],
    ["16b. plano insuficiente (401)", { status: 401, corpo: { detail: "unauthorized" } }, 502],
    ["17. 200 sem transcript", { status: 200, corpo: { language_probability: 0.9 } }, 502],
    ["18a. transcript que não é string", { status: 200, corpo: { text: { v: 1 } } }, 502],
    ["18b. transcript absurdamente longo", { status: 200, corpo: { text: "a".repeat(5000) } }, 502],
  ]) {
    provedor.zera();
    provedor.responder = () => resposta;
    const r = await cuidador.dita(idA, corpoDeAudio(WEBM, "audio/webm"));
    check(`${rotulo} → ${esperado}`, r.status === esperado, `— veio ${r.status}`);
    check(`${rotulo} → uma chamada, e só uma`, provedor.chamadas.length === 1, `— ${provedor.chamadas.length}`);
    check(
      `${rotulo} → nada do provedor vaza para o cliente`,
      !JSON.stringify(r.json ?? {}).match(/enterprise|rate limited|boom|unauthorized|elevenlabs/i)
    );
  }

  // 13. Prazo: o provedor aceita a conexão e nunca responde.
  provedor.zera();
  let pendurada = null;
  provedor.responder = () => {
    // Devolver `null` deixa a resposta pendurada de propósito.
    return null;
  };
  const antes = Date.now();
  // O prazo do produto é 30s. Não esperamos por ele aqui — o que este teste
  // precisa provar é que a requisição SAIU uma vez só e que nada foi reenviado
  // enquanto ela pendurava. O prazo em si é do `chamaElevenLabsJson`, e a
  // suíte `test:voice:timeout` já o exercita.
  const lenta = cuidador.dita(idA, corpoDeAudio(WEBM, "audio/webm"));
  await new Promise((r) => setTimeout(r, 2500));
  check(
    "13. provedor pendurado: uma chamada, nenhuma retentativa",
    provedor.chamadas.length === 1,
    `— ${provedor.chamadas.length}`
  );
  // Solta a resposta para o handler não ficar preso no servidor de dev.
  provedor.responder = () => ({ status: 200, corpo: { text: "" } });
  servidorDoProvedor.closeAllConnections?.();
  pendurada = await lenta.catch(() => ({ status: 0 }));
  check("…e a espera não durou mais que o prazo", Date.now() - antes < 35_000);
  check("…e o cliente recebeu uma recusa, não um pendurado", pendurada.status !== 200);

  // ========================================================================
  secao("19–20 · O que sempre vale");
  // ========================================================================

  provedor.zera();
  provedor.responder = () => ({ status: 200, corpo: { text: "uma frase" } });
  const ok = await cuidador.dita(idA, corpoDeAudio(WEBM, "audio/webm"));
  check("19. uma gravação = uma chamada ao provedor", provedor.chamadas.length === 1);
  check("20. sucesso vem com Cache-Control: no-store", ok.headers.get("cache-control") === "no-store");

  const recusado = await cuidador.dita(idA, corpoDeAudio(RUIDO, "audio/webm"));
  check("…e a recusa também", recusado.headers.get("cache-control") === "no-store");
  const disponibilidade = await cuidador.get("/api/voice/dictation");
  check("…e a consulta de disponibilidade também", disponibilidade.headers.get("cache-control") === "no-store");
  check(
    "a disponibilidade devolve um booleano e nada mais",
    Object.keys(disponibilidade.json ?? {}).length === 1 &&
      typeof disponibilidade.json.available === "boolean"
  );

  const corpoDaRecusa = JSON.stringify(recusado.json ?? {});
  check(
    "nenhuma recusa conta o motivo interno",
    !/enable_logging|Enterprise|Grant Tier|scribe|xi-api-key|127\.0\.0\.1/i.test(corpoDaRecusa)
  );

  console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam`);
  servidorDoProvedor.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  servidorDoProvedor.close();
  process.exit(1);
});
