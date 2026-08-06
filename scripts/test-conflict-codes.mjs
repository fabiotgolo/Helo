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

  // ════ Caso 4 — resposta alterada ════
  //
  // A fronteira com o caso 11 é o que estas asserções guardam: o servidor ter
  // mudado NÃO é conflito; conflito é o CONTEÚDO divergir.
  console.log("\nCaso 4 — RESPONSE_CHANGED:");
  {
    const s = await novaSessao();
    const turno = (
      await claudia.post(`${RTQ}/turns`, {
        patientId: pFabio, sessionId: s.id, text: "O senhor está com dor?",
      })
    ).json.turn;
    const acao = async (action, extra = {}) =>
      claudia.patch(`${RTQ}/turns`, {
        patientId: pFabio, sessionId: s.id, turnId: turno.id, action, ...extra,
      });

    await acao({ kind: "REVIEW", reviewedText: "O senhor está com dor?" });
    await acao({ kind: "PRESENT" });
    await acao({ kind: "AWAIT_RESPONSE" });

    // O cuidador leu a tela AQUI: é este updatedAt que a fila guardaria.
    const antes = (await acao({ kind: "SELECT_RESPONSE", response: "YES" })).json.turn;
    check("resposta registrada no servidor", antes.provisionalResponse === "YES");

    // Um aparelho offline volta com TALVEZ, partindo de uma versão anterior.
    const base = "2020-01-01T00:00:00.000Z";
    const r = await acao({ kind: "CHANGE_RESPONSE", response: "MAYBE" }, { baseVersion: base });
    check("recusa com 400", r.status === 400, JSON.stringify(r.json));
    check("code = RESPONSE_CHANGED", r.json?.code === "RESPONSE_CHANGED", JSON.stringify(r.json));
    check(
      "facts trazem a resposta DO SERVIDOR, para a tela mostrar ao lado",
      r.json?.facts?.serverValue === "YES",
      JSON.stringify(r.json?.facts)
    );
    check(
      "e o horário em que ela foi registrada",
      typeof r.json?.facts?.serverAt === "string",
      JSON.stringify(r.json?.facts)
    );

    // A MESMA resposta, mesmo com baseVersion velho, NÃO é conflito: nada
    // divergiu. Isto é o caso 11 — e tratá-lo como conflito encheria a tela
    // de decisões vazias.
    const igual = await acao({ kind: "CHANGE_RESPONSE", response: "YES" }, { baseVersion: base });
    check(
      "mesma resposta com baseVersion velho NÃO é conflito (caso 11)",
      igual.json?.code !== "RESPONSE_CHANGED",
      JSON.stringify(igual.json)
    );
  }

  // ════ Caso 7 — contexto alterado ════
  console.log("\nCaso 7 — CONTEXT_VERSION:");
  {
    const s = await novaSessao();
    const salvar = (body) =>
      claudia.post(`${RTQ}/session-context`, {
        patientId: pFabio, sessionId: s.id, ...body,
      });

    const v1 = (await salvar({ intention: "consulta de rotina" })).json.context;
    check("primeira versão gravada", v1?.version === 1, JSON.stringify(v1));

    // Outro aparelho grava por cima — v1 deixa de ser a vigente.
    const v2 = (await salvar({ intention: "conversa sobre alta" })).json.context;
    check("segunda versão gravada", v2?.version === 2);

    // O aparelho offline volta partindo da v1, com texto DIFERENTE.
    const r = await salvar({ intention: "dor no peito", baseVersion: v1.updatedAt });
    check("recusa com 400", r.status === 400, JSON.stringify(r.json));
    check("code = CONTEXT_VERSION", r.json?.code === "CONTEXT_VERSION", JSON.stringify(r.json));
    check(
      "facts resumem a versão do servidor, sem mandar o documento inteiro",
      typeof r.json?.facts?.serverValue === "string" &&
        r.json.facts.serverValue.includes("conversa sobre alta") &&
        r.json.facts.notes === undefined,
      JSON.stringify(r.json?.facts)
    );

    // Conteúdo IGUAL ao vigente, com baseVersion velho: não é conflito.
    const igual = await salvar({
      intention: "conversa sobre alta",
      baseVersion: v1.updatedAt,
    });
    check(
      "conteúdo igual ao vigente NÃO é conflito (caso 11)",
      igual.json?.code !== "CONTEXT_VERSION",
      JSON.stringify(igual.json)
    );

    // E sem baseVersion nenhum, tudo segue como sempre foi.
    const semBase = await salvar({ intention: "mais uma mudança" });
    check(
      "sem baseVersion, grava normalmente — cliente online não é afetado",
      semBase.status === 200,
      JSON.stringify(semBase.json)
    );
  }

  // ════ R6 — a fila é de outro cuidador ════
  //
  // O cenário real: máquina de plantão, duas abas. Claudia tem fila pendente;
  // Marcos entra na outra aba. A partir daí a fila da Claudia sairia com o
  // cookie do Marcos — e o servidor grava `assistantId` de quem está
  // autenticado. Sem esta guarda, a pergunta da Claudia entraria no prontuário
  // assinada pelo Marcos, e nada no registro denunciaria a troca.
  console.log("\nR6 — IDENTITY_MISMATCH (autoria trocada):");
  {
    // Marcos PRECISA ter acesso ao paciente: é isso que torna o cenário
    // perigoso. Sem vínculo daria 403 comum e a autoria nunca correria risco.
    const rMarcos = (await admin.get("/api/admin/users")).json.users.find(
      (u) => u.email === "marcos@helo.test"
    );
    await admin.post("/api/admin/access", {
      userId: rMarcos.id,
      patientId: pFabio,
      permissions: ["viewSessions", "createSession"],
    });
    const s = (await marcos.post(`${RTQ}/sessions`, { patientId: pFabio })).json.session;

    // Marcos autenticado, enviando uma operação que diz ser da Claudia.
    const r = await marcos.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "pergunta que a Claudia escreveu sem conexão",
      expectedUserId: rClaudia.json.user.id,
    });
    check("recusa com 403", r.status === 403, `veio ${r.status}: ${JSON.stringify(r.json)}`);
    check("code = IDENTITY_MISMATCH", r.json?.code === "IDENTITY_MISMATCH", JSON.stringify(r.json));
    check(
      "a mensagem diz o que fazer: entrar com a conta de quem criou",
      typeof r.json?.error === "string" && /outro cuidador/i.test(r.json.error),
      r.json?.error
    );

    // E o turno NÃO foi criado: a recusa acontece antes de qualquer escrita.
    const turnos = (
      await marcos.get(`${RTQ}/turns?patientId=${pFabio}&sessionId=${s.id}`)
    ).json.turns;
    check("nada foi gravado", turnos.length === 0, JSON.stringify(turnos));

    // O MESMO envio, com a identidade certa, passa.
    const certo = await marcos.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "pergunta do próprio Marcos",
      expectedUserId: rMarcos.id,
    });
    check("com a identidade certa, grava normalmente", certo.status === 200, JSON.stringify(certo.json));
    check(
      "e a autoria é de quem está autenticado",
      certo.json?.turn?.assistantId === rMarcos.id,
      JSON.stringify(certo.json?.turn?.assistantId)
    );

    // Sem o campo, tudo segue como sempre — é o caso de todo cliente online.
    const semCampo = await marcos.post(`${RTQ}/turns`, {
      patientId: pFabio, sessionId: s.id, text: "sem expectedUserId",
    });
    check("sem expectedUserId, nada muda", semCampo.status === 200, JSON.stringify(semCampo.json));
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
