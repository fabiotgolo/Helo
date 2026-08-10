// ——— Toda ação tem uma classe, e uma só (fechamento da Fase 5.1A) ———
//
//   npm run test:agent:invariants
//
// O gate do R-02 decide pela CLASSE da ação. Isso só vale alguma coisa se a
// classe for uma propriedade da ação — não do contexto em que ela foi pedida.
// A entrega da 5.1A tinha `conversa.repetir` classificado como `operational`
// numa fase da tela e `patientResponse` em outra: o mesmo identificador com
// duas autoridades. Nenhum bypass real (as duas fases nunca coexistem), mas um
// buraco na afirmação — e uma afirmação de segurança com exceção não é uma
// afirmação. Este teste existe para que a exceção não volte.
//
// ——— Como ele lê o registry ———
//
// As ações são registradas por componentes React montados; não há um catálogo
// estático para importar. O teste então LÊ O FONTE das telas que registram, e
// declara aqui o conjunto que espera encontrar. Se alguém adicionar, remover
// ou renomear uma ação sem passar por aqui, a comparação falha — é o que
// transforma "percorre o registry completo" numa verificação, e não numa
// promessa.

import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { isActionAllowedFor, resolveRequestedUIActionIn } = await import(
  "../lib/helo-action-registry.ts"
);

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

// ——— Leitura do fonte ———

const ARQUIVOS = [
  "app/(palco)/conversa/page.tsx",
  "app/(palco)/rotina/page.tsx",
  "app/(palco)/atividades/page.tsx",
  "app/(palco)/emergencia/page.tsx",
  "components/activity-player.tsx",
  "components/phrases-to-listen-modal.tsx",
  "components/helo-dialog.tsx",
  "components/helo-agent-provider.tsx",
  "components/realtime-questions/session.tsx",
];

/**
 * Lê o valor de `actionId:` a partir de uma posição, atravessando quebras de
 * linha até a vírgula que fecha a propriedade. Não é um parser de TypeScript:
 * é um leitor do valor curto que segue a chave, com profundidade de
 * parênteses/chaves/colchetes e ciência de strings — o suficiente para
 * `"literal"`, `` `template.${x}` `` e `cond ? "a" : "b"`, que são as três
 * formas usadas no código.
 */
function leValor(texto, inicio) {
  let i = inicio;
  let profundidade = 0;
  let saida = "";
  while (i < texto.length) {
    const c = texto[i];
    if (c === "," && profundidade === 0) break;
    if ((c === "}" || c === ")") && profundidade === 0) break;
    if (c === "(" || c === "[" || c === "{") profundidade++;
    if (c === ")" || c === "]" || c === "}") profundidade--;
    if (c === '"' || c === "'" || c === "`") {
      const aspa = c;
      saida += c;
      i++;
      while (i < texto.length) {
        if (texto[i] === "\\") { saida += texto.slice(i, i + 2); i += 2; continue; }
        saida += texto[i];
        if (texto[i] === aspa) { i++; break; }
        i++;
      }
      continue;
    }
    saida += c;
    i++;
  }
  return saida.trim();
}

/**
 * Reduz o valor a PADRÕES de id. Um template vira um padrão com `*` no lugar
 * da parte dinâmica — é a granularidade certa: `atividades.editar.${id}` é uma
 * ação, não uma por atividade, e a classe precisa ser a mesma para todas elas.
 */
function padroes(valor) {
  const encontrados = [];
  const re = /(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  let m;
  while ((m = re.exec(valor)) != null) {
    const bruto = m[2];
    if (!bruto.includes(".") && !/^[a-z]/i.test(bruto)) continue;
    encontrados.push(bruto.replace(/\$\{[^}]*\}/g, "*"));
  }
  return encontrados;
}

