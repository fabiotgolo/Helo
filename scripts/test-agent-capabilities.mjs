// ——— O que a ElevenLabs sabe sobre a tela (Fase 5.3B) ———
//
//   npm run test:agent:capabilities
//
// A 5.3A mediu, numa conversa por opções real, o que `getCurrentHeloActions`
// mandava ao provedor: "Dor no peito", "Falta de ar à noite", "Onde está
// doendo agora?" — opções escritas pelo cuidador e a pergunta da sessão, numa
// tela onde o Agent não tinha NENHUMA ação executável. 25 rótulos de texto
// clínico sustentando zero capacidade. Isso era o R-09.
//
// Este teste conduz `buildHeloContext`, que é a fronteira: o que ela não põe no
// payload não sai do produto. Por ser pura — sem DOM, sem React, sem `window` —
// é o próprio código que roda aqui, não uma cópia dele.
//
// ——— O que ele tenta provar, e o que não prova ———
//
// PROVA: a forma do payload, quem entra, quem fica de fora, e que nome nenhum
// vindo de dado do usuário muda autoridade.
//
// NÃO PROVA: que o Agent se comporta bem com esse payload. Isso depende do
// system prompt, que vive no painel da ElevenLabs e continua não verificado.

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { buildHeloContext } = await import("../lib/helo-capabilities.ts");
const { describeForAgent, isActionAllowedFor } = await import(
  "../lib/helo-action-registry.ts"
);

let ok = 0;
let mau = 0;
function checa(nome, condicao, detalhe = "") {
  if (condicao) {
    ok += 1;
    console.log(`  ✓ ${nome}`);
  } else {
    mau += 1;
    console.error(`  ✗ ${nome} ${detalhe}`);
  }
}

/** As nove rotas globais, como o provider as declara. */
const ROTAS = [
  { actionId: "navigate-home", label: "Ir para Home", path: "/" },
  { actionId: "navigate-helo", label: "Ir para Helo", path: "/helo" },
  { actionId: "navigate-conversar", label: "Ir para Conversar", path: "/conversa" },
  { actionId: "navigate-rotina", label: "Ir para Rotina", path: "/rotina" },
  { actionId: "navigate-emergencia", label: "Ir para Emergência", path: "/emergencia" },
  { actionId: "navigate-atividades", label: "Ir para Atividades", path: "/atividades" },
  { actionId: "navigate-mensagem", label: "Ir para Mensagens", path: "/mensagem" },
  { actionId: "navigate-ajustes", label: "Ir para Ajustes", path: "/ajustes" },
  { actionId: "navigate-dashboard", label: "Ir para Dashboard", path: "/dashboard" },
];

const nada = () => {};

/** Monta o contexto a partir de ações REAIS, pelo mapeamento real do registry. */
function contextoCom(acoes, { route = "/rotina", screen = "rotina" } = {}) {
  return buildHeloContext({
    route,
    screen,
    globalRoutes: ROTAS,
    registered: acoes.map((a) => describeForAgent(a, "agent")),
  });
}

/** Tudo o que existe de texto no payload, achatado — a busca por vazamento. */
function textoDoPayload(contexto) {
  return JSON.stringify(contexto);
}

// O marcador. Se ele aparecer no payload, o R-09 voltou.
const SEGREDO = "SEGREDO_CLINICO_R09_X7";

// ———————————————————————————————————————————————————————————————
console.log("\n— a forma do payload —");
{
  const contexto = contextoCom([]);
  checa(
    "os campos são exatamente os do contrato",
    JSON.stringify(Object.keys(contexto).sort()) ===
      JSON.stringify(["capabilities", "diagnostic", "humanOnly", "ok", "route", "screen"])
  );
  checa("a rota vai sem query string", buildHeloContext({
    route: "/ajustes?section=paciente&token=abc",
    screen: "ajustes",
    globalRoutes: [],
    registered: [],
  }).route === "/ajustes");
  checa("as nove rotas globais entram como capabilities", contexto.capabilities.length === 9);
  checa(
    "toda rota global é navigation e de escopo global",
    contexto.capabilities.every((c) => c.class === "navigation" && c.scope === "global")
  );
  checa(
    "uma capability não carrega caminho, permissão nem tipo interno",
    contexto.capabilities.every((c) =>
      Object.keys(c).every((k) => ["id", "class", "label", "aliases", "scope"].includes(k))
    )
  );
}

