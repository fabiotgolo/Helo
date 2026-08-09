// ——— Todo caminho até a voz do paciente passa pelo grant ———
//
//   npm run test:voice:callsites
//
// A suíte de HTTP prova que `/api/tts` RECUSA uma fala do paciente sem grant.
// Isso é metade da garantia. A outra metade é que todo lugar do produto que
// legitimamente faz a voz do paciente soar saiba pedir a autorização — e essa
// metade não tinha teste nenhum.
//
// O defeito que originou este arquivo: a migração da 5.1A passou por
// app/ajustes (prévia da voz do paciente) e esqueceu app/admin, que tem a
// MESMA prévia numa segunda tela. O servidor fez o certo e recusou com 403; o
// botão "🔊 Ouvir" da aba Vozes simplesmente parou de funcionar, e ninguém
// soube até alguém clicar.
//
// A lição não é "faltou um call site". É que o inventário de call sites era
// uma lista na minha cabeça. Aqui ele vira uma verificação: qualquer chamada
// de cliente que possa produzir voz do paciente precisa estar numa função que
// obtenha o grant antes.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

/** Todo .ts/.tsx sob app/, components/ e lib/ — o código que roda no cliente. */
function fontes(raiz, acc = []) {
  for (const nome of readdirSync(raiz)) {
    if (nome === "node_modules" || nome.startsWith(".")) continue;
    const caminho = join(raiz, nome);
    if (statSync(caminho).isDirectory()) fontes(caminho, acc);
    else if (/\.tsx?$/.test(nome)) acc.push(caminho);
  }
  return acc;
}

const ARQUIVOS = ["app", "components", "lib"]
  .flatMap((r) => fontes(r))
  // As rotas de API são o SERVIDOR: é lá que o grant é verificado, não pedido.
  .filter((f) => !f.startsWith("app/api/"));

// ——— Pendências conhecidas ———
//
// Um call site que produz voz do paciente e NÃO pede grant. Não é omissão: é
// uma decisão de produto ainda em aberto, registrada aqui para não virar
// esquecimento. O teste segue reprovando qualquer caso NOVO — esta lista é
// nominal, e cada entrada precisa dizer o que está esperando.
//
// Enquanto uma entrada existir, a suíte imprime o aviso e o resumo final —
// passar não pode parecer "está tudo certo".
const PENDENCIAS = {};

/**
 * Recorta a função que contém uma posição: do `const nome = ` mais próximo
 * acima até o próximo, ou o fim do arquivo. Grosseiro de propósito — o que
 * importa é se o pedido do grant e a chamada do TTS moram na mesma unidade de
 * código, e para isso um recorte generoso erra para o lado de reprovar.
 */
function blocoDe(fonte, posicao) {
  const antes = fonte.slice(0, posicao);
  const inicio = Math.max(
    antes.lastIndexOf("\n  const "),
    antes.lastIndexOf("\n  async function "),
    antes.lastIndexOf("\n  function "),
    antes.lastIndexOf("\nexport function "),
    antes.lastIndexOf("\nexport async function "),
    0
  );
  const resto = fonte.slice(posicao);
  const fim = resto.search(/\n {2}const \w+ = |\n {2}function |\nexport function /);
  return fonte.slice(inicio, posicao + (fim === -1 ? resto.length : fim));
}

