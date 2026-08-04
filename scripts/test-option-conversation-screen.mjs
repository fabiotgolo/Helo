// ——— Qual tela um caminho mostra, e quando ela é do paciente ———
// Prova, por enumeração de todo NodeStatus e StatementStatus alcançável, que
// `pacienteEstaOlhando` é exatamente `telaDerivada(...).kind === "STAGE" ||
// "CONFIRM_STATEMENT"` — nunca um terceiro critério, nunca uma cópia da regra
// que possa divergir dela.
//
// Teste de domínio puro: não toca rede, servidor nem emulador.
//
//   npm run test:oc:screen
//
// Por que isto importa mais do que parece: `session.tsx` usa esta MESMA
// função (importada de lib/, não uma cópia) para decidir se a barra "Ver/
// Editar contexto" aparece. A seção final confere que os casos abaixo
// alcançaram os seis `kind` do tipo Screen — se um `NodeStatus` ou
// `StatementStatus` novo nascer sem entrar neste arquivo, essa contagem
// não muda, mas o caso novo passa a cair no ramo `default` de
// `telaDerivada` (hoje só ATINGIDO por AWAITING_SELECTION e
// PROVISIONAL_SELECTION) sem que nenhum teste tenha provado isso — o sinal
// de alerta é a lista de status no topo de cada seção não bater mais com
// `NODE_STATUSES`/`STATEMENT_STATUSES` do domínio.

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { telaDerivada, pacienteEstaOlhando, liveStatement } = await import(
  "../lib/option-conversation-screen.ts"
);
const { NODE_STATUSES, STATEMENT_STATUSES, PATH_STATUSES, isTerminalPathStatus } =
  await import("../lib/option-conversation-types.ts");

let passed = 0;
let failed = 0;
const kindsVistos = new Set();

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

/**
 * Roda os DOIS lados da garantia sobre o mesmo `detail`: a tela e a
 * visibilidade. `pacienteEstaOlhando` nunca é chamada com um resultado
 * pré-calculado — sempre com o `detail` bruto, exatamente como session.tsx
 * chama.
 */
function checar(rotulo, detail, kindEsperado, pacienteEsperado) {
  const kind = telaDerivada(detail).kind;
  kindsVistos.add(kind);
  check(`${rotulo} → tela ${kindEsperado}`, kind === kindEsperado, `(veio ${kind})`);
  check(
    `${rotulo} → paciente ${pacienteEsperado ? "" : "NÃO "}está olhando`,
    pacienteEstaOlhando(detail) === pacienteEsperado
  );
}

const T = "2026-08-04T12:00:00.000Z";