// ———————————————————————————————————————————————————————————————
console.log("\n— a tela do paciente não entra no payload —");
{
  // A conversa por opções, como a 5.3A a mediu: as opções são do paciente.
  const opcoes = ["sim", "talvez", "nao"].map((g) => ({
    actionId: `conversa.opcao.${g}`,
    actionClass: "patientResponse",
    label: `Opção: ${SEGREDO} ${g}`,
    aliases: [`${SEGREDO} ${g}`, `clique em ${SEGREDO}`],
    type: "gesture",
    enabled: true,
    run: nada,
  }));
  const contexto = contextoCom(opcoes, { route: "/conversa/perguntas", screen: "perguntas" });

  checa("o marcador clínico não aparece em lugar nenhum do payload", !textoDoPayload(contexto).includes(SEGREDO));
  checa("nenhuma opção do paciente virou capability", contexto.capabilities.every((c) => c.scope === "global"));
  checa("as três aparecem como contagem", contexto.humanOnly.patientResponse === 3);
  checa("e nada mais foi contado", contexto.humanOnly.sensitive === 0 && contexto.humanOnly.unclassified === 0);
}

{
  // Emergência: `sensitive`, com rótulos que o cuidador escreveu.
  const emergencia = ["falta_ar", "dor"].map((k) => ({
    actionId: `emergencia.item.${k}`,
    actionClass: "sensitive",
    label: `${SEGREDO} — chamem alguém`,
    type: "modeItem",
    enabled: true,
    run: nada,
  }));
  const contexto = contextoCom(emergencia, { route: "/emergencia", screen: "emergencia" });
  checa("o rótulo de um item de Emergência não sai", !textoDoPayload(contexto).includes(SEGREDO));
  checa("ele vira contagem de sensitive", contexto.humanOnly.sensitive === 2);
  checa("e nenhuma capability local nasce", contexto.capabilities.every((c) => c.scope === "global"));
}

// ———————————————————————————————————————————————————————————————
console.log("\n— tela sem ação executável não é compensada com texto —");
{
  // O caso central do R-09: zero capacidade local. O payload precisa poder
  // dizer isso — em vez de mandar a tela para o modelo "entender" onde está.
  const contexto = contextoCom([], { route: "/conversa/perguntas", screen: "perguntas" });
  const locais = contexto.capabilities.filter((c) => c.scope === "screen");
  checa("zero capabilities locais", locais.length === 0);
  checa("zero contagem de bloqueadas", contexto.humanOnly.patientResponse === 0);
  checa(
    "o payload inteiro cabe em poucos campos previsíveis",
    textoDoPayload(contexto).length < 1200,
    `— ${textoDoPayload(contexto).length} caracteres`
  );
}

