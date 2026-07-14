// Teste de integração de Feedback & Support contra o emulador do Firestore.
// Usa um banco isolado (ex.: feedback-test), nunca a base de produção.
//
// FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
// FIRESTORE_DATABASE_ID=feedback-test \
// node scripts/test-feedback.mjs http://localhost:3002

const BASE = process.argv[2] ?? "http://localhost:3002";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "feedback-test";

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
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
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      let json = null;
      try {
        json = await response.json();
      } catch {}
      return { status: response.status, json };
    },
    get(path) { return this.req("GET", path); },
    post(path, body) { return this.req("POST", path, body); },
    patch(path, body) { return this.req("PATCH", path, body); },
    del(path, body) { return this.req("DELETE", path, body); },
  };
}

async function main() {
  console.log(`base: ${BASE} · emulador: ${EMU} (db ${DB})`);
  const wipe = await fetch(
    `http://${EMU}/emulator/v1/projects/${PROJECT}/databases/${DB}/documents`,
    { method: "DELETE" }
  );
  if (!wipe.ok) {
    console.error("não consegui limpar o banco isolado do emulador — abortando");
    process.exit(1);
  }

  const anon = client();
  const admin = client();
  const ana = client();
  const bruno = client();

  console.log("\nAutorização e criação:");
  check("anônimo não lista feedback", (await anon.get("/api/feedback")).status === 401);
  check("anônimo não cria feedback", (await anon.post("/api/feedback", { title: "x" })).status === 401);

  check(
    "bootstrap cria Admin",
    (await admin.post("/api/auth/bootstrap", {
      name: "Admin", email: "admin@helo.test", password: "senha-admin-123",
    })).status === 200
  );
  for (const [session, name, email] of [
    [ana, "Ana", "ana@helo.test"],
    [bruno, "Bruno", "bruno@helo.test"],
  ]) {
    const created = await admin.post("/api/admin/users", {
      name, email, password: "senha-teste-123", role: "cuidador", professionalType: null,
    });
    check(`admin cria ${name}`, created.status === 200, JSON.stringify(created.json));
    check(`${name} autentica`, (await session.post("/api/auth/login", {
      email, password: "senha-teste-123",
    })).status === 200);
  }

  const feature = await ana.post("/api/feedback", {
    title: "Filtro por profissional", description: "Permitir filtrar pacientes por profissional.",
    type: "feature", route: "/dashboard", viewport: { width: 1280, height: 800 },
    patientId: null,
  });
  check("Ana cria feature pública", feature.status === 201, JSON.stringify(feature.json));
  const featureId = feature.json?.feedback?.id;
  check("feature grava status inicial e sem paciente", feature.json?.feedback?.status === "new" && feature.json?.feedback?.isOwner);

  const bug = await ana.post("/api/feedback", {
    title: "Tela não atualiza", description: "Após salvar, o card continua antigo.",
    type: "bug", route: "/ajustes", viewport: { width: 390, height: 844 },
  });
  check("Ana cria bug privado", bug.status === 201 && bug.json?.feedback?.visibility === "private", JSON.stringify(bug.json));
  const bugId = bug.json?.feedback?.id;

  check("título vazio é rejeitado", (await ana.post("/api/feedback", {
    title: "", description: "descrição", type: "feature",
  })).status === 400);

  console.log("\nEdição e exclusão pelo autor:");
  check("Bruno não edita o bug de Ana", (await bruno.patch(`/api/feedback/${bugId}`, {
    title: "Tentativa", description: "Não deveria ser permitido.",
  })).status === 403);
  check("Bruno não exclui o bug de Ana", (await bruno.del(`/api/feedback/${bugId}`)).status === 403);
  check("Ana edita o próprio bug", (await ana.patch(`/api/feedback/${bugId}`, {
    title: "Tela ainda não atualiza", description: "Após salvar, o card continua antigo até atualizar a página.",
  })).status === 200);
  const ownDraft = await ana.post("/api/feedback", {
    title: "Rascunho para excluir", description: "Teste de exclusão pelo autor.",
    type: "feature", route: "/feedback",
  });
  check("Ana exclui a própria solicitação", (await ana.del(`/api/feedback/${ownDraft.json?.feedback?.id}`)).status === 200);

  console.log("\nVisibilidade e votos:");
  const brunoList = await bruno.get("/api/feedback");
  const visibleToBruno = brunoList.json?.requests ?? [];
  check("Bruno vê a feature pública", visibleToBruno.some((item) => item.id === featureId));
  check("Bruno não vê o bug privado de Ana", !visibleToBruno.some((item) => item.id === bugId));

  const firstVote = await bruno.post(`/api/feedback/${featureId}/vote`);
  check("Bruno vota na feature", firstVote.status === 200 && firstVote.json?.hasVoted && firstVote.json?.votesCount === 1, JSON.stringify(firstVote.json));
  const secondVote = await bruno.post(`/api/feedback/${featureId}/vote`);
  check("Bruno remove o próprio voto", secondVote.status === 200 && !secondVote.json?.hasVoted && secondVote.json?.votesCount === 0, JSON.stringify(secondVote.json));
  const [concurrentA, concurrentB] = await Promise.all([
    bruno.post(`/api/feedback/${featureId}/vote`),
    bruno.post(`/api/feedback/${featureId}/vote`),
  ]);
  const afterConcurrent = await bruno.get("/api/feedback");
  const afterFeature = afterConcurrent.json?.requests?.find((item) => item.id === featureId);
  check(
    "votos concorrentes preservam contador consistente",
    concurrentA.status === 200 && concurrentB.status === 200 && afterFeature?.votesCount === 0 && !afterFeature?.hasVoted,
    JSON.stringify({ concurrentA, concurrentB, afterFeature })
  );

  console.log("\nAdministração:");
  check("usuário comum não acessa gestão", (await ana.get("/api/admin/feedback")).status === 403);
  const adminList = await admin.get("/api/admin/feedback");
  check("Admin vê feature e bug", adminList.status === 200 && adminList.json?.requests?.length === 2, JSON.stringify(adminList.json));
  const adminBug = adminList.json?.requests?.find((item) => item.id === bugId);
  check("Admin recebe contexto técnico mínimo do bug", Boolean(adminBug?.metadata?.browser) && adminBug?.route === "/ajustes");
  check("Admin atualiza status", (await admin.patch("/api/admin/feedback", {
    id: featureId, status: "planned",
  })).status === 200);
  check("Admin arquiva", (await admin.patch("/api/admin/feedback", {
    id: featureId, archived: true,
  })).status === 200);
  check("feature arquivada deixa lista pública", !(await bruno.get("/api/feedback")).json?.requests?.some((item) => item.id === featureId));
  check("Admin exclui bug", (await admin.del("/api/admin/feedback", { id: bugId })).status === 200);

  console.log(`\n${passed} passou, ${failed} falhou.`);
  process.exit(failed ? 1 : 0);
}

void main();
