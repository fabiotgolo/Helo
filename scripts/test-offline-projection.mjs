// ——— Snapshot + fila = o que a tela mostra sem conexão (Fase 4.9.2) ———
//
// Puro, como o teste da fila. Prova duas famílias de coisa:
//
//   1. CONTINUIDADE — sem rede o cuidador consegue mesmo criar pergunta,
//      apresentar, registrar a seleção observada, escrever interpretação,
//      editar contexto, abrir os controles do paciente e pausar;
//
//   2. AUTORIA — e, fazendo tudo isso, NÃO consegue produzir fala confirmada.
//
// A segunda é a razão de o arquivo existir. A projeção roda as MESMAS máquinas
// de estados do servidor, então ela teria como levar uma frase a CONFIRMED —
// e uma frase CONFIRMED passa pelo portão de autoria, que faz a interface
// escrever "Confirmada pelo paciente" sobre um SIM que ninguém registrou.
//
// O guarda olha o RESULTADO da transição, não o nome da ação. A seção final
// confere isso contra o PORTÃO DE VERDADE (`tryToConfirmedPatientStatement`),
// e não contra uma cópia da regra dele — uma cópia poderia divergir, e a que
// divergisse seria exatamente a que deixaria passar.
//
//   npm run test:offline:projection

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const {
  projetarSessao,
  projetarCaminhos,
  assertNenhumaFalaForjada,
  confirmadasNoSnapshot,
  motivoParaRecusarOffline,
} = await import("../lib/offline/projection.ts");

const { appendOperation, markStatus } = await import("../lib/offline/queue.ts");
const { newEntityId, PREFIXO } = await import("../lib/offline/ids.ts");
const { tryToConfirmedPatientStatement, rotuloDeAutoria } = await import(
  "../lib/confirmed-patient-statement.ts"
);
const { STATEMENT_STATUSES } = await import("../lib/option-conversation-types.ts");

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

function lanca(nome, fn, trecho = "") {
  try {
    fn();
    failed++;
    console.error(`  ✗ ${nome} — não lançou`);
  } catch (e) {
    if (!trecho || String(e.message).includes(trecho)) {
      passed++;
      console.log(`  ✓ ${nome}`);
    } else {
      failed++;
      console.error(`  ✗ ${nome} — mensagem inesperada: ${e.message}`);
    }
  }
}

// ---------- Fixtures ----------

const PACIENTE_NUM = 7;
const PACIENTE = "7";
const SESSAO = "cqs-fixture";
const AGORA = "2026-08-04T10:00:00.000Z";

const AUTOR = {
  assistantId: "user-1",
  assistantName: "Ana",
  patientId: PACIENTE_NUM,
};

function sessaoBase(extra = {}) {
  return {
    session: {
      id: SESSAO,
      patientId: PACIENTE_NUM,
      assistantId: "user-1",
      assistantName: "Ana",
      status: "ACTIVE",
      startedAt: AGORA,
      pausedAt: null,
      resumedAt: null,
      completedAt: null,
      abandonedAt: null,
      turnCount: 0,
      createdAt: AGORA,
      updatedAt: AGORA,
      ...extra,
    },
    turns: [],
    context: null,
    controlRequest: null,
  };
}

function fraseBase(extra = {}) {
  return {
    id: "ocs-antiga",
    pathId: "ocp-1",
    sessionId: SESSAO,
    patientId: PACIENTE_NUM,
    assistantId: "user-1",
    originNodeId: null,
    origin: "OPTION_PATH",
    interactionMode: "FINAL_STATEMENT_CONFIRMATION",
    originalDraft: "quero água",
    currentText: "quero água",
    presentedText: "quero água",
    status: "PROVISIONAL_RESPONSE",
    provisionalResponse: "YES",
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
    presentedAt: AGORA,
    respondedAt: AGORA,
    reconfirmedAt: null,
    confirmedAt: null,
    rejectedAt: null,
    canceledAt: null,
    replacedAt: null,
    createdAt: AGORA,
    updatedAt: AGORA,
    ...extra,
  };
}

