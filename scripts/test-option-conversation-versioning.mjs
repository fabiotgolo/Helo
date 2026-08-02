// ——— Conversa por opções: edição, substituição e versionamento (§36) ———
// Cobre os casos 14, 15, 26, 27 e 28 da especificação.
//
// A regra verificada aqui é a mais dura do produto: NADA apresentado ao
// paciente é reescrito. Antes da apresentação, edita-se o mesmo rascunho;
// depois dela, só existe versão corrigida — registro novo, original intacto, e
// nenhuma resposta migrando de um para o outro.
//
//   npm run test:oc:versioning

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

  // ════ 14. Edição ANTES da apresentação: mesmo registro ════
  console.log("14 Edição antes da apresentação:");
  const s1 = await novaSessao();
  const c1 = await novoCaminho(s1.id);
  const n1 = (
    await novoNivel(s1.id, c1.id, {
      promptText: "Sobre o que falar?",
      options: [{ label: "FAMILIA" }, { label: "SAUDE" }],
      clientRequestId: rid("node"),
    })
  ).json.node;

  const revisado = (
    await acaoNivel(s1.id, c1.id, n1.id, {
      kind: "REVIEW",
      promptText: "Sobre qual assunto deseja conversar?",
      options: [{ label: "FAMÍLIA" }, { label: "SAÚDE" }, { label: "ROTINA" }],
    })
  ).json.node;
  check(
    "14. a edição no rascunho altera o MESMO registro",
    revisado.id === n1.id &&
      revisado.status === "REVIEWED" &&
      revisado.promptText === "Sobre qual assunto deseja conversar?" &&
      revisado.options.map((o) => o.label).join("|") === "FAMÍLIA|SAÚDE|ROTINA",
    JSON.stringify(revisado.options.map((o) => o.label))
  );
  check(
    "14. OPTION_LEVEL_REVIEWED guarda o valor anterior e o novo",
    (await eventos(s1.id, `&nodeId=${n1.id}`)).some(
      (e) =>
        e.eventType === "OPTION_LEVEL_REVIEWED" &&
        e.previousValue?.promptText === "Sobre o que falar?" &&
        e.newValue?.promptText === "Sobre qual assunto deseja conversar?"
    )
  );
  check(
    "14. a edição respeita o limite de três opções",
    (
      await acaoNivel(s1.id, c1.id, n1.id, {
        kind: "REVIEW",
        options: [
          { label: "A" },
          { label: "B" },
          { label: "C" },
          { label: "D" },
        ],
      })
    ).status === 400
  );
  check(
    "14. o caminho continua com um nível só — editar não cria outro",
    (await caminho(s1.id, c1.id)).nodes.length === 1
  );

  // Frase: edição antes de apresentar
  const sF = await novaSessao();
  const cF = await novoCaminho(sF.id);
  const fRascunho = (
    await novaFrase(sF.id, cF.id, {
      text: "Estou com dor.",
      clientRequestId: rid("stmt"),
    })
  ).json.statement;
  const fEditada = (
    await acaoFrase(sF.id, cF.id, fRascunho.id, {
      kind: "EDIT",
      text: "Estou sentindo dor na perna.",
    })
  ).json.statement;
  check(
    "14. a frase em construção é editada no MESMO registro",
    fEditada.id === fRascunho.id &&
      fEditada.currentText === "Estou sentindo dor na perna." &&
      fEditada.originalDraft === "Estou com dor." &&
      fEditada.editCount === 1,
    JSON.stringify(fEditada)
  );
  check(
    "14. o texto original permanece guardado em originalDraft",
    fEditada.originalDraft === "Estou com dor."
  );

  // ════ 15. Substituição APÓS a apresentação ════
  console.log("\n15 Substituição após a apresentação:");
  await acaoNivel(s1.id, c1.id, n1.id, { kind: "PRESENT" });
  await acaoNivel(s1.id, c1.id, n1.id, { kind: "AWAIT_SELECTION" });
  check(
    "15. depois de apresentado, editar o mesmo registro é RECUSADO",
    (
      await acaoNivel(s1.id, c1.id, n1.id, {
        kind: "REVIEW",
        promptText: "Tentativa de reescrever",
      })
    ).status === 400
  );

  const apresentadoAntes = (await caminho(s1.id, c1.id)).nodes.find(
    (n) => n.id === n1.id
  );
  const substituicao = (
    await novoNivel(s1.id, c1.id, {
      replaceNodeId: n1.id,
      clientRequestId: rid("replace"),
    })
  ).json;
  check(
    "15. a versão corrigida nasce em DRAFT, vinculada ao original",
    substituicao.created.status === "DRAFT" &&
      substituicao.created.replacesNodeId === n1.id &&
      substituicao.created.id !== n1.id,
    JSON.stringify(substituicao.created)
  );
  check(
    "15. o original é marcado como substituído e aponta para a nova versão",
    substituicao.original.status === "REPLACED" &&
      substituicao.original.replacedByNodeId === substituicao.created.id &&
      !!substituicao.original.replacedAt
  );
  check(
    "15. a versão corrigida copia o texto e as opções, com ids de opção NOVOS",
    substituicao.created.promptText === apresentadoAntes.promptText &&
      substituicao.created.options.map((o) => o.label).join("|") ===
        apresentadoAntes.options.map((o) => o.label).join("|") &&
      substituicao.created.options.every(
        (o) => !apresentadoAntes.options.some((a) => a.id === o.id)
      )
  );
  check(
    "15. a versão corrigida NÃO herda seleção nem confirmação",
    substituicao.created.provisionalOptionId === null &&
      substituicao.created.confirmedOptionId === null
  );
  check(
    "15. OPTION_LEVEL_EDIT_REQUESTED e OPTION_LEVEL_REPLACED registrados",
    (await eventos(s1.id, `&nodeId=${n1.id}`)).some(
      (e) => e.eventType === "OPTION_LEVEL_EDIT_REQUESTED"
    ) &&
      (await eventos(s1.id, `&nodeId=${n1.id}`)).some(
        (e) => e.eventType === "OPTION_LEVEL_REPLACED"
      )
  );
  check(
    "15. a versão corrigida abre uma ramificação nova",
    substituicao.created.branchId !== apresentadoAntes.branchId
  );

  // Corrigir de fato o texto de uma opção (§29: SAÚDE → DOR|REMÉDIOS|CONSULTA)
  const corrigido = (
    await acaoNivel(s1.id, c1.id, substituicao.created.id, {
      kind: "REVIEW",
      options: [{ label: "FAMÍLIA" }, { label: "SAÚDE" }, { label: "LAZER" }],
    })
  ).json.node;
  check(
    "15. a versão corrigida é editável, sendo um rascunho",
    corrigido.options.map((o) => o.label).join("|") === "FAMÍLIA|SAÚDE|LAZER"
  );

  // ════ 26. Nenhuma alteração retroativa ════
  console.log("\n26 Ausência de alteração retroativa:");
  const depoisDeCorrigir = (await caminho(s1.id, c1.id)).nodes.find(
    (n) => n.id === n1.id
  );
  check(
    "26. o nível ORIGINAL continua com o texto que o paciente viu",
    depoisDeCorrigir.promptText === apresentadoAntes.promptText &&
      depoisDeCorrigir.options.map((o) => o.label).join("|") ===
        "FAMÍLIA|SAÚDE|ROTINA",
    JSON.stringify(depoisDeCorrigir.options.map((o) => o.label))
  );
  check(
    "26. o original permanece no banco — substituir não exclui",
    !!depoisDeCorrigir && depoisDeCorrigir.status === "REPLACED"
  );

  // Frase apresentada e confirmada: a confirmação continua valendo para ela
  const sC = await novaSessao();
  const cC = await novoCaminho(sC.id);
  const fOrig = (
    await novaFrase(sC.id, cC.id, {
      text: "Estou sentindo dor na perna.",
      clientRequestId: rid("stmt"),
    })
  ).json.statement;
  await acaoFrase(sC.id, cC.id, fOrig.id, { kind: "EDIT", text: fOrig.currentText });
  await acaoFrase(sC.id, cC.id, fOrig.id, { kind: "PRESENT" });
  await acaoFrase(sC.id, cC.id, fOrig.id, { kind: "RESPOND", response: "YES" });
  const confirmadaOrig = (
    await acaoFrase(sC.id, cC.id, fOrig.id, { kind: "CONFIRM" })
  ).json.statement;
  check(
    "26. a frase original foi confirmada",
    confirmadaOrig.status === "CONFIRMED" &&
      confirmadaOrig.confirmedResponse === "YES"
  );
  check(
    "26. editar uma frase apresentada é RECUSADO",
    (
      await acaoFrase(sC.id, cC.id, fOrig.id, {
        kind: "EDIT",
        text: "Reescrita indevida",
      })
    ).status === 400
  );

  const substFrase = (
    await novaFrase(sC.id, cC.id, {
      replaceStatementId: fOrig.id,
      clientRequestId: rid("replace-stmt"),
    })
  ).json;
  check(
    "26. mesmo confirmada, a frase pode originar uma versão nova",
    substFrase.created.status === "DRAFT" &&
      substFrase.created.replacesStatementId === fOrig.id
  );
  check(
    "26. a confirmação original continua válida para o texto original",
    substFrase.original.status === "REPLACED" &&
      substFrase.original.confirmedResponse === "YES" &&
      !!substFrase.original.confirmedAt,
    JSON.stringify(substFrase.original)
  );
  check(
    "26. a nova versão NÃO herda a resposta nem a confirmação",
    substFrase.created.provisionalResponse === null &&
      substFrase.created.confirmedResponse === null &&
      substFrase.created.presentedAt === null &&
      substFrase.created.confirmedAt === null,
    JSON.stringify(substFrase.created)
  );
  check(
    "26. a nova versão exige apresentação e confirmação próprias",
    (
      await acaoFrase(sC.id, substFrase.path.id, substFrase.created.id, {
        kind: "CONFIRM",
      })
    ).status === 400
  );
  check(
    "26. FINAL_STATEMENT_EDIT_REQUESTED e FINAL_STATEMENT_REPLACED registrados",
    (await eventos(sC.id, `&statementId=${fOrig.id}`)).some(
      (e) => e.eventType === "FINAL_STATEMENT_EDIT_REQUESTED"
    ) &&
      (await eventos(sC.id, `&statementId=${fOrig.id}`)).some(
        (e) => e.eventType === "FINAL_STATEMENT_REPLACED"
      )
  );

  // ════ 27. Vínculos reusedFrom e replaces ════
  console.log("\n27 Vínculos de reutilização e substituição:");
  check(
    "27. replacesNodeId ↔ replacedByNodeId formam o par completo",
    substituicao.created.replacesNodeId === n1.id &&
      substituicao.original.replacedByNodeId === substituicao.created.id
  );
  check(
    "26. a versão corrigida nasce num caminho NOVO, sem reabrir o concluído",
    substFrase.path.id !== cC.id &&
      substFrase.path.status === "ACTIVE" &&
      substFrase.path.reusedFromPathId === cC.id,
    JSON.stringify(substFrase.path)
  );

  check(
    "27. replacesStatementId ↔ replacedByStatementId formam o par completo",
    substFrase.created.replacesStatementId === fOrig.id &&
      substFrase.original.replacedByStatementId === substFrase.created.id
  );
  const reuso = (
    await claudia.post(`${RTQ}/nodes`, {
      patientId: pFabio,
      sessionId: s1.id,
      reuseFromNodeId: n1.id,
      clientRequestId: rid("reuse"),
    })
  ).json;
  check(
    "27. reusedFromNodeId aponta para a origem, num caminho NOVO",
    reuso.node.reusedFromNodeId === n1.id &&
      reuso.path.id !== c1.id &&
      reuso.path.reusedFromPathId === c1.id,
    JSON.stringify({ no: reuso.node.reusedFromNodeId, caminho: reuso.path.id })
  );
  check(
    "27. um nível não pode substituir a si mesmo",
    substituicao.created.replacesNodeId !== substituicao.created.id
  );

  // ════ 28. Prevenção de duplicação ════
  console.log("\n28 Prevenção de duplicação:");
  // Só um nível JÁ APRESENTADO pode ser substituído; um rascunho se edita.
  check(
    "28. substituir um RASCUNHO é recusado — rascunho se edita, não se versiona",
    (
      await novoNivel(s1.id, c1.id, {
        replaceNodeId: substituicao.created.id,
        clientRequestId: rid("replace"),
      })
    ).status === 400
  );

  await acaoNivel(s1.id, c1.id, substituicao.created.id, {
    kind: "REVIEW",
    promptText: corrigido.promptText,
  });
  await acaoNivel(s1.id, c1.id, substituicao.created.id, { kind: "PRESENT" });

  const antesSubst = (await caminho(s1.id, c1.id)).nodes.length;
  const substA = await novoNivel(s1.id, c1.id, {
    replaceNodeId: substituicao.created.id,
    clientRequestId: "replace-duplo",
  });
  const substB = await novoNivel(s1.id, c1.id, {
    replaceNodeId: substituicao.created.id,
    clientRequestId: "replace-duplo",
  });
  check(
    "28. duas substituições com o mesmo pedido geram UM registro",
    substA.json.created?.id === substB.json.created?.id &&
      (await caminho(s1.id, c1.id)).nodes.length === antesSubst + 1,
    `${antesSubst} → ${(await caminho(s1.id, c1.id)).nodes.length}`
  );
  const reuseA = await claudia.post(`${RTQ}/statements`, {
    patientId: pFabio,
    sessionId: sC.id,
    reuseFromStatementId: fOrig.id,
    clientRequestId: "reuse-frase-duplo",
  });
  const reuseB = await claudia.post(`${RTQ}/statements`, {
    patientId: pFabio,
    sessionId: sC.id,
    reuseFromStatementId: fOrig.id,
    clientRequestId: "reuse-frase-duplo",
  });
  check(
    "28. duas reutilizações com o mesmo pedido geram UMA frase",
    reuseA.json.statement.id === reuseB.json.statement.id,
    `${reuseA.json.statement?.id} vs ${reuseB.json.statement?.id}`
  );
  check(
    "28. e um caminho só",
    reuseA.json.path.id === reuseB.json.path.id
  );
  check(
    "28. a rota não aceita MARK_REPLACED direto do cliente",
    (
      await acaoNivel(s1.id, c1.id, n1.id, {
        kind: "MARK_REPLACED",
        replacedByNodeId: "forjado",
      })
    ).status === 400
  );

  console.log(`\n${passed} passaram · ${failed} falharam`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
