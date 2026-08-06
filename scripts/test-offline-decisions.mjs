// ——— O que a decisão do cuidador faz com a fila (Fase 4.9.3-C.2, §10) ———
//
// Puro. A parte que mais pode dar errado em silêncio é a CADEIA: descartar uma
// criação condena tudo que dependia dela, e errar isso para menos deixa na
// fila operações órfãs que tentam para sempre contra um registro que nunca vai
// nascer — errar para mais apaga trabalho do cuidador que ainda era válido.
//
//   npm run test:offline:decisions

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const {
  aplicarDecisao,
  cadeiaDependente,
  chaveDeReaproveitamento,
  comAlvo,
  opcaoDisponivel,
  textoDe,
} = await import("@/lib/offline/decisions");
const { appendOperation, markStatus } = await import("@/lib/offline/queue");
const { classificarRecusa } = await import("@/lib/offline/conflicts");

let passou = 0;
let falhou = 0;
function ok(cond, nome) {
  if (cond) {
    passou += 1;
    console.log(`  ✓ ${nome}`);
  } else {
    falhou += 1;
    console.log(`  ✗ ${nome}`);
  }
}
function eq(a, b, nome) {
  ok(a === b, `${nome}${a === b ? "" : ` — esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`}`);
}
function secao(t) {
  console.log(`\n${t}`);
}

const conflitoDe = (code, fatos) =>
  classificarRecusa({ status: 400, code, mensagem: "…", fatos });

/** Uma fila com caminho → nível → seleção, como a conversa por opções cria. */
function filaEncadeada() {
  let fila = [];
  const r1 = appendOperation(fila, {
    operationType: "createPath",
    sessionId: "s1",
    patientId: "7",
    payload: { sessionId: "s1" },
    createdEntityId: "ocp_caminho",
  });
  fila = r1.fila;
  const r2 = appendOperation(fila, {
    operationType: "createNode",
    sessionId: "s1",
    patientId: "7",
    payload: { pathId: "ocp_caminho", promptText: "Onde dói?" },
    createdEntityId: "ocn_nivel",
  });
  fila = r2.fila;
  const r3 = appendOperation(fila, {
    operationType: "nodeAction",
    sessionId: "s1",
    patientId: "7",
    payload: { nodeId: "ocn_nivel", action: { kind: "SELECT_OPTION" } },
  });
  fila = r3.fila;
  return { fila, caminho: r1.operacao, nivel: r2.operacao, selecao: r3.operacao };
}

// ════════════════════════════════════════════════════════════════════
secao("1. A cadeia — quem cai junto");
{
  const { fila, caminho, nivel, selecao } = filaEncadeada();

  const doCaminho = cadeiaDependente(fila, caminho.id);
  eq(doCaminho.length, 2, "descartar o caminho leva o nível e a seleção");
  ok(
    doCaminho.some((o) => o.id === nivel.id) &&
      doCaminho.some((o) => o.id === selecao.id),
    "e são exatamente esses dois — o fecho é transitivo, não de um nível só"
  );

  const doNivel = cadeiaDependente(fila, nivel.id);
  eq(doNivel.length, 1, "descartar o nível leva só a seleção");
  eq(doNivel[0].id, selecao.id, "e não toca o caminho, que veio antes");

  eq(cadeiaDependente(fila, selecao.id).length, 0, "a folha não leva ninguém");
  eq(cadeiaDependente(fila, "inexistente").length, 0, "id desconhecido não explode");
}

secao("2. A cadeia NÃO inclui o que o servidor já aceitou");
{
  const { fila, caminho, nivel } = filaEncadeada();
  // O nível foi confirmado: ele existe no servidor. Descartar o caminho local
  // não pode "desconfirmar" o que já foi aceito lá.
  const comSynced = markStatus(
    markStatus(fila, nivel.id, "SYNCING"),
    nivel.id,
    "SYNCED"
  );
  const cadeia = cadeiaDependente(comSynced, caminho.id);
  ok(
    !cadeia.some((o) => o.id === nivel.id),
    "operação SYNCED nunca entra na cadeia — nada local desfaz o que o servidor aceitou"
  );
}

secao("3. DESCARTAR leva a cadeia e diz quantos");
{
  const { fila, caminho } = filaEncadeada();
  const r = aplicarDecisao(fila, caminho.id, "DESCARTAR", conflitoDe("PATH_ENDED"));
  eq(r.fila.length, 0, "a fila fica vazia — os três saem juntos");
  eq(r.removidas.length, 3, "e os três ids são devolvidos para apagar do banco");
  ok(
    /mais 2 que dependiam dele/.test(r.descricao),
    `a frase diz quantos foram junto — veio: "${r.descricao}"`
  );
}

