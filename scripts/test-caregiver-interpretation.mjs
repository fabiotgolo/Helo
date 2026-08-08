// ——— Interpretação digitada pelo cuidador (Fase 4.2) ———
// O cuidador escreve o que entendeu de uma vocalização, apresenta ao paciente,
// e SÓ o SIM do paciente transforma aquilo em comunicação confirmada — sem
// nunca apagar o fato de que quem formulou o texto foi o cuidador.
//
// Roda contra o dev server + emulador do Firestore. NUNCA rode contra
// produção: o script LIMPA o banco do emulador antes de começar.
//
//   npm run emu                                                (terminal 1)
//   FIRESTORE_DATABASE_ID=fases4x-test PORT=3002 npm run dev:preview   (terminal 2)
//   FIRESTORE_DATABASE_ID=fases4x-test npm run test:interpretation -- http://localhost:3002

import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";
// Guarda: esta suíte apaga o banco inteiro. Ver scripts/emulator-guard.mjs.
assertEmuladorDescartavel(EMU, DB, "test-caregiver-interpretation.mjs");

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
    put(p, b) { return this.req("PUT", p, b); },
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

  console.log("Preparação:");
  check(
    "bootstrap do admin",
    (await admin.post("/api/auth/bootstrap", {
      name: "Admin", email: "admin@helo.test", password: "senha-admin-123",
    })).status === 200
  );
  async function createUser(c, name, email, professionalType) {
    const r = await admin.post("/api/admin/users", {
      name, email, password: "senha-teste-123", role: "profissional", professionalType,
    });
    check(`admin cria ${name}`, r.status === 200, JSON.stringify(r.json));
    check(`${name} faz login`, (await c.post("/api/auth/login", {
      email, password: "senha-teste-123",
    })).status === 200);
    return r.json.user;
  }
  const uClaudia = await createUser(claudia, "Claudia", "claudia@helo.test", "fonoaudiologo");
  const uMarcos = await createUser(marcos, "Marcos", "marcos@helo.test", "terapeuta");

  const pFabio = (await admin.post("/api/patients", { name: "Dr. Fábio" })).json.patient.id;
  await sleep(5);
  const pRoberto = (await admin.post("/api/patients", { name: "Sr. Roberto" })).json.patient.id;

  const FULL = ["viewDashboard", "viewSessions", "viewMetrics", "createSession", "editGestures"];
  for (const [u, pid] of [[uClaudia, pFabio], [uMarcos, pRoberto]]) {
    check(`vínculo ${u.name}`, (await admin.post("/api/admin/access", {
      userId: u.id, patientId: pid, permissions: FULL,
    })).status === 200);
  }

  const RTQ = "/api/realtime-questions";
  const novaSessao = async (c = claudia, patientId = pFabio) =>
    (await c.post(`${RTQ}/sessions`, { patientId })).json.session;
  const interpretar = (sessionId, body, c = claudia, patientId = pFabio) =>
    c.post(`${RTQ}/statements`, {
      patientId, sessionId, origin: "CAREGIVER_INTERPRETATION", ...body,
    });
  const acaoFrase = (sessionId, pathId, statementId, action, c = claudia, patientId = pFabio) =>
    c.patch(`${RTQ}/statements`, { patientId, sessionId, pathId, statementId, action });
  const eventos = async (sessionId, c = claudia, patientId = pFabio) =>
    (await c.get(`${RTQ}/events?patientId=${patientId}&sessionId=${sessionId}`)).json.events;
  const caminho = async (sessionId, pathId, c = claudia, patientId = pFabio) =>
    (await c.get(`${RTQ}/paths?patientId=${patientId}&sessionId=${sessionId}&pathId=${pathId}`)).json;

  /**
   * Interpretação criada, revisada e apresentada — pronta para a resposta do
   * paciente. A revisão não é opcional: o domínio recusa apresentar direto do
   * rascunho, e é isso que garante que o cuidador leia o que escreveu antes de
   * mostrar ao paciente.
   */
  async function apresentada(sessionId, texto, extra = {}) {
    const r = await interpretar(sessionId, { text: texto, clientRequestId: `i-${Math.random()}`, ...extra });
    const { path, statement } = r.json;
    await acaoFrase(sessionId, path.id, statement.id, { kind: "EDIT", text: texto });
    await acaoFrase(sessionId, path.id, statement.id, { kind: "PRESENT" });
    return { path, statement };
  }

  // ————————————————————————————————————————————————
  console.log("\n9–12 Criação da interpretação:");
  {
    const s = await novaSessao();
    const r = await interpretar(s.id, {
      text: "Gostaria de falar sobre comer churrasco e tomar cerveja.",
      clientRequestId: "c1",
    });
    check("a interpretação é criada", r.status === 200, JSON.stringify(r.json));
    const { path, statement } = r.json;
    check("nasce um contêiner próprio, sem árvore de opções", path.kind === "CAREGIVER_INTERPRETATION" && path.rootNodeId === null);
    check("a frase registra a origem", statement.origin === "CAREGIVER_INTERPRETATION");
    check("e o modo derivado dela", statement.interactionMode === "CAREGIVER_INTERPRETATION");
    check("nasce em rascunho", statement.status === "DRAFT");
    check("sem resposta e sem confirmação", statement.provisionalResponse === null && statement.confirmedResponse === null);
    check("não nasce de um nível de opções", statement.originNodeId === null);

    const comNivel = await interpretar(s.id, { text: "x", clientRequestId: "c2", originNodeId: "node-x", pathId: path.id });
    check("interpretação com nível de opções é recusada", comNivel.status === 400, JSON.stringify(comNivel.json));
    const vazia = await interpretar(s.id, { text: "   ", clientRequestId: "c3" });
    check("interpretação vazia é recusada", vazia.status === 400);
  }

  console.log("\n13–15 Revisão, apresentação e SIM:");
  {
    const s = await novaSessao();
    const r = await interpretar(s.id, { text: "Quero ver minha filha.", clientRequestId: "d1" });
    const { path, statement } = r.json;

    const editada = await acaoFrase(s.id, path.id, statement.id, {
      kind: "EDIT", text: "Quero ver a minha filha hoje.",
    });
    check("edita antes de apresentar, no MESMO registro", editada.json.statement.id === statement.id);
    check("e vai para revisada", editada.json.statement.status === "REVIEWED");

    const apr = await acaoFrase(s.id, path.id, statement.id, { kind: "PRESENT" });
    check("apresenta ao paciente", apr.json.statement.status === "PRESENTED");
    check("o texto apresentado congela", apr.json.statement.presentedText === "Quero ver a minha filha hoje.");

    const sim = await acaoFrase(s.id, path.id, statement.id, { kind: "RESPOND", response: "YES" });
    check("SIM observado NÃO confirma sozinho", sim.json.statement.status === "PROVISIONAL_RESPONSE");
    check("e ainda não é comunicação confirmada", sim.json.statement.confirmedResponse === null);

    const conf = await acaoFrase(s.id, path.id, statement.id, { kind: "CONFIRM" });
    check("a conferência do assistente confirma", conf.json.statement.status === "CONFIRMED");
    check("registra SIM como resposta confirmada", conf.json.statement.confirmedResponse === "YES");
    check("a ORIGEM sobrevive à confirmação", conf.json.statement.origin === "CAREGIVER_INTERPRETATION");
    check("o caminho é concluído", conf.json.path.status === "COMPLETED");
  }

  console.log("\n16 TALVEZ ajusta sem confirmar:");
  {
    const s = await novaSessao();
    const { path, statement } = await apresentada(s.id, "O senhor quer sair da cama?");
    const talvez = await acaoFrase(s.id, path.id, statement.id, { kind: "RESPOND", response: "MAYBE" });
    check("TALVEZ para em provisória", talvez.json.statement.status === "PROVISIONAL_RESPONSE");
    check("TALVEZ nunca confirma", talvez.json.statement.confirmedResponse === null);
    const confirmar = await acaoFrase(s.id, path.id, statement.id, { kind: "CONFIRM" });
    check("confirmar sobre TALVEZ é recusado", confirmar.status === 400, JSON.stringify(confirmar.json));

    // Ajustar depois de apresentado cria versão NOVA.
    const nova = await claudia.post(`${RTQ}/statements`, {
      patientId: pFabio, sessionId: s.id, pathId: path.id,
      replaceStatementId: statement.id, clientRequestId: "aj1",
    });
    // A substituição devolve { original, created, path }: as duas pontas do par.
    check("ajustar cria uma versão nova", nova.status === 200 && nova.json.created?.id !== statement.id, JSON.stringify(nova.json).slice(0, 200));
    check("a versão nova herda a origem", nova.json.created.origin === "CAREGIVER_INTERPRETATION");
    check("a versão nova NÃO herda a resposta", nova.json.created.provisionalResponse === null);
    check("a versão nova volta a rascunho", nova.json.created.status === "DRAFT");
    check("a versão nova aponta para a original", nova.json.created.replacesStatementId === statement.id);
    const det = await caminho(s.id, path.id);
    const original = det.statements.find((x) => x.id === statement.id);
    check("a original vira SUBSTITUÍDA", original.status === "REPLACED");
    check("a original preserva o texto apresentado", original.presentedText === "O senhor quer sair da cama?");
  }

  console.log("\n17 NÃO rejeita sem apagar:");
  {
    const s = await novaSessao();
    const { path, statement } = await apresentada(s.id, "O senhor quer dormir agora?");
    await acaoFrase(s.id, path.id, statement.id, { kind: "RESPOND", response: "NO" });
    const rej = await acaoFrase(s.id, path.id, statement.id, { kind: "REJECT" });
    check("NÃO rejeita a interpretação", rej.json.statement.status === "REJECTED");
    check("rejeitada NUNCA registra confirmação", rej.json.statement.confirmedResponse === null);
    check("o texto rejeitado é preservado", rej.json.statement.presentedText === "O senhor quer dormir agora?");
    const evs = await eventos(s.id);
    check("a rejeição fica na trilha", evs.some((e) => e.eventType === "CAREGIVER_INTERPRETATION_REJECTED"));
  }

  console.log("\n20 Conteúdo sensível:");
  {
    const s = await novaSessao();
    const { path, statement } = await apresentada(s.id, "Quero rever meu testamento.", {
      isSensitive: true, sensitiveCategory: "LEGAL",
    });
    check("a interpretação nasce marcada como sensível", statement.isSensitive === true);
    await acaoFrase(s.id, path.id, statement.id, { kind: "RESPOND", response: "YES" });
    const direto = await acaoFrase(s.id, path.id, statement.id, { kind: "CONFIRM" });
    check("sensível NÃO confirma sem reconfirmação", direto.status === 400, JSON.stringify(direto.json));
    const rec = await acaoFrase(s.id, path.id, statement.id, { kind: "RECONFIRM" });
    check("a reconfirmação reforçada é registrada", rec.json.statement.status === "RECONFIRMATION_PENDING");
    const conf = await acaoFrase(s.id, path.id, statement.id, { kind: "CONFIRM" });
    check("só então confirma", conf.json.statement.status === "CONFIRMED");
    check("as duas confirmações ficam preservadas", !!conf.json.statement.reconfirmedAt && !!conf.json.statement.confirmedAt);
  }

  console.log("\n18 Repetir a MESMA interpretação (base da Fase 4.7):");
  {
    const s = await novaSessao();
    const { path, statement } = await apresentada(s.id, "O senhor está com frio?");
    const r1 = await acaoFrase(s.id, path.id, statement.id, { kind: "REPRESENT" });
    check("repetir é aceito de PRESENTED", r1.status === 200, JSON.stringify(r1.json));
    check("continua a MESMA frase", r1.json.statement.id === statement.id);
    check("o texto apresentado não muda", r1.json.statement.presentedText === "O senhor está com frio?");
    check("conta a repetição", r1.json.statement.representCount === 1);
    check("segue aguardando resposta", r1.json.statement.status === "PRESENTED");
    const r2 = await acaoFrase(s.id, path.id, statement.id, { kind: "REPRESENT" });
    check("repetir de novo incrementa", r2.json.statement.representCount === 2);
    const evs = await eventos(s.id);
    check("a repetição fica na trilha", evs.some((e) => e.eventType === "CAREGIVER_INTERPRETATION_REPRESENTED"));

    // Confirmada, não se repete mais.
    await acaoFrase(s.id, path.id, statement.id, { kind: "RESPOND", response: "YES" });
    await acaoFrase(s.id, path.id, statement.id, { kind: "CONFIRM" });
    const tarde = await acaoFrase(s.id, path.id, statement.id, { kind: "REPRESENT" });
    check("repetir uma frase já confirmada é recusado", tarde.status === 400);
  }

  console.log("\n19 Reutilização a partir do histórico:");
  {
    const s = await novaSessao();
    const { path, statement } = await apresentada(s.id, "Quero tomar um café.");
    await acaoFrase(s.id, path.id, statement.id, { kind: "RESPOND", response: "YES" });
    await acaoFrase(s.id, path.id, statement.id, { kind: "CONFIRM" });

    const reuso = await claudia.post(`${RTQ}/statements`, {
      patientId: pFabio, sessionId: s.id,
      reuseFromStatementId: statement.id, clientRequestId: "re1",
    });
    check("reutilizar é aceito", reuso.status === 200, JSON.stringify(reuso.json));
    check("copia só o texto", reuso.json.statement.currentText === "Quero tomar um café.");
    check("NÃO copia a resposta", reuso.json.statement.confirmedResponse === null);
    check("nasce em rascunho", reuso.json.statement.status === "DRAFT");
    check("aponta para a origem", reuso.json.statement.reusedFromStatementId === statement.id);
    check("a original continua confirmada", (await caminho(s.id, path.id)).statements.find((x) => x.id === statement.id).status === "CONFIRMED");
  }

  console.log("\n21 Auditoria com nomes próprios:");
  {
    const s = await novaSessao();
    const { path, statement } = await apresentada(s.id, "Quero falar com o meu filho.");
    await acaoFrase(s.id, path.id, statement.id, { kind: "RESPOND", response: "YES" });
    await acaoFrase(s.id, path.id, statement.id, { kind: "CONFIRM" });
    const tipos = (await eventos(s.id)).map((e) => e.eventType);
    check("registra a criação", tipos.includes("CAREGIVER_INTERPRETATION_CREATED"));
    check("registra a apresentação", tipos.includes("CAREGIVER_INTERPRETATION_PRESENTED"));
    check("registra a confirmação", tipos.includes("CAREGIVER_INTERPRETATION_CONFIRMED"));
    check("NÃO usa os nomes da frase escolhida entre opções", !tipos.some((t) => t.startsWith("FINAL_STATEMENT_")));
  }

  console.log("\n34 Duplicação, pausa, sessão encerrada e isolamento:");
  {
    const s = await novaSessao();
    const a = await interpretar(s.id, { text: "Estou com sede.", clientRequestId: "dup" });
    const b = await interpretar(s.id, { text: "Estou com sede.", clientRequestId: "dup" });
    check("o mesmo pedido devolve a MESMA frase", a.json.statement.id === b.json.statement.id);
    check("e o MESMO contêiner", a.json.path.id === b.json.path.id);

    const s2 = await novaSessao();
    const { path, statement } = await apresentada(s2.id, "O senhor quer água?");
    await claudia.patch(`${RTQ}/sessions`, { patientId: pFabio, sessionId: s2.id, action: "PAUSE" });
    const pausada = await acaoFrase(s2.id, path.id, statement.id, { kind: "RESPOND", response: "YES" });
    check("sessão pausada recusa responder", pausada.status === 400, JSON.stringify(pausada.json));
    await claudia.patch(`${RTQ}/sessions`, { patientId: pFabio, sessionId: s2.id, action: "RESUME" });
    await claudia.patch(`${RTQ}/sessions`, { patientId: pFabio, sessionId: s2.id, action: "COMPLETE" });
    const encerrada = await interpretar(s2.id, { text: "tarde demais", clientRequestId: "fim" });
    check("sessão concluída recusa nova interpretação", encerrada.status === 400);

    const alheia = await interpretar(s.id, { text: "invasão", clientRequestId: "iso" }, marcos, pRoberto);
    check("outro paciente não escreve nesta sessão", alheia.status === 400, JSON.stringify(alheia.json));
    const semVinculo = await marcos.get(`${RTQ}/paths?patientId=${pFabio}&sessionId=${s.id}`);
    check("sem vínculo com o paciente recebe 403", semVinculo.status === 403);
  }

  console.log(`\n${passed} passaram · ${failed} falharam\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
