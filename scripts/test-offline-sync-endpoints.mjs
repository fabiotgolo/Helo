// ——— Fila → requisição HTTP: teste de domínio (Fase B) ———
//
// Puro. Prova que cada tipo de operação vira o método, o caminho e o corpo
// certos — sem servidor, sem rede, em milissegundos. O que isto garante:
//
//   • clientRequestId no corpo é SEMPRE op.idempotencyKey, nunca um valor
//     preso dentro do payload;
//   • os ids que o payload já carrega vão para o corpo sem tradução;
//   • createCaregiverInterpretation nunca manda `pathId` (isso mudaria de
//     ramo a rota) — manda `interpretationPathId`.
//
//   npm run test:offline:sync-endpoints

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { buildSyncRequest, extractConfirmation, UnsupportedOperationError } =
  await import("../lib/offline/sync-endpoints.ts");

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

function op(overrides) {
  return {
    id: "op1",
    idempotencyKey: "a-chave-estavel",
    sessionId: "cqs1",
    patientId: "42",
    operationType: "createTurn",
    payload: {},
    status: "PENDING",
    createdAt: new Date().toISOString(),
    retryCount: 0,
    sequence: 1,
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    dependsOn: [],
    baseVersion: null,
    lastError: null,
    nextRetryAt: null,
    createdEntityId: null,
    remoteConfirmedAt: null,
    remoteEntityId: null,
    ...overrides,
  };
}

console.log("1. createTurn:");
{
  const r = buildSyncRequest(
    op({
      operationType: "createTurn",
      payload: {
        sessionId: "cqs1",
        turnId: "cqt123",
        text: "Está com dor?",
        questionSource: "MANUAL_TEXT",
        isSensitive: false,
        sensitiveCategory: null,
        reusedFromTurnId: null,
      },
    })
  );
  check("método e caminho corretos", r.method === "POST" && r.path === "/turns");
  check(
    "clientRequestId é o idempotencyKey da OPERAÇÃO, não algo do payload",
    r.body.clientRequestId === "a-chave-estavel"
  );
  check("turnId vai sem tradução", r.body.turnId === "cqt123");
  check("patientId é número", r.body.patientId === 42);
}

console.log("\n2. turnAction:");
{
  const r = buildSyncRequest(
    op({
      operationType: "turnAction",
      payload: { sessionId: "cqs1", turnId: "cqt123", action: { kind: "PRESENT" } },
    })
  );
  check(
    "método, caminho e corpo",
    r.method === "PATCH" &&
      r.path === "/turns" &&
      r.body.turnId === "cqt123" &&
      r.body.action.kind === "PRESENT"
  );
}

console.log("\n3. createPath / pathAction:");
{
  const r1 = buildSyncRequest(
    op({ operationType: "createPath", payload: { sessionId: "cqs1", pathId: "ocp1" } })
  );
  check("createPath", r1.method === "POST" && r1.path === "/paths" && r1.body.pathId === "ocp1");

  const r2 = buildSyncRequest(
    op({
      operationType: "pathAction",
      payload: { sessionId: "cqs1", pathId: "ocp1", action: { kind: "PAUSE" } },
    })
  );
  check(
    "pathAction",
    r2.method === "PATCH" && r2.path === "/paths" && r2.body.action.kind === "PAUSE"
  );
}

console.log("\n4. createNode:");
{
  const r = buildSyncRequest(
    op({
      operationType: "createNode",
      payload: {
        sessionId: "cqs1",
        pathId: "ocp1",
        nodeId: "ocn1",
        promptText: "Onde dói?",
        options: [{ label: "Cabeça" }],
        parentNodeId: null,
        isSensitive: false,
        sensitiveCategory: null,
        // Um clientRequestId DENTRO do payload — resquício do dedup local do
        // clique. NÃO pode vazar para o corpo da requisição.
        clientRequestId: "clique-local-que-nao-deveria-ser-usado",
      },
    })
  );
  check("caminho e método", r.method === "POST" && r.path === "/nodes");
  check("nodeId vai sem tradução", r.body.nodeId === "ocn1");
  check(
    "o clientRequestId do CORPO é o da operação, não o do payload",
    r.body.clientRequestId === "a-chave-estavel"
  );
}

console.log("\n5. reviewNode — desempacota `input`:");
{
  const r = buildSyncRequest(
    op({
      operationType: "reviewNode",
      payload: {
        sessionId: "cqs1",
        pathId: "ocp1",
        nodeId: "ocn1",
        input: { promptText: "Novo texto", options: [{ label: "A" }] },
      },
    })
  );
  check(
    "vira action REVIEW com os campos do input",
    r.body.action.kind === "REVIEW" &&
      r.body.action.promptText === "Novo texto" &&
      Array.isArray(r.body.action.options)
  );
}