secao("4. DESCARTAR de uma folha não arrasta ninguém");
{
  const { fila, selecao } = filaEncadeada();
  const r = aplicarDecisao(fila, selecao.id, "DESCARTAR", conflitoDe("PATH_ENDED"));
  eq(r.fila.length, 2, "caminho e nível continuam na fila");
  eq(r.removidas.length, 1, "só a folha sai");
  ok(
    /este registro\.$/.test(r.descricao),
    `a frase não fala de dependentes que não existem — veio: "${r.descricao}"`
  );
}

secao("5. MANTER_DO_SERVIDOR descarta, mas com outra frase");
{
  const { fila, selecao } = filaEncadeada();
  const r = aplicarDecisao(
    fila,
    selecao.id,
    "MANTER_DO_SERVIDOR",
    conflitoDe("RESPONSE_CHANGED")
  );
  eq(r.removidas.length, 1, "a intenção local sai");
  ok(
    /Mantivemos o que estava no Helo/.test(r.descricao),
    "e o cuidador lê que o do servidor prevaleceu, não que ele 'perdeu' algo"
  );
}

secao("6. REAPROVEITAR guarda o texto como RASCUNHO, nunca como registro");
{
  let fila = [];
  const r1 = appendOperation(fila, {
    operationType: "createTurn",
    sessionId: "s1",
    patientId: "7",
    payload: { sessionId: "s1", text: "O senhor está com dor?" },
    createdEntityId: "cqt_x",
  });
  fila = r1.fila;

  const r = aplicarDecisao(
    fila,
    r1.operacao.id,
    "REAPROVEITAR_COMO_RASCUNHO",
    conflitoDe("SESSION_COMPLETED")
  );
  eq(r.fila.length, 0, "a operação sai da fila");
  ok(r.rascunho !== null, "e o texto volta como rascunho");
  eq(r.rascunho.valor, "O senhor está com dor?", "com o texto exato que o cuidador escreveu");
  eq(
    r.rascunho.chave,
    chaveDeReaproveitamento(r1.operacao),
    "numa chave própria daquela operação"
  );
  // A garantia central: NADA volta como operação, então nada pode ser enviado
  // nem confirmado sem o cuidador escrever de novo e submeter.
  eq(
    r.fila.filter((o) => o.status === "PENDING").length,
    0,
    "nenhuma operação nova foi criada — o texto não vira registro sozinho"
  );
  ok(
    /não foi registrado nem apresentado/.test(r.descricao),
    "e a frase diz isso com todas as letras"
  );
}

secao("7. REPETIR_SOBRE_A_NOVA cria intenção NOVA, com chave NOVA");
{
  let fila = [];
  const r1 = appendOperation(fila, {
    operationType: "nodeAction",
    sessionId: "s1",
    patientId: "7",
    payload: { nodeId: "ocn_velho", action: { kind: "PRESENT" } },
  });
  fila = r1.fila;

  const r = aplicarDecisao(
    fila,
    r1.operacao.id,
    "REPETIR_SOBRE_A_NOVA",
    conflitoDe("TURN_REPLACED", { replacedById: "ocn_novo" })
  );
  eq(r.fila.length, 1, "a antiga sai e a nova entra");
  const nova = r.fila[0];
  eq(nova.payload.nodeId, "ocn_novo", "apontando para a versão nova");
  eq(nova.operationType, "nodeAction", "com a mesma intenção do cuidador");
  ok(
    nova.idempotencyKey !== r1.operacao.idempotencyKey,
    "e chave de idempotência NOVA — senão o servidor devolveria o resultado da recusada"
  );
  ok(nova.id !== r1.operacao.id, "é outra operação, com outra identidade na fila");
  eq(nova.status, "PENDING", "e ela nasce pronta para ir");
}

secao("8. RETOMAR_E_CONTINUAR põe o RESUME ANTES, por dependência");
{
  let fila = [];
  const r1 = appendOperation(fila, {
    operationType: "createTurn",
    sessionId: "s1",
    patientId: "7",
    payload: { sessionId: "s1", text: "posso continuar?" },
    createdEntityId: "cqt_y",
  });
  fila = r1.fila;
  const emConflito = markStatus(fila, r1.operacao.id, "CONFLICT", {
    conflict: conflitoDe("SESSION_PAUSED"),
  });

  const r = aplicarDecisao(
    emConflito,
    r1.operacao.id,
    "RETOMAR_E_CONTINUAR",
    conflitoDe("SESSION_PAUSED")
  );
  eq(r.fila.length, 2, "a fila ganha o RESUME");
  const resume = r.fila.find((o) => o.operationType === "sessionAction");
  const original = r.fila.find((o) => o.id === r1.operacao.id);
  ok(resume, "o RESUME existe");
  eq(resume.payload.action, "RESUME", "e é mesmo um RESUME");
  eq(original.status, "PENDING", "a operação recusada volta para PENDING");
  eq(original.conflict, null, "e perde a marca de conflito");
  ok(
    original.dependsOn.includes(resume.sequence),
    "e passa a DEPENDER do RESUME — a ordem é garantida pela fila, não pela sorte"
  );
  eq(r.removidas.length, 0, "nada foi apagado: retomar não descarta trabalho");
}

