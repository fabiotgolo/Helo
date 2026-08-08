// ——— Conversa por opções: histórico e reutilização (§36) ———
// Cobre os casos 22, 23, 24 e 25 da especificação.
//
// A regra verificada aqui: reutilizar cria SEMPRE um registro novo em
// rascunho, vinculado ao original — que permanece intacto. Nenhuma resposta e
// nenhuma confirmação são copiadas, e abrir um item do histórico não altera
// nada.
//
//   npm run test:oc:history

import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";
// Guarda: esta suíte apaga o banco inteiro. Ver scripts/emulator-guard.mjs.
assertEmuladorDescartavel(EMU, DB, "test-option-conversation-history.mjs");

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
    name: "Admin",
    email: "admin@helo.test",
    password: "senha-admin-123",
  });
  const criar = async (c, name, email) => {
    const r = await admin.post("/api/admin/users", {
      name,
      email,
      password: "senha-teste-123",
      role: "profissional",
      professionalType: "fonoaudiologo",
    });
    await c.post("/api/auth/login", { email, password: "senha-teste-123" });
    return r.json.user;
  };
  const uClaudia = await criar(claudia, "Claudia", "claudia@helo.test");
  const uMarcos = await criar(marcos, "Marcos", "marcos@helo.test");
  const pFabio = (await admin.post("/api/patients", { name: "Dr. Fábio" })).json
    .patient.id;
  await new Promise((r) => setTimeout(r, 5));
  const pRoberto = (await admin.post("/api/patients", { name: "Sr. Roberto" }))
    .json.patient.id;
  const FULL = [
    "viewDashboard",
    "viewSessions",
    "viewMetrics",
    "createSession",
    "editGestures",
  ];
  await admin.post("/api/admin/access", {
    userId: uClaudia.id,
    patientId: pFabio,
    permissions: FULL,
  });
  await admin.post("/api/admin/access", {
    userId: uMarcos.id,
    patientId: pRoberto,
    permissions: FULL,
  });
  console.log("Preparação concluída.\n");

  const RTQ = "/api/realtime-questions";
  const novaSessao = async () =>
    (await claudia.post(`${RTQ}/sessions`, { patientId: pFabio })).json.session;
  const novoCaminho = async (sessionId) =>
    (await claudia.post(`${RTQ}/paths`, { patientId: pFabio, sessionId })).json
      .path;
  const caminho = async (sessionId, pathId) =>
    (
      await claudia.get(
        `${RTQ}/paths?patientId=${pFabio}&sessionId=${sessionId}&pathId=${pathId}`
      )
    ).json;
  const detalhes = async (sessionId) =>
    (
      await claudia.get(
        `${RTQ}/paths?patientId=${pFabio}&sessionId=${sessionId}&detail=1`
      )
    ).json.details;
  const novoNivel = (sessionId, pathId, body) =>
    claudia.post(`${RTQ}/nodes`, { patientId: pFabio, sessionId, pathId, ...body });
  const acaoNivel = (sessionId, pathId, nodeId, action) =>
    claudia.patch(`${RTQ}/nodes`, {
      patientId: pFabio,
      sessionId,
      pathId,
      nodeId,
      action,
    });
  const novaFrase = (sessionId, pathId, body) =>
    claudia.post(`${RTQ}/statements`, {
      patientId: pFabio,
      sessionId,
      pathId,
      ...body,
    });
  const acaoFrase = (sessionId, pathId, statementId, action) =>
    claudia.patch(`${RTQ}/statements`, {
      patientId: pFabio,
      sessionId,
      pathId,
      statementId,
      action,
    });
  const eventos = async (sessionId, filtro = "") =>
    (
      await claudia.get(
        `${RTQ}/events?patientId=${pFabio}&sessionId=${sessionId}${filtro}`
      )
    ).json.events;

  let seq = 0;
  const rid = (p) => `${p}-${++seq}`;

  /** Uma conversa completa e CONCLUÍDA, com frase confirmada. */
  async function conversaConcluida(sessionId) {
    const c = await novoCaminho(sessionId);
    const raiz = (
      await novoNivel(sessionId, c.id, {
        promptText: "Sobre qual assunto deseja conversar?",
        options: [
          { label: "FAMÍLIA" },
          {
            label: "SAÚDE",
            isTerminal: true,
            finalStatementDraft: "Quero falar sobre saúde.",
          },
          { label: "ROTINA" },
        ],
        clientRequestId: rid("node"),
      })
    ).json.node;
    await acaoNivel(sessionId, c.id, raiz.id, {
      kind: "REVIEW",
      promptText: raiz.promptText,
    });
    await acaoNivel(sessionId, c.id, raiz.id, { kind: "PRESENT" });
    await acaoNivel(sessionId, c.id, raiz.id, { kind: "AWAIT_SELECTION" });
    await acaoNivel(sessionId, c.id, raiz.id, {
      kind: "SELECT_OPTION",
      optionId: raiz.options[1].id,
    });
    await acaoNivel(sessionId, c.id, raiz.id, { kind: "CONFIRM_OPTION" });

    const f = (
      await novaFrase(sessionId, c.id, {
        text: "Quero falar sobre saúde.",
        originNodeId: raiz.id,
        clientRequestId: rid("stmt"),
      })
    ).json.statement;
    await acaoFrase(sessionId, c.id, f.id, { kind: "EDIT", text: f.currentText });
    await acaoFrase(sessionId, c.id, f.id, { kind: "PRESENT" });
    await acaoFrase(sessionId, c.id, f.id, { kind: "RESPOND", response: "YES" });
    await acaoFrase(sessionId, c.id, f.id, { kind: "CONFIRM" });
    return { pathId: c.id, nodeId: raiz.id, statementId: f.id };
  }

  // ════ 22. Reutilização de pergunta fechada ════
  console.log("22 Reutilização de pergunta fechada:");
  const s1 = await novaSessao();
  const t1 = (
    await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s1.id,
      text: "O senhor está com sede?",
      isSensitive: true,
      sensitiveCategory: "MEDICAL",
    })
  ).json.turn;
  await claudia.patch(`${RTQ}/turns`, {
    patientId: pFabio,
    sessionId: s1.id,
    turnId: t1.id,
    action: { kind: "REVIEW", reviewedText: t1.reviewedText },
  });
  for (const kind of ["PRESENT", "AWAIT_RESPONSE"]) {
    await claudia.patch(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s1.id,
      turnId: t1.id,
      action: { kind },
    });
  }
  await claudia.patch(`${RTQ}/turns`, {
    patientId: pFabio,
    sessionId: s1.id,
    turnId: t1.id,
    action: { kind: "SELECT_RESPONSE", response: "YES" },
  });
  await claudia.patch(`${RTQ}/turns`, {
    patientId: pFabio,
    sessionId: s1.id,
    turnId: t1.id,
    action: { kind: "VERIFY_RESPONSE" },
  });
  await claudia.patch(`${RTQ}/turns`, {
    patientId: pFabio,
    sessionId: s1.id,
    turnId: t1.id,
    action: { kind: "RECONFIRM_RESPONSE" },
  });

  const reutilizada = (
    await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: s1.id,
      text: "O senhor está com sede?",
      isSensitive: true,
      sensitiveCategory: "MEDICAL",
      reusedFromTurnId: t1.id,
    })
  ).json.turn;
  check(
    "22. a pergunta reutilizada nasce em DRAFT, vinculada à original",
    reutilizada.status === "DRAFT" &&
      reutilizada.reusedFromTurnId === t1.id &&
      reutilizada.id !== t1.id &&
      reutilizada.reviewedText === "O senhor está com sede?",
    JSON.stringify(reutilizada)
  );
  check(
    "22. a reutilização NÃO copia resposta nem confirmação",
    reutilizada.provisionalResponse === null &&
      reutilizada.confirmedResponse === null &&
      reutilizada.presentedAt === null &&
      reutilizada.confirmedAt === null,
    JSON.stringify(reutilizada)
  );
  check(
    "22. a marcação sensível é preservada na cópia",
    reutilizada.isSensitive === true &&
      reutilizada.sensitiveCategory === "MEDICAL"
  );
  const t1Depois = (
    await claudia.get(
      `${RTQ}/turns?patientId=${pFabio}&sessionId=${s1.id}`
    )
  ).json.turns.find((t) => t.id === t1.id);
  check(
    "22. a pergunta ORIGINAL permanece intacta, com sua confirmação",
    t1Depois.status === "CONFIRMED" && t1Depois.confirmedResponse === "YES"
  );
  check(
    "22. CONTENT_REUSED registrado com a origem",
    (await eventos(s1.id, `&turnId=${reutilizada.id}`)).some(
      (e) =>
        e.eventType === "CONTENT_REUSED" &&
        e.previousValue?.sourceId === t1.id
    )
  );
  check(
    "22. origem inexistente é recusada",
    (
      await claudia.post(`${RTQ}/turns`, {
        patientId: pFabio,
        sessionId: s1.id,
        text: "Forjada",
        reusedFromTurnId: "nao-existe",
      })
    ).status === 400
  );

  // ════ 23. Reutilização de nível ════
  console.log("\n23 Reutilização de nível:");
  const s2 = await novaSessao();
  const concluida = await conversaConcluida(s2.id);
  const antesDoReuso = await caminho(s2.id, concluida.pathId);
  check(
    "23. a conversa de origem está CONCLUÍDA",
    antesDoReuso.path.status === "COMPLETED"
  );

  const reusoNivel = (
    await claudia.post(`${RTQ}/nodes`, {
      patientId: pFabio,
      sessionId: s2.id,
      reuseFromNodeId: concluida.nodeId,
      clientRequestId: rid("reuse-node"),
    })
  ).json;
  check(
    "23. o nível reutilizado nasce em DRAFT, num caminho NOVO",
    reusoNivel.node.status === "DRAFT" &&
      reusoNivel.node.reusedFromNodeId === concluida.nodeId &&
      reusoNivel.path.id !== concluida.pathId &&
      reusoNivel.path.status === "ACTIVE",
    JSON.stringify({ no: reusoNivel.node.status, caminho: reusoNivel.path.id })
  );
  check(
    "23. o conteúdo é copiado: título, opções, terminal e frase associada",
    reusoNivel.node.promptText === "Sobre qual assunto deseja conversar?" &&
      reusoNivel.node.options.map((o) => o.label).join("|") ===
        "FAMÍLIA|SAÚDE|ROTINA" &&
      reusoNivel.node.options[1].isTerminal === true &&
      reusoNivel.node.options[1].finalStatementDraft ===
        "Quero falar sobre saúde."
  );
  check(
    "23. as opções da cópia têm ids NOVOS e nenhum vínculo com o nível seguinte",
    reusoNivel.node.options.every(
      (o) =>
        !antesDoReuso.nodes[0].options.some((a) => a.id === o.id) &&
        o.nextNodeId === null
    )
  );
  check(
    "23. a cópia NÃO herda seleção nem confirmação",
    reusoNivel.node.provisionalOptionId === null &&
      reusoNivel.node.confirmedOptionId === null &&
      reusoNivel.node.presentedAt === null
  );
  const origemDepois = await caminho(s2.id, concluida.pathId);
  check(
    "23. o nível ORIGINAL permanece intacto, confirmado, no caminho concluído",
    origemDepois.path.status === "COMPLETED" &&
      origemDepois.nodes[0].status === "CONFIRMED" &&
      origemDepois.nodes[0].confirmedOptionId ===
        antesDoReuso.nodes[0].confirmedOptionId
  );
  check(
    "23. OPTION_LEVEL_REUSED e CONTENT_REUSED registrados",
    (await eventos(s2.id, `&nodeId=${reusoNivel.node.id}`)).some(
      (e) => e.eventType === "OPTION_LEVEL_REUSED"
    ) &&
      (await eventos(s2.id, `&nodeId=${reusoNivel.node.id}`)).some(
        (e) => e.eventType === "CONTENT_REUSED"
      )
  );

  // ════ 24. Reutilização de frase ════
  console.log("\n24 Reutilização de frase:");
  const reusoFrase = (
    await claudia.post(`${RTQ}/statements`, {
      patientId: pFabio,
      sessionId: s2.id,
      reuseFromStatementId: concluida.statementId,
      clientRequestId: rid("reuse-stmt"),
    })
  ).json;
  check(
    "24. a frase reutilizada nasce em DRAFT, num caminho NOVO",
    reusoFrase.statement.status === "DRAFT" &&
      reusoFrase.statement.reusedFromStatementId === concluida.statementId &&
      reusoFrase.path.id !== concluida.pathId,
    JSON.stringify(reusoFrase.statement)
  );
  check(
    "24. o texto é copiado e vira o novo rascunho original",
    reusoFrase.statement.currentText === "Quero falar sobre saúde." &&
      reusoFrase.statement.originalDraft === "Quero falar sobre saúde."
  );
  check(
    "24. a frase reutilizada NÃO herda resposta nem confirmação",
    reusoFrase.statement.provisionalResponse === null &&
      reusoFrase.statement.confirmedResponse === null &&
      reusoFrase.statement.presentedAt === null &&
      reusoFrase.statement.confirmedAt === null,
    JSON.stringify(reusoFrase.statement)
  );
  check(
    "24. FINAL_STATEMENT_REUSED registrado",
    (await eventos(s2.id, `&statementId=${reusoFrase.statement.id}`)).some(
      (e) => e.eventType === "FINAL_STATEMENT_REUSED"
    )
  );

  // ════ 25. Caminho concluído: reutilizar, nunca retomar ════
  console.log("\n25 Caminho concluído nunca volta a ser ativo:");
  check(
    "25. um caminho concluído não aceita novos níveis",
    (
      await novoNivel(s2.id, concluida.pathId, {
        promptText: "Não deveria entrar",
        options: [{ label: "X" }],
        clientRequestId: rid("node"),
      })
    ).status === 400
  );
  check(
    "25. nem volta a ACTIVE por ação de caminho",
    (
      await claudia.patch(`${RTQ}/paths`, {
        patientId: pFabio,
        sessionId: s2.id,
        pathId: concluida.pathId,
        action: { kind: "RESUME" },
      })
    ).status === 400
  );
  const reusoCaminho = (
    await claudia.post(`${RTQ}/paths`, {
      patientId: pFabio,
      sessionId: s2.id,
      reuseFromPathId: concluida.pathId,
      clientRequestId: rid("reuse-path"),
    })
  ).json;
  check(
    "25. reutilizar o caminho cria outro, com o primeiro nível copiado em DRAFT",
    reusoCaminho.path.id !== concluida.pathId &&
      reusoCaminho.path.reusedFromPathId === concluida.pathId &&
      reusoCaminho.node?.status === "DRAFT" &&
      reusoCaminho.node?.reusedFromNodeId === concluida.nodeId,
    JSON.stringify(reusoCaminho.path)
  );
  check(
    "25. reutilizar não altera o caminho de origem",
    (await caminho(s2.id, concluida.pathId)).path.status === "COMPLETED"
  );
  check(
    "25. reutilizar para dentro de um caminho ENCERRADO é recusado",
    (
      await claudia.post(`${RTQ}/nodes`, {
        patientId: pFabio,
        sessionId: s2.id,
        pathId: concluida.pathId,
        reuseFromNodeId: concluida.nodeId,
        clientRequestId: rid("reuse-node"),
      })
    ).status === 400
  );

  // ════ Abrir um item nunca altera dados (§22) ════
  console.log("\nAbrir um item do histórico:");
  const antesDeAbrir = await caminho(s2.id, concluida.pathId);
  const abertura = await claudia.put(`${RTQ}/paths`, {
    patientId: pFabio,
    sessionId: s2.id,
    itemType: "PATH",
    itemId: concluida.pathId,
  });
  const depoisDeAbrir = await caminho(s2.id, concluida.pathId);
  check(
    "abrir registra a consulta e devolve sucesso",
    abertura.status === 200 &&
      (await eventos(s2.id, `&pathId=${concluida.pathId}`)).some(
        (e) => e.eventType === "HISTORY_ITEM_OPENED"
      )
  );
  check(
    "abrir NÃO altera nenhum dado do item",
    JSON.stringify(antesDeAbrir.path) === JSON.stringify(depoisDeAbrir.path) &&
      JSON.stringify(antesDeAbrir.nodes) ===
        JSON.stringify(depoisDeAbrir.nodes),
    "o caminho mudou ao ser aberto"
  );
  check(
    "tipo de item inválido é recusado",
    (
      await claudia.put(`${RTQ}/paths`, {
        patientId: pFabio,
        sessionId: s2.id,
        itemType: "OUTRO",
        itemId: concluida.pathId,
      })
    ).status === 400
  );

  // ════ Histórico completo e isolamento ════
  console.log("\nHistórico da sessão e isolamento:");
  const todos = await detalhes(s2.id);
  check(
    "o histórico devolve caminhos, níveis e frases numa leitura só",
    Array.isArray(todos) &&
      todos.length >= 4 &&
      todos.every((d) => Array.isArray(d.nodes) && Array.isArray(d.statements))
  );
  check(
    "os caminhos vêm na ordem em que foram criados",
    todos.every((d, i) => i === 0 || todos[i - 1].path.sequence <= d.path.sequence)
  );
  check(
    "outro assistente não lê o histórico deste paciente (403)",
    (
      await marcos.get(
        `${RTQ}/paths?patientId=${pFabio}&sessionId=${s2.id}&detail=1`
      )
    ).status === 403
  );
  check(
    "nem reutiliza um nível deste paciente",
    (
      await marcos.post(`${RTQ}/nodes`, {
        patientId: pRoberto,
        sessionId: s2.id,
        reuseFromNodeId: concluida.nodeId,
        clientRequestId: rid("reuse-node"),
      })
    ).status === 400
  );
  check(
    "nem registra abertura de item deste paciente",
    (
      await marcos.put(`${RTQ}/paths`, {
        patientId: pFabio,
        sessionId: s2.id,
        itemType: "PATH",
        itemId: concluida.pathId,
      })
    ).status === 403
  );

  console.log(`\n${passed} passaram · ${failed} falharam`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