function caminhoBase(extra = {}) {
  return {
    path: {
      id: "ocp-1",
      sessionId: SESSAO,
      patientId: PACIENTE_NUM,
      assistantId: "user-1",
      kind: "OPTION_TREE",
      status: "ACTIVE",
      rootNodeId: null,
      activeNodeId: null,
      activeBranchId: "br-1",
      finalStatementId: null,
      sequence: 1,
      restartedFromPathId: null,
      reusedFromPathId: null,
      clientRequestId: null,
      startedAt: AGORA,
      pausedAt: null,
      resumedAt: null,
      completedAt: null,
      interruptedAt: null,
      restartedAt: null,
      createdAt: AGORA,
      updatedAt: AGORA,
      ...extra,
    },
    nodes: [],
    statements: [],
  };
}

/** Monta uma fila a partir de entradas simplificadas. */
function filaDe(...entradas) {
  let fila = [];
  for (const e of entradas) {
    fila = appendOperation(fila, {
      sessionId: SESSAO,
      patientId: PACIENTE,
      ...e,
    }).fila;
  }
  return fila;
}

// ---------- 1. Pergunta manual sem conexão ----------

console.log("\nPergunta manual sem conexão:");
{
  const turnId = newEntityId(PREFIXO.turn);
  const fila = filaDe({
    operationType: "createTurn",
    createdEntityId: turnId,
    payload: { sessionId: SESSAO, turnId, text: "Você está com dor?" },
  });

  const { detail, marcas } = projetarSessao(sessaoBase(), fila, AUTOR);
  check("a pergunta aparece na tela", detail.turns.length === 1);
  check("com o id que o cliente cunhou", detail.turns[0].id === turnId);
  check("com o texto que o cuidador escreveu", detail.turns[0].reviewedText === "Você está com dor?");
  check("em rascunho — nada foi apresentado ainda", detail.turns[0].status === "DRAFT");
  check("sem resposta observada", detail.turns[0].provisionalResponse === null);
  check("sem resposta confirmada", detail.turns[0].confirmedResponse === null);
  check("o contador da sessão acompanha", detail.session.turnCount === 1);
  check("o registro é marcado como local", marcas.locais.has(turnId));
  check(
    "presentedText continua vazio: o paciente não viu nada",
    detail.turns[0].presentedText === ""
  );
  check(
    "a autoria é do cuidador autenticado, não de um valor do payload",
    detail.turns[0].assistantId === AUTOR.assistantId
  );
  check(
    "e o paciente é o da sessão",
    detail.turns[0].patientId === PACIENTE_NUM
  );
}

// ---------- 2. Ciclo da pergunta fechada ----------

console.log("\nApresentar e registrar a resposta observada:");
{
  const turnId = newEntityId(PREFIXO.turn);
  const fila = filaDe(
    {
      operationType: "createTurn",
      createdEntityId: turnId,
      payload: { sessionId: SESSAO, turnId, text: "Está com dor?" },
    },
    {
      operationType: "turnAction",
      payload: {
        sessionId: SESSAO,
        turnId,
        action: { kind: "REVIEW", reviewedText: "Está com dor?" },
      },
    },
    {
      operationType: "turnAction",
      payload: { sessionId: SESSAO, turnId, action: { kind: "PRESENT" } },
    },
    {
      operationType: "turnAction",
      payload: { sessionId: SESSAO, turnId, action: { kind: "AWAIT_RESPONSE" } },
    },
    {
      operationType: "turnAction",
      payload: {
        sessionId: SESSAO,
        turnId,
        action: { kind: "SELECT_RESPONSE", response: "YES" },
      },
    }
  );

  const { detail, marcas } = projetarSessao(sessaoBase(), fila, AUTOR);
  const turno = detail.turns[0];
  check("o ciclo inteiro foi aplicado", marcas.naoAplicadas.length === 0);
  check("a pergunta chegou a resposta provisória", turno.status === "PROVISIONAL_RESPONSE");
  check("com o SIM que o cuidador observou", turno.provisionalResponse === "YES");
  check("mas SEM resposta confirmada", turno.confirmedResponse === null);
  check("o texto apresentado ficou congelado", turno.presentedText === "Está com dor?");
  check("com horário de apresentação", turno.presentedAt !== null);
}

// ---------- 3. Ordem e escopo ----------

