// ——— O servidor NOMEIA o conflito (Fase 4.9.3-C, §10) ———
//
// O teste puro (`test:offline:conflicts`) prova que o classificador sabe o que
// fazer com cada código. Este prova a metade que falta, e que só o servidor de
// verdade pode provar: que os códigos SAEM de lá.
//
// Sem este arquivo, a matriz seria uma tabela bonita alimentada por um
// contrato que ninguém verificou — e o primeiro sintoma de que o servidor
// parou de mandar `code` seria um cuidador, em produção, vendo "o servidor
// recusou este registro, e não sabemos dizer por quê".
//
// O que cada asserção protege, além do código em si:
//
//   • a MENSAGEM em português continua exatamente a mesma de antes. Nomear o
//     conflito não podia mudar o que o produto já dizia — as telas online
//     leem `error`, e uma mudança ali seria regressão silenciosa;
//   • o corpo NÃO carrega o documento inteiro. Uma resposta de erro vai para
//     quem acabou de ser recusado; mandar o registro junto vazaria dado
//     clínico exatamente para quem talvez não devesse mais lê-lo.
//
//   npm run emu                          (terminal 1)
//   npm run dev                          (terminal 2)
//   npm run test:conflict-codes          (terminal 3)

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";

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
  };
}

const rid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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
  await admin.post("/api/admin/users", {
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
    userId: rClaudia.json.user.id,
    patientId: pFabio,
    permissions: ["viewSessions", "createSession"],
  });

  const RTQ = "/api/realtime-questions";
  const novaSessao = async () =>
    (await claudia.post(`${RTQ}/sessions`, { patientId: pFabio })).json.session;

  // ════ Caso 1 — sessão concluída em outro dispositivo ════
  console.log("\nCaso 1 — SESSION_COMPLETED:");
  {
    const s = await novaSessao();
    await claudia.patch(`${RTQ}/sessions`, {
      patientId: pFabio, sessionId: s.id, action: "COMPLETE",
    });
    // A fila offline chega atrasada com uma pausa: a sessão já acabou.
    const r = await claudia.patch(`${RTQ}/sessions`, {
      patientId: pFabio, sessionId: s.id, action: "PAUSE",
    });
    check("recusa com 400", r.status === 400, JSON.stringify(r.json));
    check("code = SESSION_COMPLETED", r.json?.code === "SESSION_COMPLETED", JSON.stringify(r.json));
    check(
      "facts trazem o status do servidor",
      r.json?.facts?.serverStatus === "COMPLETED",
      JSON.stringify(r.json?.facts)
    );
    // A frase em português é a MESMA de sempre — nada que já lia isto quebra.
    check(
      "a mensagem original foi preservada",
      typeof r.json?.error === "string" && r.json.error.includes("transição de sessão inválida"),
      r.json?.error
    );
    check(
      "o corpo NÃO carrega a sessão inteira",
      r.json?.session === undefined && r.json?.turn === undefined,
      JSON.stringify(Object.keys(r.json ?? {}))
    );
  }

  // ════ Caso 2 — sessão pausada em outro dispositivo ════
  console.log("\nCaso 2 — SESSION_PAUSED:");
  {
    const s = await novaSessao();
    await claudia.patch(`${RTQ}/sessions`, {
      patientId: pFabio, sessionId: s.id, action: "PAUSE",
    });
    // Pausar de novo: o servidor recusa, e agora DIZ que é porque está pausada.
    const r = await claudia.patch(`${RTQ}/sessions`, {
      patientId: pFabio, sessionId: s.id, action: "PAUSE",
    });
    check("recusa com 400", r.status === 400, JSON.stringify(r.json));
    check("code = SESSION_PAUSED", r.json?.code === "SESSION_PAUSED", JSON.stringify(r.json));
    check(
      "NÃO se confunde com SESSION_COMPLETED",
      r.json?.code !== "SESSION_COMPLETED",
      "os dois casos pedem telas diferentes"
    );
    check("facts trazem PAUSED", r.json?.facts?.serverStatus === "PAUSED", JSON.stringify(r.json?.facts));
  }

  // ════ Caso 5 — caminho encerrado ════
  console.log("\nCaso 5 — PATH_ENDED:");
  {
    const s = await novaSessao();
    const path = (
      await claudia.post(`${RTQ}/paths`, { patientId: pFabio, sessionId: s.id })
    ).json.path;
    const interrompeu = await claudia.patch(`${RTQ}/paths`, {
      patientId: pFabio, sessionId: s.id, pathId: path.id,
      action: { kind: "INTERRUPT", reason: "mudou de assunto" },
    });
    check("o caminho foi mesmo interrompido", interrompeu.status === 200, JSON.stringify(interrompeu.json));
    // Um nível que a fila offline tenta criar depois do caminho ter acabado.
    const r = await claudia.post(`${RTQ}/nodes`, {
      patientId: pFabio, sessionId: s.id, pathId: path.id,
      promptText: "Onde dói?", options: [{ label: "Cabeça" }, { label: "Barriga" }],
    });
    check("recusa", r.status >= 400, JSON.stringify(r.json));
    check("code = PATH_ENDED", r.json?.code === "PATH_ENDED", JSON.stringify(r.json));
    check(
      "facts dizem em que estado o caminho está",
      typeof r.json?.facts?.serverStatus === "string",
      JSON.stringify(r.json?.facts)
    );
  }

  // ════ Caso 9 — acesso revogado ════
  console.log("\nCaso 9 — acesso revogado (403):");
  {
    const s = await novaSessao();
    // Marcos existe, está autenticado, e NÃO tem vínculo com este paciente.
    const r = await marcos.post(`${RTQ}/turns`, {
      patientId: pFabio, sessionId: s.id, text: "posso ler isto?",
    });
    check("403, não 400", r.status === 403, `veio ${r.status}`);
    check(
      "o 403 basta para o cliente classificar o caso 9",
      r.status === 403,
      "o classificador usa o status; código no corpo é opcional aqui"
    );
    check(
      "e nada do conteúdo alheio volta junto",
      r.json?.turn === undefined && r.json?.session === undefined,
      JSON.stringify(Object.keys(r.json ?? {}))
    );
  }

  // ════ Caso 12 — mesma chave, intenção diferente ════
  console.log("\nCaso 12 — IDEMPOTENCY_MISMATCH:");
  {
    const s = await novaSessao();
    const crid = rid("turn");
    const r1 = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio, sessionId: s.id, text: "O senhor está com dor?",
      clientRequestId: crid,
    });
    check("o primeiro envio passa", r1.status === 200);
    const r2 = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio, sessionId: s.id, text: "OUTRA pergunta, mesma chave",
      clientRequestId: crid,
    });
    check("recusa com 409", r2.status === 409, `veio ${r2.status}`);
    check("code = IDEMPOTENCY_MISMATCH", r2.json?.code === "IDEMPOTENCY_MISMATCH", JSON.stringify(r2.json));
  }

  // ════ O que NÃO mudou ════
  console.log("\nO que NÃO mudou — recusas comuns seguem sem código:");
  {
    const s = await novaSessao();
    // Pergunta vazia é erro de validação, não conflito de estado: continua
    // sendo um 400 sem `code`. Se ganhasse um código, o cliente abriria uma
    // tela de decisão para algo que não tem decisão nenhuma a tomar.
    const r = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio, sessionId: s.id, text: "   ",
    });
    check("recusa com 400", r.status === 400);
    check("SEM code — não é conflito de estado", r.json?.code === undefined, JSON.stringify(r.json));
    check(
      "a mensagem continua explicando o problema",
      typeof r.json?.error === "string" && r.json.error.length > 0,
      r.json?.error
    );
  }

  console.log(`\n${passed} passou, ${failed} falhou.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