secao("9. Opções que não têm para onde apontar não são oferecidas");
{
  let fila = [];
  const r1 = appendOperation(fila, {
    operationType: "nodeAction",
    sessionId: "s1",
    patientId: "7",
    payload: { nodeId: "ocn_velho", action: { kind: "PRESENT" } },
  });
  const op = r1.operacao;

  ok(
    !opcaoDisponivel(conflitoDe("TURN_REPLACED", {}), op, "REPETIR_SOBRE_A_NOVA"),
    "sem saber QUAL é a versão nova, 'repetir' não é oferecido"
  );
  ok(
    opcaoDisponivel(
      conflitoDe("TURN_REPLACED", { replacedById: "ocn_novo" }),
      op,
      "REPETIR_SOBRE_A_NOVA"
    ),
    "com a versão nova informada, é oferecido"
  );
  ok(
    !opcaoDisponivel(conflitoDe("SESSION_COMPLETED"), op, "REAPROVEITAR_COMO_RASCUNHO"),
    "uma ação sem texto não oferece 'reaproveitar' — não há o que guardar"
  );
  ok(
    opcaoDisponivel(conflitoDe("SESSION_COMPLETED"), op, "DESCARTAR"),
    "descartar está sempre disponível"
  );
}

secao("10. Uma decisão que não se aplica devolve a fila INTACTA");
{
  const { fila, selecao } = filaEncadeada();
  const r = aplicarDecisao(
    fila,
    selecao.id,
    "REPETIR_SOBRE_A_NOVA",
    conflitoDe("TURN_REPLACED", {})
  );
  eq(r.fila.length, 3, "nada foi removido");
  eq(r.removidas.length, 0, "nada foi apagado do banco");
  ok(r.descricao.length > 0, "e o cuidador é avisado de por que não deu");

  const inexistente = aplicarDecisao(fila, "nao-existe", "DESCARTAR", conflitoDe("PATH_ENDED"));
  eq(inexistente.fila.length, 3, "decidir sobre operação que sumiu não apaga nada");
}

secao("11. Informativas não mexem na fila");
{
  const { fila, caminho } = filaEncadeada();
  for (const opcao of ["VER_PENDENTES", "DECIDIR_A_CADEIA"]) {
    const r = aplicarDecisao(fila, caminho.id, opcao, conflitoDe("SESSION_COMPLETED"));
    eq(r.fila.length, 3, `${opcao}: a fila continua igual`);
    eq(r.removidas.length, 0, `${opcao}: nada apagado`);
    eq(r.descricao, "", `${opcao}: sem frase de conclusão — nada concluiu`);
  }
}

secao("12. comAlvo — cada tipo tem seu campo");
{
  const alvo = (tipo, payload) =>
    comAlvo({ operationType: tipo, payload }, "novo_id");
  eq(alvo("turnAction", { turnId: "velho" }).turnId, "novo_id", "turnAction → turnId");
  eq(alvo("nodeAction", { nodeId: "velho" }).nodeId, "novo_id", "nodeAction → nodeId");
  eq(alvo("reviewNode", { nodeId: "velho" }).nodeId, "novo_id", "reviewNode → nodeId");
  eq(
    alvo("statementAction", { statementId: "velho" }).statementId,
    "novo_id",
    "statementAction → statementId"
  );
  eq(alvo("pathAction", { pathId: "velho" }).pathId, "novo_id", "pathAction → pathId");
  eq(
    alvo("patientControlAction", { requestId: "velho" }).requestId,
    "novo_id",
    "patientControlAction → requestId"
  );
  // O resto do payload sobrevive: trocar o alvo não pode perder a ação.
  const completo = alvo("nodeAction", { nodeId: "v", action: { kind: "PRESENT" } });
  eq(completo.action.kind, "PRESENT", "o resto do payload é preservado");
}

secao("13. textoDe — de onde sai o texto do cuidador");
{
  const t = (payload) => textoDe({ operationType: "createTurn", payload });
  eq(t({ text: "pergunta" }), "pergunta", "createTurn usa `text`");
  eq(t({ promptText: "nível" }), "nível", "criação de nível usa `promptText`");
  eq(t({ reviewedText: "revisado" }), "revisado", "revisão usa `reviewedText`");
  eq(t({ text: "  com espaço  " }), "com espaço", "vem aparado");
  eq(t({ text: "   " }), null, "texto só de espaço não conta");
  eq(t({}), null, "payload sem texto devolve null");
  eq(t(null), null, "payload nulo não explode");
}

// ════════════════════════════════════════════════════════════════════
console.log(`\n${passou} passou, ${falhou} falhou.`);
process.exit(falhou === 0 ? 0 : 1);
