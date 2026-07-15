"use client";

// ——— Estado central da experiência Helo ———
// Fonte única de verdade para: qual modo está ativo (orbe central),
// os metadados dos três modos e a voz global da Helo (uma só instância,
// que sobrevive a trocas de modo e, futuramente, de rota).
//
// Mapeamento da arquitetura conceitual → convenção do projeto:
//   HeloExperienceShell        → composição da Home (app/page.tsx)
//   OrbStage                   → components/orb-stage.tsx
//   VoiceExperienceController  → este provider (voz global via useSpeech)
//   ExperienceOverlay          → Fase 3 (overlays contextuais)

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useSpeech, type SpeakResult } from "@/lib/useSpeech";
import type { ActiveSpeaker, SpeakOptions, VoiceSource } from "@/lib/voice";
import type { OrbPalette } from "@/components/ui";

export type HeloMode = "conversar" | "rotina" | "emergencia" | "atividades" | "helo";

export interface HeloModeInfo {
  id: HeloMode;
  title: string;
  description: string;
  /** Paleta visual do orbe (cores do shader e do gradiente CSS). */
  palette: OrbPalette;
  /** Rota da experiência atual — vira overlay na Fase 3. */
  href: string;
  /** Fala de entrada do modo, quando a apresentação por voz estiver ativa. */
  spoken: string;
}

export const HELO_MODES: Record<HeloMode, HeloModeInfo> = {
  conversar: {
    id: "conversar",
    title: "Conversar",
    description: "Conversa guiada por voz e gestos, no ritmo do paciente.",
    palette: "coral",
    href: "/conversa",
    spoken: "Vamos conversar. Eu pergunto, você responde com um gesto.",
  },
  rotina: {
    id: "rotina",
    title: "Rotina",
    description: "Frases do dia a dia, prontas para usar. Funciona sem IA.",
    palette: "lilas",
    href: "/rotina",
    spoken: "Rotina: frases do dia a dia, prontas para usar.",
  },
  emergencia: {
    id: "emergencia",
    title: "Emergência",
    description: "Ajuda imediata, sempre disponível. Não depende de IA.",
    palette: "ambar",
    href: "/emergencia",
    spoken: "Emergência. Pedido de ajuda urgente do paciente.",
  },
  atividades: {
    id: "atividades",
    title: "Atividades",
    description:
      "Sessões personalizadas: memórias, reconhecimento, treino e exercícios.",
    palette: "ceu",
    href: "/atividades",
    spoken: "Atividades: experiências pensadas especialmente para você.",
  },
  helo: {
    id: "helo",
    title: "Helo",
    description: "Converse por voz com a inteligência conversacional da Helo.",
    palette: "coral",
    href: "/helo",
    // A saudação pertence ao Agent configurado na ElevenLabs, não ao cliente.
    spoken: "",
  },
};

// A ordem preserva o trio original nos mesmos lugares (slots ±1 do palco);
// o 4º modo entra no slot seguinte.
export const MODE_ORDER: HeloMode[] = [
  "rotina",
  "conversar",
  "emergencia",
  "atividades",
  "helo",
];

// Apresentação inicial da Helo — falada uma única vez, ao abrir o app
export const INTRO_SPEECH =
  "Olá! Eu sou a Helo — o elo entre sentir e dizer. Quando estiverem prontos, vamos conversar.";

interface HeloContextValue {
  activeMode: HeloMode;
  setActiveMode: (mode: HeloMode) => void;
  /** Entra na experiência do modo: apresenta por voz e transiciona — o palco persiste. */
  enterMode: (mode: HeloMode, opts?: { silent?: boolean }) => void;
  /**
   * Fala a apresentação inicial uma única vez por sessão. Chamadas
   * concorrentes/repetidas recebem a mesma promessa ("ignorada" após feita).
   * Se o navegador bloquear o autoplay, permite nova tentativa depois.
   */
  playIntro: () => Promise<SpeakResult | "ignorada">;
  modes: typeof HELO_MODES;
  // Orquestrador de voz global. Sem opções, a fala é da PLATAFORMA (voz
  // oficial ElevenLabs da Helo); com speakerRole "patient" + confirmação,
  // é do PACIENTE (voz clonada ElevenLabs dele).
  speak: (text: string, options?: SpeakOptions) => Promise<SpeakResult>;
  /** Pré-aquece o cache de áudio para frases conhecidas, na voz da autoria indicada. */
  prime: (texts: string[], options?: SpeakOptions) => Promise<void>;
  stop: () => void;
  speaking: boolean;
  engine: "elevenlabs" | "navegador";
  /** Quem fala agora — o Orb ativo reage a esta fala, seja de que papel for. */
  activeSpeaker: ActiveSpeaker;
  activeVoiceSource: VoiceSource;
  getAmplitude: () => number;
  /** Alimenta o palco com o áudio real do ElevenAgents enquanto a sessão vive. */
  setAgentAmplitude: (amplitude: number | null) => void;
}