/** Todas as ocorrências de `actionId:` de um arquivo, com contexto local. */
function ocorrencias(caminho) {
  const fonte = readFileSync(caminho, "utf8");
  const linhas = fonte.split("\n");
  const achados = [];
  const re = /actionId:\s*/g;
  let m;
  while ((m = re.exec(fonte)) != null) {
    const posValor = m.index + m[0].length;
    const linha = fonte.slice(0, m.index).split("\n").length; // 1-indexada
    const valor = leValor(fonte, posValor);
    const ids = padroes(valor);
    // Janela local: `actionClass` é sempre irmã direta de `actionId` — mesma
    // linha ou a seguinte. A janela para na próxima `actionId`, para nunca
    // atribuir a classe de uma ação à ação anterior. Se a formatação mudar a
    // ponto de a classe sair da janela, o teste falha — na direção segura.
    const fim = Math.min(linhas.length, linha + 3);
    let classe = null;
    for (let l = linha - 1; l < fim; l++) {
      if (l > linha - 1 && /actionId:/.test(linhas[l])) break;
      const c = linhas[l].match(/actionClass:\s*"([a-zA-Z]+)"/);
      if (c) { classe = c[1]; break; }
    }
    // Uma DECLARAÇÃO tem handler. O resto são referências: rotas globais,
    // descritores de contexto de tela, o eco do id na resposta da tool.
    // A janela é generosa (uma ação com muitos aliases empurra o `run:` para
    // longe) e para na próxima `actionId:`, que é o limite real do literal.
    let temRun = false;
    for (let l = linha - 1; l < Math.min(linhas.length, linha + 60); l++) {
      if (l > linha - 1 && /actionId:/.test(linhas[l])) break;
      if (/\brun:\s/.test(linhas[l])) { temRun = true; break; }
    }
    // O TEXTO da classe, antes de julgar se é literal. É o que permite pegar
    // uma classe calculada em vez de apenas registrá-la como ausente.
    let classeBruta = null;
    for (let l = linha - 1; l < fim; l++) {
      if (l > linha - 1 && /actionId:/.test(linhas[l])) break;
      const c = linhas[l].match(/actionClass:\s*([^\n,]+)/);
      if (c) { classeBruta = c[1].trim(); break; }
    }
    achados.push({ arquivo: caminho, linha, valor, ids, classe, classeBruta, declaracao: temRun });
  }
  return achados;
}

const todas = ARQUIVOS.flatMap(ocorrencias);
const declaracoes = todas.filter((o) => o.declaracao && o.ids.length > 0);
const referencias = todas.filter((o) => !o.declaracao);

// ——— O catálogo esperado ———
//
// Cada linha é uma ação registrada hoje, com a classe que ela DEVE ter. O
// fonte é a fonte da verdade da classe; esta tabela é a fonte da verdade de
// QUE AÇÕES EXISTEM. As duas precisam concordar.
const CATALOGO = {
  // /conversa
  "conversa.comecar": "operational",
  "conversa.repetir": "operational",
  "conversa.repetirMensagemPaciente": "patientResponse",
  "conversa.continuar": "operational",
  "conversa.pausar": "operational",
  "conversa.retomar": "operational",
  "conversa.voltar": "navigation",
  "conversa.encerrar": "sensitive",
  "conversa.gestoIncerto": "patientResponse",
  "conversa.opcao.*": "patientResponse",
  "gesto.confirmar": "patientResponse",
  "gesto.reformular": "patientResponse",
  "gesto.recusar": "patientResponse",
  // /rotina
  "routine.open.*": "operational",
  "routine.answer.*.*": "patientResponse",
  "routine.backToMenu": "navigation",
  // /atividades e o player
  "atividades.iniciar.*": "operational",
  "atividades.criar": "sensitive",
  "atividades.editar.*": "sensitive",
  "atividades.gerenciar": "sensitive",
  "atividades.voltarLista": "navigation",
  "atividades.anterior": "operational",
  "atividades.proxima": "operational",
  "atividades.concluir": "sensitive",
  "atividades.encerrar": "sensitive",
  "atividades.resposta.*.*": "patientResponse",
  "atividades.resposta.pergunta": "patientResponse",
  "atividades.frases.abrir": "operational",
  "atividades.frases.fechar": "navigation",
  "atividades.frases.anterior": "navigation",
  "atividades.frases.proxima": "navigation",
  "atividades.frases.ouvir": "patientResponse",
  "activity.goToActivityMenu": "navigation",
  "activity.goToManageActivities": "sensitive",
  // /emergencia
  "emergencia.item.*": "sensitive",
  "emergencia.editar.*": "sensitive",
  // modal de confirmação
  "dialog.confirm": "sensitive",
  "dialog.cancel": "sensitive",
  // /conversa/perguntas — cobertura segura acrescentada na 5.3B. Nenhuma
  // delas responde pelo paciente, e nenhuma conclui o que a política manda um
  // humano concluir: encerrar sessão, apresentar a pergunta e reiniciar o
  // caminho continuam fora do alcance do Agent.
  "perguntas.controlesDoPaciente": "navigation",
  "perguntas.sairDaConversaPorOpcoes": "navigation",
  "perguntas.pausar": "operational",
  "perguntas.retomar": "operational",
  "perguntas.conversaPorOpcoes": "operational",
  "perguntas.registrarInterpretacao": "operational",
  // /helo
  "helo.conectar": "operational",
  "helo.solicitarMicrofone": "operational",
  "helo.encerrar": "sensitive",
};

