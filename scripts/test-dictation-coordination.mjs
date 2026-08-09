// ——— Um dono do microfone, e nenhuma callback atrasada capaz de mentir ———
//
//   npm run test:dictation:coordination
//
// A Fase 5.2A entregou o ditado com a arbitragem que dava para fazer naquele
// momento: dois booleans, cada lado consultando o do outro antes de abrir o
// dispositivo. Esta suíte existe porque essa forma tem um defeito estrutural, e
// ele não é hipotético — é o que acontece quando o cuidador toca no botão de
// ditar enquanto a conversa com a Helo ainda está abrindo:
//
//   `connect()` consulta "o ditado está ativo?", ouve não, e sai para pedir o
//   token e negociar o WebRTC. Dois segundos depois ele marca a própria
//   ocupação. No meio disso o ditado consulta "o Agente está ativo?", ouve não,
//   e abre o microfone. Os dois têm razão. Os dois estão dentro.
//
// E o defeito simétrico, mais silencioso: um `release` que chega tarde — a
// resposta de rede de uma captura antiga, o `onstop` de um gravador esquecido,
// a desmontagem de um campo que o cuidador deixou para trás — soltava o dono
// ATUAL, porque a liberação era global e não tinha a quem se referir.
//
// A primeira metade da suíte conduz `lib/voice/mic-ownership.ts`, que é onde a
// 5.2B pôs a decisão: posse tomada de forma indivisível, com identidade. A
// segunda metade confere que os DOIS lados — a captura e o Agente — realmente
// passaram a usá-la, e que os caminhos de saída exigidos pela fase existem no
// código de produção.
//
// Nada aqui abre microfone, toca rede ou gasta crédito.

import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const {
  adquireMicrofone,
  agenteDetemMicrofone,
  avancaMicrofone,
  concessaoVigente,
  ditadoDetemMicrofone,
  donoDoMicrofone,
  liberaMicrofone,
  microfoneLivre,
  microfoneOcupadoPorOutro,
  assinaMicrofone,
  reiniciaMicrofoneParaTeste,
} = await import("../lib/voice/mic-ownership.ts");

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

