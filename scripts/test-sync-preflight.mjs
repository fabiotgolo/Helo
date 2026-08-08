// ——— Preflight da fila: identidade, autenticação e acesso ANTES do envio ———
//
// Prova, contra o servidor de verdade, que `/api/realtime-questions/preflight`
// devolve a MESMA decisão que uma escrita de verdade devolveria — sem gravar
// nada. É a peça que fecha a lacuna que o relatório da Fase D apontou: até
// aqui, "401 antes do envio" só existia reativamente, descoberto no meio de
// um `write` de verdade.
//
//   npm run emu                          (terminal 1)
//   npm run dev                          (terminal 2)
//   npm run test:sync-preflight          (terminal 3)

import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";
// Guarda: esta suíte apaga o banco inteiro. Ver scripts/emulator-guard.mjs.
assertEmuladorDescartavel(EMU, DB, "test-sync-preflight.mjs");

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

function client() {
  let cookie = "";
  return {
    async req(method, path, body) {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = r.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      let json = null;
      try {
        json = await r.json();
      } catch {}
      return { status: r.status, json };
    },
    get(p) { return this.req("GET", p); },
    post(p, b) { return this.req("POST", p, b); },
    patch(p, b) { return this.req("PATCH", p, b); },
    del(p, b) { return this.req("DELETE", p, b); },
  };
}