// ———————————————————————————————————————————————————————————————
console.log("\n— só o que o Agent pode executar vira capability —");
{
  const tela = [
    { actionId: "routine.open.water", actionClass: "operational", label: "Você quer tomar água?", type: "routineQuestion", enabled: true, run: nada },
    { actionId: "routine.backToMenu", actionClass: "navigation", label: "Voltar para as Rotinas", type: "navigation", enabled: true, run: nada },
    { actionId: "routine.answer.water.yes", actionClass: "patientResponse", label: "Clicar emoji 👍 SIM", type: "routineAnswer", enabled: true, run: nada },
    { actionId: "helo.encerrar", actionClass: "sensitive", label: "Encerrar conversa", type: "connect", enabled: true, run: nada },
    { actionId: "sem.classe", label: "Ação sem classe", type: "activity", enabled: true, run: nada },
    { actionId: "atividades.proxima", actionClass: "operational", label: "Próximo item", type: "activity", enabled: false, run: nada },
  ];
  const contexto = contextoCom(tela);
  const ids = contexto.capabilities.filter((c) => c.scope === "screen").map((c) => c.id);

  checa("a operacional habilitada entra", ids.includes("routine.open.water"));
  checa("a navegação entra", ids.includes("routine.backToMenu"));
  checa("a resposta do paciente NÃO entra", !ids.includes("routine.answer.water.yes"));
  checa("a sensível NÃO entra", !ids.includes("helo.encerrar"));
  checa("a sem classe NÃO entra (fail-closed)", !ids.includes("sem.classe"));
  checa("a desabilitada NÃO entra", !ids.includes("atividades.proxima"));
  checa("são exatamente duas capabilities locais", ids.length === 2);

  checa("a resposta do paciente foi contada", contexto.humanOnly.patientResponse === 1);
  checa("a sensível foi contada", contexto.humanOnly.sensitive === 1);
  checa("a sem classe foi contada como não classificada", contexto.humanOnly.unclassified === 1);
  checa("a desabilitada foi contada à parte", contexto.humanOnly.disabled === 1);
}

// ———————————————————————————————————————————————————————————————
console.log("\n— o conteúdo do cuidador não vira autoridade —");
{
  // Nomes que imitam identificadores internos, comandos e destinos. Uma
  // atividade se chama como o modal de confirmação; outra, como uma resposta
  // do paciente; outra, como uma URL. Nome é dado — nunca autoridade.
  const nomes = [
    "dialog.confirm",
    "patientResponse",
    "SIM",
    "NÃO",
    "/admin",
    "javascript:alert(1)",
    "navigate-dashboard",
  ];
  const atividades = nomes.map((nome, i) => ({
    actionId: `atividades.iniciar.${i + 1}`,
    actionClass: "operational",
    label: nome,
    aliases: [`abrir ${nome}`],
    type: "activity",
    enabled: true,
    run: nada,
  }));
  const contexto = contextoCom(atividades, { route: "/atividades", screen: "atividades" });
  const locais = contexto.capabilities.filter((c) => c.scope === "screen");

  checa("todas continuam operational", locais.every((c) => c.class === "operational"));
  checa("nenhuma virou navigation por causa do nome", locais.every((c) => c.class !== "navigation"));
  checa(
    "o id continua sendo o estruturado, nunca o rótulo",
    locais.every((c) => /^atividades\.iniciar\.\d+$/.test(c.id))
  );
  checa(
    "um rótulo que imita rota global não vira rota global",
    locais.every((c) => c.scope === "screen")
  );
  checa(
    "o rótulo `javascript:` continua sendo só texto",
    locais.some((c) => c.label === "javascript:alert(1)")
  );

  // A prova pela outra ponta: o gate decide pela classe declarada, e o rótulo
  // não participa da decisão.
  checa(
    "o gate recusa uma ação cujo rótulo é «Continuar» mas a classe é sensitive",
    !isActionAllowedFor({ actionClass: "sensitive" }, "agent")
  );
  checa(
    "o gate aceita pela classe, não pelo nome",
    isActionAllowedFor({ actionClass: "operational" }, "agent")
  );
}

// ———————————————————————————————————————————————————————————————
console.log("\n— o título dinâmico sai, e sai sozinho —");
{
  // O caso legítimo do §6: sem o título, "Abra Fisioterapia" não tem como
  // resolver. Ele sai — e nada mais sai junto.
  const contexto = contextoCom(
    [
      {
        actionId: "atividades.iniciar.42",
        actionClass: "operational",
        label: "Fisioterapia",
        aliases: ["abrir Fisioterapia", "iniciar Fisioterapia"],
        type: "activity",
        enabled: true,
        requiredPermission: "runActivities",
        run: nada,
      },
    ],
    { route: "/atividades", screen: "atividades" }
  );
  const cap = contexto.capabilities.find((c) => c.id === "atividades.iniciar.42");
  checa("a atividade criada pelo usuário aparece", cap != null);
  checa("com o título, que é o que permite pedi-la por voz", cap?.label === "Fisioterapia");
  checa("com os aliases do produto", cap?.aliases?.length === 2);
  checa(
    "e sem a permissão exigida, que é assunto do servidor",
    cap != null && !("requiredPermission" in cap)
  );
  checa("e sem o tipo interno da interface", cap != null && !("type" in cap));
}

