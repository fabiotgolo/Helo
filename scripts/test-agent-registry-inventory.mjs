// ——— O inventário do Agent não muda sozinho (Fase 5.3A) ———
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

// ——— 3. O que sai daqui para a ElevenLabs é uma lista declarada ———

console.log("\ncontexto enviado ao provedor: campos declarados, não acumulados");
{
  const provider = codigoDe("components/helo-agent-provider.tsx");
  const descoberta =
    provider.match(/const discoverActions = async \(\) => \{[\s\S]*?\n {4}\};/)?.[0] ?? "";
  checa("a função de descoberta foi encontrada", descoberta.length > 0);

  const retorno = descoberta.match(/return toolResult\(\{([\s\S]*?)\n {6}\}\);/)?.[1] ?? "";
  const campos = [...retorno.matchAll(/^\s{8}(?:\.\.\.)?([A-Za-z_]\w*)/gm)].map((m) => m[1]);

  // Cada nome aqui é um dado que ATRAVESSA a fronteira do Helo. Acrescentar um
  // campo exige acrescentar uma linha aqui — e responder por que ele precisa
  // sair. `localElements` está nesta lista com uma ressalva registrada no
  // documento da 5.3A: ele carrega texto visível da tela, inclusive clínico.
  const ESPERADOS = [
    "ok",
    "currentPath",
    "screen",
    "patientId",
    "globalRoutes",
    "localElements",
    "availableActions",
    "actions",
  ];
  const novos = campos.filter((c) => !ESPERADOS.includes(c));
  const sumidos = ESPERADOS.filter((c) => !campos.includes(c));
  checa(
    `o payload tem exatamente os campos declarados (${campos.length})`,
    novos.length === 0,
    `— campo novo indo ao provedor sem passar por aqui: ${novos.join(", ")}`
  );
  checa(
    "nenhum campo declarado sumiu do payload",
    sumidos.length === 0,
    `— sumiram: ${sumidos.join(", ")}`
  );

  // O único espalhamento permitido, e ele merece nome: a tela montada publica
  // `extra` (hoje `currentQuestion`, a pergunta da Rotina aberta) e esse objeto
  // entra inteiro no payload. Um espalhamento novo levaria dado ao provedor
  // sem aparecer na lista de campos acima.
  const espalhamentos = [...retorno.matchAll(/^ {8}\.\.\.\(?([^\n]*)/gm)].map((m) => m[1].trim());
  checa(
    `o único espalhamento no payload é screenContext.extra (${espalhamentos.length})`,
    espalhamentos.length === 1 && espalhamentos[0].startsWith("screenContext?.extra"),
    `— espalhamentos encontrados: ${espalhamentos.join(" | ")}`
  );

  // A superfície do R-09, prendida na forma exata em que foi medida.
  checa(
    "localElements continua saindo de button/a — qualquer alargamento falha aqui",
    /querySelectorAll<HTMLElement>\("button, a"\)/.test(descoberta),
    "— o seletor do contexto local mudou; a medição do R-09 precisa ser refeita"
  );
  checa(
    "a descoberta não lê campos de formulário nem o texto do corpo",
    !/\binput\b|\btextarea\b|body\.innerText|document\.body\.textContent/.test(descoberta)
  );
  checa(
    "a descoberta é leitura pura — não executa handler nenhum",
    !descoberta.includes(".run(")
  );
}

// ——— 4. O gate continua sendo a única decisão de autoridade ———

console.log("\no gate de origem não ganhou concorrente");
{
  const provider = codigoDe("components/helo-agent-provider.tsx");
  const chamadas = (provider.match(/isActionAllowedFor\(/g) ?? []).length;
  // Dois pontos, e só dois: o dispatcher (interactWithHeloUI) e a delegação da
  // navegação para "atividades", que também executa um handler de tela.
  checa(
    `todo caminho que executa handler consulta o gate (${chamadas} consultas)`,
    chamadas === 2,
    "— um caminho de execução novo pode ter aparecido sem consultar o gate"
  );

  const execucoes = (provider.match(/\.run\(\{/g) ?? []).length;
  checa(
    `só existem dois pontos que executam handler de tela (${execucoes})`,
    execucoes === 2,
    "— um ponto de execução novo precisa de um gate próprio"
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