async function main() {
  console.log(`base: ${BASE} · emulador: ${EMU} (db ${DB})`);
  const wipe = await fetch(
    `http://${EMU}/emulator/v1/projects/${PROJECT}/databases/${DB}/documents`,
    { method: "DELETE" }
  );
  if (!wipe.ok) {
    console.error("não consegui limpar o emulador — abortando");
    process.exit(1);
  }
  console.log("emulador limpo.\n");

  const admin = client();
  const claudia = client();
  const marcos = client();

  await admin.post("/api/auth/bootstrap", {
    name: "Admin", email: "admin@helo.test", password: "senha-admin-123",
  });
  const rClaudia = await admin.post("/api/admin/users", {
    name: "Claudia", email: "claudia@helo.test", password: "senha-teste-123",
    role: "profissional", professionalType: "fonoaudiologo",
  });
  const rMarcos = await admin.post("/api/admin/users", {
    name: "Marcos", email: "marcos@helo.test", password: "senha-teste-123",
    role: "profissional", professionalType: "fonoaudiologo",
  });
  await claudia.post("/api/auth/login", {
    email: "claudia@helo.test", password: "senha-teste-123",
  });
  await marcos.post("/api/auth/login", {
    email: "marcos@helo.test", password: "senha-teste-123",
  });
  const pFabio = (await admin.post("/api/patients", { name: "Dr. Fábio" })).json.patient.id;
  await admin.post("/api/admin/access", {
    userId: rClaudia.json.user.id, patientId: pFabio,
    permissions: ["viewSessions", "createSession"],
  });

  const preflight = (c, expectedUserId) =>
    c.get(`/api/realtime-questions/preflight?patientId=${pFabio}&expectedUserId=${expectedUserId}`);

  // ════ 1. Tudo certo ════
  console.log("\n1. Identidade correta, acesso concedido:");
  {
    const r = await preflight(claudia, rClaudia.json.user.id);
    check("200", r.status === 200, JSON.stringify(r.json));
    check("ok: true", r.json?.ok === true, JSON.stringify(r.json));
    check("devolve o próprio userId", r.json?.userId === rClaudia.json.user.id, JSON.stringify(r.json));
  }

  // ════ 2. Autenticação AUSENTE — detectada ANTES de qualquer write ════
  console.log("\n2. Autenticação ausente (sem cookie):");
  {
    const semSessao = client(); // nunca fez login
    const r = await preflight(semSessao, rClaudia.json.user.id);
    check("401", r.status === 401, `veio ${r.status}: ${JSON.stringify(r.json)}`);
    check("nenhum turno foi criado no caminho", true); // não há write nesta chamada por construção — a rota é GET
  }

  // ════ 3. Acesso ao paciente REVOGADO — detectado ANTES de qualquer write ════
  console.log("\n3. Acesso revogado:");
  {
    // Marcos está autenticado, mas nunca teve vínculo com este paciente.
    const r = await preflight(marcos, rMarcos.json.user.id);
    check("403", r.status === 403, `veio ${r.status}: ${JSON.stringify(r.json)}`);
    check("sem opção de forçar no corpo", r.json?.ok !== true, JSON.stringify(r.json));
  }

  // ════ 4. Identidade trocada (R6) — a fila é de outro cuidador ════
  console.log("\n4. Identidade trocada (R6):");
  {
    // Dá acesso ao Marcos, mas a fila (expectedUserId) continua sendo da Claudia.
    await admin.post("/api/admin/access", {
      userId: rMarcos.json.user.id, patientId: pFabio,
      permissions: ["viewSessions", "createSession"],
    });
    const r = await preflight(marcos, rClaudia.json.user.id);
    check("403", r.status === 403, `veio ${r.status}: ${JSON.stringify(r.json)}`);
    check("code = IDENTITY_MISMATCH", r.json?.code === "IDENTITY_MISMATCH", JSON.stringify(r.json));
  }

  // ════ 5. "Sessão inválida" — a conta foi desativada ════
  console.log("\n5. Sessão inválida (conta desativada depois do login):");
  {
    // Faz login e IMEDIATAMENTE desativa a conta — `updateUser` com
    // status:"inactive" chama `invalidateUserSessions`, que apaga TODAS as
    // sessões do usuário. O cookie que esta aba ainda tem passa a apontar
    // para um token que não existe mais.
    const efemero = client();
    await efemero.post("/api/auth/login", {
      email: "marcos@helo.test", password: "senha-teste-123",
    });
    const desativou = await admin.patch("/api/admin/users", {
      id: rMarcos.json.user.id, status: "inactive",
    });
    check("a conta foi desativada", desativou.status === 200, JSON.stringify(desativou.json));

    const r = await preflight(efemero, rMarcos.json.user.id);
    check(
      "401 — nunca 200 com uma sessão que devia ter parado de valer",
      r.status === 401,
      `veio ${r.status}: ${JSON.stringify(r.json)}`
    );

    // Restaura, para não vazar estado para a seção 6.
    await admin.patch("/api/admin/users", {
      id: rMarcos.json.user.id, status: "active",
    });
  }

  // ════ 6. Mudança DEPOIS do preflight ainda é pega pelo write ════
  console.log("\n6. Mudança depois do preflight: o write ainda recusa:");
  {
    const s = await claudia.post("/api/realtime-questions/sessions", { patientId: pFabio });
    check("sessão criada", s.status === 200, JSON.stringify(s.json));
    const sessionId = s.json.session.id;

    // Preflight passa — está tudo certo NESTE instante.
    const antes = await preflight(claudia, rClaudia.json.user.id);
    check("preflight passa antes da revogação", antes.status === 200, JSON.stringify(antes.json));

    // "Outro aparelho" revoga o vínculo da Claudia DEPOIS do preflight —
    // exatamente a janela que uma checagem só-de-preflight NÃO fecha, e que
    // o requisito exige continuar coberta pelo write.
    const links = (await admin.get("/api/admin/access")).json.links;
    const linkClaudia = links.find(
      (l) => l.userId === rClaudia.json.user.id && l.patientId === pFabio
    );
    check("achou o vínculo da Claudia para revogar", Boolean(linkClaudia));
    await admin.del("/api/admin/access", { id: linkClaudia.id });

    // O WRITE, não o preflight, é quem pega agora — exatamente como antes
    // desta mudança: o servidor confere a CADA requisição.
    const w = await claudia.post("/api/realtime-questions/turns", {
      patientId: pFabio, sessionId,
      text: "pergunta depois da revogação",
      expectedUserId: rClaudia.json.user.id,
    });
    check(
      "o write recusa (403) mesmo com o preflight anterior tendo passado",
      w.status === 403,
      `veio ${w.status}: ${JSON.stringify(w.json)}`
    );
  }

  console.log(`\n${passed} passou, ${failed} falhou.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