function path(over = {}) {
  return {
    id: "path-1",
    sessionId: "sess-1",
    patientId: 7,
    assistantId: "user-1",
    kind: "OPTION_TREE",
    status: "ACTIVE",
    rootNodeId: "node-1",
    activeNodeId: "node-1",
    activeBranchId: "branch-1",
    finalStatementId: null,
    sequence: 1,
    restartedFromPathId: null,
    reusedFromPathId: null,
    clientRequestId: null,
    startedAt: T,
    pausedAt: null,
    resumedAt: null,
    completedAt: null,
    interruptedAt: null,
    restartedAt: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function node(over = {}) {
  return {
    id: "node-1",
    pathId: "path-1",
    sessionId: "sess-1",
    patientId: 7,
    assistantId: "user-1",
    parentNodeId: null,
    branchId: "branch-1",
    depth: 0,
    sequence: 1,
    interactionMode: "OPTION_SELECTION",
    promptText: "O que o senhor quer?",
    status: "AWAITING_SELECTION",
    options: [
      { id: "opt-1", position: 1, label: "Água", nextNodeId: null, isTerminal: false, finalStatementDraft: null, isSensitive: false, sensitiveCategory: null },
      { id: "opt-2", position: 2, label: "Descansar", nextNodeId: null, isTerminal: false, finalStatementDraft: null, isSensitive: false, sensitiveCategory: null },
    ],
    provisionalOptionId: null,
    confirmedOptionId: null,
    reusedFromNodeId: null,
    replacesNodeId: null,
    replacedByNodeId: null,
    isSensitive: false,
    sensitiveCategory: null,
    correctionCount: 0,
    clientRequestId: null,
    presentedAt: T,
    selectedAt: null,
    confirmedAt: null,
    deactivatedAt: null,
    canceledAt: null,
    replacedAt: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function statement(over = {}) {
  return {
    id: "st-1",
    pathId: "path-1",
    sessionId: "sess-1",
    patientId: 7,
    assistantId: "user-1",
    originNodeId: "node-1",
    origin: "OPTION_PATH",
    interactionMode: "FINAL_STATEMENT_CONFIRMATION",
    originalDraft: "Quero água",
    currentText: "Quero água",
    presentedText: "Quero água",
    status: "PRESENTED",
    provisionalResponse: null,
    confirmedResponse: null,
    reusedFromStatementId: null,
    replacesStatementId: null,
    replacedByStatementId: null,
    isSensitive: false,
    sensitiveCategory: null,
    editCount: 0,
    correctionCount: 0,
    representCount: 0,
    clientRequestId: null,
    presentedAt: T,
    respondedAt: null,
    reconfirmedAt: null,
    confirmedAt: null,
    rejectedAt: null,
    canceledAt: null,
    replacedAt: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

const OPCAO_COMUM = { id: "opt-1", position: 1, label: "Água", nextNodeId: null, isTerminal: false, finalStatementDraft: null, isSensitive: false, sensitiveCategory: null };
const OPCAO_TERMINAL = { id: "opt-1", position: 1, label: "Água", nextNodeId: null, isTerminal: true, finalStatementDraft: "Quero água.", isSensitive: false, sensitiveCategory: null };

// ════ 1. Caminho terminal: DONE sempre, não importa o resto ════

console.log("Caminho terminal encerra a tela em DONE, sem olhar mais nada:");
for (const s of PATH_STATUSES.filter(isTerminalPathStatus)) {
  checar(`path.status=${s}`, { path: path({ status: s }), nodes: [node()], statements: [] }, "DONE", false);
}

// ════ 2. Cada NodeStatus, com caminho ATIVO e sem frase viva ════

console.log("\nCada estado de nível mapeia para exatamente uma tela:");
const ESPERADO_POR_NODE_STATUS = {
  DRAFT: "EDIT_NODE",
  REVIEWED: "REVIEW_NODE",
  PRESENTED: "STAGE",
  AWAITING_SELECTION: "STAGE",
  PROVISIONAL_SELECTION: "STAGE",
  // CONFIRMED depende da opção escolhida — tratado à parte, abaixo.
  INACTIVE: "STAGE",
  CANCELED: "STAGE",
  REPLACED: "STAGE",
};
check(
  "a tabela acima cobre todo NodeStatus do domínio (menos CONFIRMED)",
  NODE_STATUSES.filter((s) => s !== "CONFIRMED").every((s) => s in ESPERADO_POR_NODE_STATUS) &&
    Object.keys(ESPERADO_POR_NODE_STATUS).length === NODE_STATUSES.length - 1
);
for (const s of NODE_STATUSES) {
  if (s === "CONFIRMED") continue;
  const esperado = ESPERADO_POR_NODE_STATUS[s];
  checar(`node.status=${s}`, { path: path(), nodes: [node({ status: s })], statements: [] }, esperado, esperado === "STAGE");
}

console.log("\nNível CONFIRMED: opção terminal abre o compositor, comum abre o próximo nível:");
checar(
  "opção comum confirmada",
  { path: path(), nodes: [node({ status: "CONFIRMED", confirmedOptionId: "opt-1", options: [OPCAO_COMUM] })], statements: [] },
  "EDIT_NODE",
  false
);
checar(
  "opção terminal confirmada",
  { path: path(), nodes: [node({ status: "CONFIRMED", confirmedOptionId: "opt-1", options: [OPCAO_TERMINAL] })], statements: [] },
  "EDIT_STATEMENT",
  false
);

console.log("\nSem nó ativo nenhum: EDIT_NODE do primeiro nível, e não STAGE:");
checar("sem activeNodeId", { path: path({ activeNodeId: null }), nodes: [], statements: [] }, "EDIT_NODE", false);

// ════ 3. Cada StatementStatus não-terminal domina sobre o nível ════

console.log("\nUma frase viva e não-terminal manda na tela, não importa o nível:");
const ESPERADO_POR_STATEMENT_STATUS = {
  DRAFT: "EDIT_STATEMENT",
  REVIEWED: "EDIT_STATEMENT",
  PRESENTED: "CONFIRM_STATEMENT",
  PROVISIONAL_RESPONSE: "CONFIRM_STATEMENT",
  RECONFIRMATION_PENDING: "CONFIRM_STATEMENT",
  // CONFIRMED, REJECTED, CANCELED, REPLACED são terminais — tratados abaixo.
};
const TERMINAIS_DE_STATEMENT = STATEMENT_STATUSES.filter((s) => !(s in ESPERADO_POR_STATEMENT_STATUS));
check(
  "as duas tabelas juntas cobrem todo StatementStatus do domínio",
  TERMINAIS_DE_STATEMENT.length + Object.keys(ESPERADO_POR_STATEMENT_STATUS).length === STATEMENT_STATUSES.length
);
for (const s of STATEMENT_STATUSES) {
  if (!(s in ESPERADO_POR_STATEMENT_STATUS)) continue;
  const esperado = ESPERADO_POR_STATEMENT_STATUS[s];
  const detail = {
    path: path(),
    // Nó CONFIRMED com opção terminal: o caso real em que uma frase nasce.
    nodes: [node({ status: "CONFIRMED", confirmedOptionId: "opt-1", options: [OPCAO_TERMINAL] })],
    statements: [statement({ status: s })],
  };
  checar(`statement.status=${s}`, detail, esperado, esperado === "CONFIRM_STATEMENT");
}

console.log("\nCONFIRMED e REJECTED são terminais e ainda VIVOS para liveStatement — encerram em DONE:");
for (const s of ["CONFIRMED", "REJECTED"]) {
  const over = s === "CONFIRMED" ? { confirmedResponse: "YES" } : {};
  const detail = { path: path(), nodes: [node({ status: "CONFIRMED" })], statements: [statement({ status: s, ...over })] };
  checar(`statement.status=${s}`, detail, "DONE", false);
}

// CANCELED e REPLACED são o oposto: `liveStatement` os descarta ANTES do
// próprio terminal-check de telaDerivada rodar — nunca chegam lá "vivos".
// Na prática isso é o comportamento certo: uma frase cancelada ou substituída
// sempre convive, no mesmo caminho, com a que veio depois dela (a versão
// corrigida, ou o registro novo aberto após "aprofundar assunto"). Com um nó
// CONFIRMED e opção terminal — e nenhuma outra frase no array —, a tela cai
// de volta no compositor para uma frase NOVA, e não em DONE.
console.log("\nCANCELED e REPLACED são descartados por liveStatement — a tela recai sobre o nível:");
for (const s of ["CANCELED", "REPLACED"]) {
  const detail = {
    path: path(),
    nodes: [node({ status: "CONFIRMED", confirmedOptionId: "opt-1", options: [OPCAO_TERMINAL] })],
    statements: [statement({ status: s })],
  };
  checar(`statement.status=${s}`, detail, "EDIT_STATEMENT", false);
}

// ════ 4. liveStatement descarta CANCELED/REPLACED — é por isso que eles caem
//         no ramo terminal acima, e não continuam "vivos" ════

console.log("\nliveStatement descarta o que já foi descartado ou substituído:");
{
  const s1 = statement({ id: "st-old", status: "CANCELED" });
  const s2 = statement({ id: "st-new", status: "PRESENTED" });
  check("a última não-descartada é a viva", liveStatement({ statements: [s1, s2] })?.id === "st-new");
  const s3 = statement({ id: "st-replaced", status: "REPLACED" });
  check("nenhuma viva quando todas foram descartadas/substituídas", liveStatement({ statements: [s3, s1] }) === null);
}

// ════ 5. Cobertura: os casos acima realmente visitaram os seis `kind` do
//         tipo Screen — não só uma parte dele. Se um `kind` sumir da lista
//         (por exemplo, alguém remover o caso REVIEW_NODE sem querer), a
//         checagem de tamanho abaixo denuncia o buraco. ════

console.log("\nOs casos acima cobrem todos os seis `kind` de Screen:");
const TODOS_OS_KINDS = ["EDIT_NODE", "REVIEW_NODE", "STAGE", "EDIT_STATEMENT", "CONFIRM_STATEMENT", "DONE"];
for (const kind of TODOS_OS_KINDS) {
  check(`kind=${kind} foi exercitado por algum caso acima`, kindsVistos.has(kind));
}
check("nenhum kind fora da lista apareceu", [...kindsVistos].every((k) => TODOS_OS_KINDS.includes(k)));

console.log(`\n${passed} passaram · ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
