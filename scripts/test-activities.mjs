// ——— Testes obrigatórios das Atividades (seção 35 do requisito) ———
// Roda contra o dev server + emulador do Firestore. NUNCA rode contra
// produção: o script LIMPA o banco do emulador antes de começar.
//
//   npm run emu          (terminal 1)
//   npm run dev          (terminal 2)
//   node scripts/test-activities.mjs http://localhost:3000

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";

// PNG 1×1 válido — suficiente para o fluxo de upload/serviço de mídia.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
    /** GET bruto (mídia): status + content-type + tamanho, sem parse JSON. */
    async raw(path) {
      const r = await fetch(`${BASE}${path}`, {
        headers: cookie ? { cookie } : {},
      });
      const buf = await r.arrayBuffer();
      return {
        status: r.status,
        contentType: r.headers.get("content-type") ?? "",
        cacheControl: r.headers.get("cache-control") ?? "",
        bytes: buf.byteLength,
      };
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
  const paula = client();
  const semVinculo = client();

  // ════ Preparação: usuários, pacientes, vínculos ════
  console.log("Preparação (usuários, pacientes, vínculos):");
  const boot = await admin.post("/api/auth/bootstrap", {
    name: "Admin",
    email: "admin@helo.test",
    password: "senha-admin-123",
  });
  check("bootstrap do admin", boot.status === 200);

  async function createUser(c, name, email, role, professionalType) {
    const r = await admin.post("/api/admin/users", {
      name,
      email,
      password: "senha-teste-123",
      role,
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

  const uClaudia = await createUser(claudia, "Claudia", "claudia@helo.test", "profissional", "fonoaudiologo");
  const uMarcos = await createUser(marcos, "Marcos", "marcos@helo.test", "profissional", "terapeuta");
  const uFamiliar = await createUser(familiar, "Familiar A", "familiar@helo.test", "familiar", null);
  const uPaula = await createUser(paula, "Paula", "paula@helo.test", "profissional", "terapeuta_ocupacional");
  await createUser(semVinculo, "Sofia", "sofia@helo.test", "profissional", "medico");

  const pFabio = (await admin.post("/api/patients", { name: "Dr. Fábio" })).json.patient.id;
  await sleep(5);
  const pRoberto = (await admin.post("/api/patients", { name: "Sr. Roberto" })).json.patient.id;

  const FULL = [
    "viewDashboard", "viewSessions", "viewMetrics", "createSession",
    "viewActivities", "runActivities", "createActivities", "editActivities",
    "deleteActivities", "viewActivityResults",
  ];
  async function link(user, patientId, permissions) {
    const r = await admin.post("/api/admin/access", {
      userId: user.id,
      patientId,
      permissions,
    });
    check(`vínculo ${user.name} ↔ ${patientId === pFabio ? "Dr. Fábio" : "Sr. Roberto"}`, r.status === 200);
  }
  await link(uClaudia, pFabio, FULL);
  await link(uClaudia, pRoberto, FULL);
  // Marcos: executa e vê resultados — NÃO cria nem edita (seção 12).
  await link(uMarcos, pFabio, ["viewDashboard", "viewActivities", "runActivities", "viewActivityResults"]);
  // Familiar: vê e executa — sem resultados detalhados, sem mídia própria.
  await link(uFamiliar, pFabio, ["viewDashboard", "viewActivities", "runActivities"]);
  // Paula: vínculo com permissões PADRÃO do papel profissional.
  await link(uPaula, pFabio, undefined);

  // ════ 1–5 ENTRETENIMENTO ════
  console.log("\nEntretenimento e memórias:");
  const up = await claudia.post("/api/media", {
    patientId: pFabio,
    name: "capa-livro.png",
    contentType: "image/png",
    dataBase64: PNG_BASE64,
  });
  check("upload da foto do livro", up.status === 200 && up.json.media?.id, JSON.stringify(up.json));
  const mediaId = up.json.media.id;

  const tLivro = await claudia.post("/api/activities", {
    patientId: pFabio,
    template: {
      title: "Meu Livro",
      description: "A capa do livro escrito pelo Dr. Fábio",
      category: "entretenimento",
      items: [
        {
          title: "A capa do livro",
          text: "Este é o livro que o senhor escreveu.",
          media: [{ kind: "imagem", mediaId, url: null, caption: "Capa" }],
          question: "",
          options: [],
        },
      ],
    },
  });
  check("criar sessão com foto de livro", tLivro.status === 200, JSON.stringify(tLivro.json));
  check(
    "item de memória NÃO vira teste (sem gestos/opções)",
    tLivro.json.template.items[0].gesturesEnabled === false &&
      tLivro.json.template.items[0].options.length === 0
  );

  const abre = await claudia.get(`/api/activities?patientId=${pFabio}`);
  check(
    "abrir sessão (aparece na lista do paciente)",
    abre.status === 200 && abre.json.templates.some((t) => t.title === "Meu Livro")
  );
  const img = await claudia.raw(`/api/media?patientId=${pFabio}&id=${mediaId}`);
  check(
    "visualizar imagem (bytes + content-type + cache privado)",
    img.status === 200 && img.contentType === "image/png" && img.bytes > 50 &&
      img.cacheControl.includes("private"),
    JSON.stringify(img)
  );

  const tVideo = await claudia.post("/api/activities", {
    patientId: pFabio,
    template: {
      title: "Meu Aniversário",
      category: "memorias",
      items: [
        {
          title: "A festa de 70 anos",
          media: [
            { kind: "youtube", mediaId: null, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
          ],
          question: "",
          options: [],
        },
      ],
    },
  });
  check("criar sessão com vídeo (YouTube)", tVideo.status === 200);
  check(
    "URL do vídeo preservada para o player",
    tVideo.json.template.items[0].media[0].kind === "youtube" &&
      tVideo.json.template.items[0].media[0].url.includes("youtube.com")
  );

  // ════ 6–11 RECONHECIMENTO ════
  console.log("\nReconhecimento e associação:");
  const upNeto = await claudia.post("/api/media", {
    patientId: pFabio,
    name: "neto.png",
    contentType: "image/png",
    dataBase64: PNG_BASE64,
  });
  check("adicionar foto de familiar", upNeto.status === 200);
  const tRec = await claudia.post("/api/activities", {
    patientId: pFabio,
    template: {
      title: "Reconhecimento dos Netos",
      category: "reconhecimento",
      items: [
        {
          media: [{ kind: "imagem", mediaId: upNeto.json.media.id, url: null }],
          question: "Qual é o nome dele?",
          options: [
            { id: "pedro", label: "Pedro" },
            { id: "renato", label: "Renato" },
            { id: "gilberto", label: "Gilberto" },
          ],
          correctOptionId: "pedro",
        },
      ],
    },
  });
  check(
    "pergunta + três opções + resposta correta",
    tRec.status === 200 &&
      tRec.json.template.items[0].options.length === 3 &&
      tRec.json.template.items[0].correctOptionId === "pedro" &&
      tRec.json.template.items[0].gesturesEnabled === true
  );
  const recId = tRec.json.template.id;
  const recItemId = tRec.json.template.items[0].id;

  const run1 = await claudia.post("/api/activities/runs", {
    patientId: pFabio,
    templateId: recId,
  });
  check(
    "iniciar sessão cria run com snapshot",
    run1.status === 200 && run1.json.run.items.length === 1 &&
      run1.json.run.operatorId === uClaudia.id
  );
  const resp1 = await claudia.post("/api/activities/responses", {
    patientId: pFabio,
    runId: run1.json.run.id,
    itemId: recItemId,
    // Gesto POR alternativa: 👍 no Pedro, ✊ nos outros.
    optionGestures: [
      { optionId: "pedro", gesture: "sim" },
      { optionId: "renato", gesture: "nao" },
      { optionId: "gilberto", gesture: "nao" },
    ],
    responseTimeMs: 2300,
  });
  check(
    "gesto por alternativa + opção afirmada derivada (separados)",
    resp1.status === 200 &&
      resp1.json.response.selectedOptionId === "pedro" &&
      resp1.json.response.optionGestures.length === 3 &&
      resp1.json.response.optionGestures.find((g) => g.optionId === "pedro")?.gesture === "sim" &&
      resp1.json.response.correctness === "correta" &&
      resp1.json.response.responseTimeMs === 2300,
    JSON.stringify(resp1.json)
  );
  check(
    "👍 numa alternativa NÃO vira gesto único da resposta (conceitos separados)",
    resp1.json.response.optionGestures.filter((g) => g.gesture === "nao").length === 2
  );
  await claudia.patch("/api/activities/runs", {
    patientId: pFabio,
    runId: run1.json.run.id,
    status: "concluida",
  });

  // ════ 12–15 TREINO ════
  console.log("\nTreino:");
  const tTreino = await claudia.post("/api/activities", {
    patientId: pFabio,
    template: {
      title: "Treino de Identificação",
      category: "treino",
      items: [
        {
          question: "Qual é o seu nome?",
          options: [
            { id: "fabio", label: "Dr. Fábio" },
            { id: "jose", label: "José" },
            { id: "antonio", label: "Antonio" },
          ],
          correctOptionId: "fabio",
        },
      ],
    },
  });
  check("criar pergunta com três respostas", tTreino.status === 200);
  const treinoId = tTreino.json.template.id;
  const treinoItem = tTreino.json.template.items[0].id;

  async function runTreino(c, optionGestures) {
    const run = await c.post("/api/activities/runs", {
      patientId: pFabio,
      templateId: treinoId,
    });
    const resp = await c.post("/api/activities/responses", {
      patientId: pFabio,
      runId: run.json.run.id,
      itemId: treinoItem,
      optionGestures,
      responseTimeMs: 1500,
    });
    await c.patch("/api/activities/runs", {
      patientId: pFabio,
      runId: run.json.run.id,
      status: "concluida",
    });
    return { run: run.json.run, resp: resp.json.response };
  }
  const t1 = await runTreino(claudia, [{ optionId: "jose", gesture: "sim" }]);
  check("👍 numa alternativa errada → incorreta", t1.resp.correctness === "incorreta");
  const t2 = await runTreino(claudia, [{ optionId: "fabio", gesture: "talvez" }]);
  check('qualquer "talvez" → incerta (nunca erro automático)', t2.resp.correctness === "incerta");
  const t3 = await runTreino(claudia, [
    { optionId: "fabio", gesture: "nao" },
    { optionId: "jose", gesture: "nao" },
    { optionId: "antonio", gesture: "nao" },
  ]);
  check("só recusas (nenhum sim/talvez) → não respondida", t3.resp.correctness === "nao_respondida");
  const t4 = await runTreino(claudia, [{ optionId: "fabio", gesture: "sim" }]);
  check("👍 só na alternativa certa → correta", t4.resp.correctness === "correta");
  const t5 = await runTreino(claudia, [
    { optionId: "fabio", gesture: "sim" },
    { optionId: "jose", gesture: "sim" },
  ]);
  check("dois 👍 (ambiguidade) → incerta", t5.resp.correctness === "incerta");

  // ════ 16–20 EXERCÍCIO COGNITIVO + Dashboard ════
  console.log("\nExercício cognitivo e Dashboard:");
  const tEx = await claudia.post("/api/activities", {
    patientId: pFabio,
    template: {
      title: "Exercícios de Memória",
      category: "exercicio",
      items: [
        {
          question: "Em que cidade você mora?",
          options: [
            { id: "sp", label: "São Paulo" },
            { id: "rj", label: "Rio de Janeiro" },
            { id: "bh", label: "Belo Horizonte" },
          ],
          correctOptionId: "sp",
        },
        {
          question: "Qual destes objetos é um telefone?",
          options: [
            { id: "tel", label: "O da esquerda" },
            { id: "liv", label: "O do meio" },
            { id: "cop", label: "O da direita" },
          ],
          correctOptionId: "tel",
        },
      ],
    },
  });
  check("criar exercício estruturado (2 itens)", tEx.status === 200);
  const exId = tEx.json.template.id;
  const exItems = tEx.json.template.items.map((i) => i.id);
  for (let n = 0; n < 2; n++) {
    const run = await claudia.post("/api/activities/runs", {
      patientId: pFabio,
      templateId: exId,
    });
    for (const [j, itemId] of exItems.entries()) {
      await claudia.post("/api/activities/responses", {
        patientId: pFabio,
        runId: run.json.run.id,
        itemId,
        optionGestures: [
          { optionId: j === 0 ? "sp" : "tel", gesture: n === 0 ? "sim" : "talvez" },
        ],
        responseTimeMs: 1000 + n * 500,
      });
    }
    await claudia.patch("/api/activities/runs", {
      patientId: pFabio,
      runId: run.json.run.id,
      status: "concluida",
    });
  }
  check("executar várias vezes", true);

  const dash = await claudia.get(
    `/api/activities/runs?patientId=${pFabio}&period=hoje`
  );
  const totals = dash.json?.stats?.totals;
  // Até aqui: 1 reconhecimento + 5 treinos + 2 exercícios = 8 sessões;
  // respostas: 1 + 5 + (2 execuções × 2 itens) = 10.
  check(
    "resultados no Dashboard (sessões + respostas persistidas)",
    dash.status === 200 && totals.sessoes === 8 && totals.respostas === 10,
    JSON.stringify(totals)
  );
  check(
    "métricas reais: corretas/incorretas/incertas/não respondidas",
    totals.corretas >= 2 && totals.incorretas >= 1 && totals.incertas >= 1 && totals.naoRespondidas >= 1
  );
  check(
    "gráfico só com dados reais (porDia e porHora preenchidos)",
    dash.json.stats.porDia.length >= 1 && dash.json.stats.porHora.length >= 1
  );
  check(
    "distribuição de gestos registrada",
    totals.gestos.sim >= 2 && totals.gestos.talvez >= 1 && totals.gestos.nao >= 1
  );
  check(
    "tempo médio de resposta calculado",
    typeof totals.tempoMedioMs === "number" && totals.tempoMedioMs > 0
  );
  check(
    "filtro por template funciona",
    (await claudia.get(`/api/activities/runs?patientId=${pFabio}&period=hoje&templateId=${exId}`)).json.stats.totals.sessoes === 2
  );
  check(
    "filtro por categoria funciona",
    (await claudia.get(`/api/activities/runs?patientId=${pFabio}&period=hoje&category=treino`)).json.stats.totals.sessoes === 5
  );

  // ════ 21–24 PERMISSÕES ════
  console.log("\nPermissões:");
  check("profissional autorizado cria template (Claudia)", tEx.status === 200);
  check(
    "profissional SEM permissão não cria (Marcos → 403)",
    (
      await marcos.post("/api/activities", {
        patientId: pFabio,
        template: { title: "X", category: "treino", items: [] },
      })
    ).status === 403
  );
  check(
    "vínculo padrão de profissional NÃO cria (Paula → 403)",
    (
      await paula.post("/api/activities", {
        patientId: pFabio,
        template: { title: "X", category: "treino", items: [] },
      })
    ).status === 403
  );
  check(
    "vínculo padrão VÊ atividades (Paula → 200)",
    (await paula.get(`/api/activities?patientId=${pFabio}`)).status === 200
  );
  check(
    "Marcos não edita (403)",
    (
      await marcos.patch("/api/activities", {
        patientId: pFabio,
        templateId: treinoId,
        template: { title: "Hack" },
      })
    ).status === 403
  );
  check(
    "Marcos não exclui (403)",
    (await marcos.del("/api/activities", { patientId: pFabio, templateId: treinoId })).status === 403
  );
  const runMarcos = await marcos.post("/api/activities/runs", {
    patientId: pFabio,
    templateId: recId,
  });
  check("usuário autorizado executa (Marcos → 200)", runMarcos.status === 200);
  await marcos.patch("/api/activities/runs", {
    patientId: pFabio,
    runId: runMarcos.json.run.id,
    status: "abandonada",
  });
  check(
    "familiar sem viewActivityResults não vê resultados (403)",
    (await familiar.get(`/api/activities/runs?patientId=${pFabio}&period=hoje`)).status === 403
  );
  check(
    "familiar sem createActivities não envia mídia (403)",
    (
      await familiar.post("/api/media", {
        patientId: pFabio,
        name: "x.png",
        contentType: "image/png",
        dataBase64: PNG_BASE64,
      })
    ).status === 403
  );
  check(
    "acesso direto sem vínculo é negado (Sofia → 403)",
    (await semVinculo.get(`/api/activities?patientId=${pFabio}`)).status === 403
  );
  check(
    "mídia sem vínculo é negada (Sofia → 403)",
    (await semVinculo.raw(`/api/media?patientId=${pFabio}&id=${mediaId}`)).status === 403
  );
  check(
    "sem autenticação → 401",
    (await anon.get(`/api/activities?patientId=${pFabio}`)).status === 401
  );
  check(
    "formato de mídia inválido → 400",
    (
      await claudia.post("/api/media", {
        patientId: pFabio,
        name: "x.txt",
        contentType: "text/plain",
        dataBase64: PNG_BASE64,
      })
    ).status === 400
  );

  // ════ 25–28 MULTIPACIENTE ════
  console.log("\nMultipaciente (isolamento):");
  const listRoberto = await claudia.get(`/api/activities?patientId=${pRoberto}`);
  check(
    "template de A não aparece em B",
    listRoberto.status === 200 && listRoberto.json.templates.length === 0
  );
  const mediaRoberto = await claudia.get(`/api/media?patientId=${pRoberto}`);
  check(
    "mídia de A não aparece na biblioteca de B",
    mediaRoberto.status === 200 && mediaRoberto.json.media.length === 0
  );
  check(
    "mídia de A inacessível via patientId de B (404)",
    (await claudia.raw(`/api/media?patientId=${pRoberto}&id=${mediaId}`)).status === 404
  );
  const runsRoberto = await claudia.get(
    `/api/activities/runs?patientId=${pRoberto}&period=vitalicio`
  );
  check(
    "resultados de A não aparecem em B",
    runsRoberto.status === 200 && runsRoberto.json.stats.totals.sessoes === 0
  );
  check(
    "detalhe de run de A inacessível via B (404)",
    (
      await claudia.get(
        `/api/activities/runs?patientId=${pRoberto}&runId=${run1.json.run.id}`
      )
    ).status === 404
  );

  // ════ 29–31 MULTIUSUÁRIO ════
  console.log("\nMultiusuário (dados do paciente, não do profissional):");
  const dashMarcos = await marcos.get(
    `/api/activities/runs?patientId=${pFabio}&period=hoje`
  );
  check(
    "Marcos autorizado vê as sessões que Claudia executou",
    dashMarcos.status === 200 &&
      dashMarcos.json.runs.some((r) => r.operatorId === uClaudia.id)
  );
  check(
    "operatorId identifica Claudia corretamente",
    dashMarcos.json.runs.some(
      (r) => r.operatorId === uClaudia.id && r.operatorName === "Claudia"
    )
  );
  check(
    "sem cópia por profissional: mesma contagem para Claudia e Marcos",
    dashMarcos.json.stats.totals.sessoes ===
      (await claudia.get(`/api/activities/runs?patientId=${pFabio}&period=hoje`)).json.stats.totals.sessoes
  );

  // ════ 32–35 VERSIONAMENTO ════
  console.log("\nVersionamento (snapshot imutável):");
  const oldRunId = t1.run.id;
  const oldDetail = await claudia.get(
    `/api/activities/runs?patientId=${pFabio}&runId=${oldRunId}`
  );
  check(
    "run antiga guarda as opções da época (José)",
    oldDetail.json.items[0].options.some((o) => o.label === "José")
  );
  const edit = await claudia.patch("/api/activities", {
    patientId: pFabio,
    templateId: treinoId,
    template: {
      items: [
        {
          id: treinoItem,
          question: "Qual é o seu nome?",
          options: [
            { id: "fabio", label: "Dr. Fábio" },
            { id: "roberto", label: "Roberto" },
            { id: "antonio", label: "Antonio" },
          ],
          correctOptionId: "fabio",
        },
      ],
    },
  });
  check(
    "editar pergunta sobe a versão (v2)",
    edit.status === 200 && edit.json.template.version === 2,
    JSON.stringify(edit.json.template?.version)
  );
  const runV2 = await claudia.post("/api/activities/runs", {
    patientId: pFabio,
    templateId: treinoId,
  });
  check(
    "nova execução usa o conteúdo novo (Roberto, v2)",
    runV2.json.run.templateVersion === 2 &&
      runV2.json.run.items[0].options.some((o) => o.label === "Roberto")
  );
  await claudia.patch("/api/activities/runs", {
    patientId: pFabio,
    runId: runV2.json.run.id,
    status: "concluida",
  });
  const oldDetail2 = await claudia.get(
    `/api/activities/runs?patientId=${pFabio}&runId=${oldRunId}`
  );
  check(
    "sessão antiga PRESERVA conteúdo antigo (José, v1)",
    oldDetail2.json.run.templateVersion === 1 &&
      oldDetail2.json.items[0].options.some((o) => o.label === "José") &&
      !oldDetail2.json.items[0].options.some((o) => o.label === "Roberto")
  );

  // ════ Robustez: duplicidade, correção, ciclo de vida ════
  console.log("\nRobustez (duplicidade, correção, ciclo de vida):");
  const runDup = await claudia.post("/api/activities/runs", {
    patientId: pFabio,
    templateId: recId,
  });
  // Primeiro registro: 👍 no Renato (afirmação errada).
  await claudia.post("/api/activities/responses", {
    patientId: pFabio,
    runId: runDup.json.run.id,
    itemId: recItemId,
    optionGestures: [{ optionId: "renato", gesture: "sim" }],
  });
  // Correção explícita: o operador reconfigura o mapa — Renato vira ✊, Pedro 👍.
  const corrige = await claudia.post("/api/activities/responses", {
    patientId: pFabio,
    runId: runDup.json.run.id,
    itemId: recItemId,
    optionGestures: [
      { optionId: "renato", gesture: "nao" },
      { optionId: "pedro", gesture: "sim" },
    ],
  });
  check(
    "correção explícita sobrescreve com revision 2 (nunca duplica)",
    corrige.json.response.revision === 2 &&
      corrige.json.response.selectedOptionId === "pedro"
  );
  const dupDetail = await claudia.get(
    `/api/activities/runs?patientId=${pFabio}&runId=${runDup.json.run.id}`
  );
  check(
    "uma única resposta por item no histórico",
    dupDetail.json.items[0].response.revision === 2
  );
  await claudia.patch("/api/activities/runs", {
    patientId: pFabio,
    runId: runDup.json.run.id,
    status: "concluida",
  });
  check(
    "resposta em sessão encerrada é recusada (400)",
    (
      await claudia.post("/api/activities/responses", {
        patientId: pFabio,
        runId: runDup.json.run.id,
        itemId: recItemId,
        optionGestures: [{ optionId: "pedro", gesture: "sim" }],
      })
    ).status === 400
  );
  await claudia.patch("/api/activities/runs", {
    patientId: pFabio,
    runId: runDup.json.run.id,
    status: "abandonada",
  });
  const lifecycle = await claudia.get(
    `/api/activities/runs?patientId=${pFabio}&runId=${runDup.json.run.id}`
  );
  check(
    "estado terminal não regride (concluída não vira abandonada)",
    lifecycle.json.run.status === "concluida"
  );
  // Execução ATIVA fresca — exercita os caminhos de item/gesto inválidos
  // sem esbarrar antes na checagem de sessão encerrada.
  const runActive = await claudia.post("/api/activities/runs", {
    patientId: pFabio,
    templateId: recId,
  });
  const activeRunId = runActive.json.run.id;
  const activeItemId = runActive.json.run.items[0].id;
  check(
    "resposta órfã impossível: item fora do snapshot → 400",
    (
      await claudia.post("/api/activities/responses", {
        patientId: pFabio,
        runId: activeRunId,
        itemId: "item-inexistente",
        optionGestures: [{ optionId: "x", gesture: "sim" }],
      })
    ).status === 400
  );
  check(
    "registro sem nenhum gesto válido é recusado (400)",
    (
      await claudia.post("/api/activities/responses", {
        patientId: pFabio,
        runId: activeRunId,
        itemId: activeItemId,
        optionGestures: [],
      })
    ).status === 400
  );
  check(
    "gesto em optionId fora do snapshot é ignorado → 400 (nenhum válido)",
    (
      await claudia.post("/api/activities/responses", {
        patientId: pFabio,
        runId: activeRunId,
        itemId: activeItemId,
        optionGestures: [{ optionId: "opcao-fantasma", gesture: "sim" }],
      })
    ).status === 400
  );
  await claudia.patch("/api/activities/runs", {
    patientId: pFabio,
    runId: activeRunId,
    status: "abandonada",
  });

  // ════ Ativar/desativar/duplicar/excluir ════
  console.log("\nGestão de templates:");
  const dup = await claudia.post("/api/activities", {
    patientId: pFabio,
    action: "duplicate",
    templateId: recId,
  });
  check("duplicar template", dup.status === 200 && dup.json.template.title.includes("cópia"));
  await claudia.patch("/api/activities", {
    patientId: pFabio,
    templateId: dup.json.template.id,
    template: { status: "inativa" },
  });
  const listaMarcos = await marcos.get(`/api/activities?patientId=${pFabio}`);
  check(
    "template inativo some do modo de uso",
    !listaMarcos.json.templates.some((t) => t.id === dup.json.template.id)
  );
  const listaEditor = await claudia.get(`/api/activities?patientId=${pFabio}&all=1`);
  check(
    "template inativo segue visível no modo de edição",
    listaEditor.json.templates.some((t) => t.id === dup.json.template.id)
  );
  check(
    "executar template inativo é recusado (400)",
    (
      await claudia.post("/api/activities/runs", {
        patientId: pFabio,
        templateId: dup.json.template.id,
      })
    ).status === 400
  );
  check(
    "excluir template (com permissão)",
    (await claudia.del("/api/activities", { patientId: pFabio, templateId: dup.json.template.id })).status === 200
  );
  const aposExcluir = await claudia.get(
    `/api/activities/runs?patientId=${pFabio}&runId=${oldRunId}`
  );
  check(
    "histórico sobrevive à exclusão do template",
    aposExcluir.status === 200 && aposExcluir.json.items.length === 1
  );

  // ════ Auditoria ════
  console.log("\nAuditoria:");
  const audit = (await admin.get("/api/admin/audit")).json.events;
  check(
    "auditoria registra criação de template",
    audit.some((e) => e.action === "activity_template.create")
  );
  check(
    "auditoria registra início de sessão",
    audit.some((e) => e.action === "activity_run.start")
  );
  check(
    "auditoria registra upload de mídia (sem conteúdo)",
    audit.some((e) => e.action === "media.upload")
  );

  console.log(`\n———— RESULTADO: ${passed} ok · ${failed} falhas ————`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("erro fatal:", e);
  process.exit(1);
});
