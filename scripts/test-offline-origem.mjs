// ——— Origem da operação: teste de domínio (Fase 4.9.5) ———
//
// Puro. Prova os dois lados do metadado sem tocar rede:
//
//   • no CLIENTE, que a origem é cunhada uma vez e nunca mais se mexe;
//   • no SERVIDOR, que um relógio mentiroso não entra na trilha.
//
//   npm run test:offline:origem
//
// O que este arquivo existe para impedir, em uma frase cada:
//
//   • que uma operação feita COM conexão apareça na trilha como offline;
//   • que um retry, um refresh ou um conflito reescrevam quando o cuidador agiu;
//   • que `intendedAt` seja confundido com horário do servidor;
//   • que um relógio adiantado empurre um "amanhã" para dentro do prontuário;
//   • que algum dos catorze tipos de operação viaje sem os dois campos.

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { appendOperation, markStatus, restoreOperation } = await import(
  "../lib/offline/queue.ts"
);
const { OFFLINE_OPERATION_TYPES } = await import("../lib/offline/types.ts");
const { buildSyncRequest } = await import("../lib/offline/sync-endpoints.ts");
const { lerOrigem, validarIntendedAt, comOrigem, metadadosDaOrigem } =
  await import("../lib/origem-da-operacao.ts");

let passed = 0;
let failed = 0;
function check(nome, condicao, detalhe = "") {
  if (condicao) {
    passed++;
    console.log(`  ✓ ${nome}`);
  } else {
    failed++;
    console.error(`  ✗ ${nome} ${detalhe}`);
  }
}

const base = {
  sessionId: "ses_1",
  patientId: "7",
  userId: "u1",
  payload: { text: "está com dor?" },
};

function criar(extra = {}) {
  return appendOperation([], {
    ...base,
    operationType: "createTurn",
    ...extra,
  }).operacao;
}

// ---------- A. A origem é observada uma vez ----------

console.log("\nA. A origem é observada uma vez, na criação:");
{
  const offline = criar({ offlineQueued: true });
  const online = criar({ offlineQueued: false });
  const omitido = criar();

  check("nascida sem conexão fica offlineQueued=true", offline.offlineQueued === true);
  check("nascida com conexão fica offlineQueued=false", online.offlineQueued === false);
  check(
    "omitido lê como ONLINE — afirmar offline sem evidência seria inventar",
    omitido.offlineQueued === false
  );
  check(
    "createdAt local é ISO 8601 válido",
    typeof offline.createdAt === "string" &&
      !Number.isNaN(Date.parse(offline.createdAt))
  );
}

// ---------- B. Imutável por toda a vida da operação ----------

console.log("\nB. Retry, conflito e reautenticação não mexem na origem:");
{
  const op = criar({ offlineQueued: true });
  const intencaoOriginal = op.createdAt;

  let fila = [op];
  fila = markStatus(fila, op.id, "SYNCING");
  fila = markStatus(fila, op.id, "PENDING", {
    incrementRetry: true,
    error: { kind: "NETWORK", message: "timeout" },
  });
  fila = markStatus(fila, op.id, "SYNCING");
  fila = markStatus(fila, op.id, "PENDING", { incrementRetry: true });
  const depoisDoRetry = fila[0];

  check("duas tentativas contadas", depoisDoRetry.retryCount === 2);
  check(
    "intendedAt (createdAt local) é o MESMO depois de dois retries",
    depoisDoRetry.createdAt === intencaoOriginal
  );
  check(
    "offlineQueued sobrevive aos retries",
    depoisDoRetry.offlineQueued === true
  );

  const emConflito = markStatus(fila, op.id, "CONFLICT", {
    conflict: { code: "SESSION_COMPLETED", facts: {} },
  });
  check(
    "conflito não reescreve o momento da intenção",
    emConflito[0].createdAt === intencaoOriginal
  );
  check("conflito não reescreve a origem", emConflito[0].offlineQueued === true);

  const sincronizada = markStatus(
    markStatus(fila, op.id, "SYNCING"),
    op.id,
    "SYNCED",
    { remoteConfirmedAt: "2030-01-01T00:00:00.000Z" }
  );
  check(
    "nem a confirmação do servidor sobrescreve a intenção local",
    sincronizada[0].createdAt === intencaoOriginal
  );
  check(
    "o horário do servidor vive em campo PRÓPRIO, sem encostar no local",
    sincronizada[0].remoteConfirmedAt === "2030-01-01T00:00:00.000Z" &&
      sincronizada[0].createdAt === intencaoOriginal
  );
}

// ---------- C. Sobrevive a refresh e a reabertura ----------