console.log("\n— O registry inteiro está classificado —");
{
  const semClasse = declaracoes.filter((d) => !d.classe);
  check(
    "nenhuma ação registrada existe sem actionClass",
    semClasse.length === 0,
    semClasse.map((d) => `${d.arquivo}:${d.linha} ${d.ids.join("/")}`).join("; ")
  );

  const encontrados = new Set(declaracoes.flatMap((d) => d.ids));
  const esperados = new Set(Object.keys(CATALOGO));
  const novos = [...encontrados].filter((id) => !esperados.has(id));
  const sumidos = [...esperados].filter((id) => !encontrados.has(id));
  check(
    "nenhuma ação nova entrou sem passar por esta tabela",
    novos.length === 0,
    `— não catalogadas: ${novos.join(", ")}`
  );
  check(
    "nenhuma ação catalogada desapareceu do fonte",
    sumidos.length === 0,
    `— sumiram: ${sumidos.join(", ")}`
  );
}

console.log("\n— Cada actionId tem exatamente uma classe —");
{
  // O defeito concreto que este bloco pega: o mesmo id declarado duas vezes
  // com classes diferentes, dependendo da fase da tela.
  const porId = new Map();
  for (const d of declaracoes) {
    for (const id of d.ids) {
      if (!porId.has(id)) porId.set(id, new Set());
      porId.get(id).add(d.classe ?? "(sem classe)");
    }
  }
  const conflitantes = [...porId.entries()].filter(([, classes]) => classes.size > 1);
  check(
    "nenhum actionId muda de classe entre declarações",
    conflitantes.length === 0,
    conflitantes.map(([id, c]) => `${id} → ${[...c].join(" e ")}`).join("; ")
  );

  const divergentes = [...porId.entries()].filter(
    ([id, classes]) => CATALOGO[id] && !classes.has(CATALOGO[id])
  );
  check(
    "a classe no fonte é a classe esperada, ação por ação",
    divergentes.length === 0,
    divergentes.map(([id, c]) => `${id}: fonte ${[...c]} ≠ tabela ${CATALOGO[id]}`).join("; ")
  );

  // A ação que motivou o checkpoint: duas coisas diferentes, dois ids.
  check(
    "conversa.repetir e a repetição da fala do paciente são ids distintos",
    porId.has("conversa.repetir") &&
      porId.has("conversa.repetirMensagemPaciente") &&
      [...porId.get("conversa.repetir")][0] === "operational" &&
      [...porId.get("conversa.repetirMensagemPaciente")][0] === "patientResponse"
  );
}

