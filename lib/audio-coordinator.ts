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

/** Motivo pelo qual a fala da plataforma foi negada. */
export type PlatformSpeakDenyReason =
  | "patient_voice_active"
  | "agent_active"
  | "platform_muted";

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
  };
}
