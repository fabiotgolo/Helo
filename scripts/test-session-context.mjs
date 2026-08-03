// ——— Contexto da sessão (Fase 4.8) ———
// Com quem, para quê e onde a conversa acontece: opcional, versionado,
// auditado, e nunca confundido com fala do paciente.
//
// Roda contra o dev server + emulador do Firestore. NUNCA rode contra
// produção: o script LIMPA o banco do emulador antes de começar.
//
//   npm run emu                                              (terminal 1)
//   FIRESTORE_DATABASE_ID=fases4x-test PORT=3002 npm run dev  (terminal 2)
//   FIRESTORE_DATABASE_ID=fases4x-test npm run test:session-context -- http://localhost:3002

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
  const semPermissao = client();

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

  async function createUser(c, name, email, professionalType) {
    const r = await admin.post("/api/admin/users", {
      name,
      email,
      password: "senha-teste-123",
      role: "profissional",
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

  const uClaudia = await createUser(claudia, "Claudia", "claudia@helo.test", "fonoaudiologo");
  const uMarcos = await createUser(marcos, "Marcos", "marcos@helo.test", "terapeuta");
  const uLeitor = await createUser(semPermissao, "Leitor", "leitor@helo.test", "terapeuta");

  const pFabio = (await admin.post("/api/patients", { name: "Dr. Fábio" })).json.patient.id;
  await sleep(5);
  const pRoberto = (await admin.post("/api/patients", { name: "Sr. Roberto" })).json.patient.id;

  const FULL = ["viewDashboard", "viewSessions", "viewMetrics", "createSession", "editGestures", "editProfile"];
  async function link(user, patientId, permissions = FULL) {
    const r = await admin.post("/api/admin/access", { userId: user.id, patientId, permissions });
    check(`vínculo ${user.name} ↔ paciente ${patientId}`, r.status === 200);
  }
  await link(uClaudia, pFabio);
  await link(uMarcos, pRoberto);
  // Só leitura: base do teste de permissão.
  await link(uLeitor, pFabio, ["viewSessions"]);

  const RTQ = "/api/realtime-questions";
  const CTX = `${RTQ}/session-context`;
  const novaSessao = async (c = claudia, patientId = pFabio) =>
    (await c.post(`${RTQ}/sessions`, { patientId })).json.session;
  const salvar = (sessionId, body, c = claudia, patientId = pFabio) =>
    c.post(CTX, { patientId, sessionId, ...body });
  const ler = async (sessionId, c = claudia, patientId = pFabio) =>
    (await c.get(`${CTX}?patientId=${patientId}&sessionId=${sessionId}`)).json;
  const versoes = async (sessionId, c = claudia, patientId = pFabio) =>
    (await c.get(`${CTX}?patientId=${patientId}&sessionId=${sessionId}&all=1`)).json.versions;
  const eventos = async (sessionId, c = claudia, patientId = pFabio) =>
    (await c.get(`${RTQ}/events?patientId=${patientId}&sessionId=${sessionId}`)).json.events;

  // ————————————————————————————————————————————————
  console.log("\n1–2 Criação do contexto:");
  {
    const s = await novaSessao();
    check("sessão nasce sem contexto", (await ler(s.id)).context === null);

    const vazio = await salvar(s.id, { clientRequestId: "r1", skipped: true });
    check("contexto pulado é aceito", vazio.status === 200, JSON.stringify(vazio.json));
    check("contexto pulado nasce na versão 1", vazio.json?.context?.version === 1);
    check("contexto pulado não guarda conteúdo", vazio.json?.context?.intention === null && vazio.json?.context?.interlocutorName === null);
    check("'sem contexto' fica registrado, não some", (await ler(s.id)).context?.skipped === true);
  }
  {
    const s = await novaSessao();
    const r = await salvar(s.id, {
      clientRequestId: "r2",
      interlocutorName: "Dra. Helena",
      interlocutorRelation: "médica",
      intention: "Explicar um desconforto",
      environment: "Consulta",
      initialTopic: "dor",
      notes: "Paciente acordou incomodado.",
    });
    check("contexto preenchido é aceito", r.status === 200, JSON.stringify(r.json));
    const c = r.json.context;
    check("guarda o interlocutor livre", c.interlocutorName === "Dra. Helena" && c.interlocutorRelation === "médica");
    check("marca a origem como texto livre", c.interlocutorSource === "FREE_TEXT");
    check("texto livre NÃO aponta para pessoa cadastrada", c.interlocutorPersonId === null);
    check("guarda intenção, ambiente e assunto", c.intention === "Explicar um desconforto" && c.environment === "Consulta" && c.initialTopic === "dor");
    check("registra que foi preenchido à mão", c.filledBy === "ASSISTANT_MANUAL");
    check("todos os campos são opcionais", (await salvar((await novaSessao()).id, { clientRequestId: "r3" })).status === 200);
  }

  console.log("\n2. Interlocutor da rede do paciente:");
  {
    const antes = (await claudia.get(`/api/people?patientId=${pFabio}`)).json.people;
    const pessoa = (await claudia.post("/api/people", { patientId: pFabio, name: "Ana", relation: "esposa" })).json;
    check("pessoa cadastrada na rede do paciente", typeof pessoa.id === "number");

    const s = await novaSessao();
    const r = await salvar(s.id, { clientRequestId: "r4", interlocutorPersonId: pessoa.id });
    const c = r.json.context;
    check("aceita pessoa já cadastrada", r.status === 200, JSON.stringify(r.json));
    check("marca a origem como pessoa cadastrada", c.interlocutorSource === "REGISTERED_PERSON");
    check("copia nome e relação como snapshot", c.interlocutorName === "Ana" && c.interlocutorRelation === "esposa");

    const depois = (await claudia.get(`/api/people?patientId=${pFabio}`)).json.people;
    check("escolher pessoa não cria contato novo", depois.length === antes.length + 1);

    const s2 = await novaSessao();
    await salvar(s2.id, { clientRequestId: "r5", interlocutorName: "fisioterapeuta do plano" });
    const depois2 = (await claudia.get(`/api/people?patientId=${pFabio}`)).json.people;
    check("texto livre NÃO cria contato novo", depois2.length === depois.length);

    const alheia = await salvar((await novaSessao()).id, { clientRequestId: "r6", interlocutorPersonId: 999999 });
    check("pessoa fora da rede do paciente é recusada", alheia.status === 400, JSON.stringify(alheia.json));
  }

  console.log("\n3. Edição e versionamento:");
  {
    const s = await novaSessao();
    await salvar(s.id, { clientRequestId: "v1", intention: "Pedir algo", initialTopic: "água" });
    const r2 = await salvar(s.id, { clientRequestId: "v2", intention: "Explicar um desconforto", initialTopic: "dor" });
    check("edição é aceita", r2.status === 200, JSON.stringify(r2.json));
    check("a edição cria a versão 2", r2.json.context.version === 2);
    check("a versão 2 aponta para a que substitui", typeof r2.json.context.replacesContextId === "string");

    const todas = await versoes(s.id);
    check("as duas versões continuam legíveis", todas.length === 2);
    const v1 = todas.find((v) => v.version === 1);
    check("a versão 1 vira REPLACED", v1.status === "REPLACED");
    check("a versão 1 aponta para a que a substituiu", v1.replacedByContextId === r2.json.context.id);
    check("a versão 1 preserva o conteúdo antigo", v1.intention === "Pedir algo" && v1.initialTopic === "água");
    check("a leitura simples devolve só a vigente", (await ler(s.id)).context.version === 2);
    check("nunca há duas versões vigentes", todas.filter((v) => v.status === "ACTIVE").length === 1);
  }

  console.log("\n4. Prevenção de duplicação:");
  {
    const s = await novaSessao();
    const a = await salvar(s.id, { clientRequestId: "dup", intention: "Conversar com alguém" });
    const b = await salvar(s.id, { clientRequestId: "dup", intention: "Conversar com alguém" });
    check("o mesmo pedido devolve a MESMA versão", a.json.context.id === b.json.context.id);
    check("e não cria uma segunda versão", (await versoes(s.id)).length === 1);

    const [c1, c2] = await Promise.all([
      salvar(s.id, { clientRequestId: "corrida", intention: "Tomar uma decisão" }),
      salvar(s.id, { clientRequestId: "corrida", intention: "Tomar uma decisão" }),
    ]);
    check("cliques simultâneos com o mesmo pedido geram UMA versão", c1.json.context.id === c2.json.context.id);
  }

  console.log("\n5. Auditoria:");
  {
    const s = await novaSessao();
    const criado = await salvar(s.id, { clientRequestId: "a1", intention: "Pedir algo" });
    await salvar(s.id, { clientRequestId: "a2", intention: "Expressar sentimento" });
    await claudia.put(CTX, { patientId: pFabio, sessionId: s.id, contextId: criado.json.context.id });

    const evs = await eventos(s.id);
    const tipos = evs.map((e) => e.eventType);
    check("registra a criação", tipos.includes("SESSION_CONTEXT_CREATED"));
    check("registra a edição", tipos.includes("SESSION_CONTEXT_EDITED"));
    check("registra a substituição da versão anterior", tipos.includes("SESSION_CONTEXT_REPLACED"));
    check("registra a consulta", tipos.includes("SESSION_CONTEXT_VIEWED"));
    check("os eventos carregam o contextId", evs.filter((e) => e.eventType.startsWith("SESSION_CONTEXT")).every((e) => !!e.contextId));
    check("a edição guarda o valor anterior", evs.find((e) => e.eventType === "SESSION_CONTEXT_EDITED")?.previousValue?.intention === "Pedir algo");

    const s2 = await novaSessao();
    await salvar(s2.id, { clientRequestId: "a3", skipped: true });
    check("registra que o contexto foi pulado", (await eventos(s2.id)).some((e) => e.eventType === "SESSION_CONTEXT_SKIPPED"));
  }

  console.log("\n6. Isolamento entre pacientes:");
  {
    const s = await novaSessao();
    await salvar(s.id, { clientRequestId: "iso", intention: "Pedir algo" });
    const alheio = await marcos.get(`${CTX}?patientId=${pRoberto}&sessionId=${s.id}`);
    check("outro paciente não enxerga este contexto", alheio.json.context === null);
    const escrita = await salvar(s.id, { clientRequestId: "iso2", intention: "invadir" }, marcos, pRoberto);
    check("nem grava contexto na sessão de outro paciente", escrita.status === 400, JSON.stringify(escrita.json));
    const semVinculo = await marcos.get(`${CTX}?patientId=${pFabio}&sessionId=${s.id}`);
    check("sem vínculo com o paciente recebe 403", semVinculo.status === 403);
  }

  console.log("\n7. Permissão e sessão encerrada:");
  {
    const s = await novaSessao();
    const leitura = await semPermissao.get(`${CTX}?patientId=${pFabio}&sessionId=${s.id}`);
    check("quem só vê sessões consegue ler o contexto", leitura.status === 200);
    const escrita = await salvar(s.id, { clientRequestId: "perm", intention: "x" }, semPermissao);
    check("quem não tem createSession não grava (403)", escrita.status === 403);

    const s2 = await novaSessao();
    await salvar(s2.id, { clientRequestId: "fim1", intention: "Pedir algo" });
    await claudia.patch(`${RTQ}/sessions`, { patientId: pFabio, sessionId: s2.id, action: "COMPLETE" });
    const depois = await salvar(s2.id, { clientRequestId: "fim2", intention: "tarde demais" });
    check("sessão concluída recusa gravar contexto", depois.status === 400, JSON.stringify(depois.json));
    check("mas o contexto continua legível", (await ler(s2.id)).context?.intention === "Pedir algo");
  }

  console.log(`\n${passed} passaram · ${failed} falharam\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