/** O texto de um arquivo de produção, sem comentários. */
function fonte(caminho) {
  const bruto = readFileSync(new URL(`../${caminho}`, import.meta.url), "utf8");
  // Comentários explicam o que o código NÃO faz — e é exatamente por isso que
  // uma varredura ingênua encontra neles as palavras que ela procura provar
  // ausentes. Já aconteceu três vezes neste projeto.
  return bruto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ==========================================================================
secao("§2 · A posse é uma só, e ela tem nome");
// ==========================================================================

reiniciaMicrofoneParaTeste();
check("sem ninguém, o dono é NONE", donoDoMicrofone() === "NONE");
check("…e o microfone está livre", microfoneLivre() === true);
check("…sem concessão vigente", concessaoVigente() === null);

const c1 = adquireMicrofone("DICTATION_REQUESTING");
check("o ditado toma o microfone", c1 !== null && c1.familia === "DICTATION");
check("o dono passa a ser DICTATION_REQUESTING", donoDoMicrofone() === "DICTATION_REQUESTING");
check("ditadoDetemMicrofone reconhece", ditadoDetemMicrofone() === true);
check("agenteDetemMicrofone nega", agenteDetemMicrofone() === false);

check("pedindo permissão já é ocupação", microfoneOcupadoPorOutro("AGENT") === true);
avancaMicrofone(c1, "DICTATION_LISTENING");
check("gravando é ocupação", microfoneOcupadoPorOutro("AGENT") === true);
avancaMicrofone(c1, "DICTATION_PROCESSING");
check(
  "transcrevendo TAMBÉM é ocupação — a resposta ainda vai mexer na tela",
  microfoneOcupadoPorOutro("AGENT") === true && ditadoDetemMicrofone() === true
);
check("…e o dono é DICTATION_PROCESSING", donoDoMicrofone() === "DICTATION_PROCESSING");

// ==========================================================================
secao("§3 · A aquisição é indivisível: só um vence");
// ==========================================================================

reiniciaMicrofoneParaTeste();
const agente = adquireMicrofone("AGENT_CONNECTING");
const ditado = adquireMicrofone("DICTATION_REQUESTING");
check("o Agente chegou primeiro e ficou", agente !== null);
check("o ditado, no mesmo instante, foi recusado", ditado === null);
check("e o dono continua sendo um só", donoDoMicrofone() === "AGENT_CONNECTING");

reiniciaMicrofoneParaTeste();
const ditadoPrimeiro = adquireMicrofone("DICTATION_LISTENING");
const agenteDepois = adquireMicrofone("AGENT_CONNECTING");
check("na ordem inversa, o resultado é o espelho", ditadoPrimeiro !== null && agenteDepois === null);

reiniciaMicrofoneParaTeste();
// Cem tentativas simultâneas — o duplo clique levado ao extremo.
const tentativas = Array.from({ length: 100 }, (_, i) =>
  adquireMicrofone(i % 2 === 0 ? "DICTATION_REQUESTING" : "AGENT_CONNECTING")
);
check(
  "cem aquisições disputando: exatamente uma vence",
  tentativas.filter(Boolean).length === 1
);

reiniciaMicrofoneParaTeste();
const meu = adquireMicrofone("DICTATION_REQUESTING");
check("quem já tem não adquire de novo", adquireMicrofone("DICTATION_REQUESTING") === null);
check("…nem para a outra família", adquireMicrofone("AGENT_CONNECTING") === null);
liberaMicrofone(meu);

// ==========================================================================
secao("§3 · Uma liberação atrasada nunca solta o dono novo");
// ==========================================================================

reiniciaMicrofoneParaTeste();
// O cenário escrito na fase, na ordem exata: A adquire, A encerra, B adquire,
// e só então a callback atrasada de A chama release.
const sessaoA = adquireMicrofone("DICTATION_LISTENING");
check("A liberou de verdade", liberaMicrofone(sessaoA) === true);
const sessaoB = adquireMicrofone("AGENT_CONNECTING");
check("B assumiu", sessaoB !== null);
check("o release atrasado de A não faz nada", liberaMicrofone(sessaoA) === false);
check("…e B continua dono", donoDoMicrofone() === "AGENT_CONNECTING");
check("…com a concessão dele, não a de A", concessaoVigente() === sessaoB.id);

check("o avanço atrasado de A também não faz nada", avancaMicrofone(sessaoA, "DICTATION_PROCESSING") === false);
check("…o dono segue intacto", donoDoMicrofone() === "AGENT_CONNECTING");

check("liberar duas vezes é inofensivo", liberaMicrofone(sessaoB) === true && liberaMicrofone(sessaoB) === false);
check("…e o microfone fica livre, não negativo", microfoneLivre() === true);

reiniciaMicrofoneParaTeste();
const antesDoReinicio = adquireMicrofone("DICTATION_LISTENING");
reiniciaMicrofoneParaTeste();
const depoisDoReinicio = adquireMicrofone("AGENT_ACTIVE");
check(
  "ids nunca se repetem — nem depois de reiniciar a posse",
  depoisDoReinicio.id !== antesDoReinicio.id
);
check("…logo a concessão velha continua sem valer", liberaMicrofone(antesDoReinicio) === false);

// ==========================================================================
secao("§4 · Transições da mesma concessão, e nada além delas");
// ==========================================================================

reiniciaMicrofoneParaTeste();
const captura = adquireMicrofone("DICTATION_REQUESTING");
check("REQUESTING → LISTENING", avancaMicrofone(captura, "DICTATION_LISTENING") === true);
check("LISTENING → PROCESSING", avancaMicrofone(captura, "DICTATION_PROCESSING") === true);
check("avançar para o mesmo estado é aceito e não muda nada", avancaMicrofone(captura, "DICTATION_PROCESSING") === true);
check(
  "o ditado NÃO vira Agente no meio do caminho",
  avancaMicrofone(captura, "AGENT_ACTIVE") === false
);
check("…e o dono continua o que era", donoDoMicrofone() === "DICTATION_PROCESSING");
liberaMicrofone(captura);
check("avançar sem posse nenhuma não ressuscita ninguém", avancaMicrofone(captura, "DICTATION_LISTENING") === false);
check("…o microfone segue livre", donoDoMicrofone() === "NONE");

// Quem observa a posse é avisado — é assim que a interface descobre.
reiniciaMicrofoneParaTeste();
let avisos = 0;
const desassina = assinaMicrofone(() => avisos++);
const observada = adquireMicrofone("AGENT_CONNECTING");
avancaMicrofone(observada, "AGENT_ACTIVE");
liberaMicrofone(observada);
check("tomar, avançar e soltar avisam quem observa", avisos === 3, `— ${avisos}`);
desassina();
const semObservador = adquireMicrofone("AGENT_CONNECTING");
liberaMicrofone(semObservador);
check("depois de desassinar, o observador some", avisos === 3);

// ==========================================================================
secao("§18 · Agente × ditado, as oito regras");
// ==========================================================================

function comPosse(dono, fn) {
  reiniciaMicrofoneParaTeste();
  const c = adquireMicrofone(dono);
  const r = fn(c);
  reiniciaMicrofoneParaTeste();
  return r;
}

check(
  "A · Agente CONNECTING já bloqueia o ditado",
  comPosse("AGENT_CONNECTING", () => adquireMicrofone("DICTATION_REQUESTING") === null)
);
check(
  "B · Agente ACTIVE bloqueia o ditado",
  comPosse("AGENT_ACTIVE", () => adquireMicrofone("DICTATION_REQUESTING") === null)
);
check(
  "C · ditado REQUESTING bloqueia o Agente",
  comPosse("DICTATION_REQUESTING", () => adquireMicrofone("AGENT_CONNECTING") === null)
);
check(
  "D · ditado LISTENING bloqueia o Agente",
  comPosse("DICTATION_LISTENING", () => adquireMicrofone("AGENT_CONNECTING") === null)
);
check(
  "E · ditado PROCESSING bloqueia o Agente até concluir",
  comPosse("DICTATION_PROCESSING", () => adquireMicrofone("AGENT_CONNECTING") === null)
);
check(
  "F · falha de inicialização libera o dono",
  comPosse("AGENT_CONNECTING", (c) => {
    liberaMicrofone(c);
    return adquireMicrofone("DICTATION_REQUESTING") !== null;
  })
);
check(
  "G · desconexão libera o dono",
  comPosse("AGENT_ACTIVE", (c) => {
    liberaMicrofone(c);
    return microfoneLivre();
  })
);
check(
  "H · callback atrasada não libera a sessão nova",
  (() => {
    reiniciaMicrofoneParaTeste();
    const velha = adquireMicrofone("AGENT_ACTIVE");
    liberaMicrofone(velha);
    const nova = adquireMicrofone("DICTATION_LISTENING");
    liberaMicrofone(velha); // atrasada
    const intacta = donoDoMicrofone() === "DICTATION_LISTENING";
    liberaMicrofone(nova);
    return intacta;
  })()
);

// ==========================================================================
secao("§32 · Cem ciclos, e nada fica para trás");
// ==========================================================================

reiniciaMicrofoneParaTeste();
const vencidas = [];
let concessoesEmitidas = 0;
let liberacoesEfetivas = 0;
for (let i = 0; i < 100; i++) {
  const c = adquireMicrofone("DICTATION_REQUESTING");
  if (!c) break;
  concessoesEmitidas++;
  avancaMicrofone(c, "DICTATION_LISTENING");
  avancaMicrofone(c, "DICTATION_PROCESSING");
  // A cada volta, todas as concessões já vencidas tentam agir de novo — é o
  // acúmulo de callbacks atrasadas que uma sessão longa produz de verdade.
  for (const antiga of vencidas) {
    liberaMicrofone(antiga);
    avancaMicrofone(antiga, "DICTATION_LISTENING");
  }
  if (donoDoMicrofone() !== "DICTATION_PROCESSING") break;
  if (liberaMicrofone(c)) liberacoesEfetivas++;
  vencidas.push(c);
}
check("cem ciclos completos", concessoesEmitidas === 100, `— ${concessoesEmitidas}`);
check("cada um liberou exatamente uma vez", liberacoesEfetivas === 100, `— ${liberacoesEfetivas}`);
check("nenhuma das 99 concessões vencidas conseguiu agir", vencidas.length === 100);
check("no fim, zero posse pendurada", microfoneLivre() === true);
check("…e o dono é NONE", donoDoMicrofone() === "NONE");
check("o microfone ainda funciona depois de tudo", adquireMicrofone("AGENT_CONNECTING") !== null);
reiniciaMicrofoneParaTeste();

// ==========================================================================
secao("§4–§10 · A captura usa a posse, e sai por todos os caminhos");
// ==========================================================================

const captacao = fonte("lib/voice/use-dictation.ts");

check(
  "a posse é TOMADA antes de qualquer coisa assíncrona",
  /adquireMicrofone\("DICTATION_REQUESTING"\)/.test(captacao) &&
    captacao.indexOf("adquireMicrofone") < captacao.indexOf("getUserMedia")
);
check("a posse avança para LISTENING", /avancaMicrofone\([^)]*"DICTATION_LISTENING"\)/.test(captacao));
check("…e para PROCESSING ao parar", /avancaMicrofone\([^)]*"DICTATION_PROCESSING"\)/.test(captacao));
check("a posse é devolvida com a concessão em mãos", /liberaMicrofone\(execucao\.concessao\)/.test(captacao));
check(
  "não sobrou nenhum boolean global de ditado",
  !/setDictationActive/.test(captacao)
);