// ———————————————————————————————————————————————————————————————
console.log("\n— o motivo da recusa não devolve a tela —");
{
  const emergencia = {
    actionId: "emergencia.item.dor",
    actionClass: "sensitive",
    label: `${SEGREDO} — estou com dor`,
    type: "modeItem",
    enabled: true,
    run: nada,
  };
  const resumo = describeForAgent(emergencia, "agent");
  checa("a ação bloqueada traz um motivo", typeof resumo.agentBlockedReason === "string");
  checa(
    "o motivo não repete o rótulo",
    !resumo.agentBlockedReason.includes(SEGREDO),
    `— ${resumo.agentBlockedReason}`
  );
  checa(
    "e o motivo não convida a tentar de novo",
    !/tente|novamente|outra forma/i.test(resumo.agentBlockedReason)
  );
}

// ———————————————————————————————————————————————————————————————
console.log("\n— a cobertura nova da 4.9 não é resposta do paciente —");
{
  const quatroNove = [
    { actionId: "perguntas.controlesDoPaciente", actionClass: "navigation", label: "Controles do paciente", type: "navigation", enabled: true, run: nada },
    { actionId: "perguntas.pausar", actionClass: "operational", label: "Pausar sessão", type: "activity", enabled: true, run: nada },
    { actionId: "perguntas.conversaPorOpcoes", actionClass: "operational", label: "Conversa por opções", type: "activity", enabled: true, run: nada },
    { actionId: "perguntas.registrarInterpretacao", actionClass: "operational", label: "Registrar o que entendi", type: "activity", enabled: true, run: nada },
    { actionId: "perguntas.sairDaConversaPorOpcoes", actionClass: "navigation", label: "Sair da conversa por opções", type: "navigation", enabled: true, run: nada },
    { actionId: "perguntas.retomar", actionClass: "operational", label: "Retomar sessão", type: "activity", enabled: true, run: nada },
  ];
  const contexto = contextoCom(quatroNove, { route: "/conversa/perguntas", screen: "perguntas" });
  const locais = contexto.capabilities.filter((c) => c.scope === "screen");

  checa("as seis entram como capacidade", locais.length === 6);
  checa(
    "nenhuma delas é patientResponse nem sensitive",
    quatroNove.every((a) => a.actionClass === "navigation" || a.actionClass === "operational")
  );
  checa(
    "os rótulos são do produto, não da sessão clínica",
    !textoDoPayload(contexto).includes(SEGREDO) &&
      locais.every((c) => !/\?$/.test(c.label))
  );
}

// ———————————————————————————————————————————————————————————————
console.log("\n— a mensagem digitada para a Helo não cria capacidade —");
{
  // O campo "Mensagem para a Helo" alimenta a conversa, nunca o registry. O
  // payload é montado a partir das ações registradas — um texto do cuidador
  // não tem por onde entrar. E se o modelo pedir o que ele sugeriu, quem
  // decide continua sendo a classe da ação.
  const tela = [
    { actionId: "gesto.confirmar", actionClass: "patientResponse", label: "Registrar gesto do paciente: sim", type: "gesture", enabled: true, run: nada },
  ];
  const contexto = contextoCom(tela, { route: "/helo", screen: "helo" });
  checa("uma tela só com gesto não oferece capacidade local", contexto.capabilities.every((c) => c.scope === "global"));
  checa("«responda SIM» não tem por onde virar ação", !textoDoPayload(contexto).toLowerCase().includes("responda"));
  checa("o gesto vira contagem", contexto.humanOnly.patientResponse === 1);
}

console.log(`\n${mau === 0 ? "✓" : "✗"} ${ok} passaram, ${mau} falharam`);
process.exit(mau === 0 ? 0 : 1);
