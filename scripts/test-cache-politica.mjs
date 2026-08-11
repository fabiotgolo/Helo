// ——— O que não pode ser guardado diz que não pode (Fase 5.4C — A-10b) ———
//
//   npm run emu:test                                          (terminal 1)
//   npm run dev:teste                                          (terminal 2)
//   npm run test:cache:politica                                (terminal 3)
//
// ——— O que a medição encontrou, e por que esta suíte existe ———
//
// A 5.4A leu o código e listou rotas sem `Cache-Control`. A 5.4C mediu: uma
// build de PRODUÇÃO do Next 16.2.10, catorze rotas consultadas, **nenhuma**
// emitiu `Cache-Control` — nem no 200, nem no 400, nem no 401. Não existe
// default do framework a herdar. O que não está escrito na rota não existe na
// resposta.
//
// A correção foi rota a rota, e é justamente por isso que esta suíte pergunta
// ao SERVIDOR em vez de ler o código: uma política aplicada arquivo por
// arquivo é uma política que a próxima rota esquece. Quem esquecer verá um
// teste vermelho, não um revisor atento.
//
// ——— Por que o erro importa tanto quanto o sucesso ———
//
// O padrão que a auditoria encontrou era o header no 200 e ausente no 401. Mas
// uma recusa também carrega contexto: "sem vínculo com este paciente",
// guardado por um intermediário, conta a quem a recebe que aquele paciente
// existe. Cada rota aqui é conferida nos dois estados.

import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const BASE = process.argv[2] ?? "http://localhost:3510";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";

assertEmuladorDescartavel(EMU, DB, "test-cache-politica.mjs");

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

function cliente() {
  let cookie = "";
  return {
    async req(method, path, body) {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = r.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      return r;
    },
    async post(path, body) {
      const r = await this.req("POST", path, body);
      let json = null;
      try {
        json = await r.json();
      } catch {}
      return { status: r.status, json, headers: r.headers };
    },
    get(path) {
      return this.req("GET", path);
    },
  };
}

/**
 * A pergunta que esta suíte faz, uma vez por resposta.
 *
 * `statusEsperado` não é decoração: sem ele, uma rota que passasse a devolver
 * 404 por outro motivo continuaria "passando" no teste de header enquanto o
 * caminho que se queria exercitar deixava de existir.
 */
async function exige(rotulo, chamada, statusEsperado) {
  const r = await chamada();
  const status = r.status ?? r.status;
  const cache = (r.headers.get("cache-control") ?? "").toLowerCase();
  const statusOk = statusEsperado === undefined || status === statusEsperado;
  check(
    `${rotulo} → ${status}${statusEsperado === undefined ? "" : ""} · ${cache || "(SEM Cache-Control)"}`,
    statusOk && cache === "no-store",
    statusOk ? "" : `— esperava ${statusEsperado}`
  );
  return r;
}

