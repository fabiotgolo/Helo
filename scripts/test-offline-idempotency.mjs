// ——— Ledger de idempotência do servidor (Fase 4.9.3, §3.4a) ———
//
// Prova, contra o servidor de verdade, que reenviar a MESMA intenção
// (mesma `clientRequestId`) não duplica nada — que é a garantia sem a qual
// uma fila offline não pode existir: toda operação enfileirada pode, em
// princípio, ser reenviada mais de uma vez (perda de resposta, retry).
//
// Fecha G1 (reuseNode/reuseStatement/reusePath duplicavam CONTENT_REUSED) e
// G2 (transições de estado sem proteção — o caso que CORROMPE é
// REMOVE_RESPONSE sobre frase, que incrementava correctionCount a cada
// reenvio).
//
//   npm run emu                              (terminal 1)
//   npm run dev                              (terminal 2)
//   npm run test:offline:idempotency         (terminal 3)

import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";
// Guarda: esta suíte apaga o banco inteiro. Ver scripts/emulator-guard.mjs.
assertEmuladorDescartavel(EMU, DB, "test-offline-idempotency.mjs");

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
  };
}

const rid = (prefixo) =>
  `${prefixo}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Id no MESMO formato que lib/offline/ids.ts gera no cliente. */
function entityId(prefixo) {
  const alfabeto = "0123456789abcdefghijklmnopqrstuvwxyz";
  let sufixo = "";
  for (let i = 0; i < 12; i++) {
    sufixo += alfabeto[Math.floor(Math.random() * 36)];
  }
  return `${prefixo}${Date.now().toString(36)}${sufixo}`;
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
  const rClaudia = await admin.post("/api/admin/users", {
    name: "Claudia",
    email: "claudia@helo.test",
    password: "senha-teste-123",
    role: "profissional",
    professionalType: "fonoaudiologo",
  });
  check("cria Claudia", rClaudia.status === 200);
  check(
    "Claudia faz login",
    (
      await claudia.post("/api/auth/login", {
        email: "claudia@helo.test",
        password: "senha-teste-123",
      })
    ).status === 200
  );
  const pFabio = (await admin.post("/api/patients", { name: "Dr. Fábio" })).json
    .patient.id;
  check(
    "vínculo Claudia ↔ paciente",
    (
      await admin.post("/api/admin/access", {
        userId: rClaudia.json.user.id,
        patientId: pFabio,
        permissions: ["viewSessions", "createSession"],
      })
    ).status === 200
  );

  const RTQ = "/api/realtime-questions";
  const novaSessao = async () =>
    (await claudia.post(`${RTQ}/sessions`, { patientId: pFabio })).json.session;
  const eventos = async (sessionId, extra = "") =>
    (
      await claudia.get(
        `${RTQ}/events?patientId=${pFabio}&sessionId=${sessionId}${extra}`
      )
    ).json.events;

  // ════ 1. createTurn — replay devolve o MESMO turno, sem duplicar ════
  console.log("\n1. createTurn — replay não cria um segundo turno:");
  {
    const s = await novaSessao();
    const crid = rid("turn");
    const r1 = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "O senhor está com dor?",
      clientRequestId: crid,
    });
    const r2 = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "O senhor está com dor?",
      clientRequestId: crid,
    });
    check("primeiro envio cria", r1.status === 200);
    check(
      "reenvio devolve o MESMO id",
      r2.status === 200 && r2.json.turn.id === r1.json.turn.id,
      JSON.stringify({ r1: r1.json, r2: r2.json })
    );
    const ev = await eventos(s.id);
    check(
      "só um QUESTION_CREATED na trilha",
      ev.filter((e) => e.eventType === "QUESTION_CREATED").length === 1,
      JSON.stringify(ev.map((e) => e.eventType))
    );
    check(
      "sem a chave, dois envios criam DOIS turnos (comportamento anterior preservado)",
      (
        await (async () => {
          const a = await claudia.post(`${RTQ}/turns`, {
            patientId: pFabio,
            sessionId: s.id,
            text: "Outra pergunta",
          });
          const b = await claudia.post(`${RTQ}/turns`, {
            patientId: pFabio,
            sessionId: s.id,
            text: "Outra pergunta",
          });
          return a.json.turn.id !== b.json.turn.id;
        })()
      )
    );
  }

  // ════ 2. runTurnAction — replay não repete a transição nem duplica evento ════
  console.log("\n2. runTurnAction — replay devolve o mesmo estado, sem novo evento:");
  {
    const s = await novaSessao();
    const t = (
      await claudia.post(`${RTQ}/turns`, {
        patientId: pFabio,
        sessionId: s.id,
        text: "O senhor quer água?",
      })
    ).json.turn;
    const crid = rid("review");
    const r1 = await claudia.patch(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      turnId: t.id,
      action: { kind: "REVIEW", reviewedText: "O senhor quer água agora?" },
      clientRequestId: crid,
    });
    const r2 = await claudia.patch(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      turnId: t.id,
      action: { kind: "REVIEW", reviewedText: "O senhor quer água agora?" },
      clientRequestId: crid,
    });
    check("primeira REVIEW aplica", r1.status === 200);
    check(
      "reenvio devolve 200 (não um erro de domínio)",
      r2.status === 200,
      JSON.stringify(r2.json)
    );
    const ev = await eventos(s.id, `&turnId=${t.id}`);
    check(
      "só um evento de revisão na trilha",
      ev.filter((e) => e.eventType === "QUESTION_REVIEWED").length === 1,
      JSON.stringify(ev.map((e) => e.eventType))
    );
  }

  // ════ 3. G1 — reuseNode não duplica CONTENT_REUSED ════
  console.log("\n3. reuseNode — G1: replay não duplica o evento de reutilização:");
  {
    const s = await novaSessao();
    const path = (
      await claudia.post(`${RTQ}/paths`, { patientId: pFabio, sessionId: s.id })
    ).json.path;
    const origem = (
      await claudia.post(`${RTQ}/nodes`, {
        patientId: pFabio,
        sessionId: s.id,
        pathId: path.id,
        promptText: "Onde dói?",
        options: [{ label: "Cabeça" }, { label: "Barriga" }],
      })
    ).json.node;

    const crid = rid("reuse");
    const r1 = await claudia.post(`${RTQ}/nodes`, {
      patientId: pFabio,
      sessionId: s.id,
      reuseFromNodeId: origem.id,
      clientRequestId: crid,
    });
    const r2 = await claudia.post(`${RTQ}/nodes`, {
      patientId: pFabio,
      sessionId: s.id,
      reuseFromNodeId: origem.id,
      clientRequestId: crid,
    });
    check("primeira reutilização cria", r1.status === 200, JSON.stringify(r1.json));
    check(
      "reenvio devolve o MESMO nível",
      r2.status === 200 && r2.json.node.id === r1.json.node.id,
      JSON.stringify({ r1: r1.json, r2: r2.json })
    );
    const ev = await eventos(s.id, `&nodeId=${r1.json.node.id}`);
    check(
      "só UM evento CONTENT_REUSED — antes desta correção, seriam dois",
      ev.filter((e) => e.eventType === "CONTENT_REUSED").length === 1,
      JSON.stringify(ev.map((e) => e.eventType))
    );
  }

  // ════ 4. G2 — REMOVE_RESPONSE sobre frase: o caso que CORROMPE ════
  console.log(
    "\n4. runStatementAction REMOVE_RESPONSE — G2: replay não incrementa correctionCount duas vezes:"
  );
  {
    const s = await novaSessao();
    const path = (
      await claudia.post(`${RTQ}/paths`, { patientId: pFabio, sessionId: s.id })
    ).json.path;
    const frase = (
      await claudia.post(`${RTQ}/statements`, {
        patientId: pFabio,
        sessionId: s.id,
        pathId: path.id,
        text: "Estou com fome.",
      })
    ).json.statement;
    // DRAFT → REVIEWED antes de PRESENT (mesmo caminho de scripts/test-option-conversation-branches.mjs).
    await claudia.patch(`${RTQ}/statements`, {
      patientId: pFabio,
      sessionId: s.id,
      pathId: path.id,
      statementId: frase.id,
      action: { kind: "EDIT", text: "Estou com fome." },
    });
    await claudia.patch(`${RTQ}/statements`, {
      patientId: pFabio,
      sessionId: s.id,
      pathId: path.id,
      statementId: frase.id,
      action: { kind: "PRESENT" },
    });
    await claudia.patch(`${RTQ}/statements`, {
      patientId: pFabio,
      sessionId: s.id,
      pathId: path.id,
      statementId: frase.id,
      action: { kind: "RESPOND", response: "MAYBE" },
    });
    // Agora em PROVISIONAL_RESPONSE — o estado onde REMOVE_RESPONSE é um
    // self-loop que, sem o ledger, incrementava correctionCount a cada
    // reenvio.
    const crid = rid("remove-resp");
    const r1 = await claudia.patch(`${RTQ}/statements`, {
      patientId: pFabio,
      sessionId: s.id,
      pathId: path.id,
      statementId: frase.id,
      action: { kind: "REMOVE_RESPONSE" },
      clientRequestId: crid,
    });
    check(
      "primeiro REMOVE_RESPONSE aplica, correctionCount = 1",
      r1.status === 200 && r1.json.statement.correctionCount === 1,
      JSON.stringify(r1.json)
    );
    const r2 = await claudia.patch(`${RTQ}/statements`, {
      patientId: pFabio,
      sessionId: s.id,
      pathId: path.id,
      statementId: frase.id,
      action: { kind: "REMOVE_RESPONSE" },
      clientRequestId: crid,
    });
    check(
      "reenvio devolve correctionCount = 1 — NÃO 2",
      r2.status === 200 && r2.json.statement.correctionCount === 1,
      JSON.stringify(r2.json)
    );

    // Controle negativo: SEM a chave, o replay corrompe como antes — prova
    // que a proteção é do LEDGER, não de a máquina ter passado a recusar a
    // transição.
    const semChave1 = await claudia.patch(`${RTQ}/statements`, {
      patientId: pFabio,
      sessionId: s.id,
      pathId: path.id,
      statementId: frase.id,
      action: { kind: "REMOVE_RESPONSE" },
    });
    const semChave2 = await claudia.patch(`${RTQ}/statements`, {
      patientId: pFabio,
      sessionId: s.id,
      pathId: path.id,
      statementId: frase.id,
      action: { kind: "REMOVE_RESPONSE" },
    });
    check(
      "controle: sem clientRequestId, correctionCount SOBE a cada chamada (2, depois 3)",
      semChave1.json.statement.correctionCount === 2 &&
        semChave2.json.statement.correctionCount === 3,
      JSON.stringify({ a: semChave1.json, b: semChave2.json })
    );
  }

  // ════ 5. reviewNode — replay não duplica o evento de edição ════
  console.log("\n5. reviewNode — replay não duplica o evento:");
  {
    const s = await novaSessao();
    const path = (
      await claudia.post(`${RTQ}/paths`, { patientId: pFabio, sessionId: s.id })
    ).json.path;
    const node = (
      await claudia.post(`${RTQ}/nodes`, {
        patientId: pFabio,
        sessionId: s.id,
        pathId: path.id,
        promptText: "Quer água?",
        options: [{ label: "Sim" }, { label: "Não" }],
      })
    ).json.node;
    const crid = rid("reviewnode");
    const acao = {
      kind: "REVIEW",
      promptText: "Quer água gelada?",
      clientRequestId: crid,
    };
    const r1 = await claudia.patch(`${RTQ}/nodes`, {
      patientId: pFabio,
      sessionId: s.id,
      pathId: path.id,
      nodeId: node.id,
      action: acao,
      clientRequestId: crid,
    });
    const r2 = await claudia.patch(`${RTQ}/nodes`, {
      patientId: pFabio,
      sessionId: s.id,
      pathId: path.id,
      nodeId: node.id,
      action: acao,
      clientRequestId: crid,
    });
    check("primeira REVIEW aplica", r1.status === 200, JSON.stringify(r1.json));
    check("reenvio devolve 200", r2.status === 200, JSON.stringify(r2.json));
    const ev = await eventos(s.id, `&nodeId=${node.id}`);
    check(
      "só um evento de edição na trilha",
      ev.filter((e) => e.eventType === "OPTION_LEVEL_REVIEWED").length === 1,
      JSON.stringify(ev.map((e) => e.eventType))
    );
  }

  // ════ 6. Isolamento — a mesma clientRequestId em sessões diferentes NÃO colide ════
  console.log("\n6. isolamento entre sessões — mesma chave, sessões diferentes:");
  {
    const s1 = await novaSessao();
    const s2 = await novaSessao();
    const crid = rid("cross-session");
    const r1 = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s1.id,
      text: "Pergunta da sessão 1",
      clientRequestId: crid,
    });
    const r2 = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s2.id,
      text: "Pergunta da sessão 2",
      clientRequestId: crid,
    });
    check(
      "mesma clientRequestId em sessões diferentes cria DOIS turnos distintos",
      r1.status === 200 &&
        r2.status === 200 &&
        r1.json.turn.id !== r2.json.turn.id &&
        r2.json.turn.reviewedText === "Pergunta da sessão 2",
      JSON.stringify({ r1: r1.json, r2: r2.json })
    );
  }

  // ════ 7. Id proposto pelo cliente (Fase B, revisão do §3.3) ════
  //
  // O cliente PROPÕE a identidade do registro; o servidor decide tudo o
  // resto (autenticação, autorização, estado, versão, horário). Isto
  // substitui o design original de handles locais — decisão registrada em
  // lib/realtime-question-store.ts, acima de `resolveEntityId`.
  console.log("\n7. id proposto pelo cliente:");
  {
    const s = await novaSessao();

    // 7a. Id proposto é aceito e usado como identidade definitiva.
    const idProposto = entityId("cqt");
    const r = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "Pergunta com id proposto",
      turnId: idProposto,
    });
    check(
      "7a. id proposto pelo cliente é usado como identidade definitiva",
      r.status === 200 && r.json.turn.id === idProposto,
      JSON.stringify(r.json)
    );

    // 7b. Retry com o MESMO id e a MESMA clientRequestId: sem duplicação.
    const crid2 = rid("retry-id");
    const idProposto2 = entityId("cqt");
    const r1 = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "Pergunta com retry",
      turnId: idProposto2,
      clientRequestId: crid2,
    });
    const r2 = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "Pergunta com retry",
      turnId: idProposto2,
      clientRequestId: crid2,
    });
    check(
      "7b. retry com mesmo id e mesma clientRequestId devolve o MESMO turno, sem duplicar",
      r1.status === 200 &&
        r2.status === 200 &&
        r1.json.turn.id === idProposto2 &&
        r2.json.turn.id === idProposto2,
      JSON.stringify({ r1: r1.json, r2: r2.json })
    );
    const evR = await eventos(s.id, `&turnId=${idProposto2}`);
    check(
      "7b. só um QUESTION_CREATED para esse turno",
      evR.filter((e) => e.eventType === "QUESTION_CREATED").length === 1,
      JSON.stringify(evR.map((e) => e.eventType))
    );

    // 7c. MESMA clientRequestId, payload DIFERENTE: conflito explícito, 409.
    const crid3 = rid("mismatch");
    await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "Primeira intenção",
      turnId: entityId("cqt"),
      clientRequestId: crid3,
    });
    const conflito = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "Segunda intenção — outro texto",
      turnId: entityId("cqt"),
      clientRequestId: crid3,
    });
    check(
      "7c. mesma clientRequestId com payload diferente devolve 409, não sobrescreve",
      conflito.status === 409,
      JSON.stringify(conflito.json)
    );

    // 7d. Colisão de id: outro turno já usa aquele id (sem clientRequestId
    // repetida — é uma colisão de verdade, não um replay).
    const idColidido = entityId("cqt");
    await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "Dono original do id",
      turnId: idColidido,
    });
    const colisao = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "Tentando reutilizar o id de outro",
      turnId: idColidido,
    });
    check(
      "7d. colisão de id com outro registro é recusada, não sobrescreve",
      colisao.status === 400 &&
        /pertence a outro registro/.test(colisao.json.error),
      JSON.stringify(colisao.json)
    );

    // 7e. Formato/prefixo inválido: recusado antes de qualquer gravação.
    const formatoRuim = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "Não deveria ir a lugar nenhum",
      turnId: "ocp-isto-e-um-caminho-nao-um-turno",
    });
    check(
      "7e. prefixo errado (id de outro tipo de recurso) é recusado",
      formatoRuim.status === 400,
      JSON.stringify(formatoRuim.json)
    );
    const curtoDemais = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "Também não deveria ir",
      turnId: "cqt1",
    });
    check(
      "7e. id curto demais é recusado",
      curtoDemais.status === 400,
      JSON.stringify(curtoDemais.json)
    );
    const comBarra = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "Não pode quebrar o caminho da coleção",
      turnId: "cqt../../outra-colecao",
    });
    check(
      "7e. id com caracteres fora do alfabeto é recusado",
      comBarra.status === 400,
      JSON.stringify(comBarra.json)
    );

    // 7f. O mesmo id, em SESSÕES diferentes, não colide — coleções distintas.
    const s2 = await novaSessao();
    const idCompartilhavel = entityId("cqt");
    const emS1 = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s.id,
      text: "Turno da primeira sessão",
      turnId: idCompartilhavel,
    });
    const emS2 = await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s2.id,
      text: "Turno da segunda sessão",
      turnId: idCompartilhavel,
    });
    check(
      "7f. o mesmo id em sessões diferentes não colide (coleções distintas)",
      emS1.status === 200 && emS2.status === 200,
      JSON.stringify({ emS1: emS1.json, emS2: emS2.json })
    );

    // 7g. Referências entre recursos criados offline: path→node→statement
    // com todos os ids propostos pelo cliente continuam válidas sem
    // remapeamento — é o ponto central da decisão de não usar handles.
    const pathIdProposto = entityId("ocp");
    const path = (
      await claudia.post(`${RTQ}/paths`, {
        patientId: pFabio,
        sessionId: s.id,
        pathId: pathIdProposto,
      })
    ).json.path;
    const nodeIdProposto = entityId("ocn");
    const node = (
      await claudia.post(`${RTQ}/nodes`, {
        patientId: pFabio,
        sessionId: s.id,
        pathId: path.id,
        nodeId: nodeIdProposto,
        promptText: "Dói onde?",
        options: [{ label: "Cabeça" }, { label: "Barriga" }],
      })
    ).json.node;
    check(
      "7g. path e node criados com ids propostos, e o node referencia o path certo",
      path.id === pathIdProposto &&
        node.id === nodeIdProposto &&
        node.pathId === path.id,
      JSON.stringify({ path, node })
    );
    // A ação sobre o node usa o id proposto diretamente — sem tradução.
    // DRAFT → REVIEWED → PRESENTED → AWAITING_SELECTION antes de
    // SELECT_OPTION ser aceita.
    await claudia.patch(`${RTQ}/nodes`, {
      patientId: pFabio,
      sessionId: s.id,
      pathId: path.id,
      nodeId: node.id,
      action: { kind: "REVIEW", promptText: node.promptText },
    });
    await claudia.patch(`${RTQ}/nodes`, {
      patientId: pFabio,
      sessionId: s.id,
      pathId: path.id,
      nodeId: node.id,
      action: { kind: "PRESENT" },
    });
    await claudia.patch(`${RTQ}/nodes`, {
      patientId: pFabio,
      sessionId: s.id,
      pathId: path.id,
      nodeId: node.id,
      action: { kind: "AWAIT_SELECTION" },
    });
    const acaoNode = await claudia.patch(`${RTQ}/nodes`, {
      patientId: pFabio,
      sessionId: s.id,
      pathId: path.id,
      nodeId: node.id,
      action: { kind: "SELECT_OPTION", optionId: node.options[0].id },
    });
    check(
      "7g. ação sobre o node criado offline funciona pelo id proposto, direto",
      acaoNode.status === 200 &&
        acaoNode.json.node.provisionalOptionId === node.options[0].id,
      JSON.stringify(acaoNode.json)
    );

    // 7h. Isolamento: paciente diferente não alcança o id proposto de outro.
    const outroPacienteId = (
      await admin.post("/api/patients", { name: "Sr. Roberto" })
    ).json.patient.id;
    const rMarcos = await admin.post("/api/admin/users", {
      name: "Marcos",
      email: "marcos@helo.test",
      password: "senha-teste-123",
      role: "profissional",
      professionalType: "terapeuta",
    });
    const marcos = client();
    await marcos.post("/api/auth/login", {
      email: "marcos@helo.test",
      password: "senha-teste-123",
    });
    await admin.post("/api/admin/access", {
      userId: rMarcos.json.user.id,
      patientId: outroPacienteId,
      permissions: ["viewSessions", "createSession"],
    });
    const sMarcos = (
      await marcos.post(`${RTQ}/sessions`, { patientId: outroPacienteId })
    ).json.session;
    const tentativaCruzada = await marcos.post(`${RTQ}/turns`, {
      patientId: outroPacienteId,
      sessionId: sMarcos.id,
      text: "Marcos tentando um id que Claudia já usou",
      turnId: idProposto, // o id de 7a, criado na sessão da Claudia
    });
    check(
      "7h. o mesmo id em sessão de OUTRO paciente/usuário não colide (coleção distinta)",
      tentativaCruzada.status === 200 && tentativaCruzada.json.turn.id === idProposto,
      JSON.stringify(tentativaCruzada.json)
    );
    // E o turno original da Claudia continua intacto e dela.
    const original = await claudia.get(
      `${RTQ}/turns?patientId=${pFabio}&sessionId=${s.id}`
    );
    check(
      "7h. o turno original da Claudia não foi alterado pela tentativa de Marcos",
      original.json.turns.some(
        (t) => t.id === idProposto && t.reviewedText === "Pergunta com id proposto"
      ),
      JSON.stringify(original.json.turns.find((t) => t.id === idProposto))
    );
  }

  console.log(`\n${passed} passou, ${failed} falhou.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