console.log("\n— Ações dinâmicas resolvem para uma classe determinística —");
{
  // `routine.answer.${chave}.${resposta}` gera um id por pergunta e por
  // resposta. Nenhum valor de dado pode mudar a classe do que foi gerado —
  // senão bastaria criar uma atividade com o nome certo para escapar do gate.
  const dinamicas = declaracoes.filter((d) => d.ids.some((id) => id.includes("*")));
  check(
    "toda ação com id dinâmico tem classe fixa na declaração",
    dinamicas.every((d) => d.classe != null),
    dinamicas.filter((d) => !d.classe).map((d) => `${d.arquivo}:${d.linha}`).join("; ")
  );
  // A classe nunca é calculada — em nenhuma ação, dinâmica ou não. Uma classe
  // vinda de variável abriria a porta que os ids dinâmicos fecham: bastaria a
  // expressão depender de algo que o pedido do Agent influencia. (Fora das
  // declarações a classe É lida em variável — a recusa do gate devolve ao
  // Agent a classe da ação que ele tentou executar. Ali ela é informação de
  // resposta, não decisão, e por isso a verificação olha só as declarações.)
  const calculadas = declaracoes.filter(
    (d) => !/^"(navigation|operational|sensitive|patientResponse)"(\s+as\s+const)?$/.test(d.classeBruta ?? "")
  );
  check(
    "nenhuma actionClass declarada é calculada — todas são literais das quatro classes",
    calculadas.length === 0,
    calculadas.map((d) => `${d.arquivo}:${d.linha} → ${d.classeBruta}`).join("; ")
  );
  // O caso mais delicado: ids gerados a partir de conteúdo editável pelo
  // usuário (itens de Emergência, atividades). Nome nenhum muda a autoridade.
  const instancias = [
    "emergencia.item.navigation",
    "emergencia.item.conversa.opcao.1",
    "atividades.editar.gesto.confirmar",
    "atividades.iniciar.dialog.confirm",
  ];
  check(
    "id de instância com nome malicioso não herda a classe do nome",
    instancias.every((id) => {
      const base = id.replace(/^(emergencia\.item|emergencia\.editar|atividades\.editar|atividades\.iniciar)\..*/, "$1.*");
      return CATALOGO[base] != null;
    }),
    "— um id gerado escapou dos padrões catalogados"
  );
}

console.log("\n— Aliases não mudam a classe do que executam —");
{
  // Um alias é texto que resolve para uma ação. O risco não é resolver: é
  // resolver para uma ação MAIS PERMISSIVA do que aquela cujo alias ele é.
  const PESO = { patientResponse: 3, sensitive: 2, operational: 1, navigation: 0 };
  const POOL = [
    {
      actionId: "routine.answer.water.yes",
      actionClass: "patientResponse",
      label: "Clicar emoji 👍 SIM",
      aliases: ["sim", "positivo", "confirmar", "clique no sim", "joinha", "👍"],
      type: "routineAnswer", enabled: true, run: () => {},
    },
    {
      actionId: "routine.open.water",
      actionClass: "operational",
      label: "Você quer tomar água?",
      aliases: ["água", "card da água", "abrir água"],
      type: "routineQuestion", enabled: true, run: () => {},
    },
    {
      actionId: "routine.backToMenu",
      actionClass: "navigation",
      label: "Voltar para as Rotinas",
      aliases: ["voltar", "menu de rotinas"],
      type: "navigation", enabled: true, run: () => {},
    },
    {
      actionId: "dialog.confirm",
      actionClass: "sensitive",
      label: "Continuar — Encerrar sessão?",
      aliases: ["sim", "confirmar", "continuar", "clique em sim"],
      type: "navigation", enabled: true, run: () => {},
    },
    {
      actionId: "dialog.cancel",
      actionClass: "sensitive",
      label: "Cancelar — Encerrar sessão?",
      aliases: ["não", "cancelar", "manter aberto"],
      type: "navigation", enabled: true, run: () => {},
    },
  ];

  const desvios = [];
  for (const acao of POOL) {
    for (const alias of acao.aliases ?? []) {
      const alvo = resolveRequestedUIActionIn(POOL, alias);
      if (!alvo) continue; // alias ambíguo que não resolve é seguro
      if (PESO[alvo.actionClass] < PESO[acao.actionClass]) {
        desvios.push(`"${alias}" (${acao.actionId}/${acao.actionClass}) → ${alvo.actionId}/${alvo.actionClass}`);
      }
    }
  }
  check(
    "nenhum alias leva de uma classe protegida para uma mais permissiva",
    desvios.length === 0,
    desvios.join("; ")
  );

  // E o caso concreto que a coexistência cria: com o modal aberto, "sim" é
  // alias de duas ações de classes diferentes. Qualquer das duas que ganhe, o
  // Agent não executa — é isso que precisa continuar verdadeiro.
  const sim = resolveRequestedUIActionIn(POOL, "sim");
  check(
    "'sim' com modal aberto resolve para algo, e o Agent não executa",
    sim != null && isActionAllowedFor(sim, "agent") === false,
    sim ? `${sim.actionId}/${sim.actionClass}` : "— não resolveu"
  );
}

