// ——— Testes obrigatórios de "Perguntas em tempo real" (seção 15) ———
// Roda contra o dev server + emulador do Firestore. NUNCA rode contra
// produção: o script LIMPA o banco do emulador antes de começar.
//
//   npm run emu                          (terminal 1)
//   npm run dev                          (terminal 2)
//   npm run test:realtime-questions      (terminal 3)

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
    get(p) {
      return this.req("GET", p);
    },
    post(p, b) {
      return this.req("POST", p, b);
    },
    patch(p, b) {
      return this.req("PATCH", p, b);
    },
    put(p, b) {
      return this.req("PUT", p, b);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // ════ Preparação ════
  console.log("Preparação (usuários, pacientes, vínculos):");
  check(
    "bootstrap do admin",
    (
      await admin.post("/api/auth/bootstrap", {
        name: "Admin",
        email: "admin@helo.test",
        password: "senha-admin-123",
      })
    ).status === 200
  );

  async function createUser(c, name, email, role, professionalType) {
    const r = await admin.post("/api/admin/users", {
      name,
      email,
      password: "senha-teste-123",
      role,
      professionalType,
    });
    check(`admin cria ${name}`, r.status === 200, JSON.stringify(r.json));
    const login = await c.post("/api/auth/login", {
      email,
      password: "senha-teste-123",
    });
    check(`${name} faz login`, login.status === 200);
    return r.json.user;
  }

  const uClaudia = await createUser(
    claudia,
    "Claudia",
    "claudia@helo.test",
    "profissional",
    "fonoaudiologo"
  );
  const uMarcos = await createUser(
    marcos,
    "Marcos",
    "marcos@helo.test",
    "profissional",
    "terapeuta"
  );

  const pFabio = (await admin.post("/api/patients", { name: "Dr. Fábio" })).json
    .patient.id;
  await sleep(5);
  const pRoberto = (await admin.post("/api/patients", { name: "Sr. Roberto" }))
    .json.patient.id;

  const FULL = [
    "viewDashboard",
    "viewSessions",
    "viewMetrics",
    "createSession",
    "editGestures",
  ];
  async function link(user, patientId, permissions) {
    const r = await admin.post("/api/admin/access", {
      userId: user.id,
      patientId,
      permissions,
    });
    check(`vínculo ${user.name} ↔ paciente ${patientId}`, r.status === 200);
  }
  await link(uClaudia, pFabio, FULL);
  // Marcos só alcança o Sr. Roberto — base do teste de isolamento (24).
  await link(uMarcos, pRoberto, FULL);

  // ——— Atalhos ———
  const RTQ = "/api/realtime-questions";
  const novaSessao = async (c = claudia, patientId = pFabio) =>
    (await c.post(`${RTQ}/sessions`, { patientId })).json.session;
  const acaoSessao = (sessionId, action, c = claudia, patientId = pFabio) =>
    c.patch(`${RTQ}/sessions`, { patientId, sessionId, action });
  const novaPergunta = (sessionId, body, c = claudia, patientId = pFabio) =>
    c.post(`${RTQ}/turns`, { patientId, sessionId, ...body });
  const acao = (sessionId, turnId, action, c = claudia, patientId = pFabio) =>
    c.patch(`${RTQ}/turns`, { patientId, sessionId, turnId, action });
  const eventos = async (sessionId, turnId, c = claudia, patientId = pFabio) =>
    (
      await c.get(
        `${RTQ}/events?patientId=${patientId}&sessionId=${sessionId}` +
          (turnId ? `&turnId=${turnId}` : "")
      )
    ).json.events;

  /** Cria uma pergunta e a leva até AWAITING_RESPONSE. */
  async function perguntaAguardando(sessionId, opts = {}) {
    const t = (await novaPergunta(sessionId, { text: "O senhor está com dor?", ...opts }))
      .json.turn;
    await acao(sessionId, t.id, { kind: "REVIEW", reviewedText: t.reviewedText });
    await acao(sessionId, t.id, { kind: "PRESENT" });
    const r = await acao(sessionId, t.id, { kind: "AWAIT_RESPONSE" });
    return r.json.turn;
  }

  // ════ 1. Criação de uma sessão ════
  console.log("\n1–4 Ciclo de vida da sessão:");
  const s1 = await novaSessao();
  check(
    "1. sessão criada em ACTIVE, com paciente e assistente",
    s1?.status === "ACTIVE" &&
      s1.patientId === pFabio &&
      s1.assistantId === uClaudia.id &&
      !!s1.startedAt,
    JSON.stringify(s1)
  );
  check(
    "1. evento SESSION_STARTED registrado com autoria e horário",
    (await eventos(s1.id)).some(
      (e) =>
        e.eventType === "SESSION_STARTED" &&
        e.assistantId === uClaudia.id &&
        !!e.createdAt
    )
  );

  // ════ 2. Pausa e retomada ════
  const pausa = await acaoSessao(s1.id, "PAUSE");
  check(
    "2. sessão pausada",
    pausa.status === 200 && pausa.json.session.status === "PAUSED" && !!pausa.json.session.pausedAt
  );
  const retoma = await acaoSessao(s1.id, "RESUME");
  check(
    "2. sessão retomada",
    retoma.status === 200 &&
      retoma.json.session.status === "ACTIVE" &&
      !!retoma.json.session.resumedAt
  );

  // ════ 3. Conclusão ════
  const s3 = await novaSessao();
  const conclui = await acaoSessao(s3.id, "COMPLETE");
  check(
    "3. sessão concluída",
    conclui.status === 200 &&
      conclui.json.session.status === "COMPLETED" &&
      !!conclui.json.session.completedAt
  );
  check(
    "3. sessão concluída não volta a ACTIVE",
    (await acaoSessao(s3.id, "RESUME")).status === 400
  );

  // ════ 4. Abandono (preserva perguntas, não gera negativa) ════
  const s4 = await novaSessao();
  const t4 = await perguntaAguardando(s4.id);
  const abandona = await acaoSessao(s4.id, "ABANDON");
  check(
    "4. sessão abandonada",
    abandona.status === 200 && abandona.json.session.status === "ABANDONED"
  );
  const turns4 = (await claudia.get(`${RTQ}/turns?patientId=${pFabio}&sessionId=${s4.id}`))
    .json.turns;
  check(
    "4. abandono preserva a pergunta sem resposta (não vira NO nem NO_RESPONSE)",
    turns4.length === 1 &&
      turns4[0].id === t4.id &&
      turns4[0].status === "AWAITING_RESPONSE" &&
      turns4[0].confirmedResponse === null,
    JSON.stringify(turns4[0])
  );

  // ════ 5–6. Criação, revisão e apresentação ════
  console.log("\n5–6 Pergunta: criação, revisão e apresentação:");
  const s = await novaSessao();
  const nova = await novaPergunta(s.id, { text: "  O senhor quer água?  " });
  const t = nova.json.turn;
  check(
    "5. pergunta criada em DRAFT, com sequence e origem manual",
    nova.status === 200 &&
      t.status === "DRAFT" &&
      t.sequence === 1 &&
      t.questionSource === "MANUAL_TEXT" &&
      t.reviewedText === "O senhor quer água?" &&
      t.patientId === pFabio,
    JSON.stringify(t)
  );
  check(
    "5. origem por voz/IA ainda não é aceita nesta fase",
    (await novaPergunta(s.id, { text: "x", questionSource: "AI_SUGGESTION" }))
      .status === 400
  );
  const rev = await acao(s.id, t.id, {
    kind: "REVIEW",
    reviewedText: "O senhor está com sede?",
  });
  check(
    "5. pergunta revisada",
    rev.json.turn.status === "REVIEWED" &&
      rev.json.turn.reviewedText === "O senhor está com sede?"
  );
  const apres = await acao(s.id, t.id, { kind: "PRESENT" });
  check(
    "6. pergunta apresentada (texto congelado + horário)",
    apres.json.turn.status === "PRESENTED" &&
      apres.json.turn.presentedText === "O senhor está com sede?" &&
      !!apres.json.turn.presentedAt
  );
  const aguard = await acao(s.id, t.id, { kind: "AWAIT_RESPONSE" });
  check("6. aguardando resposta", aguard.json.turn.status === "AWAITING_RESPONSE");

  // ════ 7–9. Seleção provisória ════
  console.log("\n7–9 Seleção provisória (SIM / TALVEZ / NÃO):");
  for (const [n, resposta] of [
    [7, "YES"],
    [8, "MAYBE"],
    [9, "NO"],
  ]) {
    const turn = await perguntaAguardando(s.id);
    const sel = await acao(s.id, turn.id, {
      kind: "SELECT_RESPONSE",
      response: resposta,
    });
    check(
      `${n}. seleção provisória ${resposta} não aparece como confirmada`,
      sel.json.turn.status === "PROVISIONAL_RESPONSE" &&
        sel.json.turn.provisionalResponse === resposta &&
        sel.json.turn.confirmedResponse === null &&
        sel.json.turn.confirmedAt === null,
      JSON.stringify(sel.json)
    );
  }

  // ════ 10–11. Correção e remoção ════
  console.log("\n10–11 Correção e remoção da seleção:");
  const tCorr = await perguntaAguardando(s.id);
  await acao(s.id, tCorr.id, { kind: "SELECT_RESPONSE", response: "YES" });
  const corr = await acao(s.id, tCorr.id, {
    kind: "CHANGE_RESPONSE",
    response: "NO",
  });
  check(
    "10. correção troca a resposta e conta a correção",
    corr.json.turn.provisionalResponse === "NO" &&
      corr.json.turn.correctionCount === 1 &&
      corr.json.turn.confirmedResponse === null
  );
  const evCorr = await eventos(s.id, tCorr.id);
  check(
    "10. a seleção anterior fica preservada na auditoria",
    evCorr.some(
      (e) =>
        e.eventType === "RESPONSE_CHANGED" &&
        e.previousValue?.provisionalResponse === "YES" &&
        e.newValue?.provisionalResponse === "NO"
    ),
    JSON.stringify(evCorr.map((e) => e.eventType))
  );
  const rem = await acao(s.id, tCorr.id, { kind: "REMOVE_RESPONSE" });
  check(
    "11. remoção volta para AWAITING_RESPONSE, sem resposta",
    rem.json.turn.status === "AWAITING_RESPONSE" &&
      rem.json.turn.provisionalResponse === null &&
      rem.json.turn.confirmedResponse === null
  );
  check(
    "11. remoção registrada em RESPONSE_REMOVED com o valor anterior",
    (await eventos(s.id, tCorr.id)).some(
      (e) =>
        e.eventType === "RESPONSE_REMOVED" &&
        e.previousValue?.provisionalResponse === "NO"
    )
  );

  // ════ 12–13. Confirmação comum e bloqueio sem resposta ════
  console.log("\n12–13 Confirmação:");
  const tConf = await perguntaAguardando(s.id);
  check(
    "13. não confirma sem resposta observada",
    (await acao(s.id, tConf.id, { kind: "VERIFY_RESPONSE" })).status === 400
  );
  await acao(s.id, tConf.id, { kind: "SELECT_RESPONSE", response: "YES" });
  const conf = await acao(s.id, tConf.id, { kind: "VERIFY_RESPONSE" });
  check(
    "12. conferência confirma a pergunta comum, sem alterar a resposta",
    conf.json.turn.status === "CONFIRMED" &&
      conf.json.turn.confirmedResponse === "YES" &&
      conf.json.turn.provisionalResponse === "YES" &&
      !!conf.json.turn.assistantVerifiedAt &&
      !!conf.json.turn.confirmedAt &&
      conf.json.turn.reconfirmedAt === null,
    JSON.stringify(conf.json)
  );
  check(
    "12. interação confirmada é terminal (não aceita nova seleção)",
    (await acao(s.id, tConf.id, { kind: "CHANGE_RESPONSE", response: "NO" }))
      .status === 400
  );

  // ════ 14–15. Gesto incerto ════
  console.log("\n14–15 Gesto incerto:");
  const tInc = await perguntaAguardando(s.id);
  const inc = await acao(s.id, tInc.id, { kind: "RECORD_UNCERTAIN_GESTURE" });
  check(
    "14. gesto incerto não registra SIM/TALVEZ/NÃO nem confirma",
    inc.json.turn.status === "UNCERTAIN_GESTURE" &&
      inc.json.turn.provisionalResponse === null &&
      inc.json.turn.confirmedResponse === null
  );
  check(
    "14. gesto incerto preservado na auditoria",
    (await eventos(s.id, tInc.id)).some(
      (e) => e.eventType === "UNCERTAIN_GESTURE_RECORDED"
    )
  );
  check(
    "14. gesto incerto não pode ser confirmado",
    (await acao(s.id, tInc.id, { kind: "VERIFY_RESPONSE" })).status === 400
  );
  const volta = await acao(s.id, tInc.id, { kind: "AWAIT_RESPONSE" });
  check(
    "15. gesto incerto volta para AWAITING_RESPONSE",
    volta.json.turn.status === "AWAITING_RESPONSE"
  );
  const reapres = await acao(s.id, tInc.id, { kind: "REPRESENT" });
  check(
    "15. gesto incerto permite reapresentar a pergunta",
    reapres.json.turn.status === "PRESENTED" &&
      (await eventos(s.id, tInc.id)).some(
        (e) => e.eventType === "QUESTION_REPRESENTED"
      )
  );

  // ════ 16–17. Ausência de resposta ════
  console.log("\n16–17 Ausência de resposta:");
  const tSem = await perguntaAguardando(s.id);
  const sem = await acao(s.id, tSem.id, { kind: "RECORD_NO_RESPONSE" });
  check(
    "16. ausência de resposta registrada explicitamente",
    sem.json.turn.status === "NO_RESPONSE" &&
      (await eventos(s.id, tSem.id)).some(
        (e) => e.eventType === "NO_RESPONSE_RECORDED"
      )
  );
  check(
    "17. ausência de resposta NÃO é interpretada como NÃO",
    sem.json.turn.confirmedResponse === null &&
      sem.json.turn.provisionalResponse === null &&
      sem.json.turn.status !== "CONFIRMED",
    JSON.stringify(sem.json.turn)
  );
  check(
    "17. ausência de resposta não pode ser confirmada",
    (await acao(s.id, tSem.id, { kind: "VERIFY_RESPONSE" })).status === 400
  );
  // Silêncio prolongado não muda nada por conta própria (sem tempo limite).
  const antes = JSON.stringify(
    (await perguntaAguardando(s.id, { text: "O senhor quer descansar?" }))
  );
  await sleep(1200);
  const depois = (
    await claudia.get(`${RTQ}/turns?patientId=${pFabio}&sessionId=${s.id}`)
  ).json.turns.find((x) => x.id === JSON.parse(antes).id);
  check(
    "17. tempo decorrido não decide ausência de resposta (sem timeout)",
    depois.status === "AWAITING_RESPONSE" && depois.confirmedResponse === null
  );

  // ════ 18–19. Pergunta sensível ════
  console.log("\n18–19 Pergunta sensível:");
  const tSens = await perguntaAguardando(s.id, {
    text: "O senhor quer rever o testamento?",
    isSensitive: true,
    sensitiveCategory: "LEGAL",
  });
  check(
    "18. pergunta marcada como sensível",
    tSens.isSensitive === true && tSens.sensitiveCategory === "LEGAL"
  );
  await acao(s.id, tSens.id, { kind: "SELECT_RESPONSE", response: "YES" });
  const verSens = await acao(s.id, tSens.id, { kind: "VERIFY_RESPONSE" });
  check(
    "18. sensível não vai de provisória a confirmada: fica em RECONFIRMATION_PENDING",
    verSens.json.turn.status === "RECONFIRMATION_PENDING" &&
      verSens.json.turn.confirmedResponse === null &&
      !!verSens.json.turn.assistantVerifiedAt,
    JSON.stringify(verSens.json)
  );
  const reconf = await acao(s.id, tSens.id, { kind: "RECONFIRM_RESPONSE" });
  check(
    "19. reconfirmação confirma a pergunta sensível",
    reconf.json.turn.status === "CONFIRMED" &&
      reconf.json.turn.confirmedResponse === "YES" &&
      !!reconf.json.turn.reconfirmedAt &&
      (await eventos(s.id, tSens.id)).some(
        (e) => e.eventType === "RESPONSE_RECONFIRMED"
      ),
    JSON.stringify(reconf.json)
  );
  // A reconfirmação também pode ser desfeita antes de confirmar.
  const tSens2 = await perguntaAguardando(s.id, {
    text: "O senhor quer falar sobre a herança?",
    isSensitive: true,
    sensitiveCategory: "PROPERTY",
  });
  await acao(s.id, tSens2.id, { kind: "SELECT_RESPONSE", response: "MAYBE" });
  await acao(s.id, tSens2.id, { kind: "VERIFY_RESPONSE" });
  const desfaz = await acao(s.id, tSens2.id, { kind: "REMOVE_RESPONSE" });
  check(
    "19. reconfirmação pendente pode voltar para AWAITING_RESPONSE",
    desfaz.json.turn.status === "AWAITING_RESPONSE" &&
      desfaz.json.turn.provisionalResponse === null
  );
  check(
    "18. categoria sensível sem a marca de sensível é recusada",
    (await novaPergunta(s.id, { text: "x", sensitiveCategory: "MEDICAL" }))
      .status === 400
  );

  // ════ 20. Transições inválidas ════
  console.log("\n20 Transições inválidas:");
  const tInv = (await novaPergunta(s.id, { text: "Pergunta em rascunho" })).json
    .turn;
  check(
    "20. rascunho não pode ser apresentado sem revisão",
    (await acao(s.id, tInv.id, { kind: "PRESENT" })).status === 400
  );
  check(
    "20. rascunho não aceita seleção de resposta",
    (await acao(s.id, tInv.id, { kind: "SELECT_RESPONSE", response: "YES" }))
      .status === 400
  );
  check(
    "20. rascunho não aceita reconfirmação",
    (await acao(s.id, tInv.id, { kind: "RECONFIRM_RESPONSE" })).status === 400
  );
  check(
    "20. ação desconhecida é recusada",
    (await acao(s.id, tInv.id, { kind: "FORCE_CONFIRM" })).status === 400
  );
  check(
    "20. resposta semântica fora de SIM/TALVEZ/NÃO é recusada",
    (await acao(s.id, tInv.id, { kind: "SELECT_RESPONSE", response: "SIM" }))
      .status === 400
  );
  const canc = await acao(s.id, tInv.id, { kind: "CANCEL" });
  check(
    "20. interação cancelada é terminal",
    canc.json.turn.status === "CANCELED" &&
      (await acao(s.id, tInv.id, { kind: "REVIEW", reviewedText: "x" })).status ===
        400
  );

  // ════ 21. Auditoria preservada ════
  console.log("\n21 Trilha de auditoria:");
  const evTodos = await eventos(s.id);
  check(
    "21. todos os eventos têm autoria e horário do servidor",
    evTodos.length > 0 &&
      evTodos.every((e) => e.assistantId === uClaudia.id && !!e.createdAt)
  );
  check(
    "21. a trilha preserva o histórico completo da correção",
    (() => {
      const tipos = evCorr.map((e) => e.eventType);
      return (
        tipos.includes("QUESTION_CREATED") &&
        tipos.includes("RESPONSE_SELECTED") &&
        tipos.includes("RESPONSE_CHANGED")
      );
    })(),
    JSON.stringify(evCorr.map((e) => e.eventType))
  );
  const evCorrDepois = await eventos(s.id, tCorr.id);
  check(
    "21. eventos anteriores não são sobrescritos por eventos novos",
    evCorrDepois.length > evCorr.length &&
      evCorrDepois.some(
        (e) =>
          e.eventType === "RESPONSE_CHANGED" &&
          e.previousValue?.provisionalResponse === "YES"
      )
  );
  check(
    "21. a trilha é somente leitura para o cliente (sem rota de escrita)",
    (await claudia.post(`${RTQ}/events`, { patientId: pFabio, sessionId: s.id }))
      .status === 405
  );

  // ════ 22–23. Sessão concluída e sessão pausada ════
  console.log("\n22–23 Estado da sessão x interações:");
  const sFim = await novaSessao();
  const tAberta = await perguntaAguardando(sFim.id);
  await acaoSessao(sFim.id, "COMPLETE");
  check(
    "22. sessão concluída não aceita novas perguntas",
    (await novaPergunta(sFim.id, { text: "Mais uma?" })).status === 400
  );
  const turnsFim = (
    await claudia.get(`${RTQ}/turns?patientId=${pFabio}&sessionId=${sFim.id}`)
  ).json.turns;
  check(
    "22. pergunta aberta na conclusão vira NO_RESPONSE, nunca resposta negativa",
    turnsFim[0].id === tAberta.id &&
      turnsFim[0].status === "NO_RESPONSE" &&
      turnsFim[0].confirmedResponse === null,
    JSON.stringify(turnsFim[0])
  );
  check(
    "22. a conclusão gravou o evento de ausência de resposta junto",
    (await eventos(sFim.id, tAberta.id)).some(
      (e) =>
        e.eventType === "NO_RESPONSE_RECORDED" &&
        e.metadata?.reason === "session_completed"
    )
  );

  const sPausa = await novaSessao();
  const tPausa = await perguntaAguardando(sPausa.id);
  await acaoSessao(sPausa.id, "PAUSE");
  check(
    "23. sessão pausada não aceita seleção de resposta",
    (
      await acao(sPausa.id, tPausa.id, {
        kind: "SELECT_RESPONSE",
        response: "YES",
      })
    ).status === 400
  );
  check(
    "23. sessão pausada não aceita gesto incerto nem ausência de resposta",
    (await acao(sPausa.id, tPausa.id, { kind: "RECORD_UNCERTAIN_GESTURE" }))
      .status === 400 &&
      (await acao(sPausa.id, tPausa.id, { kind: "RECORD_NO_RESPONSE" })).status ===
        400
  );
  await acaoSessao(sPausa.id, "RESUME");
  check(
    "23. depois de retomada, a resposta é aceita",
    (
      await acao(sPausa.id, tPausa.id, {
        kind: "SELECT_RESPONSE",
        response: "YES",
      })
    ).json.turn.status === "PROVISIONAL_RESPONSE"
  );

  // ════ 24. Isolamento entre pacientes ════
  console.log("\n24 Isolamento entre pacientes:");
  check(
    "24. usuário sem vínculo não cria sessão no paciente (403)",
    (await marcos.post(`${RTQ}/sessions`, { patientId: pFabio })).status === 403
  );
  check(
    "24. usuário sem vínculo não lista sessões do paciente (403)",
    (await marcos.get(`${RTQ}/sessions?patientId=${pFabio}`)).status === 403
  );
  check(
    "24. troca manual de identificador não alcança a sessão de outro paciente",
    (await marcos.get(`${RTQ}/sessions?patientId=${pRoberto}&sessionId=${s.id}`))
      .status === 404
  );
  check(
    "24. nem age sobre a interação de outro paciente",
    (await acao(s.id, tConf.id, { kind: "CANCEL" }, marcos, pRoberto)).status ===
      400
  );
  check(
    "24. nem lê a trilha de auditoria de outro paciente",
    (await marcos.get(`${RTQ}/events?patientId=${pRoberto}&sessionId=${s.id}`))
      .status === 404
  );
  const sMarcos = await novaSessao(marcos, pRoberto);
  check(
    "24. cada paciente só enxerga as próprias sessões",
    (await marcos.get(`${RTQ}/sessions?patientId=${pRoberto}`)).json.sessions.every(
      (x) => x.patientId === pRoberto
    ) &&
      (await claudia.get(`${RTQ}/sessions?patientId=${pFabio}`)).json.sessions.every(
        (x) => x.patientId === pFabio && x.id !== sMarcos.id
      )
  );

  // ════ Configuração sinal → resposta semântica ════
  console.log("\nConfiguração do paciente (sinal → resposta semântica):");
  const prof = await claudia.get(`${RTQ}/response-profile?patientId=${pFabio}`);
  check(
    "padrão do modo: positivo→YES, palma aberta→MAYBE, mão fechada→NO",
    prof.status === 200 &&
      prof.json.profile.mappings.length === 3 &&
      prof.json.profile.mappings.find((m) => m.signalKey === "talvez")
        ?.response === "MAYBE"
  );
  const salvo = await claudia.put(`${RTQ}/response-profile`, {
    patientId: pFabio,
    mappings: [
      { method: "GESTURE", signalKey: "sim", label: "Polegar", response: "YES" },
      { method: "GESTURE", signalKey: "olhar_cima", label: "Olhar para cima", response: "MAYBE" },
      { method: "GESTURE", signalKey: "nao", label: "Mão fechada", response: "NO" },
    ],
  });
  check(
    "mapeamento por paciente é gravado",
    salvo.status === 200 &&
      salvo.json.profile.mappings.some((m) => m.signalKey === "olhar_cima")
  );
  check(
    "mapeamento incompleto é recusado",
    (
      await claudia.put(`${RTQ}/response-profile`, {
        patientId: pFabio,
        mappings: [
          { method: "GESTURE", signalKey: "sim", label: "Polegar", response: "YES" },
        ],
      })
    ).status === 400
  );
  check(
    "dois sinais com a mesma resposta são recusados",
    (
      await claudia.put(`${RTQ}/response-profile`, {
        patientId: pFabio,
        mappings: [
          { method: "GESTURE", signalKey: "a", label: "A", response: "YES" },
          { method: "GESTURE", signalKey: "b", label: "B", response: "YES" },
          { method: "GESTURE", signalKey: "c", label: "C", response: "NO" },
        ],
      })
    ).status === 400
  );
  check(
    "método ainda não disponível (olhar/piscar/toque) é recusado nesta fase",
    (
      await claudia.put(`${RTQ}/response-profile`, {
        patientId: pFabio,
        mappings: [
          { method: "GAZE", signalKey: "cima", label: "Olhar", response: "YES" },
          { method: "GESTURE", signalKey: "talvez", label: "Palma", response: "MAYBE" },
          { method: "GESTURE", signalKey: "nao", label: "Fechada", response: "NO" },
        ],
      })
    ).status === 400
  );
  check(
    "o mapeamento é de OUTRO paciente sem vínculo (403)",
    (await marcos.put(`${RTQ}/response-profile`, { patientId: pFabio, mappings: [] }))
      .status === 403
  );

  // ════ Fases 3 e 4: sensibilidade na revisão, reapresentações, retomada ════
  console.log("\nFases 3 e 4 (apoio da interface):");

  // A marcação de assunto sensível acontece na REVISÃO, não só na criação.
  const sRev = await novaSessao();
  const tRev = (await novaPergunta(sRev.id, { text: "O senhor quer rever o testamento?" }))
    .json.turn;
  check(
    "pergunta nasce não sensível quando não declarada",
    tRev.isSensitive === false && tRev.sensitiveCategory === null
  );
  const marcada = await acao(sRev.id, tRev.id, {
    kind: "REVIEW",
    reviewedText: tRev.reviewedText,
    isSensitive: true,
    sensitiveCategory: "LEGAL",
  });
  check(
    "a revisão marca a pergunta como sensível",
    marcada.json.turn.isSensitive === true &&
      marcada.json.turn.sensitiveCategory === "LEGAL",
    JSON.stringify(marcada.json)
  );
  check(
    "a mudança de sensibilidade fica auditada com o valor anterior",
    (await eventos(sRev.id, tRev.id)).some(
      (e) =>
        e.eventType === "QUESTION_REVIEWED" &&
        e.previousValue?.isSensitive === false &&
        e.newValue?.isSensitive === true
    )
  );
  check(
    "categoria inválida na revisão é recusada",
    (
      await acao(sRev.id, tRev.id, {
        kind: "REVIEW",
        reviewedText: "x",
        isSensitive: true,
        sensitiveCategory: "QUALQUER_COISA",
      })
    ).status === 400
  );
  // Marcada na revisão, ela exige reconfirmação como qualquer outra sensível.
  await acao(sRev.id, tRev.id, { kind: "PRESENT" });
  await acao(sRev.id, tRev.id, { kind: "AWAIT_RESPONSE" });
  await acao(sRev.id, tRev.id, { kind: "SELECT_RESPONSE", response: "YES" });
  check(
    "sensível marcada na revisão também exige reconfirmação",
    (await acao(sRev.id, tRev.id, { kind: "VERIFY_RESPONSE" })).json.turn.status ===
      "RECONFIRMATION_PENDING"
  );

  // Contador de reapresentações.
  const sRep = await novaSessao();
  const tRep = await perguntaAguardando(sRep.id);
  check("reapresentações começam em zero", tRep.representCount === 0);
  await acao(sRep.id, tRep.id, { kind: "REPRESENT" });
  await acao(sRep.id, tRep.id, { kind: "AWAIT_RESPONSE" });
  const rep2 = await acao(sRep.id, tRep.id, { kind: "REPRESENT" });
  check(
    "cada reapresentação incrementa o contador, no MESMO turno",
    rep2.json.turn.representCount === 2 && rep2.json.turn.id === tRep.id
  );
  check(
    "reapresentar não cria uma pergunta nova",
    (await claudia.get(`${RTQ}/turns?patientId=${pFabio}&sessionId=${sRep.id}`)).json
      .turns.length === 1
  );

  // Retomada: a listagem entrega a sessão recuperável, e a resposta
  // provisória continua provisória depois da pausa.
  const sRet = await novaSessao();
  const tRet = await perguntaAguardando(sRet.id);
  await acao(sRet.id, tRet.id, { kind: "SELECT_RESPONSE", response: "MAYBE" });
  await acaoSessao(sRet.id, "PAUSE");
  const recuperaveis = (await claudia.get(`${RTQ}/sessions?patientId=${pFabio}`)).json
    .sessions.filter((x) => x.status === "PAUSED");
  check(
    "a sessão pausada aparece como recuperável na listagem",
    recuperaveis.some((x) => x.id === sRet.id)
  );
  const retomada = await acaoSessao(sRet.id, "RESUME");
  const turnoRetomado = (
    await claudia.get(`${RTQ}/turns?patientId=${pFabio}&sessionId=${sRet.id}`)
  ).json.turns[0];
  check(
    "ao retomar, a resposta provisória continua PROVISÓRIA",
    retomada.json.session.status === "ACTIVE" &&
      turnoRetomado.status === "PROVISIONAL_RESPONSE" &&
      turnoRetomado.provisionalResponse === "MAYBE" &&
      turnoRetomado.confirmedResponse === null,
    JSON.stringify(turnoRetomado)
  );

  // Ação repetida não duplica evento nem estado.
  const antesEventos = (await eventos(sRet.id, tRet.id)).length;
  await acao(sRet.id, tRet.id, { kind: "VERIFY_RESPONSE" });
  const repetida = await acao(sRet.id, tRet.id, { kind: "VERIFY_RESPONSE" });
  const depoisEventos = (await eventos(sRet.id, tRet.id)).length;
  check(
    "repetir uma ação já aplicada é recusada e não grava evento extra",
    repetida.status === 400 && depoisEventos === antesEventos + 1,
    `antes ${antesEventos} · depois ${depoisEventos}`
  );

  // ════ 25. Comportamentos existentes preservados ════
  console.log("\n25 Compatibilidade com o que já existia:");
  const sessaoAntiga = await claudia.post("/api/sessions", {
    mode: "conversa",
    patientId: pFabio,
  });
  check(
    "25. sessões da tela Conversar continuam funcionando",
    sessaoAntiga.status === 200 && typeof sessaoAntiga.json.id === "number"
  );
  const eventoAntigo = await claudia.post("/api/events", {
    sessionId: sessaoAntiga.json.id,
    patientId: pFabio,
    type: "gesto",
    gesture: "talvez",
    detail: "reformulação",
  });
  check(
    "25. o gesto 'talvez' segue registrado com o significado antigo",
    eventoAntigo.status === 200
  );
  const itens = await claudia.get(
    `/api/items?patientId=${pFabio}&mode=conversa`
  );
  check(
    "25. as expressões de Conversa do paciente continuam intactas",
    itens.status === 200 && Array.isArray(itens.json.items) && itens.json.items.length > 0
  );
  const stats = await claudia.get(`/api/stats?patientId=${pFabio}&period=hoje`);
  check(
    "25. as estatísticas existentes seguem respondendo",
    stats.status === 200
  );

  console.log(`\n${passed} passaram · ${failed} falharam`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
