// ——— A transcrição é rascunho, e não tem caminho para virar outra coisa ———
//
//   npm run test:dictation:authorship
//
// A Fase 5.2A dá voz ao CUIDADOR para preencher campos. A pergunta que esta
// suíte responde é a única que importa: existe algum caminho — direto ou por
// dentro — em que falar produz uma fala confirmada do paciente, uma resposta
// SIM/TALVEZ/NÃO, um SpeechGrant, uma ação do Agent ou uma apresentação
// automática?
//
// A resposta precisa ser não POR CONSTRUÇÃO, não por verificação. Uma
// verificação alguém remove; uma ligação que não existe alguém teria que
// escrever, e escrever aparece na revisão.
//
// O caso crítico é o cuidador ditar "sim". A palavra é idêntica ao gesto que
// confirma a fala do paciente, e é a coisa mais natural do mundo de se dizer
// em voz alta ao lado de uma cama. Ela precisa ser texto, e só texto.

import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { construirTurno } = await import("../lib/offline/projection.ts");
const {
  IMPLEMENTED_QUESTION_SOURCES,
  QUESTION_SOURCES,
  assertTurnInvariants,
} = await import("../lib/realtime-question-types.ts");
const { tryToConfirmedPatientStatement, isConfirmedPatientStatement } =
  await import("../lib/confirmed-patient-statement.ts");
const { aplicaTranscricao } = await import("../lib/voice/dictation.ts");

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

/**
 * O portão de autoria não devolve fala confirmada para isto.
 *
 * "Não devolve" tem duas formas aqui, e as duas contam. A esperada é `null`.
 * A outra é lançar — e é o que de fato acontece com um turno de pergunta: o
 * portão só aceita `OptionConversationFinalStatement`, e um turno nem tem os
 * campos que ele lê. `tryTo…` só engole `RtqDomainError`, então um turno
 * estoura antes disso. É uma prova mais forte que `=== null`: significa que o
 * tipo que carrega `questionSource` não é sequer avaliável pelo portão.
 */
function naoViraFala(valor) {
  try {
    return tryToConfirmedPatientStatement(valor) === null;
  } catch {
    return true;
  }
}

const AUTOR = { patientId: 7, assistantId: "user-cuidador" };
const AGORA = "2026-08-08T12:00:00.000Z";

function turnoDitado(texto, extra = {}) {
  return construirTurno({
    id: "turn-1",
    sessionId: "sess-1",
    autor: AUTOR,
    sequence: 1,
    text: texto,
    questionSource: "VOICE_TRANSCRIPTION",
    originalText: texto,
    isSensitive: false,
    sensitiveCategory: null,
    reusedFromTurnId: null,
    agora: AGORA,
    ...extra,
  });
}

console.log("\n— A origem existe, e descreve apenas COMO o texto entrou —");
{
  check(
    "VOICE_TRANSCRIPTION é uma origem aceita",
    IMPLEMENTED_QUESTION_SOURCES.includes("VOICE_TRANSCRIPTION")
  );
  check(
    "AI_SUGGESTION continua recusada",
    QUESTION_SOURCES.includes("AI_SUGGESTION") &&
      !IMPLEMENTED_QUESTION_SOURCES.includes("AI_SUGGESTION"),
    "— não existe sugestão por IA no produto"
  );

  const turno = turnoDitado("o senhor está com dor?");
  check("a pergunta ditada nasce em DRAFT", turno.status === "DRAFT");
  check("sem resposta provisória", turno.provisionalResponse === null);
  check("sem resposta confirmada", turno.confirmedResponse === null);
  check("sem apresentação", turno.presentedText === "" && turno.presentedAt === null);
  check("sem confirmação", turno.confirmedAt === null && turno.assistantVerifiedAt === null);
  check("a origem é registrada", turno.questionSource === "VOICE_TRANSCRIPTION");
  check("a transcrição original é preservada", turno.originalText === "o senhor está com dor?");
  check("o texto revisado é o que o cuidador submeteu", turno.reviewedText === "o senhor está com dor?");

  // A origem não pode ser afirmada sem que tenha havido origem.
  let recusou = false;
  try {
    assertTurnInvariants({ ...turno, questionSource: "MANUAL_TEXT" });
  } catch {
    recusou = true;
  }
  check(
    "texto de origem numa pergunta DIGITADA é recusado",
    recusou,
    "— senão `originalText` viraria campo livre para qualquer coisa"
  );

  // E uma pergunta digitada continua nascendo digitada.
  const digitada = construirTurno({
    id: "turn-2",
    sessionId: "sess-1",
    autor: AUTOR,
    sequence: 1,
    text: "e agora?",
    isSensitive: false,
    sensitiveCategory: null,
    reusedFromTurnId: null,
    agora: AGORA,
  });
  check(
    "sem ditado, a origem continua MANUAL_TEXT",
    digitada.questionSource === "MANUAL_TEXT" && digitada.originalText === null
  );
}