console.log("\nC. Refresh e reabertura preservam os dois campos:");
{
  const offline = criar({ offlineQueued: true });
  // É por aqui que a operação volta do IndexedDB depois de fechar o navegador.
  const voltou = restoreOperation(JSON.parse(JSON.stringify(offline)));
  check("a operação volta do disco", voltou !== null);
  check("offlineQueued volta true", voltou.offlineQueued === true);
  check("createdAt volta idêntico", voltou.createdAt === offline.createdAt);

  const online = criar({ offlineQueued: false });
  const voltouOnline = restoreOperation(JSON.parse(JSON.stringify(online)));
  check("uma operação online não vira offline no caminho de volta",
    voltouOnline.offlineQueued === false);

  // Fila gravada ANTES da 4.9.5: o campo simplesmente não existe no disco.
  const antiga = JSON.parse(JSON.stringify(offline));
  delete antiga.offlineQueued;
  const legado = restoreOperation(antiga);
  check("operação anterior à fase volta legível (nada de fila apagada)", legado !== null);
  check("e sem afirmar uma origem que ninguém observou", legado.offlineQueued === false);
}

// ---------- D. Os dois campos viajam em TODA requisição ----------

console.log("\nD. Os catorze tipos levam os dois campos:");
{
  // Da lista REAL do domínio, não de uma cópia minha: um tipo novo entra
  // nesta prova sozinho, e um que esquecesse os campos falharia aqui.
  const PAYLOAD_POR_TIPO = {
    createTurn: { sessionId: "ses_1", text: "oi" },
    turnAction: { sessionId: "ses_1", turnId: "trn_1", action: { kind: "PRESENT" } },
    createPath: { sessionId: "ses_1", pathId: "pth_1" },
    pathAction: { sessionId: "ses_1", pathId: "pth_1", action: { kind: "END" } },
    createNode: { sessionId: "ses_1", pathId: "pth_1", promptText: "a", options: [] },
    nodeAction: {
      sessionId: "ses_1",
      pathId: "pth_1",
      nodeId: "nod_1",
      action: { kind: "PRESENT" },
    },
    reviewNode: {
      sessionId: "ses_1",
      pathId: "pth_1",
      nodeId: "nod_1",
      promptText: "a",
      options: [],
    },
    createStatement: { sessionId: "ses_1", pathId: "pth_1", text: "a" },
    statementAction: {
      sessionId: "ses_1",
      pathId: "pth_1",
      statementId: "stm_1",
      action: { kind: "PRESENT" },
    },
    createCaregiverInterpretation: { sessionId: "ses_1", text: "a" },
    saveSessionContext: { sessionId: "ses_1", skipped: true },
    openPatientControl: { sessionId: "ses_1" },
    patientControlAction: {
      sessionId: "ses_1",
      requestId: "pcr_1",
      action: { kind: "CANCEL" },
    },
    sessionAction: { sessionId: "ses_1", action: "PAUSE" },
  };

  const TIPOS = OFFLINE_OPERATION_TYPES.map((t) => [t, PAYLOAD_POR_TIPO[t]]);
  check(
    "a prova cobre TODOS os tipos que o domínio declara",
    TIPOS.every(([, p]) => p !== undefined),
    TIPOS.filter(([, p]) => p === undefined).map(([t]) => t).join(", ")
  );

  let comAmbos = 0;
  let semAlgum = [];
  for (const [tipo, payload] of TIPOS) {
    const op = criar({ operationType: tipo, payload, offlineQueued: true });
    let req;
    try {
      req = buildSyncRequest(op);
    } catch {
      semAlgum.push(`${tipo} (não montou)`);
      continue;
    }
    const ok =
      req.body.offlineQueued === true && req.body.intendedAt === op.createdAt;
    if (ok) comAmbos++;
    else semAlgum.push(tipo);
  }
  check(
    `os ${TIPOS.length} tipos do domínio levam offlineQueued e intendedAt`,
    comAmbos === TIPOS.length,
    semAlgum.join(", ")
  );

  const online = criar({ offlineQueued: false });
  const reqOnline = buildSyncRequest(online);
  check(
    "operação online também declara — false explícito, não silêncio",
    reqOnline.body.offlineQueued === false
  );
  check(
    "intendedAt viaja como o createdAt LOCAL, não como horário do servidor",
    reqOnline.body.intendedAt === online.createdAt
  );
  check(
    "o corpo NÃO carrega createdAt — quem cunha isso é o servidor",
    !("createdAt" in reqOnline.body)
  );
  check(
    "e o expectedUserId (R6) continua indo junto",
    reqOnline.body.expectedUserId === "u1"
  );

  // O reenvio da MESMA operação monta o MESMO corpo.
  const op = criar({ offlineQueued: true });
  const a = buildSyncRequest(op);
  const b = buildSyncRequest({ ...op, retryCount: 5 });
  check(
    "reenvio manda exatamente o mesmo intendedAt",
    a.body.intendedAt === b.body.intendedAt
  );
  check(
    "reenvio manda a mesma chave de idempotência",
    a.body.clientRequestId === b.body.clientRequestId
  );
}

