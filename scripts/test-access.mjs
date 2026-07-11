// ——— Testes obrigatórios de autorização (seções 31–35 do requisito) ———
// Roda contra o dev server + emulador do Firestore. NUNCA rode contra
// produção: o script LIMPA o banco do emulador antes de começar.
//
//   npm run emu          (terminal 1)
//   npm run dev          (terminal 2)
//   node scripts/test-access.mjs http://localhost:3000

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

/** Cliente HTTP com cookie de sessão próprio (um por usuário). */
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
    del(p, b) {
      return this.req("DELETE", p, b);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`base: ${BASE} · emulador: ${EMU} (db ${DB})`);

  // —— limpeza do emulador (só existe em dev) ——
  const wipe = await fetch(
    `http://${EMU}/emulator/v1/projects/${PROJECT}/databases/${DB}/documents`,
    { method: "DELETE" }
  );
  if (!wipe.ok) {
    console.error("não consegui limpar o emulador — abortando");
    process.exit(1);
  }
  console.log("emulador limpo.\n");

  const anon = client();
  const admin = client();
  const claudia = client();
  const marcos = client();
  const familiar = client();
  const paciente = client();

  // ════ Sem autenticação ════
  console.log("Sem autenticação:");
  check("GET /api/patients → 401", (await anon.get("/api/patients")).status === 401);
  check(
    "GET /api/stats → 401",
    (await anon.get("/api/stats?patientId=1")).status === 401
  );
  check(
    "GET /api/admin/users → 401",
    (await anon.get("/api/admin/users")).status === 401
  );

  // ════ Bootstrap do primeiro admin ════
  console.log("\nBootstrap e gestão de usuários (Admin):");
  const boot = await admin.post("/api/auth/bootstrap", {
    name: "Admin",
    email: "admin@helo.test",
    password: "senha-admin-123",
  });
  check("bootstrap cria o primeiro admin", boot.status === 200, JSON.stringify(boot.json));
  check(
    "segundo bootstrap é negado",
    (await anon.post("/api/auth/bootstrap", { name: "x", email: "x@x.x", password: "12345678" })).status === 403
  );

  // —— Admin cria usuários ——
  async function createUser(c, name, email, role, professionalType) {
    const r = await admin.post("/api/admin/users", {
      name,
      email,
      password: "senha-teste-123",
      role,
      professionalType,
    });
    check(`admin cria usuário ${name}`, r.status === 200, JSON.stringify(r.json));
    const login = await c.post("/api/auth/login", {
      email,
      password: "senha-teste-123",
    });
    check(`${name} faz login`, login.status === 200);
    return r.json.user;
  }

  const uClaudia = await createUser(claudia, "Claudia", "claudia@helo.test", "profissional", "fonoaudiologo");
  const uMarcos = await createUser(marcos, "Marcos", "marcos@helo.test", "profissional", "terapeuta");
  const uFamiliar = await createUser(familiar, "Familiar A", "familiar@helo.test", "familiar", null);
  const uPaciente = await createUser(paciente, "Conta do Dr. Fábio", "fabio@helo.test", "paciente", null);

  check(
    "não-admin não lista usuários (403)",
    (await claudia.get("/api/admin/users")).status === 403
  );
  check(
    "não-admin não cria vínculos (403)",
    (await claudia.post("/api/admin/access", { userId: "x", patientId: 1 })).status === 403
  );

  // ════ Admin cria pacientes ════
  console.log("\nPacientes (Admin cria; ids únicos):");
  const patientNames = ["Dr. Fábio", "Sr. Roberto", "Dra. Silvia", "Sra. Renata", "Sergio"];
  const pts = {};
  for (const n of patientNames) {
    const r = await admin.post("/api/patients", { name: n });
    check(`admin cria paciente ${n}`, r.status === 200);
    pts[n] = r.json.patient.id;
    await sleep(5); // ids derivados de Date.now()
  }

  // ════ Vínculos ════
  console.log("\nVínculos (Claudia ↔ 3, Marcos ↔ 3, Fábio compartilhado):");
  async function link(user, patientName, permissions) {
    const r = await admin.post("/api/admin/access", {
      userId: user.id,
      patientId: pts[patientName],
      permissions,
    });
    check(`vínculo ${user.name} ↔ ${patientName}`, r.status === 200);
    return r.json.link;
  }
  await link(uClaudia, "Dr. Fábio");
  await link(uClaudia, "Sr. Roberto");
  await link(uClaudia, "Dra. Silvia");
  const lMarcosFabio = await link(uMarcos, "Dr. Fábio");
  await link(uMarcos, "Sra. Renata");
  await link(uMarcos, "Sergio");
  // Familiar: só visualização no Dr. Fábio (permissões granulares).
  await link(uFamiliar, "Dr. Fábio", ["viewDashboard", "viewSessions", "viewMetrics"]);
  // Conta do paciente: vê apenas o próprio contexto.
  await link(uPaciente, "Dr. Fábio", ["viewDashboard", "viewSessions", "viewMetrics"]);

  // ════ Cenário Claudia e Marcos (seção 31) ════
  console.log("\nCenário Claudia e Marcos:");
  const listC = (await claudia.get("/api/patients")).json.patients;
  const listM = (await marcos.get("/api/patients")).json.patients;
  check("Claudia vê exatamente 3 pacientes", listC.length === 3, `viu ${listC.length}`);
  check("Marcos vê exatamente 3 pacientes", listM.length === 3, `viu ${listM.length}`);
  check(
    "ambos veem o MESMO patientId do Dr. Fábio",
    listC.some((p) => p.id === pts["Dr. Fábio"]) && listM.some((p) => p.id === pts["Dr. Fábio"])
  );
  check("Claudia NÃO vê Renata", !listC.some((p) => p.id === pts["Sra. Renata"]));
  check("Claudia NÃO vê Sergio", !listC.some((p) => p.id === pts["Sergio"]));
  check("Marcos NÃO vê Roberto", !listM.some((p) => p.id === pts["Sr. Roberto"]));
  check("Marcos NÃO vê Silvia", !listM.some((p) => p.id === pts["Dra. Silvia"]));

  const sumC = (await claudia.get("/api/patients/summary")).json.summaries;
  check("Dashboard Geral (summary) da Claudia: só os 3 vinculados", sumC.length === 3);

  check(
    "URL direta: Claudia em Sergio → 403",
    (await claudia.get(`/api/stats?patientId=${pts["Sergio"]}`)).status === 403
  );
  check(
    "URL direta: Marcos em Roberto → 403",
    (await marcos.get(`/api/stats?patientId=${pts["Sr. Roberto"]}`)).status === 403
  );
  check(
    "Claudia acessa stats do Dr. Fábio (200)",
    (await claudia.get(`/api/stats?patientId=${pts["Dr. Fábio"]}`)).status === 200
  );

  // Dado compartilhado: alteração da Claudia aparece para Marcos.
  const ren = await claudia.patch("/api/patients", {
    id: pts["Dr. Fábio"],
    name: "Dr. Fábio Garcia",
  });
  check("Claudia (editProfile) renomeia o Dr. Fábio", ren.status === 200);
  const listM2 = (await marcos.get("/api/patients")).json.patients;
  check(
    "Marcos vê a alteração (mesmo Dashboard, mesmos dados)",
    listM2.some((p) => p.id === pts["Dr. Fábio"] && p.name === "Dr. Fábio Garcia")
  );

  // Rotina compartilhada + isolamento entre pacientes.
  const item = await claudia.post("/api/items", {
    patientId: pts["Dr. Fábio"],
    mode: "rotina",
    item: { label: "Chá", spokenText: "Quero um chá, por favor." },
  });
  check("Claudia adiciona item de Rotina ao Dr. Fábio", item.status === 200);
  const itemsM = (await marcos.get(`/api/items?patientId=${pts["Dr. Fábio"]}&mode=rotina`)).json.items;
  check(
    "Marcos vê o MESMO item (sem cópia por usuário)",
    itemsM.some((i) => i.label === "Chá")
  );
  const itemsRoberto = (await claudia.get(`/api/items?patientId=${pts["Sr. Roberto"]}&mode=rotina`)).json.items;
  check(
    "item não vazou para Sr. Roberto (isolamento)",
    !itemsRoberto.some((i) => i.label === "Chá")
  );

  // ════ Permissões granulares (seção 33) ════
  console.log("\nPermissões granulares:");
  check(
    "familiar com viewMetrics acessa stats (200)",
    (await familiar.get(`/api/stats?patientId=${pts["Dr. Fábio"]}`)).status === 200
  );
  check(
    "familiar SEM editRoutine não edita Rotina (403)",
    (
      await familiar.post("/api/items", {
        patientId: pts["Dr. Fábio"],
        mode: "rotina",
        item: { label: "x", spokenText: "x" },
      })
    ).status === 403
  );
  check(
    "familiar SEM manageVoice não altera voz (403)",
    (
      await familiar.post("/api/settings", {
        patientId: pts["Dr. Fábio"],
        voice_id: "abc",
      })
    ).status === 403
  );
  check(
    "familiar SEM createSession não registra sessão (403)",
    (
      await familiar.post("/api/sessions", {
        mode: "rotina",
        patientId: pts["Dr. Fábio"],
      })
    ).status === 403
  );
  check(
    "Claudia COM createSession registra sessão (200)",
    (
      await claudia.post("/api/sessions", {
        mode: "rotina",
        patientId: pts["Dr. Fábio"],
      })
    ).status === 200
  );
  // Admin muda permissões do vínculo → passa a valer imediatamente.
  const links = (await admin.get("/api/admin/access")).json.links;
  const lFam = links.find((l) => l.userId === uFamiliar.id);
  await admin.patch("/api/admin/access", {
    id: lFam.id,
    permissions: [...lFam.permissions, "editRoutine"],
  });
  check(
    "admin concede editRoutine ao familiar → edição passa (200)",
    (
      await familiar.post("/api/items", {
        patientId: pts["Dr. Fábio"],
        mode: "rotina",
        item: { label: "Água", spokenText: "Quero água." },
      })
    ).status === 200
  );

  // Conta do paciente: papel paciente não cria pacientes.
  check(
    "papel paciente não cria pacientes (403)",
    (await paciente.post("/api/patients", { name: "X" })).status === 403
  );
  const listP = (await paciente.get("/api/patients")).json.patients;
  check("conta do paciente vê só o próprio contexto", listP.length === 1 && listP[0].id === pts["Dr. Fábio"]);

  // ════ Criação por não-admin (seção 32) ════
  console.log("\nCriação de paciente por não-admin:");
  const novo = await claudia.post("/api/patients", { name: "Roberto Novo" });
  check("Claudia (profissional) cria paciente", novo.status === 200);
  const listC3 = (await claudia.get("/api/patients")).json.patients;
  check("Claudia foi vinculada automaticamente (agora vê 4)", listC3.length === 4, `viu ${listC3.length}`);
  const listM3 = (await marcos.get("/api/patients")).json.patients;
  check("novo paciente NÃO aparece para Marcos", !listM3.some((p) => p.id === novo.json.patient.id));
  const famNovo = await familiar.post("/api/patients", { name: "Paciente do Familiar" });
  check("familiar autorizado também cria paciente", famNovo.status === 200);
  const listF = (await familiar.get("/api/patients")).json.patients;
  check("familiar recebe vínculo com o paciente criado", listF.some((p) => p.id === famNovo.json.patient.id));

  // ════ Revogação (seção 17) ════
  console.log("\nRevogação de acesso:");
  const rev = await admin.del("/api/admin/access", { id: lMarcosFabio.id });
  check("admin revoga Marcos ↔ Dr. Fábio", rev.status === 200);
  const listM4 = (await marcos.get("/api/patients")).json.patients;
  check("Dr. Fábio some do Dashboard Geral de Marcos", !listM4.some((p) => p.id === pts["Dr. Fábio"]));
  check(
    "Marcos não abre mais o Dr. Fábio (403)",
    (await marcos.get(`/api/stats?patientId=${pts["Dr. Fábio"]}`)).status === 403
  );
  check(
    "acesso da Claudia continua intacto (200)",
    (await claudia.get(`/api/stats?patientId=${pts["Dr. Fábio"]}`)).status === 200
  );
  check(
    "dados do Dr. Fábio não foram deletados",
    (await admin.get("/api/patients")).json.patients.some((p) => p.id === pts["Dr. Fábio"])
  );

  // ════ Desativação e exclusão de usuário (seção 18) ════
  console.log("\nDesativação/exclusão de usuário:");
  await admin.patch("/api/admin/users", { id: uMarcos.id, status: "inactive" });
  check(
    "usuário desativado perde a sessão (401)",
    (await marcos.get("/api/patients")).status === 401
  );
  check(
    "login de conta desativada é negado (403)",
    (await client().post("/api/auth/login", { email: "marcos@helo.test", password: "senha-teste-123" })).status === 403
  );
  const before = (await admin.get("/api/patients")).json.patients.length;
  await admin.del("/api/admin/users", { id: uMarcos.id });
  const usersAfter = (await admin.get("/api/admin/users")).json.users;
  check("admin deleta Marcos", !usersAfter.some((u) => u.id === uMarcos.id));
  const after = (await admin.get("/api/patients")).json.patients.length;
  check("deletar usuário NÃO deleta pacientes", after === before, `${before} → ${after}`);

  // ════ Exclusão de paciente (seção 19) ════
  console.log("\nDesativação/exclusão de paciente (Admin):");
  const soft = await admin.del("/api/patients", { id: pts["Sergio"] });
  check("soft delete (desativar) paciente", soft.status === 200 && soft.json.deleted === false);
  check(
    "paciente desativado some das listas",
    !(await admin.get("/api/patients")).json.patients.some((p) => p.id === pts["Sergio"])
  );
  const hard = await admin.del("/api/patients", { id: pts["Sra. Renata"], hard: true });
  check("hard delete de paciente (com confirmação da UI)", hard.status === 200 && hard.json.deleted === true);
  check(
    "não-admin não deleta paciente (403)",
    (await claudia.del("/api/patients", { id: pts["Dr. Fábio"] })).status === 403
  );

  // ════ Auditoria ════
  console.log("\nAuditoria:");
  const audit = (await admin.get("/api/admin/audit")).json.events;
  check("auditoria registra criações/vínculos/revogações", audit.length >= 10, `só ${audit.length}`);
  check(
    "auditoria registra quem revogou acesso",
    audit.some((e) => e.action === "access.revoke")
  );

  console.log(`\n———— RESULTADO: ${passed} ok · ${failed} falhas ————`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("erro fatal:", e);
  process.exit(1);
});