console.log("\nOrdem e escopo da projeção:");
{
  const turnId = newEntityId(PREFIXO.turn);
  // REVIEW antes de PRESENT não é cerimônia do teste: o domínio só apresenta
  // o que o assistente revisou, e a projeção usa a MESMA máquina. Uma fila que
  // pulasse este passo seria recusada aqui exatamente como no servidor — e é
  // bom que seja, porque é o que garante que o que passa offline passa online.
  let fila = filaDe(
    {
      operationType: "createTurn",
      createdEntityId: turnId,
      payload: { sessionId: SESSAO, turnId, text: "primeira" },
    },
    {
      operationType: "turnAction",
      payload: {
        sessionId: SESSAO,
        turnId,
        action: { kind: "REVIEW", reviewedText: "primeira" },
      },
    },
    {
      operationType: "turnAction",
      payload: { sessionId: SESSAO, turnId, action: { kind: "PRESENT" } },
    }
  );

  // Fora de ordem na lista, mas com sequence correto: a projeção ordena.
  const embaralhada = [fila[2], fila[0], fila[1]];
  const { detail } = projetarSessao(sessaoBase(), embaralhada, AUTOR);
  check(
    "a projeção respeita o sequence, não a ordem do array",
    detail.turns.length === 1 && detail.turns[0].status === "PRESENTED",
    detail.turns[0]?.status
  );

  // Uma operação já confirmada pelo servidor não é reaplicada.
  const confirmada = markStatus(
    markStatus(fila, fila[0].id, "SYNCING"),
    fila[0].id,
    "SYNCED"
  );
  const { detail: semReaplicar, marcas } = projetarSessao(
    sessaoBase(),
    confirmada,
    AUTOR
  );
  check(
    "operação SYNCED não é reaplicada — o snapshot já a contém",
    semReaplicar.turns.length === 0
  );
  check(
    "e as que dependiam dela ficam registradas como não aplicadas, sem quebrar a tela",
    marcas.naoAplicadas.length === 2,
    JSON.stringify(marcas.naoAplicadas)
  );

  // Operação de outra sessão é ignorada.
  const deOutra = fila.map((op) => ({ ...op, sessionId: "cqs-outra" }));
  const { detail: ignorada } = projetarSessao(sessaoBase(), deOutra, AUTOR);
  check("operação de outra sessão não entra nesta tela", ignorada.turns.length === 0);
}

// ---------- 4. Conversa por opções ----------

console.log("\nConversa por opções sem conexão:");
{
  const pathId = newEntityId(PREFIXO.path);
  const nodeId = newEntityId(PREFIXO.node);

  const fila = filaDe(
    {
      operationType: "createPath",
      createdEntityId: pathId,
      payload: { sessionId: SESSAO, pathId },
    },
    {
      operationType: "createNode",
      createdEntityId: nodeId,
      payload: {
        sessionId: SESSAO,
        pathId,
        nodeId,
        promptText: "Onde dói?",
        options: [{ label: "Cabeça" }, { label: "Barriga" }, { label: "Perna" }],
      },
    },
    {
      // Escrever no editor JÁ é a revisão do assistente — é o que `flow.tsx`
      // faz online, e a fila offline carrega o mesmo par. Sem ele o nível
      // ficaria em DRAFT e a apresentação seria recusada, aqui e no servidor.
      operationType: "reviewNode",
      payload: {
        sessionId: SESSAO,
        pathId,
        nodeId,
        input: {
          promptText: "Onde dói?",
          options: [{ label: "Cabeça" }, { label: "Barriga" }, { label: "Perna" }],
        },
      },
    },
    {
      operationType: "nodeAction",
      payload: { sessionId: SESSAO, pathId, nodeId, action: { kind: "PRESENT" } },
    },
    {
      operationType: "nodeAction",
      payload: {
        sessionId: SESSAO,
        pathId,
        nodeId,
        action: { kind: "AWAIT_SELECTION" },
      },
    }
  );

  const { details, marcas } = projetarCaminhos([], fila, AUTOR, SESSAO);
  check("o caminho nasceu localmente", details.length === 1);
  check("tudo foi aplicado", marcas.naoAplicadas.length === 0, JSON.stringify(marcas.naoAplicadas));

  const detalhe = details[0];
  check("com um nível", detalhe.nodes.length === 1);
  check("com as três opções", detalhe.nodes[0].options.length === 3);
  check(
    "as posições foram normalizadas pelo domínio",
    detalhe.nodes[0].options.map((o) => o.position).join(",") === "1,2,3"
  );
  check("o nível está aguardando seleção", detalhe.nodes[0].status === "AWAITING_SELECTION");
  check("o caminho aponta para ele como raiz", detalhe.path.rootNodeId === nodeId);
  check("e como nível ativo — é o que o breadcrumb lê", detalhe.path.activeNodeId === nodeId);

  // ——— A projeção precisa ser ESTÁVEL entre execuções ———
  //
  // Ela roda de novo a cada renderização. Se os ids de opção fossem
  // aleatórios, as opções trocariam de identidade entre um quadro e o
  // seguinte, e o `provisionalOptionId` recém-registrado apontaria para uma
  // opção que já não existe — a seleção observada do paciente sumiria da tela,
  // sem erro e sem aviso. Este teste é o que impede isso de voltar.
  const denovo = projetarCaminhos([], fila, AUTOR, SESSAO);
  check(
    "duas projeções da MESMA fila dão os mesmos ids de opção",
    JSON.stringify(denovo.details[0].nodes[0].options.map((o) => o.id)) ===
      JSON.stringify(detalhe.nodes[0].options.map((o) => o.id))
  );
  check(
    "e a mesma ramificação",
    denovo.details[0].path.activeBranchId === detalhe.path.activeBranchId
  );
  check(
    "os ids de opção são distintos entre si",
    new Set(detalhe.nodes[0].options.map((o) => o.id)).size === 3
  );

  // Seleção observada — provisória, nunca confirmada.
  const opcao = detalhe.nodes[0].options[0].id;
  const comSelecao = [
    ...fila,
    ...filaDe({
      operationType: "nodeAction",
      payload: {
        sessionId: SESSAO,
        pathId,
        nodeId,
        action: { kind: "SELECT_OPTION", optionId: opcao },
      },
    }).map((op) => ({ ...op, sequence: 99 })),
  ];
  const comSel = projetarCaminhos([], comSelecao, AUTOR, SESSAO);
  const nivel = comSel.details[0].nodes[0];
  check("a seleção observada foi registrada", nivel.status === "PROVISIONAL_SELECTION");
  check("com a opção que o cuidador observou", nivel.provisionalOptionId === opcao);
  check("e SEM opção confirmada", nivel.confirmedOptionId === null);
}