console.log("\n— SIM, TALVEZ e NÃO ditados são texto, e nada mais —");
{
  for (const palavra of ["sim", "Sim", "SIM", "talvez", "Talvez", "não", "nao", "NÃO"]) {
    const campo = aplicaTranscricao("", palavra, 500);
    check(`"${palavra}" vira texto no campo`, campo.texto === palavra && campo.mudou);

    const turno = turnoDitado(palavra);
    check(`"${palavra}" não escolhe resposta provisória`, turno.provisionalResponse === null);
    check(`"${palavra}" não confirma`, turno.confirmedResponse === null && turno.status === "DRAFT");
    check(`"${palavra}" não apresenta ao paciente`, turno.presentedAt === null);
    check(
      `"${palavra}" não vira fala confirmada`,
      naoViraFala(turno)
    );
  }
}

console.log("\n— VOICE_TRANSCRIPTION → jamais ConfirmedPatientStatement —");
{
  // Nem no pior caso construído de má-fé: um turno ditado forjado com tudo o
  // que uma confirmação teria.
  const forjado = {
    ...turnoDitado("o senhor quer ir para casa?"),
    status: "CONFIRMED",
    provisionalResponse: "YES",
    confirmedResponse: "YES",
    confirmedAt: AGORA,
    assistantVerifiedAt: AGORA,
    presentedText: "o senhor quer ir para casa?",
    presentedAt: AGORA,
  };
  check(
    "um turno ditado forjado como confirmado não passa no portão",
    naoViraFala(forjado)
  );
  check("…e não carrega a marca de autoria", !isConfirmedPatientStatement(forjado));

  // A razão estrutural: o portão só aceita uma frase final da conversa por
  // opções. `questionSource` nem existe no tipo que ele recebe — não há
  // sobrecarga, não há string, não há rascunho.
  const portao = readFileSync("lib/confirmed-patient-statement.ts", "utf8");
  check(
    "o portão de autoria não conhece questionSource",
    !/questionSource|VOICE_TRANSCRIPTION|transcri/i.test(portao),
    "— a origem do ditado não tem por onde entrar"
  );
  check(
    "…e recebe apenas OptionConversationFinalStatement",
    /toConfirmedPatientStatement\(\s*statement: OptionConversationFinalStatement\s*\)/.test(portao)
  );
}

console.log("\n— O transcript não alcança grant, registry, client tool nem TTS —");
{
  const modulos = [
    "lib/voice/dictation.ts",
    "lib/voice/dictation-server.ts",
    "lib/voice/use-dictation.ts",
    "components/voice/dictation-button.tsx",
    "app/api/voice/dictation/route.ts",
  ];
  const proibidos = [
    ["/api/voice/grant", "SpeechGrant"],
    ["issueSpeechGrant", "SpeechGrant"],
    ["speech-grant", "SpeechGrant"],
    ["/api/tts", "voz do paciente"],
    ["speakerRole", "voz do paciente"],
    ["previewPatientVoice", "voz do paciente"],
    ["findHeloUIAction", "action registry"],
    ["isActionAllowedFor", "action registry"],
    ["helo-actions", "action registry"],
    ["clientTools", "client tool"],
    ["sendUserMessage", "conversa do Agent"],
    ["sendContextualUpdate", "conversa do Agent"],
    ["useConversation", "conversa do Agent"],
    ["ConfirmedPatientStatement", "autoria"],
    ["confirmedResponse", "autoria"],
    ["provisionalResponse", "autoria"],
  ];
  for (const arquivo of modulos) {
    const corpo = readFileSync(arquivo, "utf8")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [termo, motivo] of proibidos) {
      check(
        `${arquivo} não toca em ${termo} (${motivo})`,
        !corpo.includes(termo)
      );
    }
  }
}

