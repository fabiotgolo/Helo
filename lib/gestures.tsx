"use client";

// Emojis dos gestos configuráveis por paciente. Os rótulos (Sim/Talvez/Não)
// e o significado são fixos — só o símbolo visual muda, para adaptar à
// capacidade motora de cada paciente (ex.: ✊ no lugar de 👎).
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { GESTURES, type Gesture } from "@/lib/types";

export type GestureInfo = { emoji: string; label: string; hint: string };
type GestureMap = Record<Gesture, GestureInfo>;

// Chaves usadas na coleção settings do Firestore.
export const GESTURE_EMOJI_KEYS: Record<Gesture, string> = {
  sim: "gesture_sim_emoji",
  talvez: "gesture_talvez_emoji",
  nao: "gesture_nao_emoji",
};

function mergeEmojis(settings: Record<string, string>): GestureMap {
  const out = {} as GestureMap;
  (Object.keys(GESTURES) as Gesture[]).forEach((g) => {
    const custom = settings[GESTURE_EMOJI_KEYS[g]]?.trim();
    out[g] = { ...GESTURES[g], emoji: custom || GESTURES[g].emoji };
  });
  return out;
}

const GestureContext = createContext<GestureMap>(GESTURES);

// Disparado pela tela de Ajustes ao salvar, para o provider recarregar os
// emojis na hora (o provider vive no layout raiz e não remonta ao navegar).
export const GESTURES_UPDATED_EVENT = "helo:gestures-updated";

export function GestureProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<GestureMap>(GESTURES);
  useEffect(() => {
    const load = () =>
      fetch("/api/settings")
        .then((r) => r.json())
        .then((s: Record<string, string>) => setMap(mergeEmojis(s)))
        .catch(() => {});
    void load();
    const onUpdate = () => void load();
    window.addEventListener(GESTURES_UPDATED_EVENT, onUpdate);
    return () => window.removeEventListener(GESTURES_UPDATED_EVENT, onUpdate);
  }, []);
  return (
    <GestureContext.Provider value={map}>{children}</GestureContext.Provider>
  );
}

// Emojis resolvidos (padrão + override do paciente). Fora do provider,
// devolve os padrões — nada quebra.
export function useGestures(): GestureMap {
  return useContext(GestureContext);
}