// ---------- 5. Aprofundamento exige nível confirmado ----------

console.log("\nAprofundar exige a conferência do nível anterior:");
{
  const pathId = "ocp-1";
  const paiId = "ocn-pai";
  const filhoId = newEntityId(PREFIXO.node);

  const base = [
    {
      ...caminhoBase({ activeNodeId: paiId, rootNodeId: paiId }),
      nodes: [
        {
          id: paiId,
          pathId,
          sessionId: SESSAO,
          patientId: PACIENTE_NUM,
          assistantId: "user-1",
          parentNodeId: null,
          branchId: "br-1",
          depth: 0,
          sequence: 1,
          interactionMode: "OPTION_SELECTION",
          promptText: "Onde dói?",
          status: "PROVISIONAL_SELECTION",
          options: [
            {
              id: "opt-1",
              position: 1,
              label: "Cabeça",
              nextNodeId: null,
              isTerminal: false,
              finalStatementDraft: null,
              isSensitive: false,
              sensitiveCategory: null,
            },
          ],
          provisionalOptionId: "opt-1",
          confirmedOptionId: null,
          reusedFromNodeId: null,
          replacesNodeId: null,
          replacedByNodeId: null,
          isSensitive: false,
          sensitiveCategory: null,
          correctionCount: 0,
          clientRequestId: null,
          presentedAt: AGORA,
          selectedAt: AGORA,
          confirmedAt: null,
          deactivatedAt: null,
          canceledAt: null,
          replacedAt: null,
          createdAt: AGORA,
          updatedAt: AGORA,
        },
      ],
      statements: [],
    },
  ];

  const fila = filaDe({
    operationType: "createNode",
    createdEntityId: filhoId,
    payload: {
      sessionId: SESSAO,
      pathId,
      nodeId: filhoId,
      parentNodeId: paiId,
      promptText: "Dor forte?",
      options: [{ label: "Sim" }, { label: "Mais ou menos" }],
    },
  });

  const { details, marcas } = projetarCaminhos(base, fila, AUTOR, SESSAO);
  check(
    "não aprofunda sobre um nível ainda não conferido",
    details[0].nodes.length === 1
  );
  check(
    "e o motivo fica registrado, em português, para a tela poder dizer",
    marcas.naoAplicadas.some((n) =>
      n.motivo.includes("opção confirmada antes de aprofundar")
    )
  );

  // Com o pai confirmado, aprofunda — e o vínculo entre níveis é escrito.
  const baseConfirmada = [
    {
      ...base[0],
      nodes: [
        {
          ...base[0].nodes[0],
          status: "CONFIRMED",
          confirmedOptionId: "opt-1",
          confirmedAt: AGORA,
        },
      ],
    },
  ];
  const ok = projetarCaminhos(baseConfirmada, fila, AUTOR, SESSAO);
  check("com o nível conferido, aprofunda", ok.details[0].nodes.length === 2);
  const filho = ok.details[0].nodes.find((n) => n.id === filhoId);
  check("o filho herda a ramificação do pai", filho.branchId === "br-1");
  check("e a profundidade seguinte", filho.depth === 1);
  check(
    "o vínculo é escrito na opção escolhida do pai",
    ok.details[0].nodes.find((n) => n.id === paiId).options[0].nextNodeId === filhoId
  );
}

