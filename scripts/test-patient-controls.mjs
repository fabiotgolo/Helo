// ——— Controles diretos do paciente (Fase 4.7) ———
// Pausar, repetir, não entendi, mudar de assunto, encerrar — pedidos DO
// PACIENTE, conferidos pelo cuidador, executados sem nunca inventar resposta.
//
// Roda contra o dev server + emulador do Firestore. NUNCA rode contra
// produção: o script LIMPA o banco do emulador antes de começar.
//
//   npm run emu                                                       (terminal 1)
//   FIRESTORE_DATABASE_ID=fases4x-test PORT=3002 npm run dev:preview   (terminal 2)
//   FIRESTORE_DATABASE_ID=fases4x-test npm run test:patient-controls -- http://localhost:3002

import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";
// Guarda: esta suíte apaga o banco inteiro. Ver scripts/emulator-guard.mjs.
assertEmuladorDescartavel(EMU, DB, "test-patient-controls.mjs");

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
  check("bootstrap do admin", (await admin.post("/api/auth/bootstrap", {
    name: "Admin", email: "admin@helo.test", password: "senha-admin-123",
  })).status === 200);
  async function createUser(c, name, email, tipo) {
    const r = await admin.post("/api/admin/users", {
      name, email, password: "senha-teste-123", role: "profissional", professionalType: tipo,
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
  const CTRL = `${RTQ}/patient-controls`;
  const novaSessao = async (c = claudia, patientId = pFabio) =>
    (await c.post(`${RTQ}/sessions`, { patientId })).json.session;
  const abrir = (sessionId, body = {}, c = claudia, patientId = pFabio) =>
    c.post(CTRL, { patientId, sessionId, clientRequestId: `k-${Math.random()}`, ...body });
  const acao = (sessionId, requestId, action, c = claudia, patientId = pFabio) =>
    c.patch(CTRL, { patientId, sessionId, requestId, action });
  const painel = async (sessionId, c = claudia, patientId = pFabio) =>
    (await c.get(`${CTRL}?patientId=${patientId}&sessionId=${sessionId}`)).json.request;
  const eventos = async (sessionId, c = claudia, patientId = pFabio) =>
    (await c.get(`${RTQ}/events?patientId=${patientId}&sessionId=${sessionId}`)).json.events;
  const sessao = async (sessionId, c = claudia, patientId = pFabio) =>
    (await c.get(`${RTQ}/sessions?patientId=${patientId}&sessionId=${sessionId}`)).json;

  /** Pergunta fechada apresentada e aguardando resposta. */
  async function turnoAguardando(sessionId, texto = "O senhor está com sede?") {
    const t = (await claudia.post(`${RTQ}/turns`, { patientId: pFabio, sessionId, text: texto })).json.turn;
    const act = (action) => claudia.patch(`${RTQ}/turns`, { patientId: pFabio, sessionId, turnId: t.id, action });
    await act({ kind: "REVIEW", reviewedText: texto });
    await act({ kind: "PRESENT" });
    return (await act({ kind: "AWAIT_RESPONSE" })).json.turn;
  }

  /** Leva o painel até um comando confirmado, pronto para executar. */
  async function ateConfirmar(sessionId, requestId, comando, nivel2 = false) {
    await acao(sessionId, requestId, { kind: "PRESENT" });
    if (nivel2) {
      await acao(sessionId, requestId, { kind: "AWAIT_SELECTION" });
      await acao(sessionId, requestId, { kind: "SELECT_COMMAND", command: "MORE_CONTROLS" });
      await acao(sessionId, requestId, { kind: "CONFIRM_COMMAND" });
      await acao(sessionId, requestId, { kind: "PRESENT" });
    }
    await acao(sessionId, requestId, { kind: "AWAIT_SELECTION" });
    await acao(sessionId, requestId, { kind: "SELECT_COMMAND", command: comando });
    return acao(sessionId, requestId, { kind: "CONFIRM_COMMAND" });
  }

  // ————————————————————————————————————————————————
  console.log("\n23 Abrir o painel NÃO altera a interação:");
  {
    const s = await novaSessao();
    const turno = await turnoAguardando(s.id);
    const antes = JSON.stringify(turno);
    const r = await abrir(s.id, { targetType: "TURN", targetId: turno.id });
    check("o painel abre", r.status === 200, JSON.stringify(r.json));
    check("nasce no nível 1", r.json.request.level === 1);
    check("nasce sem comando algum", r.json.request.provisionalCommand === null && r.json.request.confirmedCommand === null);

    const turnos = (await claudia.get(`${RTQ}/turns?patientId=${pFabio}&sessionId=${s.id}`)).json.turns;
    check("o turno em curso continua idêntico", JSON.stringify(turnos.find((t) => t.id === turno.id)) === antes);
    check("a sessão continua ativa", (await sessao(s.id)).session.status === "ACTIVE");
    check("abrir de novo devolve o MESMO painel", (await abrir(s.id)).json.request.id === r.json.request.id);
  }

  console.log("\n24 Dois níveis, três gestos:");
  {
    const s = await novaSessao();
    const turno = await turnoAguardando(s.id);
    const req = (await abrir(s.id, { targetType: "TURN", targetId: turno.id })).json.request;

    const apr = await acao(s.id, req.id, { kind: "PRESENT" });
    check("apresenta os comandos", apr.json.request.status === "PRESENTED");
    check("no modo de SELEÇÃO — nunca SIM/TALVEZ/NÃO", apr.json.request.interactionMode === "OPTION_SELECTION");

    await acao(s.id, req.id, { kind: "AWAIT_SELECTION" });
    const sel = await acao(s.id, req.id, { kind: "SELECT_COMMAND", command: "MORE_CONTROLS" });
    check("a seleção é PROVISÓRIA", sel.json.request.status === "PROVISIONAL_SELECTION");
    check("e não executa nada sozinha", sel.json.request.confirmedCommand === null);

    const doNivel2 = await acao(s.id, req.id, { kind: "SELECT_COMMAND", command: "ENCERRAR_INVALIDO" });
    check("comando inválido é recusado", doNivel2.status === 400);
    const foraDoNivel = await acao(s.id, req.id, { kind: "CHANGE_COMMAND", command: "CHANGE_SUBJECT" });
    check("comando de outro nível é recusado", foraDoNivel.status === 400, JSON.stringify(foraDoNivel.json));

    await acao(s.id, req.id, { kind: "CONFIRM_COMMAND" });
    const n2 = await acao(s.id, req.id, { kind: "PRESENT" });
    check("MAIS CONTROLES leva ao nível 2", n2.json.request.level === 2);
    check("e zera a seleção anterior", n2.json.request.provisionalCommand === null && n2.json.request.confirmedCommand === null);
  }

  console.log("\n25 PAUSAR:");
  {
    const s = await novaSessao();
    const turno = await turnoAguardando(s.id);
    const req = (await abrir(s.id, { targetType: "TURN", targetId: turno.id })).json.request;
    await ateConfirmar(s.id, req.id, "PAUSE");
    const ex = await acao(s.id, req.id, { kind: "EXECUTE" });
    check("o comando é executado", ex.json.request.status === "EXECUTED", JSON.stringify(ex.json));
    check("a sessão fica pausada", (await sessao(s.id)).session.status === "PAUSED");

    const turnos = (await claudia.get(`${RTQ}/turns?patientId=${pFabio}&sessionId=${s.id}`)).json.turns;
    const t = turnos.find((x) => x.id === turno.id);
    check("o turno NÃO é concluído", t.status === "AWAITING_RESPONSE");
    check("nada provisório virou confirmado", t.confirmedResponse === null);

    const tipos = (await eventos(s.id)).map((e) => e.eventType);
    check("registra que a sessão pausou", tipos.includes("SESSION_PAUSED"));
    check("e que QUEM pediu foi o paciente", tipos.includes("PATIENT_REQUESTED_PAUSE"));
  }

  console.log("\n26 REPETIR:");
  {
    const s = await novaSessao();
    const turno = await turnoAguardando(s.id);
    const req = (await abrir(s.id, { targetType: "TURN", targetId: turno.id })).json.request;
    await ateConfirmar(s.id, req.id, "REPEAT");
    const ex = await acao(s.id, req.id, { kind: "EXECUTE" });
    check("o comando é executado", ex.json.request.status === "EXECUTED", JSON.stringify(ex.json));
    check("continua o MESMO turno", ex.json.turn?.id === turno.id);
    check("o texto apresentado não muda", ex.json.turn?.presentedText === turno.presentedText);
    check("incrementa o contador de reapresentação", ex.json.turn?.representCount === turno.representCount + 1);
    check("volta a aguardar resposta", ex.json.turn?.status === "AWAITING_RESPONSE");
    check("não cria pergunta nova", (await claudia.get(`${RTQ}/turns?patientId=${pFabio}&sessionId=${s.id}`)).json.turns.length === 1);
    const tipos = (await eventos(s.id)).map((e) => e.eventType);
    check("registra o pedido de repetição do paciente", tipos.includes("PATIENT_REQUESTED_REPEAT"));
  }

  console.log("\n27 NÃO ENTENDI:");
  {
    const s = await novaSessao();
    const turno = await turnoAguardando(s.id);
    const antes = JSON.stringify(turno);
    const req = (await abrir(s.id, { targetType: "TURN", targetId: turno.id })).json.request;
    await ateConfirmar(s.id, req.id, "NOT_UNDERSTOOD", true);
    const ex = await acao(s.id, req.id, { kind: "EXECUTE" });
    check("o comando é executado", ex.json.request.status === "EXECUTED", JSON.stringify(ex.json));
    check("registra o horário da não compreensão", !!ex.json.request.notUnderstoodAt);

    const t = (await claudia.get(`${RTQ}/turns?patientId=${pFabio}&sessionId=${s.id}`)).json.turns.find((x) => x.id === turno.id);
    check("NÃO altera o turno em nada", JSON.stringify(t) === antes);
    check("NÃO vira resposta NÃO", t.provisionalResponse === null && t.confirmedResponse === null);
    check("NÃO rejeita o conteúdo", t.status === "AWAITING_RESPONSE");
    const tipos = (await eventos(s.id)).map((e) => e.eventType);
    check("registra que o paciente não compreendeu", tipos.includes("PATIENT_REPORTED_NOT_UNDERSTOOD"));
    check("e NÃO registra resposta alguma", !tipos.includes("RESPONSE_SELECTED"));
  }

  console.log("\n28 MUDAR DE ASSUNTO:");
  {
    const s = await novaSessao();
    // Um turno confirmado ANTES: ele precisa sobreviver.
    const t1 = await turnoAguardando(s.id, "O senhor dormiu bem?");
    const act1 = (action) => claudia.patch(`${RTQ}/turns`, { patientId: pFabio, sessionId: s.id, turnId: t1.id, action });
    await act1({ kind: "SELECT_RESPONSE", response: "YES" });
    await act1({ kind: "VERIFY_RESPONSE" });
    const t2 = await turnoAguardando(s.id, "O senhor quer água?");
    await claudia.patch(`${RTQ}/turns`, { patientId: pFabio, sessionId: s.id, turnId: t2.id, action: { kind: "SELECT_RESPONSE", response: "MAYBE" } });

    const req = (await abrir(s.id, { targetType: "TURN", targetId: t2.id })).json.request;
    await ateConfirmar(s.id, req.id, "CHANGE_SUBJECT", true);
    const ex = await acao(s.id, req.id, { kind: "EXECUTE" });
    check("o comando é executado", ex.json.request.status === "EXECUTED", JSON.stringify(ex.json));
    check("registra o horário da mudança", !!ex.json.request.subjectChangedAt);

    const turnos = (await claudia.get(`${RTQ}/turns?patientId=${pFabio}&sessionId=${s.id}`)).json.turns;
    const antigo = turnos.find((x) => x.id === t1.id);
    const atual = turnos.find((x) => x.id === t2.id);
    check("a resposta JÁ CONFIRMADA é preservada", antigo.status === "CONFIRMED" && antigo.confirmedResponse === "YES");
    check("o turno em curso é interrompido, não apagado", atual.status === "CANCELED");
    check("a seleção provisória é descartada", atual.provisionalResponse === null);
    check("nenhum registro some", turnos.length === 2);
    check("a sessão NÃO é concluída", (await sessao(s.id)).session.status === "ACTIVE");
    const tipos = (await eventos(s.id)).map((e) => e.eventType);
    check("registra o pedido de mudar de assunto", tipos.includes("PATIENT_REQUESTED_SUBJECT_CHANGE"));
  }

  console.log("\n29 ENCERRAR exige a confirmação final:");
  {
    const s = await novaSessao();
    const turno = await turnoAguardando(s.id);
    const req = (await abrir(s.id, { targetType: "TURN", targetId: turno.id })).json.request;
    const conf = await ateConfirmar(s.id, req.id, "END_CONVERSATION", true);
    check("o comando fica confirmado", conf.json.request.confirmedCommand === "END_CONVERSATION");

    const direto = await acao(s.id, req.id, { kind: "EXECUTE" });
    check("a seleção sozinha NÃO encerra", direto.status === 400, JSON.stringify(direto.json));
    check("a sessão continua ativa", (await sessao(s.id)).session.status === "ACTIVE");

    const pergunta = await acao(s.id, req.id, { kind: "ASK_END_CONFIRMATION" });
    check("a confirmação final é apresentada", pergunta.json.request.status === "END_CONFIRMATION_PENDING", JSON.stringify(pergunta.json));
    check("e ali os sinais voltam a ser SIM/TALVEZ/NÃO", pergunta.json.request.interactionMode === "CLOSED_CONFIRMATION");
    check("ainda sem resposta", pergunta.json.request.endResponse === null);

    const semResposta = await acao(s.id, req.id, { kind: "EXECUTE" });
    check("executar sem responder é recusado", semResposta.status === 400);
  }

  console.log("\n29b A resposta final: SIM, TALVEZ e NÃO:");
  {
    // SIM encerra o pedido; TALVEZ volta aos controles; NÃO cancela.
    for (const resposta of ["YES", "MAYBE", "NO"]) {
      const s = await novaSessao();
      const turno = await turnoAguardando(s.id);
      const req = (await abrir(s.id, { targetType: "TURN", targetId: turno.id })).json.request;
      await ateConfirmar(s.id, req.id, "END_CONVERSATION", true);
      await acao(s.id, req.id, { kind: "ASK_END_CONFIRMATION" });
      const r = await acao(s.id, req.id, { kind: "RESPOND_END", response: resposta });

      if (resposta === "YES") {
        check("SIM mantém o pedido pronto para executar", r.json.request.endResponse === "YES", JSON.stringify(r.json));
        const ex = await acao(s.id, req.id, { kind: "EXECUTE" });
        check("e só então o encerramento é executado", ex.json.request.status === "EXECUTED", JSON.stringify(ex.json));
        check("a sessão NÃO é concluída pelo comando — quem conclui é o cuidador", (await sessao(s.id)).session.status === "ACTIVE");
        check("registra o pedido de encerrar do paciente", (await eventos(s.id)).some((e) => e.eventType === "PATIENT_REQUESTED_SESSION_END"));
      } else if (resposta === "MAYBE") {
        check("TALVEZ volta aos controles, no nível 1", r.json.request.status === "PRESENTED" && r.json.request.level === 1, JSON.stringify(r.json));
        check("e limpa o comando de encerrar", r.json.request.confirmedCommand === null);
        check("a sessão continua ativa", (await sessao(s.id)).session.status === "ACTIVE");
      } else {
        check("NÃO cancela o pedido", r.json.request.status === "CANCELED", JSON.stringify(r.json));
        check("a conversa continua e o painel some", (await painel(s.id)) === null);
        check("a sessão continua ativa", (await sessao(s.id)).session.status === "ACTIVE");
      }
    }
  }

  console.log("\n30 Voltar para a conversa:");
  {
    const s = await novaSessao();
    const turno = await turnoAguardando(s.id);
    const antes = JSON.stringify(turno);
    const req = (await abrir(s.id, { targetType: "TURN", targetId: turno.id })).json.request;
    await acao(s.id, req.id, { kind: "PRESENT" });
    await acao(s.id, req.id, { kind: "AWAIT_SELECTION" });
    await acao(s.id, req.id, { kind: "SELECT_COMMAND", command: "PAUSE" });

    const fechado = await acao(s.id, req.id, { kind: "CLOSE" });
    check("o painel fecha", fechado.json.request.status === "CLOSED", JSON.stringify(fechado.json));
    check("a seleção provisória some com ele", fechado.json.request.provisionalCommand === null);
    const t = (await claudia.get(`${RTQ}/turns?patientId=${pFabio}&sessionId=${s.id}`)).json.turns.find((x) => x.id === turno.id);
    check("a interação em curso fica intacta", JSON.stringify(t) === antes);
    check("a sessão continua ativa", (await sessao(s.id)).session.status === "ACTIVE");

    const evs = await eventos(s.id);
    check("registra o fechamento como operacional", evs.some((e) => e.eventType === "PATIENT_CONTROLS_CLOSED"));
    check("e NUNCA como resposta do paciente", !evs.some((e) => e.eventType === "RESPONSE_SELECTED" || e.eventType === "PATIENT_CONTROL_EXECUTED"));
    check("depois de fechado, abrir cria um pedido novo", (await abrir(s.id)).json.request.id !== req.id);
  }

  console.log("\n34 Duplicação, pausa, sessão encerrada e isolamento:");
  {
    const s = await novaSessao();
    const a = await claudia.post(CTRL, { patientId: pFabio, sessionId: s.id, clientRequestId: "dup" });
    const b = await claudia.post(CTRL, { patientId: pFabio, sessionId: s.id, clientRequestId: "dup" });
    check("o mesmo pedido não abre dois painéis", a.json.request.id === b.json.request.id);

    const s2 = await novaSessao();
    const turno = await turnoAguardando(s2.id);
    const req = (await abrir(s2.id, { targetType: "TURN", targetId: turno.id })).json.request;
    await claudia.patch(`${RTQ}/sessions`, { patientId: pFabio, sessionId: s2.id, action: "PAUSE" });
    const pausado = await acao(s2.id, req.id, { kind: "PRESENT" });
    check("sessão pausada recusa apresentar comandos", pausado.status === 400, JSON.stringify(pausado.json));
    const fecha = await acao(s2.id, req.id, { kind: "CLOSE" });
    check("mas fechar o painel continua permitido", fecha.status === 200, JSON.stringify(fecha.json));

    await claudia.patch(`${RTQ}/sessions`, { patientId: pFabio, sessionId: s2.id, action: "RESUME" });
    await claudia.patch(`${RTQ}/sessions`, { patientId: pFabio, sessionId: s2.id, action: "COMPLETE" });
    const encerrada = await abrir(s2.id);
    check("sessão concluída recusa abrir os controles", encerrada.status === 400, JSON.stringify(encerrada.json));

    const alheio = await abrir(s.id, {}, marcos, pRoberto);
    check("outro paciente não abre controles nesta sessão", alheio.status === 400, JSON.stringify(alheio.json));
    const semVinculo = await marcos.get(`${CTRL}?patientId=${pFabio}&sessionId=${s.id}`);
    check("sem vínculo com o paciente recebe 403", semVinculo.status === 403);
  }

  console.log("\n32 Auditoria completa:");
  {
    const s = await novaSessao();
    const turno = await turnoAguardando(s.id);
    const req = (await abrir(s.id, { targetType: "TURN", targetId: turno.id })).json.request;
    await ateConfirmar(s.id, req.id, "REPEAT");
    await acao(s.id, req.id, { kind: "EXECUTE" });
    const tipos = (await eventos(s.id)).map((e) => e.eventType);
    for (const t of [
      "PATIENT_CONTROLS_OPENED",
      "PATIENT_CONTROL_PRESENTED",
      "PATIENT_CONTROL_SELECTED",
      "PATIENT_CONTROL_CONFIRMED",
      "PATIENT_CONTROL_EXECUTED",
      "PATIENT_REQUESTED_REPEAT",
    ]) {
      check(`a trilha registra ${t}`, tipos.includes(t));
    }
  }

  console.log(`\n${passed} passaram · ${failed} falharam\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
