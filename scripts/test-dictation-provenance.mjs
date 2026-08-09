// ——— VOICE_TRANSCRIPTION tem de ser verdade ———
//
//   npm run test:dictation:provenance
//
// A Fase 5.2A marcava como ditada qualquer pergunta em que uma transcrição
// tivesse entrado. Parece razoável até o caso mais comum de todos aparecer: o
// cuidador digita metade — "Dona Ana," — percebe que é mais rápido falar o
// resto, e dita. A pergunta inteira ia para o prontuário como transcrição de
// voz, incluindo as palavras que a pessoa escreveu com as mãos.
//
// Isso é uma afirmação falsa num registro clínico, e o tipo de afirmação falsa
// que ninguém confere depois. `originalText` existe justamente para permitir
// comparar o que a voz produziu com o que o cuidador revisou; se ele carrega
// texto digitado, a comparação deixa de significar alguma coisa.
//
// A 5.2B fixa o sentido:
//
//     VOICE_TRANSCRIPTION = esta pergunta NASCEU de uma transcrição.
//     Não: "em algum momento houve voz neste campo".
//
// Esta suíte conduz as funções de produção que decidem isso, e depois confere
// que a origem sobrevive ao caminho offline sem ser inventada nem perdida.

import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { procedenciaInicial, registraDitado, registraEdicao, aplicaTranscricao } = await import(
  "../lib/voice/dictation.ts"
);
const { construirTurno } = await import("../lib/offline/projection.ts");
const { assertTurnInvariants, IMPLEMENTED_QUESTION_SOURCES } = await import(
  "../lib/realtime-question-types.ts"
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
function secao(titulo) {
  console.log(`\n${titulo}`);
}

/**
 * Um campo de texto com ditado, como as telas o operam.
 *
 * `digita` é o `onChange` do teclado; `dita` é o que a transcrição faz — as
 * duas coisas passando pelas MESMAS funções que a `session.tsx` usa, na mesma
 * ordem. É o que permite afirmar que o resultado abaixo é o do produto, e não
 * o de uma reimplementação das regras dentro do teste.
 */
function campo(limite = 500) {
  let texto = "";
  let procedencia = procedenciaInicial();
  return {
    get texto() {
      return texto;
    },
    get origem() {
      return procedencia.origem;
    },
    get original() {
      return procedencia.original;
    },
    digita(valor) {
      texto = valor;
      procedencia = registraEdicao(procedencia, valor);
      return this;
    },
    dita(transcricao) {
      const antes = texto;
      const r = aplicaTranscricao(antes, transcricao, limite);
      if (r.mudou) {
        texto = r.texto;
        procedencia = registraDitado(procedencia, antes, transcricao);
      }
      return this;
    },
  };
}

// ==========================================================================
secao("§20 · CASO A — campo vazio, primeiro conteúdo por voz");
// ==========================================================================

const a = campo().dita("o senhor está com dor na perna?");
check("nasce por voz", a.origem === "VOICE_TRANSCRIPTION");
check("originalText é a transcrição bruta", a.original === "o senhor está com dor na perna?");
check("e o campo tem o texto", a.texto === "o senhor está com dor na perna?");

const aBranco = campo().digita("   ").dita("o senhor está com sede?");
check("campo só com espaço conta como vazio", aBranco.origem === "VOICE_TRANSCRIPTION");

// ==========================================================================
secao("§20 · CASO B — havia texto digitado antes do primeiro ditado");
// ==========================================================================

const b = campo().digita("Dona Ana,").dita("a senhora está com dor?");
check("a origem NÃO vira voz retroativamente", b.origem === "MANUAL_TEXT");
check("…e não existe originalText para inventar", b.original === null);
check(
  "…mas o texto ditado entrou no campo normalmente",
  b.texto === "Dona Ana, a senhora está com dor?"
);

b.dita("está doendo agora?");
check("um segundo ditado também não converte", b.origem === "MANUAL_TEXT");
check("…nem cria proveniência", b.original === null);

// ==========================================================================
secao("§20 · CASO C — nasceu por voz e depois foi revisada");
// ==========================================================================

const c = campo().dita("a senhora esta com dor");
c.digita("A senhora está com dor?");
check("continua sendo voz", c.origem === "VOICE_TRANSCRIPTION");
check("originalText preserva o que a voz produziu", c.original === "a senhora esta com dor");
check("o campo carrega a versão revisada", c.texto === "A senhora está com dor?");
check(
  "a diferença entre os dois É o registro da revisão",
  c.texto !== c.original
);

// ==========================================================================
secao("§20 · CASO D — vários ditados antes de submeter");
// ==========================================================================

const d = campo().dita("a senhora está com dor");
d.digita("A senhora está com dor,"); // revisão manual no meio
d.dita("ou está só cansada?");
check("continua sendo voz", d.origem === "VOICE_TRANSCRIPTION");
check(
  "originalText junta as transcrições BRUTAS, em ordem",
  d.original === "a senhora está com dor ou está só cansada?"
);
check(
  "…sem a vírgula que o cuidador digitou",
  !d.original.includes("dor,")
);
check(
  "o campo, esse sim, tem tudo",
  d.texto === "A senhora está com dor, ou está só cansada?"
);

// ==========================================================================
secao("§20 · CASO E — limpar o campo apaga a procedência");
// ==========================================================================

const e = campo().dita("o senhor quer água?");
check("antes de limpar, é voz", e.origem === "VOICE_TRANSCRIPTION");
e.digita("");
check("limpou: a origem volta ao padrão", e.origem === "MANUAL_TEXT");
check("…e o originalText some junto", e.original === null);

e.digita("O senhor quer água?");
check("digitar depois de limpar é digitado", e.origem === "MANUAL_TEXT");

const e2 = campo().dita("primeira pergunta").digita("").dita("segunda pergunta");
check("ditar depois de limpar é ditado de novo", e2.origem === "VOICE_TRANSCRIPTION");
check(
  "…e o originalText é só o novo — o anterior não sobrevive",
  e2.original === "segunda pergunta"
);

const e3 = campo().dita("alguma coisa").digita("   ").dita("outra coisa");
check("esvaziar com espaço também reseta", e3.original === "outra coisa");

// ==========================================================================
secao("§20 · O que NÃO muda a procedência");
// ==========================================================================

const semEfeito = campo().dita("pergunta ditada");
semEfeito.dita("");
check("transcrição vazia não mexe no originalText", semEfeito.original === "pergunta ditada");
semEfeito.dita("   ");
check("…nem uma só de espaços", semEfeito.original === "pergunta ditada");

const naoCoube = campo(20).digita("").dita("uma frase bem maior que o limite deste campo");
check("o que não coube não entrou no campo", naoCoube.texto === "");
check("…e não inventou procedência", naoCoube.origem === "MANUAL_TEXT");

// ==========================================================================
secao("§29 · A origem atravessa o caminho offline sem mudar");
// ==========================================================================

const autor = { patientId: 7, assistantId: 3 };
const base = {
  id: "op-1",
  sessionId: "s-1",
  autor,
  sequence: 1,
  isSensitive: false,
  sensitiveCategory: null,
  reusedFromTurnId: null,
  agora: "2026-08-09T12:00:00.000Z",
};

const ditadoOffline = construirTurno({
  ...base,
  text: "A senhora está com dor?",
  questionSource: "VOICE_TRANSCRIPTION",
  originalText: "a senhora esta com dor",
});
check("a projeção preserva VOICE_TRANSCRIPTION", ditadoOffline.questionSource === "VOICE_TRANSCRIPTION");
check("…e o texto de origem", ditadoOffline.originalText === "a senhora esta com dor");
check("…e o texto revisado", ditadoOffline.reviewedText === "A senhora está com dor?");
check("…e a invariante aceita o turno", (() => {
  try {
    assertTurnInvariants(ditadoOffline);
    return true;
  } catch (e) {
    return String(e);
  }
})() === true);

const manualOffline = construirTurno({
  ...base,
  text: "A senhora está com dor?",
  questionSource: "MANUAL_TEXT",
  originalText: null,
});
check("manual continua manual", manualOffline.questionSource === "MANUAL_TEXT");
check("…sem originalText", manualOffline.originalText === null);

// Uma operação antiga na fila (gravada antes desta fase) não tem os campos.
const antiga = construirTurno({ ...base, text: "pergunta de antes" });
check("operação antiga na fila não vira ditada", antiga.questionSource === "MANUAL_TEXT");
check("…nem ganha originalText", antiga.originalText === null);

// Uma operação corrompida ou de schema desconhecido não derruba a sincronização.
const estranha = construirTurno({
  ...base,
  text: "pergunta",
  questionSource: "TELEPATIA",
  originalText: "algo",
});
check("origem desconhecida cai para MANUAL_TEXT", estranha.questionSource === "MANUAL_TEXT");
check("…e o originalText é descartado junto", estranha.originalText === null);

// O par proibido: texto de origem sem ditado.
const mentiroso = { ...manualOffline, originalText: "texto que não deveria estar aqui" };
check(
  "a invariante recusa originalText em pergunta digitada",
  (() => {
    try {
      assertTurnInvariants(mentiroso);
      return false;
    } catch {
      return true;
    }
  })()
);

check(
  "só duas origens são implementadas",
  IMPLEMENTED_QUESTION_SOURCES.length === 2 &&
    IMPLEMENTED_QUESTION_SOURCES.includes("MANUAL_TEXT") &&
    IMPLEMENTED_QUESTION_SOURCES.includes("VOICE_TRANSCRIPTION")
);

// ==========================================================================
secao("§21 · A limitação do refresh continua registrada e continua verdadeira");
// ==========================================================================

const sessao = readFileSync(new URL("../components/realtime-questions/session.tsx", import.meta.url), "utf8");
const semComentarios = sessao.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

check(
  "a procedência NÃO é persistida com o rascunho",
  !/definirRascunho\([^)]*procedencia/i.test(semComentarios)
);
check(
  "…nem restaurada de lugar nenhum",
  !/procedencia\s*=\s*[^;]*rascunho/i.test(semComentarios)
);
check("a limitação está escrita onde alguém a leria", /refresh/i.test(sessao));
check(
  "a submissão usa a procedência calculada, não um boolean solto",
  /questionSource: procedencia\.origem/.test(semComentarios)
);
check(
  "originalText só existe quando a origem é voz",
  /originalText: ditada \? procedencia\.original : null/.test(semComentarios)
);

// ==========================================================================
secao("§8 · Os outros três campos não ganharam proveniência de mentira");
// ==========================================================================

for (const arquivo of [
  "components/realtime-questions/interpretation.tsx",
  "components/realtime-questions/option-conversation/composer.tsx",
  "components/realtime-questions/option-conversation/node-editor.tsx",
]) {
  const texto = readFileSync(new URL(`../${arquivo}`, import.meta.url), "utf8");
  check(
    `${arquivo.split("/").pop()} dita sem registrar origem`,
    /useDictationField/.test(texto) &&
      !/questionSource|originalText|VOICE_TRANSCRIPTION|aoDitar/.test(texto)
  );
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam`);
process.exit(failed === 0 ? 0 : 1);