// ---------- E. O servidor valida formato e plausibilidade ----------

console.log("\nE. O servidor recusa o que não descreve o que diz descrever:");
{
  const agora = Date.parse("2026-08-07T12:00:00.000Z");

  check(
    "ISO completo em UTC passa",
    validarIntendedAt("2026-08-07T11:30:00.000Z", agora) ===
      "2026-08-07T11:30:00.000Z"
  );
  check(
    "com fuso, é NORMALIZADO para UTC — uma grafia só na trilha",
    validarIntendedAt("2026-08-07T08:30:00.000-03:00", agora) ===
      "2026-08-07T11:30:00.000Z"
  );
  check("sem milissegundos passa", validarIntendedAt("2026-08-07T11:30:00Z", agora) !== null);

  check("'2026' não é um instante", validarIntendedAt("2026", agora) === null);
  check("texto livre não vira horário", validarIntendedAt("ontem à tarde", agora) === null);
  check("número não vira horário", validarIntendedAt(1754570000000, agora) === null);
  check("nulo não vira horário", validarIntendedAt(null, agora) === null);
  check("vazio não vira horário", validarIntendedAt("", agora) === null);
  check(
    "data sem hora é recusada — a promessa é o INSTANTE",
    validarIntendedAt("2026-08-07", agora) === null
  );

  check(
    "relógio adiantado em 1h ainda passa (fuso mal configurado acontece)",
    validarIntendedAt("2026-08-07T13:00:00.000Z", agora) !== null
  );
  check(
    "um 'amanhã' de dois dias é recusado",
    validarIntendedAt("2026-08-09T12:00:00.000Z", agora) === null
  );
  check(
    "um horário de dois meses atrás é recusado",
    validarIntendedAt("2026-06-01T12:00:00.000Z", agora) === null
  );
  check(
    "uma semana atrás passa — a fila vive 7 dias",
    validarIntendedAt("2026-07-31T12:00:00.000Z", agora) !== null
  );
}

// ---------- F. A leitura do corpo nunca derruba a operação ----------

console.log("\nF. Corpo malformado não impede o cuidador de registrar:");
{
  const agora = Date.parse("2026-08-07T12:00:00.000Z");

  check(
    "corpo sem os campos: online, sem intenção declarada",
    JSON.stringify(lerOrigem({}, agora)) ===
      JSON.stringify({ offlineQueued: false, intendedAt: null })
  );
  check(
    "corpo nulo não lança",
    JSON.stringify(lerOrigem(null, agora)) ===
      JSON.stringify({ offlineQueued: false, intendedAt: null })
  );
  check(
    "offlineQueued só é verdade com o booleano true",
    lerOrigem({ offlineQueued: "true" }, agora).offlineQueued === false
  );
  check(
    "offline com relógio quebrado: a ORIGEM fica, o horário não",
    (() => {
      const o = lerOrigem(
        { offlineQueued: true, intendedAt: "2099-01-01T00:00:00.000Z" },
        agora
      );
      return o.offlineQueued === true && o.intendedAt === null;
    })(),
    "offlineQueued=true com intendedAt=null é informação: o aparelho afirmou origem offline com relógio em que não se pôde confiar"
  );
}

// ---------- G. O que chega à trilha ----------

console.log("\nG. O que writeAudit acrescenta ao metadata:");
{
  check(
    "fora de uma requisição, a trilha sai como sempre saiu",
    metadadosDaOrigem() === null
  );

  const offline = comOrigem(
    { offlineQueued: true, intendedAt: "2026-08-07T11:30:00.000Z" },
    () => metadadosDaOrigem()
  );
  check("offline marca os dois campos",
    offline.offlineQueued === true &&
    offline.intendedAt === "2026-08-07T11:30:00.000Z");

  const online = comOrigem({ offlineQueued: false, intendedAt: null }, () =>
    metadadosDaOrigem()
  );
  check("online marca offlineQueued=false", online.offlineQueued === false);
  check(
    "e NÃO inventa um intendedAt",
    !("intendedAt" in online)
  );

  const semRelogio = comOrigem({ offlineQueued: true, intendedAt: null }, () =>
    metadadosDaOrigem()
  );
  check(
    "offline sem horário confiável: marca a origem e omite o horário",
    semRelogio.offlineQueued === true && !("intendedAt" in semRelogio)
  );

  check(
    "o contexto não vaza para fora da chamada",
    metadadosDaOrigem() === null
  );
}

// ---------- Resultado ----------

console.log(`\n${passed} passaram · ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
