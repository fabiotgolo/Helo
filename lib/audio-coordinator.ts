"use client";

// ——— Gerenciador global de áudio da plataforma Helo (HeloAudioManager) ———
// Ponto ÚNICO que decide se a voz automática da plataforma pode soar. Toda
// fala da plataforma passa pelo gate deste módulo (via useSpeech.speak) — nada
// toca por fora dele.
//
// Hierarquia de prioridade de voz (a regra central da Helo):
//   1. voz clonada do PACIENTE  (patientVoiceActive) — prioridade MÁXIMA;
//   2. voz do AGENTE Helo       (agentConversationActive);
//   3. voz da PLATAFORMA        (fala assistente da interface).
// Ninguém fala por cima de quem está acima. A voz do paciente interrompe e
// suprime o Agente e a plataforma; o Agente suprime a plataforma; a plataforma
// nunca sobrepõe ninguém.
//
// Travas globais, em nível de módulo (mesmo padrão de activeStops):
//   patientVoiceActive      → uma frase de emergência do paciente está soando
//                             (ou prestes a soar). Enquanto durar, interrompe a
//                             plataforma e suprime a voz do Agente, bloqueando
//                             ambas até terminar.
//   agentConversationActive → o Agente Helo (ElevenLabs) está em conversa e
//                             tem prioridade sobre a plataforma; nenhuma fala
//                             automática da plataforma pode iniciar por cima.
//   platformMuted           → o usuário mutou a voz da plataforma pelo ícone
//                             de alto-falante; preferência persistida.
//
// Regra central: se a voz do paciente estiver ativa, OU o Agente estiver ativo,
// OU a plataforma estiver mutada, a plataforma fica silenciosa. A frase de
// emergência do paciente é a exceção — ela atravessa (priority "patientEmergency")
// e assume o áudio. Falas bloqueadas são DESCARTADAS — nunca enfileiradas para
// tocar retroativamente.
//
// O Agente Helo NÃO passa por aqui: seu áudio vem do SDK da ElevenLabs. O mute
// muta a plataforma, não o microfone/conversa do Agente.

import { useEffect, useSyncExternalStore } from "react";
import {
  adquireMicrofone,
  assinaMicrofone,
  ditadoDetemMicrofone,
  donoDoMicrofone,
  liberaMicrofone,
} from "@/lib/voice/mic-ownership";

/** Motivo pelo qual a fala da plataforma foi negada. */
export type PlatformSpeakDenyReason =
  | "patient_voice_active"
  | "agent_active"
  | "platform_muted"
  /** O cuidador está com o microfone aberto: falar agora seria falar no ditado. */
  | "dictation_capturing";

export type PlatformSpeakGate =
  | { ok: true }
  | { ok: false; reason: PlatformSpeakDenyReason };

// Preferência do USUÁRIO (não do paciente): persiste no localStorage.
const MUTE_STORAGE_KEY = "heloPlatformMuted";

const state = {
  // Prioridade MÁXIMA: uma frase de emergência do paciente assumiu o áudio.
  // Enquanto ativa, a plataforma é interrompida e a voz do Agente é suprimida.
  patientVoiceActive: false,
  agentConversationActive: false,
  // O Agente está efetivamente FALANDO agora (não só conectado). Mantido para
  // diagnóstico/telemetria do orbe — não gateia mais a emergência.
  agentSpeaking: false,
  platformMuted: false,
  // Só lê o localStorage uma vez, do lado do cliente, para não divergir entre
  // SSR e hidratação (o servidor sempre renderiza "não mutado").
  hydrated: false,
};

