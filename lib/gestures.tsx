"use client";

// Emojis dos gestos configuráveis POR PACIENTE. Os rótulos (Sim/Talvez/Não)
// e o significado são fixos — só o símbolo visual muda, para adaptar à
// capacidade motora de cada paciente (ex.: ✊ no lugar de 👎).
//
// A fonte é o settings do paciente ativo (via PatientProvider), com espelho
// em localStorage — os gestos certos aparecem mesmo sem rede.
import { GESTURES, type Gesture } from "@/lib/types";
import { usePatient } from "@/lib/patient";

export type GestureInfo = { emoji: string; label: string; hint: string };
export type GestureMap = Record<Gesture, GestureInfo>;
export type GestureSemanticIntent = "confirm" | "reformulate" | "reject";

// O contrato conversacional é estável e independente do emoji escolhido pelo
// paciente. O Agent recebe esta intenção, nunca precisa inferi-la do símbolo.
export const GESTURE_SEMANTIC_INTENTS: Record<Gesture, GestureSemanticIntent> = {
  sim: "confirm",
  talvez: "reformulate",
  nao: "reject",
};

export const GESTURE_SEMANTIC_MESSAGES: Record<Gesture, string> = {
  sim:
    "Resposta observada do paciente por gesto: intenção semântica confirm. O paciente confirmou positivamente a pergunta ou proposta atual. Esta resposta foi registrada por um cuidador ou profissional na interface.",
  talvez:
    "Resposta observada do paciente por gesto: intenção semântica reformulate. O paciente indicou que não é bem assim e solicita reformulação, esclarecimento ou outra alternativa para a pergunta ou proposta atual. Esta resposta foi registrada por um cuidador ou profissional na interface.",
  nao:
    "Resposta observada do paciente por gesto: intenção semântica reject. O paciente rejeitou a pergunta ou proposta atual e não confirmou nem autorizou prosseguir. Esta resposta foi registrada por um cuidador ou profissional na interface.",
};

// Chaves usadas no settings do paciente (patients/{id}/settings).
export const GESTURE_EMOJI_KEYS: Record<Gesture, string> = {
  sim: "gesture_sim_emoji",
  talvez: "gesture_talvez_emoji",
  nao: "gesture_nao_emoji",
};

export function mergeEmojis(settings: Record<string, string>): GestureMap {
  const out = {} as GestureMap;
  (Object.keys(GESTURES) as Gesture[]).forEach((g) => {
    const custom = settings[GESTURE_EMOJI_KEYS[g]]?.trim();
    out[g] = { ...GESTURES[g], emoji: custom || GESTURES[g].emoji };
  });
  return out;
}

// Emojis resolvidos (padrão + configuração do paciente ativo).
export function useGestures(): GestureMap {
  const { settings } = usePatient();
  return mergeEmojis(settings);
}