console.log("\n6. createStatement / statementAction:");
{
  const r1 = buildSyncRequest(
    op({
      operationType: "createStatement",
      payload: { sessionId: "cqs1", pathId: "ocp1", statementId: "ocs1", text: "Água" },
    })
  );
  check(
    "createStatement",
    r1.method === "POST" && r1.path === "/statements" && r1.body.statementId === "ocs1"
  );

  const r2 = buildSyncRequest(
    op({
      operationType: "statementAction",
      payload: {
        sessionId: "cqs1",
        pathId: "ocp1",
        statementId: "ocs1",
        action: { kind: "PRESENT" },
      },
    })
  );
  check(
    "statementAction",
    r2.method === "PATCH" && r2.path === "/statements" && r2.body.statementId === "ocs1"
  );
}

console.log("\n7. createCaregiverInterpretation — NUNCA manda `pathId`:");
{
  const r = buildSyncRequest(
    op({
      operationType: "createCaregiverInterpretation",
      payload: {
        sessionId: "cqs1",
        pathId: "ocp-interp",
        statementId: "ocs-interp",
        text: "Acho que ele quer água",
      },
    })
  );
  check(
    "path proposto vai em interpretationPathId, e `pathId` NÃO existe no corpo",
    r.body.interpretationPathId === "ocp-interp" && !("pathId" in r.body),
    JSON.stringify(r.body)
  );
  check("origin é CAREGIVER_INTERPRETATION", r.body.origin === "CAREGIVER_INTERPRETATION");
}

console.log("\n8. saveSessionContext / openPatientControl / patientControlAction / sessionAction:");
{
  const r1 = buildSyncRequest(
    op({
      operationType: "saveSessionContext",
      payload: { sessionId: "cqs1", contextId: "ctx1", intention: "conversar" },
    })
  );
  check(
    "saveSessionContext não manda contextId (rota não aceita id proposto)",
    r1.path === "/session-context" && !("contextId" in r1.body),
    JSON.stringify(r1.body)
  );

  const r2 = buildSyncRequest(
    op({
      operationType: "openPatientControl",
      payload: { sessionId: "cqs1", requestId: "pcr1", targetType: "TURN", targetId: "cqt1" },
    })
  );
  check("openPatientControl", r2.method === "POST" && r2.path === "/patient-controls");

  const r3 = buildSyncRequest(
    op({
      operationType: "patientControlAction",
      payload: { sessionId: "cqs1", requestId: "pcr1", action: { kind: "EXECUTE" } },
    })
  );
  check(
    "patientControlAction",
    r3.method === "PATCH" && r3.body.requestId === "pcr1"
  );

  const r4 = buildSyncRequest(
    op({ operationType: "sessionAction", payload: { sessionId: "cqs1", action: "PAUSE" } })
  );
  check("sessionAction", r4.method === "PATCH" && r4.path === "/sessions");
}

console.log("\n9. extractConfirmation — id e horário do que o SERVIDOR devolveu:");
{
  const o = op({ operationType: "createTurn" });
  const extraido = extractConfirmation(o, {
    turn: { id: "cqt999", updatedAt: "2026-08-05T10:00:00.000Z" },
  });
  check(
    "extrai id e horário do campo certo (turn)",
    extraido.remoteEntityId === "cqt999" &&
      extraido.remoteConfirmedAt === "2026-08-05T10:00:00.000Z"
  );

  const semNada = extractConfirmation(o, {});
  check(
    "resposta sem o campo esperado não inventa nada",
    semNada.remoteEntityId === null && semNada.remoteConfirmedAt === null
  );

  const oNode = op({ operationType: "nodeAction" });
  const comPathJunto = extractConfirmation(oNode, {
    node: { id: "ocn1", updatedAt: "2026-08-05T11:00:00.000Z" },
    path: { id: "ocp1", updatedAt: "2026-08-05T10:59:00.000Z" },
  });
  check(
    "nodeAction extrai do campo `node`, não do `path` que veio junto",
    comPathJunto.remoteEntityId === "ocn1"
  );

  const oContext = op({ operationType: "saveSessionContext" });
  const semUpdatedAt = extractConfirmation(oContext, {
    context: { id: "ctx1", createdAt: "2026-08-05T09:00:00.000Z" },
  });
  check(
    "sem updatedAt, cai para createdAt",
    semUpdatedAt.remoteConfirmedAt === "2026-08-05T09:00:00.000Z"
  );
}

console.log("\n10. tipo desconhecido lança, em vez de mandar requisição sem sentido:");
{
  let lancou = false;
  try {
    buildSyncRequest(op({ operationType: "isto-nao-existe" }));
  } catch (e) {
    lancou = e instanceof UnsupportedOperationError;
  }
  check("UnsupportedOperationError para tipo desconhecido", lancou);
}

console.log(`\n${passed} passou, ${failed} falhou.`);
if (failed > 0) process.exit(1);
