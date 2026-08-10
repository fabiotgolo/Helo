// ——— O inventário do Agent não muda sozinho (Fases 5.3A e 5.3B) ———
//
//   npm run test:agent:inventory
//
// A auditoria da 5.3A encontrou três buracos entre o que o Agent PODE fazer e
// o que os testes existentes verificam. Nenhum deles é um defeito de execução —
// o gate do R-02 está de pé e `test:agent:invariants` prova a classificação
// ação por ação. São buracos de ALCANCE: coisas que crescem sem passar por
// verificação nenhuma.
//
//   1. `test:agent:invariants` lê uma LISTA FIXA de arquivos. Uma tela nova que
//      registre ações num arquivo fora dessa lista passa despercebida — as
//      ações dela nunca são confrontadas com o catálogo de classes. O teste
//      continuaria verde enquanto a superfície do Agent cresce sem controle.
//
//   2. `GLOBAL_HELO_ROUTES` é a ÚNICA porta que não passa pelo gate de classe:
//      o dispatcher a atende antes do Action Registry. Isso é correto enquanto
//      cada entrada for só um destino — um `path` literal, sem handler. Uma
//      entrada com efeito colateral ali seria uma ação sem classe, executável
//      pelo Agent, e nenhum teste de classe a alcançaria.
//
//   3. O payload de `getCurrentHeloActions` é o que sai do Helo para a
//      ElevenLabs. Ele cresceu por acréscimos (R-09) e nada o media. Aqui a
//      lista de campos é declarada: acrescentar um campo ao que vai para o
//      provedor passa a exigir uma linha neste arquivo — e, com ela, a
//      pergunta "isto precisa mesmo sair daqui?".
//
// Este arquivo NÃO julga a classificação (isso é do test:agent:invariants) nem
// a decisão do gate (test:agent:gate). Ele só mede o perímetro.
//
// Todo comentário é removido antes de qualquer busca: este arquivo fala em
// prosa dos mesmos nomes que procura, e essa armadilha já custou caro aqui.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