const HeloContext = createContext<HeloContextValue | null>(null);

export function HeloProvider({ children }: { children: ReactNode }) {
  const [activeMode, setActiveModeState] = useState<HeloMode>("conversar");
  const { speak, stop, speaking, engine, activeSpeaker, activeVoiceSource, getAmplitude, prime } =
    useSpeech();
  const router = useRouter();

  // Espelho do modo ativo fora do estado React: o stop() precisa acontecer
  // exatamente uma vez por troca, e updaters de setState devem ser puros —
  // o React pode re-executá-los (StrictMode/render concorrente), e um stop()
  // repetido dentro do updater interrompia a fala recém-iniciada do modo novo.
  const activeModeRef = useRef<HeloMode>("conversar");
  const agentAmplitudeRef = useRef<number | null>(null);

  const setActiveMode = useCallback(
    (mode: HeloMode) => {
      if (activeModeRef.current === mode) return;
      activeModeRef.current = mode;
      stop(); // a fala do modo anterior não vaza para o novo
      setActiveModeState(mode);
    },
    [stop]
  );

  // Apresentação inicial: promessa compartilhada — StrictMode/remontagens
  // recebem a mesma execução; nenhum caminho dispara a fala duas vezes.
  const introDone = useRef(false);
  const introPromise = useRef<Promise<SpeakResult> | null>(null);

  const playIntro = useCallback((): Promise<SpeakResult | "ignorada"> => {
    if (introDone.current) return Promise.resolve("ignorada" as const);
    if (!introPromise.current) {
      introPromise.current = speak(INTRO_SPEECH).then((r) => {
        if (r === "bloqueada") {
          // Autoplay negado: a apresentação ainda não aconteceu — a primeira
          // interação válida do usuário poderá destravá-la ou avançar direto.
          introPromise.current = null;
        } else {
          introDone.current = true;
        }
        return r;
      });
    }
    return introPromise.current;
  }, [speak]);

  const enterMode = useCallback(
    (mode: HeloMode, opts?: { silent?: boolean }) => {
      introDone.current = true; // entrar em qualquer modo supera a apresentação
      setActiveMode(mode);
      // A Helo se apresenta e a experiência abre em seguida — a voz atravessa
      // a transição porque o provider (e o palco) nunca desmontam.
      // Emergência também anuncia (voz da plataforma): identifica o pedido de
      // socorro em voz alta. Não atrasa o socorro — os botões da página já
      // estão ativos, e qualquer toque numa frase chama stop() e interrompe o
      // anúncio na hora (ver speak() em useSpeech).
      if (opts?.silent || mode === "helo") stop();
      else void speak(HELO_MODES[mode].spoken);
      router.push(HELO_MODES[mode].href);
    },
    [setActiveMode, speak, stop, router]
  );

  const setAgentAmplitude = useCallback((amplitude: number | null) => {
    agentAmplitudeRef.current = amplitude;
  }, []);

  const getStageAmplitude = useCallback(() => {
    return agentAmplitudeRef.current ?? getAmplitude();
  }, [getAmplitude]);

  const value = useMemo<HeloContextValue>(
    () => ({
      activeMode,
      setActiveMode,
      enterMode,
      playIntro,
      modes: HELO_MODES,
      speak,
      prime,
      stop,
      speaking,
      engine,
      activeSpeaker,
      activeVoiceSource,
      getAmplitude: getStageAmplitude,
      setAgentAmplitude,
    }),
    [activeMode, setActiveMode, enterMode, playIntro, speak, prime, stop, speaking, engine, activeSpeaker, activeVoiceSource, getStageAmplitude, setAgentAmplitude]
  );

  return <HeloContext.Provider value={value}>{children}</HeloContext.Provider>;
}

export function useHelo(): HeloContextValue {
  const ctx = useContext(HeloContext);
  if (!ctx) throw new Error("useHelo precisa estar dentro de <HeloProvider>");
  return ctx;
}
