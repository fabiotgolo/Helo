// ——— Conversa por opções: ramificações, reinício e frase final (§36) ———
// Cobre os casos 8–13, 16–18, 20 e 21 da especificação.
//
// A regra mais importante verificada aqui: SOMENTE SIM confirma uma frase.
// TALVEZ e NÃO chegam ao servidor como resposta OBSERVADA e param ali — não
// existe corpo de requisição capaz de transformá-los em confirmação.
//
//   npm run emu                            (terminal 1)
//   npm run dev                            (terminal 2)
//   npm run test:oc:branches               (terminal 3)

import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";
// Guarda: esta suíte apaga o banco inteiro. Ver scripts/emulator-guard.mjs.
assertEmuladorDescartavel(EMU, DB, "test-option-conversation-branches.mjs");

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

  await admin.post("/api/auth/bootstrap", {
    name: "Admin",
    email: "admin@helo.test",
    password: "senha-admin-123",
  });
  const uClaudia = (
    await admin.post("/api/admin/users", {
      name: "Claudia",
      email: "claudia@helo.test",
      password: "senha-teste-123",
      role: "profissional",
      professionalType: "fonoaudiologo",
    })
  ).json.user;
  await claudia.post("/api/auth/login", {
    email: "claudia@helo.test",
    password: "senha-teste-123",
  });
  const pFabio = (await admin.post("/api/patients", { name: "Dr. Fábio" })).json
    .patient.id;
  await admin.post("/api/admin/access", {
    userId: uClaudia.id,
    patientId: pFabio,
    permissions: [
      "viewDashboard",
      "viewSessions",
      "viewMetrics",
      "createSession",
      "editGestures",
    ],
  });
  console.log("Preparação concluída (Claudia ↔ Dr. Fábio).\n");

  // ——— Atalhos ———
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
  const listaCaminhos = async (sessionId) =>
    (
      await claudia.get(
        `${RTQ}/paths?patientId=${pFabio}&sessionId=${sessionId}`
      )
    ).json.paths;
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

  /** Cria um nível, apresenta e confirma a opção da posição indicada. */
  async function nivelConfirmado(sessionId, pathId, promptText, labels, position, extra = {}) {
    const criado = (
      await novoNivel(sessionId, pathId, {
        promptText,
        options: labels,
        clientRequestId: rid("node"),
        ...extra,
      })
    ).json.node;
    await acaoNivel(sessionId, pathId, criado.id, {
      kind: "REVIEW",
      promptText: criado.promptText,
    });
    await acaoNivel(sessionId, pathId, criado.id, { kind: "PRESENT" });
    await acaoNivel(sessionId, pathId, criado.id, { kind: "AWAIT_SELECTION" });
    const opcao = criado.options.find((o) => o.position === position);
    await acaoNivel(sessionId, pathId, criado.id, {
      kind: "SELECT_OPTION",
      optionId: opcao.id,
    });
    const r = await acaoNivel(sessionId, pathId, criado.id, {
      kind: "CONFIRM_OPTION",
    });
    return r.json.node;
  }

  /** Monta a árvore de referência do §5 até o nível pedido. */
  async function arvoreReferencia(sessionId, pathId) {
    const assunto = await nivelConfirmado(
      sessionId,
      pathId,
      "Sobre qual assunto deseja conversar?",
      [{ label: "FAMÍLIA" }, { label: "SAÚDE" }, { label: "ROTINA" }],
      2 // SAÚDE
    );
    const saude = await nivelConfirmado(
      sessionId,
      pathId,
      "Saúde",
      [{ label: "DOR" }, { label: "MEDICAÇÃO" }, { label: "CONSULTA" }],
      1, // DOR
      { parentNodeId: assunto.id }
    );
    const dor = await nivelConfirmado(
      sessionId,
      pathId,
      "Dor",
      [
        { label: "CABEÇA" },
        {
          label: "PERNA",
          isTerminal: true,
          finalStatementDraft: "Estou sentindo dor na perna.",
        },
        { label: "OUTRO LOCAL" },
      ],
      2, // PERNA (terminal)
      { parentNodeId: saude.id }
    );
    return { assunto, saude, dor };
  }

  // ════ 8–10. Retorno, desativação e nova ramificação ════
  console.log("8–10 Retorno pelo breadcrumb e mudança de caminho:");
  const s1 = await novaSessao();
  const c1 = await novoCaminho(s1.id);
  const { saude, dor } = await arvoreReferencia(s1.id, c1.id);

  const antes = await caminho(s1.id, c1.id);
  check(
    "8. o caminho ativo é Assunto › Saúde › Dor, com a opção terminal confirmada",
    antes.path.activeNodeId === dor.id &&
      antes.nodes.length === 3 &&
      dor.status === "CONFIRMED",
    JSON.stringify({ ativo: antes.path.activeNodeId, dor: dor.id })
  );

  const ramoAnterior = antes.path.activeBranchId;
  const retorno = (
    await claudia.patch(`${RTQ}/paths`, {
      patientId: pFabio,
      sessionId: s1.id,
      pathId: c1.id,
      returnToNodeId: saude.id,
      clientRequestId: rid("return"),
    })
  ).json;

  check(
    "8. voltar a Saúde reapresenta DOR, MEDICAÇÃO e CONSULTA, aguardando seleção",
    (() => {
      const ativo = retorno.nodes.find((n) => n.id === retorno.path.activeNodeId);
      return (
        ativo &&
        ativo.status === "AWAITING_SELECTION" &&
        ativo.options.map((o) => o.label).join("|") ===
          "DOR|MEDICAÇÃO|CONSULTA" &&
        ativo.provisionalOptionId === null &&
        ativo.confirmedOptionId === null
      );
    })(),
    JSON.stringify(retorno.nodes.find((n) => n.id === retorno.path.activeNodeId))
  );

  check(
    "9. Saúde e Dor viram INACTIVE — desativados, nunca excluídos",
    (() => {
      const s = retorno.nodes.find((n) => n.id === saude.id);
      const d = retorno.nodes.find((n) => n.id === dor.id);
      return s?.status === "INACTIVE" && d?.status === "INACTIVE";
    })(),
    JSON.stringify(retorno.nodes.map((n) => [n.promptText, n.status]))
  );
  check(
    "9. a escolha anterior (DOR) fica preservada no nível desativado",
    retorno.nodes.find((n) => n.id === saude.id)?.confirmedOptionId ===
      saude.confirmedOptionId
  );
  check(
    "9. nenhum registro foi apagado: os 3 níveis antigos seguem lá, mais o novo",
    retorno.nodes.length === 4,
    `${retorno.nodes.length}`
  );
  check(
    "9. PATH_LEVEL_RETURNED e PATH_BRANCH_DEACTIVATED registrados",
    (await eventos(s1.id, `&pathId=${c1.id}`)).some(
      (e) => e.eventType === "PATH_LEVEL_RETURNED"
    ) &&
      (await eventos(s1.id, `&pathId=${c1.id}`)).filter(
        (e) => e.eventType === "PATH_BRANCH_DEACTIVATED"
      ).length === 2
  );

  check(
    "10. o retorno abriu uma ramificação NOVA, preservando a anterior",
    retorno.path.activeBranchId !== ramoAnterior &&
      retorno.nodes.find((n) => n.id === saude.id).branchId === ramoAnterior,
    JSON.stringify({ antes: ramoAnterior, agora: retorno.path.activeBranchId })
  );
  check(
    "10. PATH_BRANCH_CREATED e PATH_CHANGED registrados",
    (await eventos(s1.id, `&pathId=${c1.id}`)).some(
      (e) => e.eventType === "PATH_BRANCH_CREATED"
    ) &&
      (await eventos(s1.id, `&pathId=${c1.id}`)).some(
        (e) => e.eventType === "PATH_CHANGED"
      )
  );
  check(
    "10. a frase anterior NÃO é transportada para a ramificação nova",
    retorno.path.finalStatementId === null
  );

  // Confirmar MEDICAÇÃO na ramificação nova
  const novoSaude = retorno.nodes.find((n) => n.id === retorno.path.activeNodeId);
  const medicacao = novoSaude.options.find((o) => o.label === "MEDICAÇÃO");
  await acaoNivel(s1.id, c1.id, novoSaude.id, {
    kind: "SELECT_OPTION",
    optionId: medicacao.id,
  });
  await acaoNivel(s1.id, c1.id, novoSaude.id, { kind: "CONFIRM_OPTION" });
  const depois = await caminho(s1.id, c1.id);
  check(
    "10. o novo caminho é Assunto › Saúde › Medicação, e o antigo continua no banco",
    depois.nodes.find((n) => n.id === novoSaude.id).confirmedOptionId ===
      medicacao.id &&
      depois.nodes.find((n) => n.id === dor.id).status === "INACTIVE" &&
      depois.nodes.find((n) => n.id === dor.id).confirmedOptionId !== null,
    JSON.stringify(depois.nodes.map((n) => [n.promptText, n.status]))
  );
  check(
    "8. o breadcrumb só navega dentro do caminho ativo",
    (
      await claudia.patch(`${RTQ}/paths`, {
        patientId: pFabio,
        sessionId: s1.id,
        pathId: c1.id,
        returnToNodeId: dor.id, // ficou numa ramificação abandonada
        clientRequestId: rid("return"),
      })
    ).status === 400
  );
  check(
    "8. voltar para o nível ATUAL é recusado",
    (
      await claudia.patch(`${RTQ}/paths`, {
        patientId: pFabio,
        sessionId: s1.id,
        pathId: c1.id,
        returnToNodeId: depois.path.activeNodeId,
        clientRequestId: rid("return"),
      })
    ).status === 400
  );

  // ════ 11–12. Reinício e preservação do caminho anterior ════
  console.log("\n11–12 Reinício:");
  const reinicio = (
    await claudia.patch(`${RTQ}/paths`, {
      patientId: pFabio,
      sessionId: s1.id,
      pathId: c1.id,
      action: { kind: "RESTART" },
      clientRequestId: rid("restart"),
    })
  ).json;
  check(
    "11. o caminho atual vira RESTARTED e um caminho NOVO nasce na mesma sessão",
    reinicio.previous.status === "RESTARTED" &&
      !!reinicio.previous.restartedAt &&
      reinicio.created.status === "ACTIVE" &&
      reinicio.created.restartedFromPathId === c1.id &&
      reinicio.created.id !== c1.id,
    JSON.stringify(reinicio)
  );
  check(
    "11. reinício duplicado é impedido",
    (
      await claudia.patch(`${RTQ}/paths`, {
        patientId: pFabio,
        sessionId: s1.id,
        pathId: c1.id,
        action: { kind: "RESTART" },
        clientRequestId: rid("restart"),
      })
    ).status === 400
  );
  check(
    "11. clique repetido com o mesmo pedido devolve o mesmo caminho novo",
    (await listaCaminhos(s1.id)).length === 2
  );
  const preservado = await caminho(s1.id, c1.id);
  check(
    "12. o caminho anterior permanece registrado, com todos os seus níveis",
    preservado.path.status === "RESTARTED" && preservado.nodes.length === 4,
    `${preservado.nodes.length} níveis`
  );
  check(
    "12. o caminho encerrado não volta a aceitar níveis",
    (
      await novoNivel(s1.id, c1.id, {
        promptText: "Não deveria entrar",
        options: [{ label: "X" }],
        clientRequestId: rid("node"),
      })
    ).status === 400
  );
  check(
    "12. CONVERSATION_PATH_RESTARTED registrado com o vínculo entre os dois",
    (await eventos(s1.id, `&pathId=${c1.id}`)).some(
      (e) =>
        e.eventType === "CONVERSATION_PATH_RESTARTED" &&
        e.metadata?.restartedIntoPathId === reinicio.created.id
    )
  );

  // ════ 13, 16. Criação da frase e confirmação com SIM ════
  console.log("\n13, 16 Frase final e confirmação com SIM:");
  const s2 = await novaSessao();
  const c2 = await novoCaminho(s2.id);
  await arvoreReferencia(s2.id, c2.id);

  const frase = (
    await novaFrase(s2.id, c2.id, {
      text: "Estou sentindo dor na perna.",
      clientRequestId: rid("stmt"),
    })
  ).json.statement;
  check(
    "13. a frase nasce em DRAFT, guardando o rascunho original",
    frase.status === "DRAFT" &&
      frase.originalDraft === "Estou sentindo dor na perna." &&
      frase.currentText === frase.originalDraft &&
      frase.confirmedResponse === null,
    JSON.stringify(frase)
  );
  check(
    "13. FINAL_STATEMENT_DRAFTED registrado com o caminho",
    (await eventos(s2.id, `&statementId=${frase.id}`)).some(
      (e) => e.eventType === "FINAL_STATEMENT_DRAFTED"
    )
  );
  check(
    "13. frase vazia é recusada",
    (await novaFrase(s2.id, c2.id, { text: "   ", clientRequestId: rid("stmt") }))
      .status === 400
  );

  await acaoFrase(s2.id, c2.id, frase.id, {
    kind: "EDIT",
    text: "Estou sentindo dor na perna.",
  });
  const apresentada = (
    await acaoFrase(s2.id, c2.id, frase.id, { kind: "PRESENT" })
  ).json.statement;
  check(
    "13. apresentar congela o texto e muda o modo de interação",
    apresentada.status === "PRESENTED" &&
      apresentada.presentedText === "Estou sentindo dor na perna." &&
      (await eventos(s2.id, `&statementId=${frase.id}`)).some(
        (e) =>
          e.eventType === "INTERACTION_MODE_SELECTED" &&
          e.newValue?.interactionMode === "FINAL_STATEMENT_CONFIRMATION"
      )
  );

  check(
    "16. confirmar sem resposta observada é recusado",
    (await acaoFrase(s2.id, c2.id, frase.id, { kind: "CONFIRM" })).status === 400
  );
  const comSim = (
    await acaoFrase(s2.id, c2.id, frase.id, { kind: "RESPOND", response: "YES" })
  ).json.statement;
  check(
    "16. SIM observado ainda NÃO confirma sozinho",
    comSim.status === "PROVISIONAL_RESPONSE" &&
      comSim.provisionalResponse === "YES" &&
      comSim.confirmedResponse === null
  );
  const confirmada = (
    await acaoFrase(s2.id, c2.id, frase.id, { kind: "CONFIRM" })
  ).json;
  check(
    "16. a conferência do SIM confirma a frase e conclui o caminho",
    confirmada.statement.status === "CONFIRMED" &&
      confirmada.statement.confirmedResponse === "YES" &&
      !!confirmada.statement.confirmedAt &&
      confirmada.path.status === "COMPLETED" &&
      confirmada.path.finalStatementId === frase.id,
    JSON.stringify(confirmada.statement)
  );
  check(
    "16. FINAL_STATEMENT_CONFIRMED e CONVERSATION_PATH_COMPLETED registrados",
    (await eventos(s2.id, `&pathId=${c2.id}`)).some(
      (e) => e.eventType === "FINAL_STATEMENT_CONFIRMED"
    ) &&
      (await eventos(s2.id, `&pathId=${c2.id}`)).some(
        (e) => e.eventType === "CONVERSATION_PATH_COMPLETED"
      )
  );

  // ════ 17. TALVEZ nunca confirma ════
  console.log("\n17 TALVEZ não confirma:");
  const s3 = await novaSessao();
  const c3 = await novoCaminho(s3.id);
  await arvoreReferencia(s3.id, c3.id);
  const f3 = (
    await novaFrase(s3.id, c3.id, {
      text: "Estou sentindo dor na perna.",
      clientRequestId: rid("stmt"),
    })
  ).json.statement;
  await acaoFrase(s3.id, c3.id, f3.id, { kind: "EDIT", text: f3.currentText });
  await acaoFrase(s3.id, c3.id, f3.id, { kind: "PRESENT" });
  const comTalvez = (
    await acaoFrase(s3.id, c3.id, f3.id, { kind: "RESPOND", response: "MAYBE" })
  ).json.statement;
  check(
    "17. TALVEZ fica como resposta observada, sem confirmar",
    comTalvez.status === "PROVISIONAL_RESPONSE" &&
      comTalvez.provisionalResponse === "MAYBE" &&
      comTalvez.confirmedResponse === null
  );
  check(
    "17. CONFIRM com TALVEZ observado é RECUSADO pelo domínio",
    (await acaoFrase(s3.id, c3.id, f3.id, { kind: "CONFIRM" })).status === 400
  );
  check(
    "17. REJECT com TALVEZ observado também é recusado",
    (await acaoFrase(s3.id, c3.id, f3.id, { kind: "REJECT" })).status === 400
  );
  check(
    "17. o caminho continua ATIVO — TALVEZ não conclui nada",
    (await caminho(s3.id, c3.id)).path.status === "ACTIVE"
  );

  // ════ 18. NÃO nunca confirma ════
  console.log("\n18 NÃO não confirma:");
  const naoObservado = (
    await acaoFrase(s3.id, c3.id, f3.id, {
      kind: "CHANGE_RESPONSE",
      response: "NO",
    })
  ).json.statement;
  check(
    "18. NÃO fica como resposta observada, sem confirmar",
    naoObservado.provisionalResponse === "NO" &&
      naoObservado.confirmedResponse === null
  );
  check(
    "18. CONFIRM com NÃO observado é RECUSADO",
    (await acaoFrase(s3.id, c3.id, f3.id, { kind: "CONFIRM" })).status === 400
  );
  const rejeitada = (
    await acaoFrase(s3.id, c3.id, f3.id, { kind: "REJECT" })
  ).json;
  check(
    "18. rejeitar registra a recusa SEM nenhuma confirmação",
    rejeitada.statement.status === "REJECTED" &&
      rejeitada.statement.confirmedResponse === null &&
      !!rejeitada.statement.rejectedAt,
    JSON.stringify(rejeitada.statement)
  );
  check(
    "18. uma frase rejeitada NÃO conclui o caminho",
    rejeitada.path.status === "ACTIVE" &&
      !rejeitada.path.completedAt &&
      rejeitada.statement.confirmedResponse === null,
    JSON.stringify({ status: rejeitada.path.status })
  );
  check(
    "18. FINAL_STATEMENT_REJECTED registrado, e nenhum CONFIRMED",
    (await eventos(s3.id, `&statementId=${f3.id}`)).some(
      (e) => e.eventType === "FINAL_STATEMENT_REJECTED"
    ) &&
      !(await eventos(s3.id, `&statementId=${f3.id}`)).some(
        (e) => e.eventType === "FINAL_STATEMENT_CONFIRMED"
      )
  );

  // ════ 19b. Frase sensível exige reconfirmação reforçada ════
  console.log("\n19 Frase sensível herda a sensibilidade do caminho:");
  const s4 = await novaSessao();
  const c4 = await novoCaminho(s4.id);
  const raizSensivel = await nivelConfirmado(
    s4.id,
    c4.id,
    "Sobre o tratamento",
    [
      { label: "CONTINUAR" },
      {
        label: "INTERROMPER",
        isTerminal: true,
        finalStatementDraft: "Quero interromper o tratamento.",
      },
    ],
    2,
    { isSensitive: true, sensitiveCategory: "MEDICAL" }
  );
  const fSens = (
    await novaFrase(s4.id, c4.id, {
      text: "Quero interromper o tratamento.",
      originNodeId: raizSensivel.id,
      clientRequestId: rid("stmt"),
    })
  ).json.statement;
  check(
    "19. a frase HERDA a sensibilidade e a categoria do caminho",
    fSens.isSensitive === true && fSens.sensitiveCategory === "MEDICAL",
    JSON.stringify(fSens)
  );
  await acaoFrase(s4.id, c4.id, fSens.id, {
    kind: "EDIT",
    text: fSens.currentText,
  });
  await acaoFrase(s4.id, c4.id, fSens.id, { kind: "PRESENT" });
  await acaoFrase(s4.id, c4.id, fSens.id, { kind: "RESPOND", response: "YES" });
  check(
    "19. uma única confirmação NÃO conclui uma frase sensível",
    (await acaoFrase(s4.id, c4.id, fSens.id, { kind: "CONFIRM" })).status === 400
  );
  await acaoFrase(s4.id, c4.id, fSens.id, { kind: "RECONFIRM" });
  const sensConfirmada = (
    await acaoFrase(s4.id, c4.id, fSens.id, { kind: "CONFIRM" })
  ).json.statement;
  check(
    "19. após a reconfirmação reforçada, a frase sensível é confirmada",
    sensConfirmada.status === "CONFIRMED" &&
      !!sensConfirmada.reconfirmedAt &&
      sensConfirmada.confirmedResponse === "YES"
  );
  check(
    "19. as duas confirmações ficam preservadas na auditoria",
    (await eventos(s4.id, `&statementId=${fSens.id}`)).filter((e) =>
      ["FINAL_STATEMENT_PRESENTED", "FINAL_STATEMENT_CONFIRMED"].includes(
        e.eventType
      )
    ).length >= 2
  );

  // ════ 20–21. Pausa, retomada e restauração ════
  console.log("\n20–21 Pausa, retomada e restauração:");
  const s5 = await novaSessao();
  const c5 = await novoCaminho(s5.id);
  const raiz5 = (
    await novoNivel(s5.id, c5.id, {
      promptText: "Sobre qual assunto deseja conversar?",
      options: [{ label: "FAMÍLIA" }, { label: "SAÚDE" }, { label: "ROTINA" }],
      clientRequestId: rid("node"),
    })
  ).json.node;
  await acaoNivel(s5.id, c5.id, raiz5.id, {
    kind: "REVIEW",
    promptText: raiz5.promptText,
  });
  await acaoNivel(s5.id, c5.id, raiz5.id, { kind: "PRESENT" });
  await acaoNivel(s5.id, c5.id, raiz5.id, { kind: "AWAIT_SELECTION" });
  await acaoNivel(s5.id, c5.id, raiz5.id, {
    kind: "SELECT_OPTION",
    optionId: raiz5.options[1].id,
  });

  await claudia.patch(`${RTQ}/paths`, {
    patientId: pFabio,
    sessionId: s5.id,
    pathId: c5.id,
    action: { kind: "PAUSE" },
  });
  check(
    "20. caminho pausado não aceita confirmar a opção",
    (await acaoNivel(s5.id, c5.id, raiz5.id, { kind: "CONFIRM_OPTION" }))
      .status === 400
  );
  const pausado = await caminho(s5.id, c5.id);
  check(
    "20. a seleção interrompida pela pausa continua PROVISÓRIA",
    pausado.nodes[0].status === "PROVISIONAL_SELECTION" &&
      pausado.nodes[0].provisionalOptionId === raiz5.options[1].id &&
      pausado.nodes[0].confirmedOptionId === null,
    JSON.stringify(pausado.nodes[0])
  );
  await claudia.patch(`${RTQ}/paths`, {
    patientId: pFabio,
    sessionId: s5.id,
    pathId: c5.id,
    action: { kind: "RESUME" },
  });
  check(
    "20. retomado, o caminho volta a aceitar a confirmação",
    (await acaoNivel(s5.id, c5.id, raiz5.id, { kind: "CONFIRM_OPTION" }))
      .status === 200
  );

  const restaurado = await caminho(s5.id, c5.id);
  check(
    "21. a restauração devolve caminho, nível ativo, breadcrumb e modo",
    restaurado.path.status === "ACTIVE" &&
      restaurado.path.activeNodeId === raiz5.id &&
      restaurado.nodes[0].status === "CONFIRMED" &&
      restaurado.nodes[0].interactionMode === "OPTION_SELECTION",
    JSON.stringify(restaurado.path)
  );
  const detalhes = (
    await claudia.get(
      `${RTQ}/paths?patientId=${pFabio}&sessionId=${s5.id}&detail=1`
    )
  ).json.details;
  check(
    "21. uma leitura só devolve caminhos, níveis e frases da sessão",
    Array.isArray(detalhes) &&
      detalhes.length === 1 &&
      detalhes[0].nodes.length === 1 &&
      Array.isArray(detalhes[0].statements)
  );
  check(
    "21. a restauração NÃO duplica registros",
    (await listaCaminhos(s5.id)).length === 1 &&
      (await caminho(s5.id, c5.id)).nodes.length === 1
  );

  console.log(`\n${passed} passaram · ${failed} falharam`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