// ———————————————————————————————————————————————————————————————
// 6. A LINHA: salvar localmente não é confirmar pelo paciente
// ———————————————————————————————————————————————————————————————

console.log("\nSalvar localmente NÃO é confirmar pelo paciente:");
{
  const base = [
    {
      ...caminhoBase({ finalStatementId: "ocs-antiga" }),
      statements: [fraseBase()],
    },
  ];

  check(
    "no snapshot, a frase ainda não é fala confirmada",
    tryToConfirmedPatientStatement(base[0].statements[0]) === null
  );

  const fila = filaDe({
    operationType: "statementAction",
    payload: {
      sessionId: SESSAO,
      pathId: "ocp-1",
      statementId: "ocs-antiga",
      action: { kind: "CONFIRM" },
    },
  });

  const { details, marcas } = projetarCaminhos(base, fila, AUTOR, SESSAO);
  const frase = details[0].statements[0];

  check("a frase NÃO foi para CONFIRMED", frase.status !== "CONFIRMED");
  check("continua exatamente onde estava", frase.status === "PROVISIONAL_RESPONSE");
  check("sem resposta confirmada", frase.confirmedResponse === null);
  check("sem horário de confirmação", frase.confirmedAt === null);
  check(
    "o PORTÃO DE AUTORIA continua recusando",
    tryToConfirmedPatientStatement(frase) === null
  );
  check(
    "e a intenção do cuidador NÃO se perdeu: a frase entra em confirmação pendente",
    marcas.confirmacaoPendente.has("ocs-antiga")
  );
  check("a operação continua na fila", fila.length === 1 && fila[0].status === "PENDING");

  // Reconfirmação de conteúdo sensível: o passo intermediário acontece
  // (é um marco real do cuidador), mas a confirmação seguinte não.
  const sensivel = [
    {
      ...caminhoBase({ finalStatementId: "ocs-s" }),
      statements: [
        fraseBase({ id: "ocs-s", isSensitive: true, sensitiveCategory: "HEALTH" }),
      ],
    },
  ];
  const filaSensivel = filaDe(
    {
      operationType: "statementAction",
      payload: {
        sessionId: SESSAO,
        pathId: "ocp-1",
        statementId: "ocs-s",
        action: { kind: "RECONFIRM" },
      },
    },
    {
      operationType: "statementAction",
      payload: {
        sessionId: SESSAO,
        pathId: "ocp-1",
        statementId: "ocs-s",
        action: { kind: "CONFIRM" },
      },
    }
  );
  const r = projetarCaminhos(sensivel, filaSensivel, AUTOR, SESSAO);
  const fraseS = r.details[0].statements[0];
  check(
    "a reconfirmação reforçada é registrada",
    fraseS.status === "RECONFIRMATION_PENDING" && fraseS.reconfirmedAt !== null
  );
  check(
    "mas nem com ela a confirmação acontece localmente",
    fraseS.status !== "CONFIRMED" &&
      tryToConfirmedPatientStatement(fraseS) === null
  );
  check(
    "e a confirmação pendente é sinalizada",
    r.marcas.confirmacaoPendente.has("ocs-s")
  );

  // Recusar a frase é decisão que merece chegar inteira ao servidor.
  const filaReject = filaDe({
    operationType: "statementAction",
    payload: {
      sessionId: SESSAO,
      pathId: "ocp-1",
      statementId: "ocs-antiga",
      action: { kind: "REJECT" },
    },
  });
  const rej = projetarCaminhos(base, filaReject, AUTOR, SESSAO);
  check(
    "REJECT não é aplicado localmente, e o motivo fica dito",
    rej.marcas.naoAplicadas.some((n) => n.motivo.includes("exige conexão"))
  );
}