check(
  "§4 · existe guarda síncrona contra o segundo clique",
  /if\s*\(execucaoRef\.current\)\s*return/.test(captacao)
);
check(
  "§4 · o teardown é idempotente por bandeira",
  /if\s*\(execucao\.encerrada\)\s*return/.test(captacao) && /execucao\.encerrada\s*=\s*true/.test(captacao)
);
check(
  "§5 · a permissão atrasada fecha as trilhas e não volta a LISTENING",
  /if\s*\(!vigente\(execucao\)\)\s*\{[\s\S]{0,160}?getTracks\(\)\)\s*trilha\.stop\(\);?[\s\S]{0,40}?return/.test(
    captacao
  )
);
check(
  "§6 · toda callback assíncrona confere a execução",
  (captacao.match(/vigente\(execucao\)/g) ?? []).length >= 7
);
check("§7 · cada envio tem o seu AbortController", /new AbortController\(\)/.test(captacao));
check("§7 · …guardado na execução, nunca reaproveitado", /execucao\.envio\s*=\s*controle/.test(captacao));
check("§7 · …e abortado no teardown", /execucao\.envio\?\.abort\(\)/.test(captacao));
check(
  "§8 · a aba escondida cancela",
  /visibilitychange/.test(captacao) && /visibilityState === "hidden"/.test(captacao)
);
check("§8 · pagehide cancela", /"pagehide"/.test(captacao));
check("§8 · voltar não retoma sozinho", !/visible[\s\S]{0,80}inicia\(\)/.test(captacao));
check(
  "§9 · perder a rede durante a captura encerra a captura",
  /!conectado && execucaoRef\.current[\s\S]{0,40}abandona\("OFFLINE"\)/.test(captacao)
);
check(
  "§10 · a trilha que termina sozinha CANCELA, não transcreve",
  /onended = \(\) => \{[\s\S]{0,120}?abandona\("DEVICE_LOST"\)/.test(captacao)
);
check(
  "§11 · o Blob usa o mimeType efetivo do gravador",
  /tipoEfetivo\(gravador, formato\)/.test(captacao) && /new Blob\(pedacos, \{ type: tipoDoBlob \}\)/.test(captacao)
);
check("§17 · não existe retentativa de áudio", !/(retry|retentativa|tentarDeNovo|reenvi)/i.test(captacao));
check("§17 · nem fila de envio", !/(queue|fila|enfileir)/i.test(captacao));
check(
  "§14 · o áudio não é guardado em lugar nenhum",
  !/(localStorage|sessionStorage|indexedDB|createObjectURL|caches\.)/.test(captacao)
);

// ==========================================================================
secao("§18 · O Agente toma a posse no primeiro instante de connect()");
// ==========================================================================

const provedorDoAgente = fonte("components/helo-agent-provider.tsx");

check(
  "connect() adquire AGENT_CONNECTING",
  /adquireMicrofone\("AGENT_CONNECTING"\)/.test(provedorDoAgente)
);
check(
  "…antes de pedir o token",
  provedorDoAgente.indexOf("adquireMicrofone") < provedorDoAgente.indexOf("conversation-token")
);
check(
  "…e desiste com uma frase para o cuidador quando não consegue",
  /if \(!concessao\) \{[\s\S]{0,220}?onError\([\s\S]{0,200}?return false/.test(provedorDoAgente)
);
check("a conversa de pé avança para AGENT_ACTIVE", /avancaMicrofone\(concessao, "AGENT_ACTIVE"\)/.test(provedorDoAgente));
check(
  "a devolução é derivada do estado real, não marcada em cada handler",
  /if \(agentActive\) return;[\s\S]{0,400}?liberaMicrofone\(concessao\)/.test(provedorDoAgente)
);
check(
  "a desmontagem também devolve",
  (provedorDoAgente.match(/liberaMicrofone\(concessao\)/g) ?? []).length >= 2
);
check(
  "o ditado em transcrição continua barrando a conexão",
  /if \(isDictationActive\(\)\)/.test(provedorDoAgente)
);
check(
  "o Agente NÃO derruba o ditado sozinho",
  !/stopAllDictation/.test(provedorDoAgente)
);

// ==========================================================================
secao("§19 · A Helo não fala dentro do microfone do cuidador");
// ==========================================================================

const coordenador = fonte("lib/audio-coordinator.ts");
const fala = fonte("lib/useSpeech.ts");

check(
  "capturando, a plataforma não começa a falar",
  /if \(isDictationCapturing\(\)\) return \{ ok: false, reason: "dictation_capturing" \}/.test(coordenador)
);
check(
  "a captura é distinguida da transcrição",
  /DICTATION_REQUESTING" \|\| dono === "DICTATION_LISTENING"/.test(coordenador)
);
check(
  "quem está soando é registrado por instância, não contado",
  /platformSpeakingTokens = new Set/.test(coordenador) && /setPlatformSpeaking/.test(coordenador)
);
check("…e a voz do paciente conta como som no ambiente", /patientVoiceActive \|\| platformSpeakingTokens\.size/.test(coordenador));
check("useSpeech alimenta esse registro no funil único", /setPlatformSpeaking\(tokenDeVoz\.current, v\)/.test(fala));
check(
  "a emergência do paciente ENCERRA o ditado em vez de tocar por cima",
  /stopAllDictation\(\);[\s\S]{0,60}stopAllPlatformAudio\(\)/.test(coordenador)
);
check(
  "com áudio da Helo tocando, o ditado não abre o microfone",
  /if \(isHeloAudioPlaying\(\)\)/.test(captacao) && /Espere o áudio da Helo terminar/.test(captacao)
);
check(
  "…e a fala em curso NÃO é interrompida para isso",
  !/stopAllPlatformAudio|stopAllSpeech/.test(captacao)
);
check(
  "com o Agente no microfone, a mensagem manda encerrar a conversa",
  /Encerre a conversa com a Helo antes de usar o ditado/.test(captacao)
);
check("nenhuma fala automática é enfileirada para depois", !/(fila|queue|enfileir)/i.test(coordenador));

// ==========================================================================
secao("§30 · A transcrição continua sem poder virar ação");
// ==========================================================================

check("a captura não fala", !/\bspeak\s*\(/.test(captacao));
check("a captura não conhece grant", !/SpeechGrant|speechGrant|grant/i.test(captacao));
check("a captura não chama client tool", !/clientTools|sendUserMessage|sendContextualUpdate/.test(captacao));
check("a captura não registra resposta do paciente", !/patientResponse|ConfirmedPatientStatement|confirmationStatus/.test(captacao));
check(
  "o coordenador arbitra dispositivo, não conteúdo",
  !/transcript/i.test(coordenador)
);
check("a posse não conhece paciente, sessão nem texto", !/(patient|session|transcript|texto)/i.test(fonte("lib/voice/mic-ownership.ts")));

// ==========================================================================
secao("§25 · O que o cuidador vê");
// ==========================================================================

const botao = fonte("components/voice/dictation-button.tsx");

check("o botão tem nome acessível", /aria-label=/.test(botao));
check("gravar é dito, não só desenhado", /Microfone aberto — gravando\./.test(botao));
check("a região viva é uma só, e é educada", (botao.match(/aria-live/g) ?? []).length === 1);
check("…e não é assertiva a ponto de interromper o leitor", !/aria-live="assertive"/.test(botao));
check("dá para descartar durante a transcrição", /ouvindo \|\| pedindo \|\| processando[\s\S]{0,400}?ditado\.cancela/.test(botao));
check(
  "o aviso sobrevive ao botão sumir",
  /if \(!ditado\.disponivel && !ditado\.aviso\) return null/.test(botao)
);
check(
  "nada técnico chega à tela",
  // `role="status"` é papel ARIA, não texto — sai antes da varredura, senão a
  // própria acessibilidade reprovaria a checagem de vocabulário.
  !/(HTTP|ZRM|Enterprise|enable_logging|MIME|ElevenLabs|feature flag|provedor)/i.test(
    botao.replace(/role="status"/g, "")
  )
);

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam`);
process.exit(failed === 0 ? 0 : 1);
