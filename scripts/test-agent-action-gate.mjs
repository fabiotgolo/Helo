// ——— O Agent não responde nem confirma pelo paciente (Fase 5.1A / R-02) ———
//
// Até aqui, uma client tool da ElevenLabs podia acionar `gesto.confirmar` ou
// `routine.answer.agua.yes`, e o resultado era indistinguível de um toque do
// paciente: evento de confirmação gravado, voz clonada dele falando. O
// cuidador dizia "pode marcar sim" e a pessoa "respondia".
//
//   npm run test:agent:gate
//
// Este teste existe para provar que a proteção é ESTRUTURAL. A tentação seria
// bloquear as palavras "sim", "yes", "positivo" — e isso perde para sinônimo,
// idioma, emoji, alias e para o actionId literal. Aqui a decisão é tomada
// sobre o que a ação É, não sobre como ela foi pedida; por isso os casos
// abaixo variam a FORMA do pedido de todas as maneiras que o código de
// resolução do provider sabe construir, e todas continuam recusadas.

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { isActionAllowedFor, agentDenialReason, resolveRequestedUIActionIn } =
  await import("../lib/helo-action-registry.ts");

/**
 * As ações REAIS de uma tela da Rotina com um card aberto, e as do /helo com a
 * conversa ativa — copiadas dos registros de app/(palco)/rotina/page.tsx e
 * components/helo-agent-provider.tsx, com os mesmos ids, rótulos e aliases.
 * É sobre este conjunto que os pedidos do Agent são resolvidos.
 */
const TELA = [
  {
    actionId: "routine.answer.water.yes",
    actionClass: "patientResponse",
    label: "Clicar emoji 👍 SIM",
    aliases: ["sim", "positivo", "confirmar", "clique no sim", "clicar no polegar", "emoji polegar", "joinha", "👍"],
    type: "routineAnswer",
    enabled: true,
    run: () => {},
  },
  {
    actionId: "routine.answer.water.no",
    actionClass: "patientResponse",
    label: "Clicar emoji ✊ NÃO",
    aliases: ["não", "negativo", "recusar", "clique no não", "clicar no punho", "emoji punho", "✊"],
    type: "routineAnswer",
    enabled: true,
    run: () => {},
  },
  {
    actionId: "routine.backToMenu",
    actionClass: "navigation",
    label: "Voltar para as Rotinas",
    aliases: ["voltar", "voltar para rotinas", "menu de rotinas", "voltar ao menu"],
    type: "navigation",
    enabled: true,
    run: () => {},
  },
  {
    actionId: "gesto.confirmar",
    actionClass: "patientResponse",
    label: "Registrar gesto do paciente: sim",
    type: "gesture",
    enabled: true,
    run: () => {},
  },
  {
    actionId: "atividades.concluir",
    actionClass: "sensitive",
    label: "Concluir sessão",
    type: "activity",
    enabled: true,
    run: () => {},
  },
];

/** O caminho real do dispatcher: resolve o pedido e então decide. */
function agentPodeExecutar(actionId, parameters = {}, payload = undefined) {
  const acao = resolveRequestedUIActionIn(TELA, actionId, parameters, payload);
  if (!acao) return { executou: false, motivo: "nao-encontrada" };
  return {
    executou: isActionAllowedFor(acao, "agent"),
    acao: acao.actionId,
    classe: acao.actionClass,
  };
}

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

const acao = (actionClass) => ({ actionClass, actionId: "x", label: "Ação" });

console.log("\n13–17. O Agent não aciona resposta do paciente:");
{
  // Os actionIds reais registrados hoje pelas telas, um a um.
  const doPaciente = [
    "gesto.confirmar",
    "gesto.reformular",
    "gesto.recusar",
    "routine.answer.water.yes",
    "routine.answer.pain.maybe",
    "routine.answer.rest.no",
    "atividades.resposta.1.sim",
    "atividades.resposta.2.talvez",
    "atividades.resposta.3.nao",
    "atividades.resposta.pergunta",
    "conversa.opcao.1",
    "conversa.gestoIncerto",
    "conversa.repetir", // na tela final, repete a fala DELE
    "atividades.frases.ouvir",
  ];
  for (const actionId of doPaciente) {
    check(
      `"${actionId}" é inalcançável pelo Agent`,
      isActionAllowedFor({ actionClass: "patientResponse", actionId }, "agent") === false
    );
  }
  check(
    "…e todas seguem disponíveis para o toque humano",
    doPaciente.every((actionId) =>
      isActionAllowedFor({ actionClass: "patientResponse", actionId }, "human")
    ),
    "— a proteção quebrou o uso manual"
  );
}