// ---------- 7. O portão de verdade confere o resultado ----------

console.log("\nO portão de autoria confere a projeção inteira:");
{
  const forjada = fraseBase({
    id: "ocs-forjada",
    status: "CONFIRMED",
    confirmedResponse: "YES",
    provisionalResponse: "YES",
    confirmedAt: AGORA,
  });

  check(
    "a frase forjada PASSARIA pelo portão — é isto que torna o guarda necessário",
    tryToConfirmedPatientStatement(forjada) !== null
  );
  lanca(
    "e a projeção recusa entregá-la sem o servidor",
    () => assertNenhumaFalaForjada([forjada], new Set()),
    "sem o servidor"
  );
  check(
    "a MESMA frase passa quando foi o servidor que a confirmou",
    (assertNenhumaFalaForjada([forjada], new Set(["ocs-forjada"])), true)
  );
  check(
    "confirmadasNoSnapshot reconhece o que o servidor já havia confirmado",
    confirmadasNoSnapshot([
      { ...caminhoBase(), statements: [forjada] },
    ]).has("ocs-forjada")
  );
  check(
    "e não inclui o que ainda não é fala confirmada",
    confirmadasNoSnapshot([
      { ...caminhoBase(), statements: [fraseBase()] },
    ]).size === 0
  );

  // ENUMERAÇÃO: nenhum status de frase alcançável pela projeção produz fala
  // confirmada. Se um StatementStatus novo nascer, ele cai aqui.
  const alcancados = new Set();
  for (const status of STATEMENT_STATUSES) {
    if (status === "CONFIRMED") continue; // é o que o guarda barra
    const f = fraseBase({ id: `ocs-${status}`, status });
    alcancados.add(status);
    if (tryToConfirmedPatientStatement(f) !== null) {
      failed++;
      console.error(`  ✗ o status ${status} passou pelo portão de autoria`);
    }
  }
  check(
    `nenhum dos ${alcancados.size} status não-CONFIRMED produz fala confirmada`,
    alcancados.size === STATEMENT_STATUSES.length - 1
  );
}

// ---------- 8. Interpretação do cuidador ----------

console.log("\nInterpretação digitada pelo cuidador:");
{
  const pathId = newEntityId(PREFIXO.path);
  const statementId = newEntityId(PREFIXO.statement);
  const fila = filaDe({
    operationType: "createCaregiverInterpretation",
    createdEntityId: pathId,
    payload: {
      sessionId: SESSAO,
      pathId,
      statementId,
      text: "Acho que você quer água",
    },
  });

  const { details } = projetarCaminhos([], fila, AUTOR, SESSAO);
  const detalhe = details[0];
  const frase = detalhe.statements[0];

  check("o contêiner nasce como interpretação", detalhe.path.kind === "CAREGIVER_INTERPRETATION");
  check("a frase carrega a origem", frase.origin === "CAREGIVER_INTERPRETATION");
  check(
    "e o modo correspondente, pela fonte única do domínio",
    frase.interactionMode === "CAREGIVER_INTERPRETATION"
  );
  check("o texto é o que o cuidador escreveu", frase.currentText === "Acho que você quer água");
  check("em rascunho — o paciente ainda não viu", frase.status === "DRAFT");
  check(
    "e ainda não é fala do paciente",
    tryToConfirmedPatientStatement(frase) === null
  );

  // A origem sobrevive à confirmação — é o que a Fase 4.2 existe para garantir.
  const comoConfirmada = {
    ...frase,
    presentedText: frase.currentText,
    status: "CONFIRMED",
    provisionalResponse: "YES",
    confirmedResponse: "YES",
    confirmedAt: AGORA,
    presentedAt: AGORA,
    respondedAt: AGORA,
  };
  const fala = tryToConfirmedPatientStatement(comoConfirmada);
  check("uma vez confirmada pelo servidor, ela é fala do paciente", fala !== null);
  check("mas o texto continua sendo do cuidador", fala.textFormulatedBy === "CAREGIVER");
  check(
    "e o rótulo diz as duas coisas",
    rotuloDeAutoria(fala) ===
      "Confirmada pelo paciente · texto formulado pelo cuidador."
  );
}