console.log("\n— patientResponse é inalcançável pelo Agent, sem exceção —");
{
  const doPaciente = Object.entries(CATALOGO).filter(([, c]) => c === "patientResponse");
  check(
    `as ${doPaciente.length} ações do paciente são recusadas ao Agent`,
    doPaciente.every(([actionId, actionClass]) => isActionAllowedFor({ actionId, actionClass }, "agent") === false)
  );
  check(
    "…e todas seguem clicáveis por uma pessoa",
    doPaciente.every(([actionId, actionClass]) => isActionAllowedFor({ actionId, actionClass }, "human"))
  );
  const sensiveis = Object.entries(CATALOGO).filter(([, c]) => c === "sensitive");
  check(
    `as ${sensiveis.length} ações sensíveis param no gate humano`,
    sensiveis.every(([actionId, actionClass]) => isActionAllowedFor({ actionId, actionClass }, "agent") === false)
  );
  const livres = Object.entries(CATALOGO).filter(([, c]) => c === "navigation" || c === "operational");
  check(
    `as ${livres.length} ações de navegação/operação continuam liberadas`,
    livres.every(([actionId, actionClass]) => isActionAllowedFor({ actionId, actionClass }, "agent") === true),
    "— a proteção passou a bloquear o que o Agent existe para fazer"
  );
}

console.log("\n— O que NÃO é ação do registry não vira porta lateral —");
{
  // As referências a `actionId` sem handler: rotas globais, o ping de
  // diagnóstico, o eco do id na resposta da tool e os descritores de contexto
  // de tela. Nenhuma delas executa nada — mas isso precisa ser verificado, não
  // suposto, porque uma delas ficaria fora do gate por construção.
  const provider = readFileSync("components/helo-agent-provider.tsx", "utf8");
  const codigo = provider
    .split("\n")
    .filter((linha) => !/^\s*(\/\/|\*|\/\*)/.test(linha))
    .join("\n");

  check(
    "as rotas globais só navegam (router.push), nunca chamam um handler",
    /const globalRoute = GLOBAL_HELO_ROUTES\.find[\s\S]{0,600}?router\.push\(globalRoute\.path\)/.test(codigo),
    "— uma rota global passou a executar ação de tela"
  );
  check(
    "a rota global que delega a uma ação de tela aplica o mesmo gate",
    /activityMenuAction\?\.enabled && isActionAllowedFor\(activityMenuAction, "agent"\)/.test(codigo),
    "— a segunda porta perdeu a tranca"
  );
  check(
    "debug.ping responde sem tocar no registry",
    /if \(actionId === "debug\.ping"\)[\s\S]{0,200}?return toolResult\(\{ ok: true[^}]*\}\)/.test(codigo)
  );
  // Invertido na 5.3B: antes o DOM aparecia na DESCOBERTA (e nunca na
  // execução). Agora ele não aparece em lugar nenhum — a descoberta deixou de
  // ler a tela e passou a montar capacidades a partir do registry.
  check(
    "a descoberta não lê mais o DOM",
    !/localElements/.test(codigo) && !/querySelectorAll/.test(codigo),
    "— a raspagem da interface voltou ao caminho do Agent"
  );
  check(
    "toda execução passa por resolveRequestedUIAction e pelo gate, nessa ordem",
    /const action = resolveRequestedUIAction\([\s\S]{0,300}?if \(!isActionAllowedFor\(action, "agent"\)\)/.test(codigo),
    "— o gate saiu do caminho da execução"
  );

  // Os ids anunciados no contexto de tela (o player usa isso para ensinar ao
  // Agent como pedir) precisam existir como ação classificada. Um id anunciado
  // que não exista no registry seria uma instrução para pedir o impossível.
  const anunciados = referencias
    .flatMap((r) => r.ids)
    .filter((id) => id.includes("."))
    .filter((id) => !id.startsWith("navigate-") && id !== "debug.ping");
  const orfaos = anunciados.filter((id) => !CATALOGO[id]);
  check(
    "todo actionId anunciado ao Agent corresponde a uma ação classificada",
    orfaos.length === 0,
    orfaos.join(", ")
  );
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