console.log("\n18–20. A forma do pedido não abre exceção (cadeia real):");
{
  // Cada linha percorre o caminho de verdade — resolução tolerante do
  // dispatcher e depois o gate — sobre um conjunto de ações copiado das telas.
  // É aqui que se prova que a proteção não é uma lista de palavras.
  const tentativas = [
    ["18. actionId exato", "routine.answer.water.yes", {}, undefined],
    ["18b. gesto.confirmar literal", "gesto.confirmar", {}, undefined],
    ["19. alias em português", "clique no sim", {}, undefined],
    ["19b. alias com emoji", "👍", {}, undefined],
    ["19c. só a palavra sim", "sim", {}, undefined],
    ["19d. rótulo inteiro", "Clicar emoji 👍 SIM", {}, undefined],
    ["19e. rótulo do gesto", "Registrar gesto do paciente: sim", {}, undefined],
    ["19f. sem acento e em caixa alta", "NAO", {}, undefined],
    ["20. payload { gesto }", "routine.answer.water", {}, { gesto: "sim" }],
    ["20b. payload { gesture }", "routine.answer.water", {}, { gesture: "yes" }],
    ["20c. payload { answer }", "routine.answer.water", {}, { answer: "positivo" }],
    ["20d. payload { choice }", "routine.answer.water", {}, { choice: "confirmar" }],
    ["20e. payload { value }", "routine.answer.water", {}, { value: "joinha" }],
    ["20f. parâmetro solto", "responder", { resposta: "sim" }, undefined],
    ["20g. gesto + opção", "clique", { opcao: "água" }, { gesto: "sim" }],
    ["20h. id remontado", "routine-answer-water-yes", {}, undefined],
    ["20i. id remontado com espaços", "routine answer water yes", {}, undefined],
  ];
  for (const [nome, actionId, parameters, payload] of tentativas) {
    const r = agentPodeExecutar(actionId, parameters, payload);
    // A exigência é dupla, e a segunda metade importa tanto quanto a primeira:
    // o pedido PRECISA resolver para uma ação real (senão o teste estaria
    // creditando ao gate uma proteção que veio do matcher não achar nada) e
    // essa ação precisa ser recusada. Antes da 5.1A, cada uma destas 17 formas
    // encontrava a ação e a executava.
    check(
      `${nome} → resolve a ação e o gate recusa`,
      r.executou === false && r.motivo !== "nao-encontrada",
      r.motivo === "nao-encontrada"
        ? "— não resolveu nada; o caso não prova o gate"
        : `— executou ${r.acao} (${r.classe})`
    );
  }
  // E o contraponto, que é o que impede a proteção de ser "bloqueia tudo":
  const voltar = agentPodeExecutar("voltar");
  check(
    "…mas 'voltar' (navegação) continua executando",
    voltar.executou === true && voltar.acao === "routine.backToMenu",
    JSON.stringify(voltar)
  );
  const concluir = agentPodeExecutar("Concluir sessão");
  check(
    "…e 'Concluir sessão' (sensível) para no gate humano",
    concluir.executou === false && concluir.classe === "sensitive",
    JSON.stringify(concluir)
  );
}

console.log("\n21. dialog.confirm não é executável pelo Agent:");
{
  check(
    "o modal humano não pode ser confirmado por voz",
    isActionAllowedFor({ actionClass: "sensitive", actionId: "dialog.confirm" }, "agent") === false
  );
  check(
    "nem cancelado",
    isActionAllowedFor({ actionClass: "sensitive", actionId: "dialog.cancel" }, "agent") === false
  );
  check(
    "mas o humano confirma normalmente",
    isActionAllowedFor({ actionClass: "sensitive", actionId: "dialog.confirm" }, "human")
  );
}

console.log("\n22–23. O que o Agent CONTINUA podendo fazer:");
{
  check("22. navegação segue liberada", isActionAllowedFor(acao("navigation"), "agent"));
  check("23. operação não sensível segue liberada", isActionAllowedFor(acao("operational"), "agent"));
}

console.log("\n24. Ação sensível para no gate humano:");
{
  const sensiveis = [
    "atividades.concluir",
    "atividades.encerrar",
    "conversa.encerrar",
    "helo.encerrar",
    "emergencia.item.emergencia.ajuda",
    "atividades.gerenciar",
    "atividades.criar",
  ];
  for (const actionId of sensiveis) {
    check(
      `"${actionId}" exige uma pessoa`,
      isActionAllowedFor({ actionClass: "sensitive", actionId }, "agent") === false
    );
  }
}

console.log("\nFail-closed: o esquecimento produz segurança, não exposição:");
{
  check(
    "ação sem classe é inalcançável pelo Agent",
    isActionAllowedFor({ actionId: "acao.nova" }, "agent") === false,
    "— uma ação nova nasceria exposta"
  );
  check(
    "ação sem classe segue clicável por uma pessoa",
    isActionAllowedFor({ actionId: "acao.nova" }, "human")
  );
  check(
    "classe desconhecida (dado corrompido) também é recusada",
    isActionAllowedFor({ actionClass: "qualquerCoisa", actionId: "x" }, "agent") === false
  );
}

console.log("\nO Agent recebe um motivo, não um silêncio:");
{
  const doPaciente = agentDenialReason({ actionClass: "patientResponse", label: "Responder sim" });
  const sensivel = agentDenialReason({ actionClass: "sensitive", label: "Concluir sessão" });
  check(
    "resposta do paciente: o motivo devolve a decisão a quem ela pertence",
    /paciente/i.test(doPaciente) && /gesto|tela/i.test(doPaciente),
    doPaciente
  );
  check(
    "sensível: o motivo diz que uma pessoa precisa concluir",
    /confirmação|pessoa/i.test(sensivel) && sensivel.includes("Concluir sessão"),
    sensivel
  );
  check(
    "nenhum motivo instrui o Agent a tentar de novo",
    !/tente|novamente|outra forma/i.test(doPaciente + sensivel)
  );
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