// ---------- 9. Contexto da sessão ----------

console.log("\nContexto da conversa sem conexão:");
{
  const ctx1 = newEntityId(PREFIXO.context);
  const fila = filaDe({
    operationType: "saveSessionContext",
    createdEntityId: ctx1,
    payload: {
      sessionId: SESSAO,
      contextId: ctx1,
      interlocutorName: "Maria",
      intention: "Pedir algo",
      environment: "Casa",
    },
  });

  const { detail } = projetarSessao(sessaoBase(), fila, AUTOR);
  check("o contexto foi gravado", detail.context !== null);
  check("na versão 1", detail.context.version === 1);
  check("com o interlocutor informado", detail.context.interlocutorName === "Maria");
  check(
    "como texto livre — offline não validamos a rede do paciente, e digitar nunca cria contato",
    detail.context.interlocutorSource === "FREE_TEXT" &&
      detail.context.interlocutorPersonId === null
  );
  check("não substitui nenhuma versão anterior", detail.context.replacesContextId === null);

  // Editar cria a versão seguinte, ligada à anterior. Nunca sobrescreve.
  const ctx2 = newEntityId(PREFIXO.context);
  const fila2 = [
    ...fila,
    ...filaDe({
      operationType: "saveSessionContext",
      createdEntityId: ctx2,
      payload: {
        sessionId: SESSAO,
        contextId: ctx2,
        interlocutorName: "Maria",
        intention: "Explicar um desconforto",
      },
    }).map((op) => ({ ...op, sequence: 50 })),
  ];
  const { detail: d2 } = projetarSessao(sessaoBase(), fila2, AUTOR);
  check("editar cria a versão 2", d2.context.version === 2);
  check("ligada à anterior", d2.context.replacesContextId === ctx1);
  check("com o conteúdo novo", d2.context.intention === "Explicar um desconforto");
  check("e a versão vigente é a nova", d2.context.id === ctx2);

  // "Começar sem contexto" é uma decisão registrada, não ausência de registro.
  const ctx3 = newEntityId(PREFIXO.context);
  const pulado = projetarSessao(
    sessaoBase(),
    filaDe({
      operationType: "saveSessionContext",
      createdEntityId: ctx3,
      payload: { sessionId: SESSAO, contextId: ctx3, skipped: true },
    }),
    AUTOR
  );
  check("pular é registrado", pulado.detail.context.skipped === true);
  check(
    "e um contexto pulado não carrega conteúdo nenhum",
    pulado.detail.context.intention === null &&
      pulado.detail.context.interlocutorName === null &&
      pulado.detail.context.interlocutorSource === null
  );
}

// ---------- 10. Controles do paciente ----------

console.log("\nControles diretos do paciente sem conexão:");
{
  const requestId = newEntityId(PREFIXO.control);
  const fila = filaDe(
    {
      operationType: "openPatientControl",
      createdEntityId: requestId,
      payload: { sessionId: SESSAO, requestId, targetType: "TURN", targetId: "cqt1" },
    },
    {
      operationType: "patientControlAction",
      payload: { sessionId: SESSAO, requestId, action: { kind: "PRESENT" } },
    },
    {
      operationType: "patientControlAction",
      payload: { sessionId: SESSAO, requestId, action: { kind: "AWAIT_SELECTION" } },
    },
    {
      operationType: "patientControlAction",
      payload: {
        sessionId: SESSAO,
        requestId,
        action: { kind: "SELECT_COMMAND", command: "PAUSE" },
      },
    }
  );

  const { detail, marcas } = projetarSessao(sessaoBase(), fila, AUTOR);
  check("o painel abriu localmente", detail.controlRequest !== null);
  check("tudo foi aplicado", marcas.naoAplicadas.length === 0, JSON.stringify(marcas.naoAplicadas));
  check("com o alvo que estava no ar", detail.controlRequest.targetId === "cqt1");
  check(
    "o comando observado é provisório",
    detail.controlRequest.provisionalCommand === "PAUSE"
  );
  check(
    "e NÃO confirmado — um comando confirmado executaria",
    detail.controlRequest.confirmedCommand === null
  );
  check(
    "nada foi executado",
    detail.controlRequest.executedAt === null && detail.session.status === "ACTIVE"
  );
}