const listeners = new Set<() => void>();
// Cada instância de useSpeech registra seu stop aqui: mutar ou ativar o Agente
// precisa silenciar QUALQUER voz em curso, em qualquer árvore React.
const platformStops = new Set<() => void>();
// O provider do Agente Helo registra aqui como suprimir/restaurar a voz do
// Agente (zerar/retomar o volume de saída do SDK). A voz clonada do paciente,
// prioridade máxima, aciona isso ao assumir o áudio — o Agente nunca soa por
// cima dela.
const agentSuppressors = new Set<(suppress: boolean) => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Assina mudanças das travas globais (usado pelo hook React). */
export function subscribeAudioCoordinator(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Registra o stop de uma instância de voz enquanto ela viver. */
export function registerPlatformStop(stop: () => void): () => void {
  platformStops.add(stop);
  return () => {
    platformStops.delete(stop);
  };
}

/** Interrompe toda fala da plataforma em curso, em qualquer instância. */
export function stopAllPlatformAudio(): void {
  console.log("[HELO AUDIO] platform audio stopped");
  for (const stop of platformStops) stop();
}

// ——— Quem está SOANDO agora (Fase 5.2B) ———
//
// Saber que existem instâncias de voz montadas nunca disse nada sobre haver som
// no ambiente, e o ditado precisa exatamente disso: abrir o microfone enquanto
// a Helo fala é gravar a Helo. O caso que dói é o terceiro — a voz clonada do
// paciente tocando enquanto o cuidador começa a ditar — porque o transcript
// sairia com a fala do PACIENTE dentro dele, num campo que o cuidador vai
// revisar como se fosse coisa que ele mesmo disse.
//
// Um Set de instâncias, e não um contador: um `stop()` chamado duas vezes
// deixaria um contador preso em 1 para sempre, e o ditado nunca mais abriria.

const platformSpeakingTokens = new Set<object>();

/** Uma instância de voz começou (ou parou) de reproduzir. Idempotente. */
export function setPlatformSpeaking(token: object, speaking: boolean): void {
  const antes = platformSpeakingTokens.size;
  if (speaking) platformSpeakingTokens.add(token);
  else platformSpeakingTokens.delete(token);
  if (platformSpeakingTokens.size !== antes) emit();
}

/** Alguma voz controlada pelo Helo está soando — plataforma ou paciente. */
export function isHeloAudioPlaying(): boolean {
  return state.patientVoiceActive || platformSpeakingTokens.size > 0;
}

// ——— Liberação do áudio guardado (Fase 5.1B, R-06) ———
//
// Parar é uma coisa; LIBERAR é outra, e faltava a segunda. Um `stop()` apenas
// pausa a reprodução — os Blobs sintetizados continuam presos na memória da
// aba pelos ObjectURLs que os apontam. Dois momentos exigem soltá-los, e
// nenhum deles é uma pausa:
//
//   "todos"     → logout. Nada do usuário anterior sobrevive, incluindo o
//                 áudio da voz clonada de um paciente.
//   "pacientes" → troca de paciente ativo. O áudio da plataforma é de
//                 ninguém em particular e fica; o de paciente sai.
//
// Mesmo padrão de `platformStops`: em nível de módulo, para alcançar qualquer
// instância de voz em qualquer árvore React — quem faz logout não sabe (nem
// deveria saber) quantos `useSpeech` existem montados.

export type EscopoLiberacaoAudio = "todos" | "pacientes";

const platformAudioPurges = new Set<(escopo: EscopoLiberacaoAudio) => void>();

/** Registra como liberar o áudio guardado de uma instância de voz. */
export function registerPlatformAudioPurge(
  purge: (escopo: EscopoLiberacaoAudio) => void
): () => void {
  platformAudioPurges.add(purge);
  return () => {
    platformAudioPurges.delete(purge);
  };
}

/** Libera os ObjectURLs guardados, em qualquer instância de voz. */
export function purgePlatformAudio(escopo: EscopoLiberacaoAudio): void {
  console.log("[HELO AUDIO] released cached audio:", escopo);
  for (const purge of platformAudioPurges) purge(escopo);
}

// ——— Ditado do cuidador (Fase 5.2A, endurecido na 5.2B) ———
//
// O microfone tem um dono de cada vez. O Agente Helo abre um stream WebRTC e o
// mantém aberto pela conversa inteira; o ditado abre um stream curto e o fecha.
// Dois donos ao mesmo tempo não é só desperdício: em boa parte dos aparelhos o
// segundo `getUserMedia` reconfigura o dispositivo, e quem perde é a captura
// que já estava em curso — a do Agente, no meio de uma frase do paciente.
//
// A 5.2A arbitrava com dois booleans consultados de longe. A 5.2B substituiu
// isso por uma posse tomada de forma indivisível, com identidade, em
// `lib/voice/mic-ownership.ts` — o motivo está escrito lá. O que sobra aqui é o
// que sempre foi deste módulo: alcançar QUALQUER captura montada, em qualquer
// árvore React, para encerrá-la de fora (logout, troca de paciente, emergência).
//
// O transcript NÃO passa por aqui. Este módulo arbitra dispositivo, não
// conteúdo — e o texto do ditado nunca chega perto da conversa do Agente.

// A posse muda fora do React; a interface precisa saber. Uma assinatura só,
// no nível do módulo, repassando para quem já ouvia este coordenador.
assinaMicrofone(emit);

const dictationStops = new Set<() => void>();

/** Registra como abortar a captura de uma instância de ditado. */
export function registerDictationStop(stop: () => void): () => void {
  dictationStops.add(stop);
  return () => {
    dictationStops.delete(stop);
  };
}

/**
 * Encerra qualquer captura de ditado em curso, em qualquer árvore React.
 * Chamado no logout e na troca de paciente: um microfone aberto não pode
 * atravessar a fronteira de nenhum dos dois.
 */
export function stopAllDictation(): void {
  if (dictationStops.size > 0) console.log("[HELO AUDIO] dictation stopped");
  for (const stop of dictationStops) stop();
}

/**
 * O ditado detém o microfone — inclusive durante a transcrição, quando o
 * dispositivo já fechou mas uma resposta ainda pode voltar e escrever no campo.
 * Derivado da posse; não existe mais um boolean que alguém possa desligar.
 */
export function isDictationActive(): boolean {
  return ditadoDetemMicrofone();
}

/**
 * O microfone está FISICAMENTE aberto para o ditado.
 *
 * Distinto do anterior de propósito: durante a transcrição a captura já
 * terminou, e é seguro voltar a tocar áudio — o que não é seguro é o Agente
 * entrar, porque a resposta pendente ainda mexe na tela.
 */
export function isDictationCapturing(): boolean {
  const dono = donoDoMicrofone();
  return dono === "DICTATION_REQUESTING" || dono === "DICTATION_LISTENING";
}

export function isPlatformMuted(): boolean {
  return state.platformMuted;
}

export function isAgentConversationActive(): boolean {
  return state.agentConversationActive;
}

export function isAgentSpeaking(): boolean {
  return state.agentSpeaking;
}

export function isPatientVoiceActive(): boolean {
  return state.patientVoiceActive;
}

/**
 * O Agente está falando neste instante. Dirigido pelo provider do Agente a
 * partir do `isSpeaking` do SDK. Não gateia nada — apenas alimenta o orbe e a
 * telemetria com o momento em que o Agente tem voz.
 */
export function setAgentSpeaking(speaking: boolean): void {
  if (state.agentSpeaking === speaking) return;
  state.agentSpeaking = speaking;
  emit();
}

/**
 * O provider do Agente registra aqui como silenciar/restaurar a própria voz.
 * `suppress(true)` deve zerar o volume de saída do SDK; `suppress(false)`
 * restaura. Registrado enquanto o provider viver.
 */
export function registerAgentSuppressor(
  suppress: (suppress: boolean) => void
): () => void {
  agentSuppressors.add(suppress);
  return () => {
    agentSuppressors.delete(suppress);
  };
}

/**
 * A voz clonada do paciente (prioridade MÁXIMA) assume o áudio. Interrompe na
 * hora a voz da plataforma e suprime a voz do Agente Helo, bloqueando ambas até
 * endPatientVoiceOverride(). Não espera brecha — a emergência nunca fica presa
 * aguardando o Agente. Idempotente.
 */
export function beginPatientVoiceOverride(): void {
  if (state.patientVoiceActive) return;
  state.patientVoiceActive = true;
  console.log("[HELO AUDIO] priority requested: patient_emergency_phrase");
  console.log("[HELO AUDIO] stopping lower priority audio");
  // A emergência não espera, e não fica esperando o ditado terminar. Ela
  // ENCERRA a captura — que é o oposto de tocar por cima dela: o áudio
  // gravado até aqui é descartado e nada é enviado, em vez de a voz do
  // paciente entrar no transcript do cuidador. Um botão de emergência que
  // pudesse ser bloqueado por um campo de texto não seria um botão de
  // emergência.
  stopAllDictation();
  stopAllPlatformAudio();
  console.log("[HELO AUDIO] suppressing agent speech");
  for (const suppress of agentSuppressors) suppress(true);
  emit();
}

/**
 * Encerra a prioridade da voz do paciente e restaura a voz do Agente. A
 * plataforma volta a poder falar conforme as demais travas (Agente/mute).
 */
export function endPatientVoiceOverride(): void {
  if (!state.patientVoiceActive) return;
  state.patientVoiceActive = false;
  console.log("[HELO AUDIO] patient cloned voice ended");
  for (const suppress of agentSuppressors) suppress(false);
  emit();
}

/**
 * Gate obrigatório: validar ANTES de qualquer mecanismo de voz (ElevenLabs ou
 * fallback speechSynthesis). Hierarquia: voz do paciente > Agente > plataforma;
 * o mute é aplicado à parte (em useSpeech), vencendo até a emergência.
 */
export function canPlatformSpeak(): PlatformSpeakGate {
  if (state.patientVoiceActive) return { ok: false, reason: "patient_voice_active" };
  if (state.agentConversationActive) return { ok: false, reason: "agent_active" };
  // Microfone do cuidador aberto: a fala da plataforma seria captada e entraria
  // no transcript como se ele a tivesse dito. Descartada, nunca enfileirada —
  // uma fala automática que "espera a vez" chega quando ninguém mais espera
  // por ela (mesma regra das demais negativas deste gate).
  if (isDictationCapturing()) return { ok: false, reason: "dictation_capturing" };
  if (state.platformMuted) return { ok: false, reason: "platform_muted" };
  return { ok: true };
}

/**
 * Liga/desliga a prioridade do Agente Helo. Ao ativar, interrompe na hora
 * qualquer voz da plataforma em curso (o Agente não fala por cima de ninguém,
 * e ninguém fala por cima dele).
 */
export function setAgentConversationActive(active: boolean): void {
  if (state.agentConversationActive === active) return;
  state.agentConversationActive = active;
  // Encerrou a conversa: o Agente não fala mais — libera qualquer espera de
  // brecha em curso.
  if (!active) state.agentSpeaking = false;
  console.log(
    active
      ? "[HELO AUDIO] agent conversation active"
      : "[HELO AUDIO] agent conversation ended"
  );
  if (active) stopAllPlatformAudio();
  emit();
}

function persistMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_STORAGE_KEY, muted ? "true" : "false");
  } catch {
    // localStorage indisponível (modo privado, cota): o estado em memória
    // ainda vale para esta sessão.
  }
}