console.log("\n— Nos quatro campos, a transcrição só sai pelo onChange do campo —");
{
  // O ponto de integração. Se um dia alguém acrescentar `onSubmit()` ao
  // `aoMudar`, ditar passa a apresentar ao paciente sozinho — e a tela pareceria
  // igual. É este bloco que precisa continuar minúsculo.
  const campos = [
    ["components/realtime-questions/session-screens.tsx", "a pergunta"],
    ["components/realtime-questions/interpretation.tsx", "a interpretação"],
    ["components/realtime-questions/option-conversation/composer.tsx", "a frase"],
    ["components/realtime-questions/option-conversation/node-editor.tsx", "o título do nível"],
  ];
  const perigosos = [
    "onSubmit",
    "onContinue",
    "onPresent",
    "onConfirm",
    "onRespond",
    "createTurn",
    "persist.",
    "fetch(",
    "grant",
    "confirm",
    "apresenta",
  ];
  for (const [arquivo, rotulo] of campos) {
    const fonte = readFileSync(arquivo, "utf8");
    check(`${arquivo} usa o ditado`, fonte.includes("useDictationField("));
    check(`${arquivo} mostra o botão para "${rotulo}"`, fonte.includes(`rotuloDoCampo="${rotulo}"`));

    // Recorta a chamada: de `useDictationField({` até a `});` seguinte.
    const inicio = fonte.indexOf("useDictationField({");
    const fim = fonte.indexOf("});", inicio);
    const bloco = fonte.slice(inicio, fim).replace(/\/\/[^\n]*/g, "");
    check(`${arquivo} — a chamada foi recortada`, inicio > 0 && fim > inicio);
    for (const termo of perigosos) {
      check(
        `${arquivo} — o ditado não chama ${termo}`,
        !bloco.includes(termo),
        `— bloco: ${bloco.replace(/\s+/g, " ").slice(0, 160)}`
      );
    }
    check(
      `${arquivo} — a transcrição entra pelo caminho do teclado`,
      /aoMudar:\s*(onChange|\(texto\))/.test(bloco),
      `— bloco: ${bloco.replace(/\s+/g, " ").slice(0, 160)}`
    );
  }
}

console.log("\n— Áudio nunca entra na fila offline —");
{
  const tipos = readFileSync("lib/offline/types.ts", "utf8");
  for (const termo of ["audio", "Blob", "MediaRecorder", "transcri", "ditad"]) {
    check(
      `a fila offline não tem noção de ${termo}`,
      !new RegExp(termo, "i").test(tipos)
    );
  }
  // O que a fila carrega de uma pergunta ditada é TEXTO — origem e transcrição
  // revisada. É isso que precisa sobreviver a uma queda de rede, e só isso.
  const sync = readFileSync("lib/offline/sync-endpoints.ts", "utf8");
  check(
    "a operação de criação leva a origem",
    /questionSource: p\.questionSource/.test(sync)
  );
  check(
    "…e leva a transcrição original",
    /originalText: p\.originalText/.test(sync),
    "— sem isto, uma pergunta ditada offline chegaria ao prontuário como digitada"
  );

  const projecao = readFileSync("lib/offline/projection.ts", "utf8");
  check(
    "o espelho local respeita a origem da operação",
    !/questionSource: "MANUAL_TEXT",/.test(projecao),
    "— voltou a ficar fixo em MANUAL_TEXT"
  );

  // Prova de ponta a ponta da transição: operação enfileirada com a origem,
  // espelho local reconstruído a partir dela.
  const daFila = construirTurno({
    id: "turn-fila",
    sessionId: "sess-1",
    autor: AUTOR,
    sequence: 1,
    text: "a senhora quer água?",
    questionSource: "VOICE_TRANSCRIPTION",
    originalText: "a senhora quer agua",
    isSensitive: false,
    sensitiveCategory: null,
    reusedFromTurnId: null,
    agora: AGORA,
  });
  check(
    "pergunta ditada com rede e submetida sem rede preserva a origem",
    daFila.questionSource === "VOICE_TRANSCRIPTION" &&
      daFila.originalText === "a senhora quer agua" &&
      daFila.reviewedText === "a senhora quer água?"
  );
  // Uma origem desconhecida na fila (schema antigo) não pode travar a
  // sincronização inteira do cuidador.
  const legado = construirTurno({
    id: "turn-legado",
    sessionId: "sess-1",
    autor: AUTOR,
    sequence: 1,
    text: "pergunta antiga",
    questionSource: "ORIGEM_QUE_NAO_EXISTE",
    isSensitive: false,
    sensitiveCategory: null,
    reusedFromTurnId: null,
    agora: AGORA,
  });
  check(
    "origem desconhecida na fila cai para o padrão em vez de reprovar",
    legado.questionSource === "MANUAL_TEXT" && legado.originalText === null
  );
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