// ---------- 11. Pausa e retomada ----------

console.log("\nPausar e retomar sem conexão:");
{
  const pausada = projetarSessao(
    sessaoBase(),
    filaDe({
      operationType: "sessionAction",
      payload: { sessionId: SESSAO, action: "PAUSE" },
    }),
    AUTOR
  );
  check("pausar funciona offline", pausada.detail.session.status === "PAUSED");
  check("com horário registrado", pausada.detail.session.pausedAt !== null);

  const retomada = projetarSessao(
    sessaoBase({ status: "PAUSED", pausedAt: AGORA }),
    filaDe({
      operationType: "sessionAction",
      payload: { sessionId: SESSAO, action: "RESUME" },
    }),
    AUTOR
  );
  check("retomar funciona offline", retomada.detail.session.status === "ACTIVE");
}

// ---------- 12. O que NÃO se faz sem conexão ----------

console.log("\nO que exige conexão:");
{
  const ativa = sessaoBase().session;
  check(
    "criar pergunta é permitido numa sessão ativa",
    motivoParaRecusarOffline("createTurn", {}, ativa) === null
  );
  check(
    "pausar é permitido",
    motivoParaRecusarOffline("sessionAction", { action: "PAUSE" }, ativa) === null
  );
  check(
    "retomar é permitido",
    motivoParaRecusarOffline("sessionAction", { action: "RESUME" }, ativa) === null
  );
  check(
    "concluir a conversa exige conexão",
    motivoParaRecusarOffline("sessionAction", { action: "COMPLETE" }, ativa) ===
      "encerrar a conversa exige conexão"
  );
  check(
    "abandonar a conversa exige conexão",
    motivoParaRecusarOffline("sessionAction", { action: "ABANDON" }, ativa) !== null
  );
  check(
    "concluir um caminho exige conexão",
    motivoParaRecusarOffline(
      "pathAction",
      { action: { kind: "COMPLETE" } },
      ativa
    ) !== null
  );
  check(
    "interromper um caminho é permitido",
    motivoParaRecusarOffline(
      "pathAction",
      { action: { kind: "INTERRUPT" } },
      ativa
    ) === null
  );

  // §5: nunca operar sobre sessão encerrada.
  for (const status of ["COMPLETED", "ABANDONED"]) {
    check(
      `nada é aceito numa sessão ${status}`,
      motivoParaRecusarOffline("createTurn", {}, { ...ativa, status }) ===
        "esta conversa já foi encerrada"
    );
  }
  check(
    "uma sessão pausada continua aceitando registro",
    motivoParaRecusarOffline("createTurn", {}, { ...ativa, status: "PAUSED" }) === null
  );
}

// ---------- 13. Recusas não quebram a tela ----------

console.log("\nUma operação impossível não derruba a projeção:");
{
  const fila = filaDe({
    operationType: "turnAction",
    payload: {
      sessionId: SESSAO,
      turnId: "cqt-inexistente",
      action: { kind: "PRESENT" },
    },
  });
  const { detail, marcas } = projetarSessao(sessaoBase(), fila, AUTOR);
  check("a sessão continua legível", detail.session.id === SESSAO);
  check("e o motivo fica registrado", marcas.naoAplicadas.length === 1);
  check(
    "com o sequence da operação que falhou",
    marcas.naoAplicadas[0].sequence === fila[0].sequence
  );

  // Transição recusada pela máquina de estados: mesma coisa.
  const turnId = newEntityId(PREFIXO.turn);
  const invalida = filaDe(
    {
      operationType: "createTurn",
      createdEntityId: turnId,
      payload: { sessionId: SESSAO, turnId, text: "x" },
    },
    {
      // CONFIRMAR sem ter apresentado: a máquina recusa, aqui como no servidor.
      operationType: "turnAction",
      payload: {
        sessionId: SESSAO,
        turnId,
        action: { kind: "SELECT_RESPONSE", response: "YES" },
      },
    }
  );
  const r = projetarSessao(sessaoBase(), invalida, AUTOR);
  check(
    "a máquina de estados recusa offline exatamente como recusaria no servidor",
    r.marcas.naoAplicadas.length === 1
  );
  check("e a pergunta criada continua na tela", r.detail.turns.length === 1);
}

// ---------- Resultado ----------

console.log(`\n${passed} passaram · ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