/**
 * Muta/desmuta a voz da plataforma. Ao mutar, interrompe a fala em curso.
 * A preferência é persistida (sobrevive ao refresh).
 */
export function setPlatformMuted(muted: boolean): void {
  if (state.platformMuted === muted) {
    persistMuted(muted);
    return;
  }
  state.platformMuted = muted;
  console.log(muted ? "[HELO AUDIO] platform muted true" : "[HELO AUDIO] platform muted false");
  if (muted) stopAllPlatformAudio();
  persistMuted(muted);
  emit();
}

/**
 * Carrega a preferência de mute do localStorage — uma única vez, no cliente.
 * Chamado pelo hook após a montagem para não causar mismatch de hidratação.
 */
export function hydratePlatformMuted(): void {
  if (state.hydrated) return;
  state.hydrated = true;
  try {
    if (localStorage.getItem(MUTE_STORAGE_KEY) === "true" && !state.platformMuted) {
      state.platformMuted = true;
      emit();
    }
  } catch {
    // Sem localStorage: mantém o padrão (não mutado).
  }
}

/**
 * Estado reativo do gerenciador para a interface (ícone de mute, avisos).
 * Não expõe os setters de agente — esses pertencem ao provider do Agente.
 */
export function useAudioCoordinator(): {
  platformMuted: boolean;
  agentActive: boolean;
  setPlatformMuted: (muted: boolean) => void;
  togglePlatformMuted: () => void;
} {
  const platformMuted = useSyncExternalStore(
    subscribeAudioCoordinator,
    () => state.platformMuted,
    () => false
  );
  const agentActive = useSyncExternalStore(
    subscribeAudioCoordinator,
    () => state.agentConversationActive,
    () => false
  );

  useEffect(() => {
    hydratePlatformMuted();
  }, []);

  return {
    platformMuted,
    agentActive,
    setPlatformMuted,
    togglePlatformMuted: () => setPlatformMuted(!state.platformMuted),
  };
}

// Inspeção/estímulo SOMENTE em desenvolvimento (mesmo padrão de __heloUIActions):
// permite validar a prioridade do Agente e a brecha da emergência sem uma
// sessão real da ElevenLabs. Nunca existe em produção.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__heloAudio = {
    state: () => ({ ...state }),
    canPlatformSpeak,
    setAgentConversationActive,
    setAgentSpeaking,
    setPlatformMuted,
    beginPatientVoiceOverride,
    endPatientVoiceOverride,
    isPatientVoiceActive,
    isDictationActive,
    isDictationCapturing,
    isHeloAudioPlaying,
    stopAllDictation,
    // A posse do microfone, para os testes de navegador poderem encená-la sem
    // uma sessão real da ElevenLabs: tomar como se o Agente estivesse
    // conectando, e devolver depois. Só em desenvolvimento, como todo o resto
    // deste objeto.
    donoDoMicrofone,
    adquireMicrofone,
    liberaMicrofone,
    setPlatformSpeaking,
  };
}