/** Sem comentários: só o código executável entra nas buscas. */
function codigoDe(caminho) {
  return readFileSync(resolve(RAIZ, caminho), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Todos os .ts/.tsx de app/, components/ e lib/ — o código do produto. */
function fontesDoProduto() {
  const achados = [];
  const ignorar = new Set(["node_modules", ".next", ".git"]);
  const anda = (dir) => {
    for (const entrada of readdirSync(dir)) {
      if (ignorar.has(entrada)) continue;
      const completo = join(dir, entrada);
      if (statSync(completo).isDirectory()) anda(completo);
      else if (/\.tsx?$/.test(entrada)) achados.push(relative(RAIZ, completo));
    }
  };
  for (const base of ["app", "components", "lib"]) anda(resolve(RAIZ, base));
  return achados;
}

// ——— 1. Nenhuma tela registra ações fora do alcance da verificação ———

console.log("\ntoda tela que registra ações é verificada pelo catálogo de classes");
{
  const registram = fontesDoProduto().filter(
    (f) =>
      f !== "lib/helo-action-registry.ts" &&
      /useRegisterHeloUIActions\s*\(/.test(codigoDe(f))
  );

  const invariantes = codigoDe("scripts/test-action-class-invariants.mjs");
  const lista = invariantes.match(/const ARQUIVOS = \[([\s\S]*?)\];/)?.[1] ?? "";
  const verificados = new Set(
    [...lista.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  );

  const forade = registram.filter((f) => !verificados.has(f));
  checa(
    `todo arquivo que chama useRegisterHeloUIActions está em ARQUIVOS (${registram.length} arquivos)`,
    forade.length === 0,
    `— fora da verificação: ${forade.join(", ")}`
  );

  const sumidos = [...verificados].filter((f) => !registram.includes(f));
  checa(
    "nenhum arquivo verificado deixou de registrar ações (lista sem entrada morta)",
    sumidos.length === 0,
    `— não registram nada: ${sumidos.join(", ")}`
  );
}

// ——— 2. A porta que não passa pelo gate só leva a lugares ———

console.log("\nGLOBAL_HELO_ROUTES: só destino, nunca handler");
{
  const provider = codigoDe("components/helo-agent-provider.tsx");
  const bloco = provider.match(/const GLOBAL_HELO_ROUTES = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  checa("o bloco de rotas globais foi encontrado", bloco.trim().length > 0);

  const entradas = [...bloco.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  checa(`as rotas globais são um conjunto fechado (${entradas.length} entradas)`, entradas.length > 0);

  const chavesPermitidas = new Set(["actionId", "label", "path", "area"]);
  const comChaveEstranha = entradas.filter((e) =>
    [...e.matchAll(/(\w+)\s*:/g)].some((m) => !chavesPermitidas.has(m[1]))
  );
  checa(
    "nenhuma rota global declara nada além de actionId, label, path e area",
    comChaveEstranha.length === 0,
    `— entrada com chave estranha: ${comChaveEstranha.join(" | ")}`
  );

  checa(
    "nenhuma rota global carrega um handler",
    !/\brun\s*:/.test(bloco) && !/=>/.test(bloco),
    "— uma rota global com handler seria uma ação sem classe, executável pelo Agent"
  );

  const caminhos = [...bloco.matchAll(/path:\s*"([^"]*)"/g)].map((m) => m[1]);
  checa(
    "todo path é um literal que começa com /",
    caminhos.length === entradas.length && caminhos.every((p) => p.startsWith("/")),
    `— caminhos: ${caminhos.join(", ")}`
  );

  // O dispatcher atende a rota global ANTES do registry. Isso só é seguro
  // porque o único efeito é `router.push` de um caminho da tabela.
  const despacho =
    provider.match(/const globalRoute = GLOBAL_HELO_ROUTES\.find[\s\S]{0,600}?\n\s{6}\}/)?.[0] ?? "";
  checa(
    "o atalho de rota global só navega — nenhum .run() nesse caminho",
    despacho.length > 0 && !despacho.includes(".run("),
    "— o atalho passou a executar handler sem passar pelo gate de classe"
  );
}

// ——— 3. O que sai daqui para a ElevenLabs é capacidade, nunca a tela ———

console.log("\ncontexto enviado ao provedor: capacidade, nunca a tela");
{
  const provider = codigoDe("components/helo-agent-provider.tsx");
  const descoberta =
    provider.match(/const discoverActions = async \(\) => \{[\s\S]*?\n {4}\};/)?.[0] ?? "";
  checa("a função de descoberta foi encontrada", descoberta.length > 0);

  // A 5.3B tirou a montagem do payload de dentro do componente: quem responde
  // pelo que sai é `buildHeloContext`, uma função pura. A descoberta agora só
  // reúne rota, tela e registry e entrega.
  checa(
    "a descoberta delega o payload ao contrato de capacidades",
    /buildHeloContext\(\{/.test(descoberta),
    "— o payload voltou a ser montado à mão dentro do componente"
  );
  for (const morto of ["localElements", "availableActions", "querySelectorAll", "textContent"]) {
    checa(`a descoberta não usa ${morto}`, !descoberta.includes(morto));
  }
  checa(
    "nenhum espalhamento de conteúdo de tela sobrou na descoberta",
    !descoberta.includes("..."),
    "— um espalhamento leva campo ao provedor sem passar pelo contrato"
  );

  // O contrato em si: a lista de campos que atravessam a fronteira. Um campo
  // novo exige uma linha aqui — e, com ela, a pergunta "isto precisa mesmo
  // sair daqui?".
  const contrato = codigoDe("lib/helo-capabilities.ts");
  const retorno = contrato.match(/return \{([\s\S]*?)\n {2}\};/)?.[1] ?? "";
  const campos = [...retorno.matchAll(/^ {4}([A-Za-z_]\w*)/gm)].map((m) => m[1]);
  const ESPERADOS = ["ok", "route", "screen", "capabilities", "humanOnly", "diagnostic"];
  const novos = campos.filter((c) => !ESPERADOS.includes(c));
  const sumidos = ESPERADOS.filter((c) => !campos.includes(c));
  checa(
    `o payload tem exatamente os campos declarados (${campos.length})`,
    novos.length === 0,
    `— campo novo indo ao provedor sem passar por aqui: ${novos.join(", ")}`
  );
  checa("nenhum campo declarado sumiu", sumidos.length === 0, `— sumiram: ${sumidos.join(", ")}`);

  // Os campos de UMA capability. Acrescentar um aqui é acrescentar um dado por
  // ação — e são as ações dinâmicas que carregam texto escrito por gente.
  const capability = contrato.match(/export interface HeloCapability \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const camposCap = [...capability.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  checa(
    `uma capability tem cinco campos e nada mais (${camposCap.join(", ")})`,
    camposCap.length === 5 &&
      ["id", "class", "label", "aliases", "scope"].every((c) => camposCap.includes(c))
  );

  // `humanOnly` é contagem. No dia em que virar lista, o rótulo de um item de
  // Emergência volta a sair — e era exatamente esse o caminho do R-09.
  const humanOnly = contrato.match(/export interface HeloHumanOnlyCount \{([\s\S]*?)\n\}/)?.[1] ?? "";
  checa(
    "humanOnly conta, não lista",
    humanOnly.length > 0 &&
      [...humanOnly.matchAll(/^ {2}(\w+):\s*(\w+)/gm)].every((m) => m[2] === "number"),
    "— um campo de humanOnly deixou de ser número"
  );

  // O contrato é PURO: sem DOM, sem React, sem window. É o que permite ao
  // teste conduzir esta função em vez de uma cópia dela.
  for (const proibido of ["document", "window", "querySelector", "useEffect", "useState"]) {
    checa(`o contrato de capacidades não usa ${proibido}`, !contrato.includes(proibido));
  }

  // O NOME da sub-tela publicado pela tela montada. O campo de conteúdo que
  // existia ao lado dele (`extra`) levava a pergunta clínica e os rótulos de
  // opção; ele não deve voltar.
  const screenContext = codigoDe("lib/helo-screen-context.ts");
  checa(
    "o contexto de tela publica só o nome, sem campo de conteúdo",
    !/\bextra\b/.test(screenContext),
    "— o campo de conteúdo do contexto de tela voltou"
  );
}

// ——— 3b. Nenhuma ação bloqueada carrega retorno de tool ———

console.log("\ntoolSuccess só existe onde o Agent chega");
{
  // `toolSuccess` é lido em UM lugar: o caminho do Agent, depois do gate. Numa
  // ação `sensitive` ou `patientResponse` ele é código morto — e era pior que
  // morto: descrevia um comportamento ("acionar por tool executa o mesmo
  // handler do clique") que o gate tinha revogado.
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
  const culpados = [];
  for (const arquivo of ARQUIVOS) {
    const linhas = codigoDe(arquivo).split("\n");
    for (let i = 0; i < linhas.length; i++) {
      const classe = linhas[i].match(/actionClass:\s*"(patientResponse|sensitive)"/);
      if (!classe) continue;
      // Da classe até a próxima `actionId:` — o corpo desta declaração.
      for (let j = i + 1; j < linhas.length && !/actionId:/.test(linhas[j]); j++) {
        if (/toolSuccess:/.test(linhas[j])) culpados.push(`${arquivo}:${j + 1} (${classe[1]})`);
      }
    }
  }
  checa(
    "nenhuma ação bloqueada declara toolSuccess",
    culpados.length === 0,
    `— retorno de tool em ação inalcançável: ${culpados.join("; ")}`
  );

  const provider = codigoDe("components/helo-agent-provider.tsx");
  checa(
    "toolSuccess é espalhado ANTES do resultado do contrato",
    /\{ \.\.\.acao\.toolSuccess, \.\.\.resultado \}/.test(provider),
    "— uma dica declarada numa tela pode sobrescrever o código de resultado"
  );
}

// ——— 3c. Uma recusa não devolve o texto da tela ———

console.log("\nas respostas ao Agent não carregam rótulo de tela");
{
  const registry = codigoDe("lib/helo-action-registry.ts");
  const motivo = registry.match(/export function agentDenialReason[\s\S]*?\n\}/)?.[0] ?? "";
  checa("agentDenialReason existe", motivo.length > 0);
  checa(
    "o motivo da recusa não interpola o rótulo da ação",
    !/action\.label/.test(motivo),
    "— o rótulo de um item de Emergência é texto escrito pelo cuidador"
  );

  const provider = codigoDe("components/helo-agent-provider.tsx");
  const executa = provider.match(/const interactWithUI = async[\s\S]*?\n {4}\};/)?.[0] ?? "";
  checa("o dispatcher foi encontrado", executa.length > 0);
  checa(
    "nenhuma resposta do dispatcher interpola action.label",
    !/action\.label/.test(executa),
    "— um rótulo de tela volta ao provedor pela resposta da tool"
  );
  checa(
    "a falha do handler não devolve a mensagem do erro ao provedor",
    !/caught instanceof Error/.test(executa),
    "— a mensagem do handler é escrita para o cuidador e pode citar a tela"
  );
  for (const codigo of [
    "SUCCESS",
    "NOT_FOUND",
    "UNAVAILABLE",
    "FORBIDDEN_BY_POLICY",
    "INVALID_PARAMETER",
  ]) {
    checa(`o dispatcher devolve o código ${codigo}`, executa.includes(`"${codigo}"`));
  }
}

// ——— 4. O gate continua sendo a única decisão de autoridade ———

console.log("\no gate de origem não ganhou concorrente");
{
  const provider = codigoDe("components/helo-agent-provider.tsx");
  const chamadas = (provider.match(/isActionAllowedFor\(/g) ?? []).length;
  // Uma das duas consultas passou a ser injetada na sequência (`permitido`),
  // e a outra continua na delegação da navegação para Atividades.
  // Dois pontos, e só dois: o dispatcher (interactWithHeloUI) e a delegação da
  // navegação para "atividades", que também executa um handler de tela.
  checa(
    `todo caminho que executa handler consulta o gate (${chamadas} consultas)`,
    chamadas === 2,
    "— um caminho de execução novo pode ter aparecido sem consultar o gate"
  );

  // Dois pontos, e continuam sendo dois — só que agora um deles mora na
  // sequência auditável da 5.3C. Somar os dois arquivos é o que mantém a
  // afirmação verdadeira depois da mudança de lugar.
  const despacho = codigoDe("lib/helo-agent-dispatch.ts");
  const execucoes =
    (provider.match(/\.run\(\{/g) ?? []).length + (despacho.match(/\.run\(\{/g) ?? []).length;
  checa(
    `só existem dois pontos que executam handler de tela (${execucoes})`,
    execucoes === 2,
    "— um ponto de execução novo precisa de um gate próprio"
  );
  checa(
    "os dois pontos entregam o lease ao handler",
    (provider.match(/__aindaVale:/g) ?? []).length +
      (despacho.match(/__aindaVale:/g) ?? []).length ===
      2,
    "— um handler com espera longa ficou sem como conferir o contexto"
  );

  const registry = codigoDe("lib/helo-action-registry.ts");
  checa(
    "sem classe, o Agent não executa (fail-closed preservado)",
    /if \(!action\.actionClass\) return false;/.test(registry)
  );
  checa(
    "só navigation e operational são alcançáveis pelo Agent",
    /return action\.actionClass === "navigation" \|\| action\.actionClass === "operational";/.test(
      registry
    )
  );
}

console.log(`\n${mau === 0 ? "✓" : "✗"} ${ok} passaram, ${mau} falharam`);
process.exit(mau === 0 ? 0 : 1);