async function main() {
  console.log(`base: ${BASE} · emulador: ${EMU} (db ${DB})\n`);

  const limpou = await fetch(
    `http://${EMU}/emulator/v1/projects/${PROJECT}/databases/${DB}/documents`,
    { method: "DELETE" }
  );
  if (!limpou.ok) {
    console.error("não consegui limpar o emulador — abortando");
    process.exit(1);
  }

  const anonimo = cliente();
  const admin = cliente();
  const cuidadora = cliente();
  const estranha = cliente();

  await admin.post("/api/auth/bootstrap", {
    name: "Admin", email: "admin@helo.test", password: "senha-admin-123",
  });
  const pA = (await admin.post("/api/patients", { name: "Paciente A" })).json;
  const pB = (await admin.post("/api/patients", { name: "Paciente B" })).json;
  const idA = pA.id ?? pA.patient?.id;
  const idB = pB.id ?? pB.patient?.id;

  const TODAS = [
    "createSession", "editRoutine", "editEmergency", "editConversation",
    "viewActivities", "createActivities", "editActivities", "deleteActivities",
    "editProfile", "editGestures", "viewMetrics",
  ];
  async function criar(c, nome, email) {
    const r = await admin.post("/api/admin/users", {
      name: nome, email, password: "senha-teste-123", role: "profissional",
      professionalType: "fonoaudiologo",
    });
    await c.post("/api/auth/login", { email, password: "senha-teste-123" });
    return r.json.user;
  }
  const uCuidadora = await criar(cuidadora, "Cuidadora", "cuidadora@helo.test");
  await criar(estranha, "Estranha", "estranha@helo.test");
  await admin.post("/api/admin/access", {
    userId: uCuidadora.id, patientId: idA, permissions: TODAS,
  });

  // ════════════════════════════════════════════════════════════════════
  secao("1. Identidade de quem está logado");
  await exige("GET /api/auth/me anônimo", () => anonimo.get("/api/auth/me"), 200);
  await exige("GET /api/auth/me autenticado", () => cuidadora.get("/api/auth/me"), 200);

  // ════════════════════════════════════════════════════════════════════
  secao("2. Estado de voz — a rota que mais conta sobre um paciente");
  await exige("GET /api/voices sem sessão", () => anonimo.get("/api/voices"), 401);
  await exige("GET /api/voices autenticada", () => cuidadora.get("/api/voices"), 200);
  await exige(
    "GET /api/voices?patientId= com vínculo",
    () => cuidadora.get(`/api/voices?patientId=${idA}`),
    200
  );
  await exige(
    "GET /api/voices?patientId= SEM vínculo (a recusa conta que o paciente existe)",
    () => estranha.get(`/api/voices?patientId=${idA}`),
    403
  );

  // ════════════════════════════════════════════════════════════════════
  secao("3. Token de conversa — a 5.4A a listou sem header nenhum");
  await exige(
    "POST /api/helo/conversation-token sem patientId",
    () => admin.post("/api/helo/conversation-token", {}),
    400
  );
  await exige(
    "POST /api/helo/conversation-token sem sessão",
    () => anonimo.post("/api/helo/conversation-token", { patientId: idA }),
    401
  );
  await exige(
    "POST /api/helo/conversation-token sem vínculo",
    () => estranha.post("/api/helo/conversation-token", { patientId: idA }),
    403
  );
  await exige(
    "POST /api/helo/conversation-token com vínculo (provedor ausente)",
    () => cuidadora.post("/api/helo/conversation-token", { patientId: idA }),
    503
  );

  // ════════════════════════════════════════════════════════════════════
  secao("4. Client tools — a outra rota que a 5.4A listou sem header");
  await exige(
    "POST /api/helo/client-tools sem paciente",
    () => admin.post("/api/helo/client-tools", {}),
    400
  );
  await exige(
    "POST /api/helo/client-tools com ação inválida",
    () => admin.post("/api/helo/client-tools", { patientId: idA, action: "formatarDisco" }),
    400
  );
  await exige(
    "POST /api/helo/client-tools sem vínculo",
    () => estranha.post("/api/helo/client-tools", { patientId: idA, action: "navigateHeloArea" }),
    403
  );
  await exige(
    "POST /api/helo/client-tools autorizada",
    () => cuidadora.post("/api/helo/client-tools", { patientId: idA, action: "navigateHeloArea" }),
    200
  );

  // ════════════════════════════════════════════════════════════════════
  secao("5. Fala do paciente — grant e síntese");
  await exige("POST /api/voice/grant sem patientId", () => admin.post("/api/voice/grant", {}), 400);
  await exige(
    "POST /api/voice/grant sem sessão",
    () => anonimo.post("/api/voice/grant", { patientId: idA, source: { kind: "favoritePhrase", phraseId: "x" } }),
    401
  );
  await exige(
    "POST /api/voice/grant sem vínculo",
    () => estranha.post("/api/voice/grant", { patientId: idA, source: { kind: "favoritePhrase", phraseId: "x" } }),
    403
  );
  await exige("POST /api/tts sem texto", () => admin.post("/api/tts", {}), 400);
  await exige("POST /api/tts sem sessão", () => anonimo.post("/api/tts", { text: "oi" }), 401);
  await exige(
    "POST /api/tts na voz de paciente sem vínculo",
    () => estranha.post("/api/tts", { text: "oi", speakerRole: "patient", patientId: idA }),
    403
  );

  // ════════════════════════════════════════════════════════════════════
  secao("6. Ditado — desligado em produção, e mesmo assim conferido");
  await exige("GET /api/voice/dictation sem sessão", () => anonimo.get("/api/voice/dictation"), 401);
  await exige("GET /api/voice/dictation autenticada", () => cuidadora.get("/api/voice/dictation"), 200);
  await exige(
    "POST /api/voice/dictation sem patientId",
    () => admin.post("/api/voice/dictation", {}),
    400
  );

  // ════════════════════════════════════════════════════════════════════
  secao("7. Configuração de voz do paciente");
  await exige(
    "POST /api/patient-voice-source sem patientId",
    () => admin.post("/api/patient-voice-source", {}),
    400
  );
  await exige(
    "POST /api/patient-voice-source sem vínculo",
    () => estranha.post("/api/patient-voice-source", { patientId: idA, source: "platform" }),
    403
  );
  await exige(
    "POST /api/voice-preference inválida",
    () => cuidadora.post("/api/voice-preference", { heloVoicePreference: "robo" }),
    400
  );
  await exige(
    "POST /api/voice-preference válida",
    () => cuidadora.post("/api/voice-preference", { heloVoicePreference: "male" }),
    200
  );

  // ════════════════════════════════════════════════════════════════════
  secao("8. Rotas de Admin — o único lugar por onde um voiceId entra");
  await exige("GET /api/admin/voices sem sessão", () => anonimo.get("/api/admin/voices"), 401);
  await exige("GET /api/admin/voices sem ser admin", () => cuidadora.get("/api/admin/voices"), 403);
  await exige("GET /api/admin/voices como admin", () => admin.get("/api/admin/voices"), 200);
  await exige(
    "POST /api/admin/patient-voice sem ser admin",
    () => cuidadora.post("/api/admin/patient-voice", { patientId: idA, elevenLabsVoiceId: "x" }),
    403
  );
  await exige(
    "POST /api/admin/patient-voice sem parâmetros",
    () => admin.post("/api/admin/patient-voice", {}),
    400
  );

  // ════════════════════════════════════════════════════════════════════
  secao("9. Mídia do paciente — os caminhos de recusa da 5.4B");
  //
  // O SUCESSO destas duas rotas tem política própria (`private, no-store` para
  // a voz clonada, `private, max-age=0, must-revalidate` para a música) e é
  // provado por `test:midia:autorizacao`, que precisa do emulador de Storage.
  // O que faltava era o outro lado: as recusas saíam sem header nenhum.
  await exige(
    "GET /api/favorite-phrases/audio sem patientId",
    () => cuidadora.get("/api/favorite-phrases/audio"),
    400
  );
  await exige(
    "GET /api/favorite-phrases/audio sem sessão",
    () => anonimo.get(`/api/favorite-phrases/audio?patientId=${idA}&phraseId=abc`),
    401
  );
  await exige(
    "GET /api/favorite-phrases/audio sem vínculo",
    () => estranha.get(`/api/favorite-phrases/audio?patientId=${idA}&phraseId=abc`),
    403
  );
  await exige(
    "GET /api/favorite-phrases/audio de frase inexistente",
    () => cuidadora.get(`/api/favorite-phrases/audio?patientId=${idA}&phraseId=naoexiste`),
    404
  );
  await exige(
    "GET playlist/audio sem id",
    () => cuidadora.get(`/api/patients/${idA}/playlist/audio`),
    400
  );
  await exige(
    "GET playlist/audio de outro paciente",
    () => cuidadora.get(`/api/patients/${idB}/playlist/audio?id=abc`),
    403
  );
  await exige(
    "GET playlist/audio de faixa inexistente",
    () => cuidadora.get(`/api/patients/${idA}/playlist/audio?id=naoexiste`),
    404
  );

  // ════════════════════════════════════════════════════════════════════
  secao("10. A recusa por limite também não é guardável");
  {
    // Um 429 guardado por um intermediário barraria alguém que já podia voltar
    // a tentar. E ele é a única resposta desta lista que carrega `Retry-After`.
    const c = cliente();
    const uLimite = await criar(c, "Cuidadora Limite", "limite@helo.test");
    // Com vínculo, de propósito: o limitador roda DEPOIS da autorização, e sem
    // vínculo estes pedidos parariam no 403 sem nunca chegar ao contador.
    await admin.post("/api/admin/access", {
      userId: uLimite.id, patientId: idA, permissions: TODAS,
    });
    let recusa = null;
    for (let i = 0; i < 15 && !recusa; i += 1) {
      const r = await c.post("/api/helo/conversation-token", { patientId: idA });
      if (r.status === 429) recusa = r;
    }
    check("o limite foi alcançado", Boolean(recusa));
    if (recusa) {
      check(
        "429 · no-store",
        (recusa.headers.get("cache-control") ?? "").toLowerCase() === "no-store",
        `— ${recusa.headers.get("cache-control")}`
      );
      check("…e traz Retry-After", Boolean(recusa.headers.get("retry-after")));
    }
    const semLimite = await cuidadora.get("/api/auth/me");
    check(
      "e Retry-After só aparece onde há espera — não em toda resposta",
      !semLimite.headers.get("retry-after")
    );
  }

  console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((erro) => {
  console.error(erro);
  process.exit(1);
});