// ——— Inventário: quem chama /api/tts no cliente ———
const chamadas = [];
for (const arquivo of ARQUIVOS) {
  const fonte = readFileSync(arquivo, "utf8");
  const re = /fetch\(\s*["'`]\/api\/tts["'`]/g;
  let m;
  while ((m = re.exec(fonte)) != null) {
    const linha = fonte.slice(0, m.index).split("\n").length;
    const bloco = blocoDe(fonte, m.index);
    chamadas.push({ arquivo, linha, bloco });
  }
}

console.log("\n— Inventário das chamadas de cliente a /api/tts —");
{
  check(
    "existe pelo menos uma chamada para inspecionar",
    chamadas.length > 0,
    "— o padrão de busca deixou de encontrar as chamadas; o teste não prova nada assim"
  );
  for (const c of chamadas) console.log(`    · ${c.arquivo}:${c.linha}`);
}

console.log("\n— Quem pode produzir voz do paciente pede o grant —");
{
  // Dois gatilhos tornam a chamada uma fala do paciente, do lado do servidor:
  //   speakerRole: "patient"   → fala confirmada
  //   previewPatientVoice      → prévia da voz dele
  // (ver app/api/tts/route.ts: `isPatientVoice`)
  const doPaciente = chamadas.filter(
    (c) => /speakerRole["']?\s*[:=]\s*["']patient["']/.test(c.bloco) ||
      /previewPatientVoice/.test(c.bloco) ||
      /\bgrant\b/.test(c.bloco)
  );
  check(
    "há chamadas classificadas como voz do paciente",
    doPaciente.length > 0,
    "— nenhuma foi reconhecida; a classificação quebrou"
  );

  const semGrant = doPaciente.filter(
    (c) =>
      // ou pede o grant ali mesmo…
      !/\/api\/voice\/grant/.test(c.bloco) &&
      // …ou recebe um grant já emitido por quem chamou.
      !/grant:\s*\w/.test(c.bloco) &&
      !/\bgrant\s*=\s*/.test(c.bloco)
  );
  const novos = semGrant.filter((c) => !PENDENCIAS[c.arquivo]);
  check(
    "nenhuma chamada NOVA de voz do paciente ficou sem grant",
    novos.length === 0,
    novos.map((c) => `${c.arquivo}:${c.linha}`).join("; ") +
      " — /api/tts vai responder 403 e o botão vai falhar em silêncio"
  );

  // Uma pendência que já foi resolvida precisa SAIR da lista. Deixá-la ali
  // faria a próxima regressão no mesmo arquivo passar despercebida.
  const resolvidas = Object.keys(PENDENCIAS).filter(
    (arquivo) => !semGrant.some((c) => c.arquivo === arquivo)
  );
  check(
    "a lista de pendências não tem entrada obsoleta",
    resolvidas.length === 0,
    `— já corrigido, remova de PENDENCIAS: ${resolvidas.join(", ")}`
  );
}

console.log("\n— Rascunho não vira fala do paciente —");
{
  // A regra de produto: texto ainda não salvo não é pronunciado na voz do
  // paciente. Ela não é imposta por uma checagem — é imposta pela AUSÊNCIA do
  // caminho. O gerenciador de frases não pede síntese nenhuma; a frase é
  // ouvida depois de salva, no modal, onde o servidor resolve a origem.
  //
  // Esta verificação existe porque a versão anterior desta tela mandava o
  // texto sendo digitado para /api/tts como fala do paciente. O servidor
  // recusava (403), e o cuidador recebia um alerta técnico por uma operação
  // que nunca mais ia funcionar.
  const gerenciador = readFileSync("app/atividades/gerenciar/page.tsx", "utf8");
  check(
    "o gerenciador de frases não chama /api/tts",
    !/fetch\(\s*["'`]\/api\/tts/.test(gerenciador),
    "— o texto do formulário é rascunho, e rascunho não tem origem para autorizar"
  );
  check(
    "…nem pede grant para o que ainda não foi salvo",
    !/\/api\/voice\/grant/.test(gerenciador),
    "— criar origem para rascunho seria contornar o R-01 por dentro"
  );
  check(
    "e o botão de prévia do rascunho não voltou",
    !/previewPhrase/.test(gerenciador),
    "— ele só podia falar texto não persistido; não havia o que consertar nele"
  );
  check(
    "a tela diz ao cuidador onde a frase é ouvida",
    /Frases para se ouvir/.test(gerenciador) && /Depois de salva/.test(gerenciador),
    "— remover o botão sem explicar deixaria a pergunta 'e como eu ouço?' sem resposta"
  );
  // A linguagem da tela é do cuidador, não da arquitetura.
  const copyDaTela = gerenciador.match(/<p className="mt-1 text-sm text-ink-soft">([^<]*)<\/p>/)?.[1] ?? "";
  check(
    "sem jargão técnico na explicação",
    copyDaTela.length > 0 &&
      !/(SpeechGrant|403|autoriza|confirmationStatus|token|grant)/i.test(copyDaTela),
    `— "${copyDaTela}"`
  );

  // O caminho seguro que já existia continua de pé.
  const modal = readFileSync("components/phrases-to-listen-modal.tsx", "utf8");
  check(
    "o modal de frases SALVAS segue pedindo grant por frase",
    /kind: "favoritePhrase", phraseId: phrase\.id/.test(modal),
    "— é ele o caminho de ouvir a frase na voz do paciente"
  );
}

console.log("\n— O cliente não decide o texto da prévia —");
{
  // A prévia era o caminho mais fácil para texto livre na voz clonada de
  // alguém: um campo de texto e um botão "ouvir". O texto tem que vir do
  // servidor, e o cliente tem que FALAR o que recebeu.
  // Por ARQUIVO, não por bloco: no Ajustes o payload é montado no JSX e o
  // fetch mora em `playPreview`, várias funções acima. Contar por bloco daria
  // um resultado que depende de como o componente foi organizado — e a
  // pergunta não é essa.
  const telas = [...new Set(
    ARQUIVOS.filter((f) => /previewPatientVoice/.test(readFileSync(f, "utf8")))
  )];
  check(
    "as telas de prévia da voz do paciente são as duas conhecidas",
    telas.length === 2 && telas.some((f) => f.includes("admin")) && telas.some((f) => f.includes("ajustes")),
    `— encontradas: ${telas.join(", ")}`
  );
  const semTextoDoServidor = telas.filter((f) => {
    const fonte = readFileSync(f, "utf8");
    return !/granted\.text/.test(fonte) || !/text:\s*spoken/.test(fonte);
  });
  check(
    "cada tela fala o texto que o servidor devolveu, não o seu",
    semTextoDoServidor.length === 0,
    semTextoDoServidor.join("; ")
  );
}

console.log("\n— A origem da prévia existe e é resolvida no servidor —");
{
  const sources = readFileSync("lib/voice/speech-sources.ts", "utf8");
  check(
    "patientVoicePreview é uma origem aceita",
    /case "patientVoicePreview"/.test(sources)
  );
  check(
    "…e a frase é composta no servidor, não recebida do cliente",
    /case "patientVoicePreview": \{[\s\S]{0,600}?getPatient\(patientId\)/.test(sources),
    "— a prévia voltou a aceitar texto do cliente"
  );
}

const pendentes = Object.entries(PENDENCIAS);
if (pendentes.length > 0) {
  console.log("\n⚠ Pendências conhecidas — a suíte passa, o produto não está inteiro:");
  for (const [arquivo, motivo] of pendentes) {
    console.log(`\n  ${arquivo}`);
    console.log(`    ${motivo.replace(/(.{72}\s)/g, "$1\n    ")}`);
  }
}

console.log(
  `\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam` +
    (pendentes.length > 0 ? ` · ${pendentes.length} pendência(s) conhecida(s)` : "") +
    "\n"
);
process.exit(failed === 0 ? 0 : 1);
