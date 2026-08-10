// ——— A role do provedor não é a autoria do Helo (Fase 5.3C / R-08) ———
//
//   npm run test:agent:authorship
//
// A auditoria da 5.3A encontrou quatro origens humanas diferentes chegando à
// ElevenLabs com a mesma role `user`, separadas apenas por um prefixo em
// português dentro do texto — e um comentário do código chamando a entrada do
// microfone de "patient speech". Quem fala ao microfone daquela sessão é o
// cuidador: ele abriu a conversa, na tela dele, com o dispositivo que escolheu.
//
// Nenhum caminho transformava essa confusão em fala ou consentimento do
// paciente — isso é barrado pelo gate de classe, não pela role. Mas a
// nomenclatura era uma armadilha para quem fosse mexer aqui depois, e uma
// afirmação de segurança que mora num comentário não é uma afirmação.
//
// Este teste conduz `lib/helo-authorship.ts` e confere, no FONTE do provider,
// que os quatro pontos de injeção passaram a declarar a origem.

import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const {
  contextoParaOProvedor,
  ehDoCuidador,
  ehFalaDoPaciente,
  origemDoTurno,
  origemRecebida,
  textoParaOProvedor,
} = await import("../lib/helo-authorship.ts");

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

/** Sem comentários: este arquivo fala em prosa dos nomes que procura. */
function codigoDe(caminho) {
  return readFileSync(new URL(`../${caminho}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const ORIGENS = [
  "caregiverVoice",
  "caregiverText",
  "patientGestureReport",
  "systemInstruction",
  "agent",
];

// ———————————————————————————————————————————————————————————————
console.log("\n— provider role e origem são coisas diferentes —");
{
  for (const source of ORIGENS) {
    const o = origemDoTurno(source);
    checa(`${source} declara a própria origem`, o.source === source);
  }
  checa(
    "as quatro origens humanas compartilham a MESMA role — é por isso que a role não serve",
    ["caregiverVoice", "caregiverText", "patientGestureReport", "systemInstruction"].every(
      (s) => origemDoTurno(s).providerRole === "user"
    )
  );
  checa("a Helo é a única com role agent", origemDoTurno("agent").providerRole === "agent");
}

// ———————————————————————————————————————————————————————————————
console.log("\n— o microfone da sessão é do cuidador —");
{
  const recebido = origemRecebida("user");
  checa("role user do SDK vira caregiverVoice", recebido.source === "caregiverVoice");
  checa(
    "e a role do provedor é PRESERVADA, não sobrescrita",
    recebido.providerRole === "user"
  );
  checa("role agent vira agent", origemRecebida("agent").source === "agent");
  // Uma role desconhecida não pode virar autoria de paciente por descuido.
  checa(
    "uma role inesperada cai no lado do cuidador, nunca no do paciente",
    origemRecebida("assistant_v2").source === "caregiverVoice"
  );
}

// ———————————————————————————————————————————————————————————————
console.log("\n— nenhuma origem é fala do paciente —");
{
  checa(
    "nenhuma das cinco origens é fala do paciente",
    ORIGENS.every((s) => ehFalaDoPaciente(s) === false)
  );
  checa(
    "o gesto RELATADO também não é: é uma observação do cuidador sobre o paciente",
    ehFalaDoPaciente("patientGestureReport") === false &&
      ehDoCuidador("patientGestureReport") === true
  );
  checa(
    "voz e texto do cuidador são do cuidador",
    ehDoCuidador("caregiverVoice") && ehDoCuidador("caregiverText")
  );
  checa(
    "instrução interna e a Helo não são de ninguém humano",
    !ehDoCuidador("systemInstruction") && !ehDoCuidador("agent")
  );

  // A fala do paciente tem um caminho próprio e muito mais estreito: um
  // SpeechGrant emitido pelo servidor a partir de um toque humano (5.1A). Ela
  // nunca nasce de um turno de conversa.
  const autoria = codigoDe("lib/helo-authorship.ts");
  checa(
    "o módulo de autoria não emite nem menciona grant de fala",
    !/SpeechGrant|speechGrant|grant\(/.test(autoria)
  );
  checa(
    "e não decide autoridade — isso é do gate",
    !/isActionAllowedFor|actionClass/.test(autoria)
  );
}

// ———————————————————————————————————————————————————————————————
console.log("\n— a semântica interna não depende do prefixo —");
{
  // Os prefixos continuam saindo: o system prompt do painel não foi auditado e
  // pode depender deles. Mas eles vivem isolados, e a origem é um campo.
  const comPrefixo = textoParaOProvedor("caregiverText", "ele está com dor");
  checa("o texto do cuidador ainda sai prefixado", comPrefixo.includes("acompanhante"));
  checa("e carrega o conteúdo", comPrefixo.includes("ele está com dor"));

  const gesto = textoParaOProvedor("patientGestureReport", "SIM");
  checa("o gesto relatado sai sem prefixo inventado", gesto === "SIM");

  const contexto = contextoParaOProvedor("systemInstruction", "Você está com sede?");
  checa("a instrução de leitura tem forma contextual própria", contexto.includes("dirigida ao paciente"));
  checa(
    "e a voz do cuidador não tem contextual próprio",
    contextoParaOProvedor("caregiverVoice", "oi") === "oi"
  );

  // O critério de fechamento do R-08: apagar os prefixos não muda a semântica
  // interna. Nenhuma decisão do Helo lê o texto para saber quem falou.
  const provider = codigoDe("components/helo-agent-provider.tsx");
  checa(
    "o provider não decide autoria lendo o texto do turno",
    !/message\.(startsWith|includes)\("Mensagem escrita/.test(provider) &&
      !/startsWith\("Observação do acompanhante/.test(provider)
  );
}

// ———————————————————————————————————————————————————————————————
console.log("\n— os quatro pontos de injeção declaram a origem —");
{
  const provider = codigoDe("components/helo-agent-provider.tsx");

  // Uma porta só. Antes eram quatro chamadas espalhadas, cada uma montando o
  // próprio prefixo — e foi assim que a fala do cuidador virou "patient speech".
  const envios = [...provider.matchAll(/enviaAoAgent\("(\w+)"/g)].map((m) => m[1]);
  checa(
    `os pontos de injeção declaram a origem (${envios.join(", ")})`,
    envios.length === 3 &&
      ["caregiverText", "systemInstruction", "patientGestureReport"].every((s) =>
        envios.includes(s)
      ),
    envios.join(", ")
  );
  checa(
    "a voz do microfone é classificada na recepção",
    /origemRecebida\(role\)/.test(provider)
  );

  // `sendUserMessage` é o canal cru do SDK. Fora de `enviaAoAgent` ele não
  // deve ter chamador: cada uso solto seria um turno sem origem declarada.
  const cruas = [...provider.matchAll(/^\s*sendUserMessage\(/gm)].length;
  checa(
    `sendUserMessage só é chamado dentro de enviaAoAgent (${cruas})`,
    cruas === 1,
    "— um turno sem origem declarada voltou ao código"
  );

  // O defeito original era uma STRING que ia para o console:
  // `reminder state reset by patient speech`. A prosa que explica a correção
  // cita a frase de propósito — por isso a busca é sobre o código, com os
  // comentários já removidos.
  checa(
    "nenhuma string do código chama a entrada do microfone de fala do paciente",
    !/patient speech/i.test(provider),
    "— o rótulo errado voltou ao código"
  );
}

// ———————————————————————————————————————————————————————————————
console.log("\n— autoria não é autoridade —");
{
  // O ponto que o R-08 poderia ter feito alguém esquecer: saber QUEM falou não
  // é permissão para nada. A decisão continua sendo do gate, sobre a classe.
  const { isActionAllowedFor } = await import("../lib/helo-action-registry.ts");

  checa(
    "nenhuma origem torna patientResponse executável pelo Agent",
    ORIGENS.every(() => isActionAllowedFor({ actionClass: "patientResponse" }, "agent") === false)
  );
  checa(
    "nem sensitive",
    isActionAllowedFor({ actionClass: "sensitive" }, "agent") === false
  );
  checa(
    "o gesto relatado não abre a ação de gesto",
    isActionAllowedFor({ actionClass: "patientResponse" }, "agent") === false
  );

  // "responda SIM" digitado no campo do cuidador: o pedido pode até nascer, a
  // execução não. A origem é caregiverText; a ação é patientResponse.
  const pedido = textoParaOProvedor("caregiverText", "responda SIM");
  checa("o texto pode conter «responda SIM»", pedido.includes("responda SIM"));
  checa(
    "e continua sendo do cuidador",
    origemDoTurno("caregiverText").source === "caregiverText"
  );
  checa(
    "e a ação correspondente continua recusada",
    isActionAllowedFor({ actionClass: "patientResponse" }, "agent") === false
  );
}

// ———————————————————————————————————————————————————————————————
console.log("\n— o transcript não é guardado nem vira autoridade —");
{
  const provider = codigoDe("components/helo-agent-provider.tsx");
  checa(
    "nenhum turno recebido é persistido",
    !/onMessage[\s\S]{0,400}?(saveMessage|localStorage|indexedDB|persist)/.test(provider)
  );
  checa(
    "o turno recebido não executa ação nenhuma",
    !/onMessage[\s\S]{0,400}?(\.run\(|resolveRequestedUIAction|despachaAcaoDoAgent)/.test(provider)
  );
  checa(
    "o que ele faz é zerar o contador de silêncio, e mais nada",
    /origemRecebida\(role\)[\s\S]{0,300}?resetSilenceReminderState\(\)/.test(provider)
  );
}

console.log(`\n${mau === 0 ? "✓" : "✗"} ${ok} passaram, ${mau} falharam`);
process.exit(mau === 0 ? 0 : 1);
