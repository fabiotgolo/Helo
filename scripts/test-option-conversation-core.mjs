// ——— Conversa por opções: domínio, níveis, seleção e auditoria (§36) ———
// Cobre os casos 1–7, 19, 29 e 30 da especificação, mais as invariantes de
// cada nível (§6) e as guardas de sessão (§33).
//
// Roda contra o dev server + emulador do Firestore. NUNCA rode contra
// produção: o script LIMPA o banco do emulador antes de começar.
//
//   npm run emu                            (terminal 1)
//   npm run dev                            (terminal 2)
//   npm run test:oc:core                   (terminal 3)

import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";
// Guarda: esta suíte apaga o banco inteiro. Ver scripts/emulator-guard.mjs.
assertEmuladorDescartavel(EMU, DB, "test-option-conversation-core.mjs");

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

  const uClaudia = await createUser(
    claudia,
    "Claudia",
    "claudia@helo.test",
    "fonoaudiologo"
  );
  const uMarcos = await createUser(
    marcos,
    "Marcos",
    "marcos@helo.test",
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
  async function link(user, patientId) {
    const r = await admin.post("/api/admin/access", {
      userId: user.id,
      patientId,
      permissions: FULL,
    });
    check(`vínculo ${user.name} ↔ paciente ${patientId}`, r.status === 200);
  }
  await link(uClaudia, pFabio);
  // Marcos só alcança o Sr. Roberto — base do teste de isolamento (29).
  await link(uMarcos, pRoberto);

  // ——— Atalhos ———
  const RTQ = "/api/realtime-questions";
  const novaSessao = async (c = claudia, patientId = pFabio) =>
    (await c.post(`${RTQ}/sessions`, { patientId })).json.session;
  const acaoSessao = (sessionId, action, c = claudia, patientId = pFabio) =>
    c.patch(`${RTQ}/sessions`, { patientId, sessionId, action });

  const novoCaminho = (sessionId, body = {}, c = claudia, patientId = pFabio) =>
    c.post(`${RTQ}/paths`, { patientId, sessionId, ...body });
  const caminho = async (sessionId, pathId, c = claudia, patientId = pFabio) =>
    (
      await c.get(
        `${RTQ}/paths?patientId=${patientId}&sessionId=${sessionId}&pathId=${pathId}`
      )
    ).json;
  const novoNivel = (sessionId, pathId, body, c = claudia, patientId = pFabio) =>
    c.post(`${RTQ}/nodes`, { patientId, sessionId, pathId, ...body });
  const acaoNivel = (
    sessionId,
    pathId,
    nodeId,
    action,
    c = claudia,
    patientId = pFabio
  ) => c.patch(`${RTQ}/nodes`, { patientId, sessionId, pathId, nodeId, action });
  const eventos = async (sessionId, filtro = "", c = claudia, patientId = pFabio) =>
    (
      await c.get(
        `${RTQ}/events?patientId=${patientId}&sessionId=${sessionId}${filtro}`
      )
    ).json.events;

  const OPCOES_ASSUNTO = [
    { label: "FAMÍLIA" },
    { label: "SAÚDE" },
    { label: "ROTINA" },
  ];

  /** Cria um nível e o leva até AWAITING_SELECTION. */
  async function nivelAguardando(sessionId, pathId, body) {
    const n = (await novoNivel(sessionId, pathId, body)).json.node;
    await acaoNivel(sessionId, pathId, n.id, {
      kind: "REVIEW",
      promptText: n.promptText,
    });
    await acaoNivel(sessionId, pathId, n.id, { kind: "PRESENT" });
    const r = await acaoNivel(sessionId, pathId, n.id, {
      kind: "AWAIT_SELECTION",
    });
    return r.json.node;
  }

  /** Leva um nível até CONFIRMED na opção da posição informada. */
  async function confirmaOpcao(sessionId, pathId, node, position) {
    const opcao = node.options.find((o) => o.position === position);
    await acaoNivel(sessionId, pathId, node.id, {
      kind: "SELECT_OPTION",
      optionId: opcao.id,
    });
    const r = await acaoNivel(sessionId, pathId, node.id, {
      kind: "CONFIRM_OPTION",
    });
    return r.json.node;
  }

  // ════ 1. Criação de caminho ════
  console.log("\n1 Criação do caminho:");
  const s1 = await novaSessao();
  const c1 = (await novoCaminho(s1.id)).json.path;
  check(
    "1. caminho criado em ACTIVE, com paciente e assistente do servidor",
    c1?.status === "ACTIVE" &&
      c1.patientId === pFabio &&
      c1.assistantId === uClaudia.id &&
      !!c1.startedAt &&
      !!c1.activeBranchId,
    JSON.stringify(c1)
  );
  check(
    "1. CONVERSATION_PATH_STARTED registrado com autoria e horário",
    (await eventos(s1.id)).some(
      (e) =>
        e.eventType === "CONVERSATION_PATH_STARTED" &&
        e.pathId === c1.id &&
        e.assistantId === uClaudia.id &&
        !!e.createdAt
    )
  );
  check(
    "1. o modo de interação fica EXPLÍCITO ao iniciar a conversa (§3)",
    (await eventos(s1.id)).some(
      (e) =>
        e.eventType === "INTERACTION_MODE_SELECTED" &&
        e.newValue?.interactionMode === "OPTION_SELECTION"
    )
  );

  // ════ 2. Criação de níveis ════
  console.log("\n2 Criação de níveis:");
  const n1 = (
    await novoNivel(s1.id, c1.id, {
      promptText: "Sobre qual assunto deseja conversar?",
      options: OPCOES_ASSUNTO,
    })
  ).json.node;
  check(
    "2. nível nasce em DRAFT, no modo OPTION_SELECTION",
    n1?.status === "DRAFT" && n1.interactionMode === "OPTION_SELECTION",
    JSON.stringify(n1)
  );
  check(
    "2. as três opções guardam a posição 1, 2 e 3",
    n1.options.length === 3 &&
      n1.options[0].position === 1 &&
      n1.options[0].label === "FAMÍLIA" &&
      n1.options[1].position === 2 &&
      n1.options[1].label === "SAÚDE" &&
      n1.options[2].position === 3 &&
      n1.options[2].label === "ROTINA",
    JSON.stringify(n1.options)
  );
  check(
    "2. o nível é a raiz do caminho e vira o nível ativo",
    n1.parentNodeId === null &&
      n1.depth === 0 &&
      (await caminho(s1.id, c1.id)).path.rootNodeId === n1.id
  );
  check(
    "2. OPTION_LEVEL_CREATED registrado com nodeId",
    (await eventos(s1.id, `&nodeId=${n1.id}`)).some(
      (e) => e.eventType === "OPTION_LEVEL_CREATED"
    )
  );

  // ════ 3. Limite de três opções e regras do nível (§6) ════
  console.log("\n3 Regras de cada nível:");
  check(
    "3. quatro opções são recusadas",
    (
      await novoNivel(s1.id, c1.id, {
        promptText: "Demais",
        options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }],
      })
    ).status === 400
  );
  check(
    "3. nenhuma opção é recusada",
    (await novoNivel(s1.id, c1.id, { promptText: "Vazio", options: [] }))
      .status === 400
  );
  check(
    "3. opção vazia ENTRE opções preenchidas é recusada",
    (
      await novoNivel(s1.id, c1.id, {
        promptText: "Buraco",
        options: [{ label: "A" }, { label: "  " }, { label: "C" }],
      })
    ).status === 400
  );
  check(
    "3. título vazio é recusado",
    (
      await novoNivel(s1.id, c1.id, {
        promptText: "   ",
        options: [{ label: "A" }],
      })
    ).status === 400
  );

  const sTrim = await novaSessao();
  const cTrim = (await novoCaminho(sTrim.id)).json.path;
  const nTrim = (
    await novoNivel(sTrim.id, cTrim.id, {
      promptText: "  Onde   dói,   exatamente?  ",
      options: [{ label: "  Cabeça  " }, { label: "Perna" }],
    })
  ).json.node;
  check(
    "3. espaços excedentes são removidos e acentos/pontuação preservados",
    nTrim.promptText === "Onde dói, exatamente?" &&
      nTrim.options[0].label === "Cabeça",
    JSON.stringify({ p: nTrim.promptText, o: nTrim.options[0].label })
  );
  // Um caminho só tem UM nível inicial: cada validação isolada usa o seu.
  const caminhoLimpo = async (sessionId) =>
    (await novoCaminho(sessionId)).json.path;

  const cUma = await caminhoLimpo(sTrim.id);
  check(
    "3. um nível aceita uma única opção",
    (
      await novoNivel(sTrim.id, cUma.id, {
        promptText: "Confirma?",
        options: [{ label: "ÚNICA" }],
      })
    ).json.node?.options.length === 1
  );
  const cDuas = await caminhoLimpo(sTrim.id);
  check(
    "3. e também duas opções",
    (
      await novoNivel(sTrim.id, cDuas.id, {
        promptText: "Onde dói?",
        options: [{ label: "CABEÇA" }, { label: "PERNA" }],
      })
    ).json.node?.options.length === 2
  );
  check(
    "3. um segundo nível inicial no MESMO caminho é recusado",
    (
      await novoNivel(sTrim.id, cUma.id, {
        promptText: "Outro início",
        options: [{ label: "X" }],
      })
    ).status === 400
  );

  // Submissão duplicada (§6, §33)
  const sDup = await novaSessao();
  const cDup = (await novoCaminho(sDup.id)).json.path;
  const dupA = await novoNivel(sDup.id, cDup.id, {
    promptText: "Assunto?",
    options: OPCOES_ASSUNTO,
    clientRequestId: "req-nivel-1",
  });
  const dupB = await novoNivel(sDup.id, cDup.id, {
    promptText: "Assunto?",
    options: OPCOES_ASSUNTO,
    clientRequestId: "req-nivel-1",
  });
  check(
    "3. submissão duplicada devolve o MESMO nível, não cria outro",
    dupA.json.node.id === dupB.json.node.id,
    `${dupA.json.node?.id} vs ${dupB.json.node?.id}`
  );
  check(
    "3. o caminho duplicado também não é criado duas vezes",
    (await novoCaminho(sDup.id, { clientRequestId: "req-caminho-1" })).json.path
      .id ===
      (await novoCaminho(sDup.id, { clientRequestId: "req-caminho-1" })).json
        .path.id
  );

  // ════ 4. Seleção provisória ════
  console.log("\n4 Seleção provisória:");
  await acaoNivel(s1.id, c1.id, n1.id, {
    kind: "REVIEW",
    promptText: n1.promptText,
  });
  await acaoNivel(s1.id, c1.id, n1.id, { kind: "PRESENT" });
  const n1Aguardando = (
    await acaoNivel(s1.id, c1.id, n1.id, { kind: "AWAIT_SELECTION" })
  ).json.node;
  check(
    "4. o nível apresentado aguarda seleção, sem opção marcada",
    n1Aguardando.status === "AWAITING_SELECTION" &&
      n1Aguardando.provisionalOptionId === null &&
      !!n1Aguardando.presentedAt
  );

  const saude = n1.options.find((o) => o.label === "SAÚDE");
  const selecionado = (
    await acaoNivel(s1.id, c1.id, n1.id, {
      kind: "SELECT_OPTION",
      optionId: saude.id,
    })
  ).json.node;
  check(
    "4. a seleção fica PROVISÓRIA e NÃO confirma sozinha",
    selecionado.status === "PROVISIONAL_SELECTION" &&
      selecionado.provisionalOptionId === saude.id &&
      selecionado.confirmedOptionId === null &&
      !!selecionado.selectedAt,
    JSON.stringify(selecionado)
  );
  check(
    "4. a seleção provisória NÃO avança para o próximo nível",
    (
      await novoNivel(s1.id, c1.id, {
        promptText: "Cedo demais",
        options: [{ label: "X" }],
        parentNodeId: n1.id,
      })
    ).status === 400
  );
  check(
    "4. OPTION_SELECTED guarda a posição e o rótulo observados",
    (await eventos(s1.id, `&nodeId=${n1.id}`)).some(
      (e) =>
        e.eventType === "OPTION_SELECTED" &&
        e.newValue?.position === 2 &&
        e.newValue?.label === "SAÚDE"
    )
  );

  // ════ 5. Correção da seleção (§12) ════
  console.log("\n5 Correção e cancelamento da seleção:");
  const rotina = n1.options.find((o) => o.label === "ROTINA");
  const corrigido = (
    await acaoNivel(s1.id, c1.id, n1.id, {
      kind: "CHANGE_OPTION",
      optionId: rotina.id,
    })
  ).json.node;
  check(
    "5. corrigir troca a opção e conta a correção",
    corrigido.provisionalOptionId === rotina.id && corrigido.correctionCount === 1
  );
  check(
    "5. a seleção anterior fica preservada na auditoria",
    (await eventos(s1.id, `&nodeId=${n1.id}`)).some(
      (e) =>
        e.eventType === "OPTION_CHANGED" &&
        e.previousValue?.label === "SAÚDE" &&
        e.newValue?.label === "ROTINA"
    )
  );
  check(
    "5. escolher de novo a MESMA opção é recusado",
    (
      await acaoNivel(s1.id, c1.id, n1.id, {
        kind: "CHANGE_OPTION",
        optionId: rotina.id,
      })
    ).status === 400
  );

  const cancelado = (
    await acaoNivel(s1.id, c1.id, n1.id, { kind: "REMOVE_SELECTION" })
  ).json.node;
  check(
    "5. cancelar a seleção volta a aguardar, mantendo o nível ativo",
    cancelado.status === "AWAITING_SELECTION" &&
      cancelado.provisionalOptionId === null,
    JSON.stringify(cancelado)
  );
  check(
    "5. OPTION_SELECTION_REMOVED preserva o que havia sido observado",
    (await eventos(s1.id, `&nodeId=${n1.id}`)).some(
      (e) =>
        e.eventType === "OPTION_SELECTION_REMOVED" &&
        e.previousValue?.label === "ROTINA"
    )
  );

  // ════ 6. Confirmação ════
  console.log("\n6 Confirmação da opção observada:");
  check(
    "6. confirmar sem seleção é recusado",
    (await acaoNivel(s1.id, c1.id, n1.id, { kind: "CONFIRM_OPTION" })).status ===
      400
  );
  await acaoNivel(s1.id, c1.id, n1.id, {
    kind: "SELECT_OPTION",
    optionId: saude.id,
  });
  const confirmado = (
    await acaoNivel(s1.id, c1.id, n1.id, { kind: "CONFIRM_OPTION" })
  ).json.node;
  check(
    "6. a confirmação registra a MESMA opção observada, com horário",
    confirmado.status === "CONFIRMED" &&
      confirmado.confirmedOptionId === saude.id &&
      confirmado.provisionalOptionId === saude.id &&
      !!confirmado.confirmedAt,
    JSON.stringify(confirmado)
  );
  check(
    "6. OPTION_CONFIRMED registrado com assistente e rótulo",
    (await eventos(s1.id, `&nodeId=${n1.id}`)).some(
      (e) =>
        e.eventType === "OPTION_CONFIRMED" &&
        e.newValue?.label === "SAÚDE" &&
        e.assistantId === uClaudia.id
    )
  );
  check(
    "6. confirmar duas vezes é recusado e não grava evento extra",
    (await acaoNivel(s1.id, c1.id, n1.id, { kind: "CONFIRM_OPTION" })).status ===
      400 &&
      (await eventos(s1.id, `&nodeId=${n1.id}`)).filter(
        (e) => e.eventType === "OPTION_CONFIRMED"
      ).length === 1
  );

  // ════ 7. Vínculo entre níveis (§11) ════
  console.log("\n7 Vínculo entre níveis:");
  const n2 = (
    await novoNivel(s1.id, c1.id, {
      promptText: "Saúde",
      options: [{ label: "DOR" }, { label: "MEDICAÇÃO" }, { label: "CONSULTA" }],
      parentNodeId: n1.id,
    })
  ).json.node;
  check(
    "7. o próximo nível nasce vinculado ao anterior, um degrau abaixo",
    n2.parentNodeId === n1.id && n2.depth === 1 && n2.status === "DRAFT",
    JSON.stringify({ parent: n2.parentNodeId, depth: n2.depth })
  );
  check(
    "7. a opção confirmada passa a apontar para o nível seguinte",
    (await caminho(s1.id, c1.id)).nodes
      .find((n) => n.id === n1.id)
      .options.find((o) => o.id === saude.id).nextNodeId === n2.id
  );
  check(
    "7. a confirmação anterior NÃO é reaproveitada no nível novo",
    n2.provisionalOptionId === null && n2.confirmedOptionId === null
  );
  check(
    "7. a mesma opção não abre um segundo nível",
    (
      await novoNivel(s1.id, c1.id, {
        promptText: "Duplicado",
        options: [{ label: "X" }],
        parentNodeId: n1.id,
      })
    ).status === 400
  );

  const sTerminal = await novaSessao();
  const cTerminal = (await novoCaminho(sTerminal.id)).json.path;
  const nTerminal = await nivelAguardando(sTerminal.id, cTerminal.id, {
    promptText: "Onde dói?",
    options: [
      { label: "CABEÇA" },
      {
        label: "PERNA",
        isTerminal: true,
        finalStatementDraft: "Estou sentindo dor na perna.",
      },
    ],
  });
  const confirmadoTerminal = await confirmaOpcao(
    sTerminal.id,
    cTerminal.id,
    nTerminal,
    2
  );
  check(
    "7. uma opção terminal guarda a frase e não abre novo nível",
    confirmadoTerminal.options[1].isTerminal === true &&
      confirmadoTerminal.options[1].finalStatementDraft ===
        "Estou sentindo dor na perna." &&
      (
        await novoNivel(sTerminal.id, cTerminal.id, {
          promptText: "Não deveria abrir",
          options: [{ label: "X" }],
          parentNodeId: nTerminal.id,
        })
      ).status === 400
  );
  check(
    "7. frase final em opção NÃO terminal é recusada",
    (
      await novoNivel(sTerminal.id, cTerminal.id, {
        promptText: "Inválido",
        options: [{ label: "A", finalStatementDraft: "não deveria" }],
      })
    ).status === 400
  );

  // ════ 19. Conteúdo sensível (§21) ════
  console.log("\n19 Conteúdo sensível:");
  const sSens = await novaSessao();
  const cSens = (await novoCaminho(sSens.id)).json.path;
  const nSens = (
    await novoNivel(sSens.id, cSens.id, {
      promptText: "Sobre o tratamento",
      options: [{ label: "CONTINUAR" }, { label: "INTERROMPER" }],
      isSensitive: true,
      sensitiveCategory: "MEDICAL",
    })
  ).json.node;
  check(
    "19. o nível preserva a marcação e a categoria sensível",
    nSens.isSensitive === true && nSens.sensitiveCategory === "MEDICAL"
  );
  check(
    "19. categoria sensível sem a marcação é recusada",
    (
      await novoNivel(sSens.id, cSens.id, {
        promptText: "Inválido",
        options: [{ label: "A" }],
        sensitiveCategory: "LEGAL",
      })
    ).status === 400
  );
  check(
    "19. categoria inválida é recusada",
    (
      await novoNivel(sSens.id, cSens.id, {
        promptText: "Inválido",
        options: [{ label: "A" }],
        isSensitive: true,
        sensitiveCategory: "NAO_EXISTE",
      })
    ).status === 400
  );
  const cSensOpcao = (await novoCaminho(sSens.id)).json.path;
  check(
    "19. uma OPÇÃO pode ser sensível por conta própria",
    (
      await novoNivel(sSens.id, cSensOpcao.id, {
        promptText: "Opção sensível",
        options: [
          { label: "A" },
          { label: "B", isSensitive: true, sensitiveCategory: "FINANCIAL" },
        ],
      })
    ).json.node?.options[1].sensitiveCategory === "FINANCIAL"
  );

  // ════ Guardas de sessão (§33) ════
  console.log("\nGuardas de sessão e de caminho:");
  const sPausa = await novaSessao();
  const cPausa = (await novoCaminho(sPausa.id)).json.path;
  const nPausa = await nivelAguardando(sPausa.id, cPausa.id, {
    promptText: "Assunto?",
    options: OPCOES_ASSUNTO,
  });
  await acaoSessao(sPausa.id, "PAUSE");
  check(
    "sessão pausada não aceita seleção",
    (
      await acaoNivel(sPausa.id, cPausa.id, nPausa.id, {
        kind: "SELECT_OPTION",
        optionId: nPausa.options[0].id,
      })
    ).status === 400
  );
  await acaoSessao(sPausa.id, "RESUME");
  check(
    "retomada, a seleção volta a ser aceita",
    (
      await acaoNivel(sPausa.id, cPausa.id, nPausa.id, {
        kind: "SELECT_OPTION",
        optionId: nPausa.options[0].id,
      })
    ).status === 200
  );
  check(
    "a seleção interrompida por pausa continua PROVISÓRIA",
    (await caminho(sPausa.id, cPausa.id)).nodes.find((n) => n.id === nPausa.id)
      .confirmedOptionId === null
  );

  const cPausaCaminho = (await novoCaminho(sPausa.id)).json.path;
  await claudia.patch(`${RTQ}/paths`, {
    patientId: pFabio,
    sessionId: sPausa.id,
    pathId: cPausaCaminho.id,
    action: { kind: "PAUSE" },
  });
  check(
    "caminho pausado não aceita apresentar nível",
    (
      await novoNivel(sPausa.id, cPausaCaminho.id, {
        promptText: "Assunto?",
        options: OPCOES_ASSUNTO,
      })
    ).status === 200 // criar rascunho é permitido…
  );
  const nCaminhoPausado = (await caminho(sPausa.id, cPausaCaminho.id)).nodes[0];
  await acaoNivel(sPausa.id, cPausaCaminho.id, nCaminhoPausado.id, {
    kind: "REVIEW",
    promptText: nCaminhoPausado.promptText,
  });
  check(
    "…mas apresentar ao paciente é bloqueado enquanto o caminho está pausado",
    (
      await acaoNivel(sPausa.id, cPausaCaminho.id, nCaminhoPausado.id, {
        kind: "PRESENT",
      })
    ).status === 400
  );

  const sConcl = await novaSessao();
  await acaoSessao(sConcl.id, "COMPLETE");
  check(
    "sessão concluída não aceita nova conversa por opções",
    (await novoCaminho(sConcl.id)).status === 400
  );

  // ════ 29. Isolamento entre pacientes ════
  console.log("\n29 Isolamento entre pacientes:");
  check(
    "29. usuário sem vínculo não cria caminho no paciente (403)",
    (
      await marcos.post(`${RTQ}/paths`, {
        patientId: pFabio,
        sessionId: s1.id,
      })
    ).status === 403
  );
  check(
    "29. usuário sem vínculo não lê os caminhos do paciente (403)",
    (
      await marcos.get(
        `${RTQ}/paths?patientId=${pFabio}&sessionId=${s1.id}`
      )
    ).status === 403
  );
  check(
    "29. troca manual de identificador não alcança o caminho de outro paciente",
    (
      await marcos.get(
        `${RTQ}/paths?patientId=${pRoberto}&sessionId=${s1.id}&pathId=${c1.id}`
      )
    ).status === 404
  );
  check(
    "29. nem age sobre um nível de outro paciente",
    (
      await marcos.patch(`${RTQ}/nodes`, {
        patientId: pRoberto,
        sessionId: s1.id,
        pathId: c1.id,
        nodeId: n1.id,
        action: { kind: "AWAIT_SELECTION" },
      })
    ).status === 400
  );
  check(
    "29. nem lê a trilha de auditoria do outro paciente",
    (
      await marcos.get(
        `${RTQ}/events?patientId=${pFabio}&sessionId=${s1.id}`
      )
    ).status === 403
  );

  // ════ 30. Trilha de auditoria ════
  console.log("\n30 Trilha de auditoria:");
  const trilha = await eventos(s1.id);
  check(
    "30. todos os eventos têm sessão, paciente, assistente e horário",
    trilha.length > 0 &&
      trilha.every(
        (e) =>
          e.sessionId === s1.id &&
          e.patientId === pFabio &&
          !!e.assistantId &&
          !!e.createdAt
      )
  );
  check(
    "30. os eventos da conversa por opções carregam pathId e nodeId",
    trilha.some((e) => e.eventType === "OPTION_CONFIRMED" && e.pathId === c1.id && e.nodeId === n1.id)
  );
  check(
    "30. a trilha está em ordem cronológica",
    trilha.every(
      (e, i) => i === 0 || trilha[i - 1].createdAt <= e.createdAt
    )
  );
  check(
    "30. o filtro por nível recorta a trilha",
    (await eventos(s1.id, `&nodeId=${n1.id}`)).every((e) => e.nodeId === n1.id)
  );
  check(
    "30. a trilha é somente leitura para o cliente (sem rota de escrita)",
    (
      await claudia.post(`${RTQ}/events`, {
        patientId: pFabio,
        sessionId: s1.id,
        eventType: "OPTION_CONFIRMED",
      })
    ).status === 405
  );
  check(
    "30. eventos anteriores não são sobrescritos por eventos novos",
    (await eventos(s1.id)).length >= trilha.length
  );

  // ════ Compatibilidade com as Fases 1–4 ════
  console.log("\nCompatibilidade com as Fases 1–4:");
  const sCompat = await novaSessao();
  const tCompat = (
    await claudia.post(`${RTQ}/turns`, {
      patientId: pFabio,
      sessionId: sCompat.id,
      text: "O senhor está com sede?",
    })
  ).json.turn;
  check(
    "a pergunta fechada continua nascendo em CLOSED_CONFIRMATION",
    tCompat.status === "DRAFT" &&
      tCompat.interactionMode === "CLOSED_CONFIRMATION",
    JSON.stringify(tCompat.interactionMode)
  );
  check(
    "perguntas fechadas e conversa por opções convivem na mesma sessão",
    (await novoCaminho(sCompat.id)).status === 200
  );

  console.log(`\n${passed} passaram · ${failed} falharam`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
