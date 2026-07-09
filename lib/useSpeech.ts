"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Desfecho real de uma fala, derivado dos eventos de reprodução — nunca de
// timers estimados. "bloqueada" = política de autoplay do navegador negou
// a reprodução sem gesto do usuário (não é erro; tentar após interação).
export type SpeakResult = "concluida" | "interrompida" | "bloqueada" | "erro";

// Voz do Helo: tenta ElevenLabs via /api/tts; sem chave ou em caso de
// falha, cai para a voz local do navegador em pt-BR. Áudios já gerados
// ficam em cache para repetição instantânea ("Repita, por favor").
//
// Expõe também getAmplitude(): volume instantâneo 0–1 da fala em curso,
// para o orbe reagir à voz. Com ElevenLabs a medição é real (AnalyserNode);
// com a voz do navegador (sem acesso à forma de onda) é um pulso sintético.
export function useSpeech() {
  const [speaking, setSpeaking] = useState(false);
  const [engine, setEngine] = useState<"elevenlabs" | "navegador">("navegador");
  const cache = useRef<Map<string, string>>(new Map());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const elevenAvailable = useRef<boolean | null>(null);
  const speakingRef = useRef(false);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserData = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  // Resolve a fala em curso exatamente uma vez — stop() interrompe de forma
  // determinística e eventos atrasados/duplicados são ignorados.
  const settleRef = useRef<((r: SpeakResult) => void) | null>(null);
  // Geração da fala: stop() invalida falas ainda em preparação (ex.: durante
  // o fetch do TTS), para o áudio não começar depois de interrompido.
  const genRef = useRef(0);

  const setSpeakingBoth = useCallback((v: boolean) => {
    speakingRef.current = v;
    setSpeaking(v);
  }, []);

  // Elemento único, reutilizado em todas as falas — permite ligar o
  // AnalyserNode uma só vez (createMediaElementSource é irrevogável).
  const ensureAudio = useCallback(() => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio();
      audioRef.current = audio;
      try {
        const ctx = new AudioContext();
        const source = ctx.createMediaElementSource(audio);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyser.connect(ctx.destination);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        analyserData.current = new Uint8Array(analyser.fftSize);
      } catch {
        // Sem Web Audio, o áudio toca direto e a amplitude vira pulso sintético
      }
    }
    if (audioCtxRef.current?.state === "suspended") {
      void audioCtxRef.current.resume();
    }
    return audio;
  }, []);

  const stop = useCallback(() => {
    genRef.current++;
    settleRef.current?.("interrompida");
    settleRef.current = null;
    audioRef.current?.pause();
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    setSpeakingBoth(false);
  }, [setSpeakingBoth]);

  useEffect(() => stop, [stop]);

  const speakBrowser = useCallback((text: string) => {
    return new Promise<SpeakResult>((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth) return resolve("erro");
      let settled = false;
      const settle = (r: SpeakResult) => {
        if (settled) return; // eventos duplicados são ignorados
        settled = true;
        if (settleRef.current === settle) settleRef.current = null;
        resolve(r);
      };
      settleRef.current = settle;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "pt-BR";
      u.rate = 0.92;
      const voice = synth
        .getVoices()
        .find((v) => v.lang.startsWith("pt-BR") || v.lang.startsWith("pt"));
      if (voice) u.voice = voice;
      u.onend = () => settle("concluida");
      u.onerror = (e) => {
        if (e.error === "not-allowed") settle("bloqueada");
        else if (e.error === "interrupted" || e.error === "canceled") settle("interrompida");
        else settle("erro");
      };
      synth.speak(u);
    });
  }, []);

  const speak = useCallback(
    async (text: string): Promise<SpeakResult> => {
      if (!text.trim()) return "concluida";
      stop();
      const gen = ++genRef.current;
      setSpeakingBoth(true);
      try {
        let url = cache.current.get(text);
        if (!url && elevenAvailable.current !== false) {
          const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          });
          if (res.ok) {
            elevenAvailable.current = true;
            const blob = await res.blob();
            url = URL.createObjectURL(blob);
            cache.current.set(text, url);
          } else if (res.status === 503) {
            elevenAvailable.current = false;
          }
        }
        // stop() chegou enquanto o áudio ainda era preparado — não toca
        if (genRef.current !== gen) return "interrompida";
        if (url) {
          setEngine("elevenlabs");
          return await new Promise<SpeakResult>((resolve) => {
            const audio = ensureAudio();
            let settled = false;
            const settle = (r: SpeakResult) => {
              if (settled) return; // eventos duplicados são ignorados
              settled = true;
              if (settleRef.current === settle) settleRef.current = null;
              resolve(r);
            };
            settleRef.current = settle;
            audio.src = url;
            audio.onended = () => settle("concluida");
            audio.onpause = () => {
              // Evento de pausa atrasado de uma fala anterior: ignora
              if (!audio.paused) return;
              settle(audio.ended ? "concluida" : "interrompida");
            };
            audio.onerror = () => settle("erro");
            audio.play().catch((err: unknown) => {
              // Autoplay negado pelo navegador — não é falha, é política
              const name = err instanceof DOMException ? err.name : "";
              settle(name === "NotAllowedError" ? "bloqueada" : "erro");
            });
          });
        }
        setEngine("navegador");
        return await speakBrowser(text);
      } finally {
        // Só a fala mais recente encerra o estado — uma fala antiga
        // interrompida não desliga o "speaking" da que a substituiu
        if (genRef.current === gen) setSpeakingBoth(false);
      }
    },
    [stop, speakBrowser, ensureAudio, setSpeakingBoth]
  );

  // Chamado a cada frame pelo orbe — usa refs, nunca estado React.
  const getAmplitude = useCallback((): number => {
    if (!speakingRef.current) return 0;
    const analyser = analyserRef.current;
    const data = analyserData.current;
    if (analyser && data && audioRef.current && !audioRef.current.paused) {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / data.length) * 3);
    }
    // Voz do navegador: pulso suave e regular enquanto fala
    return 0.3 + 0.2 * Math.sin(performance.now() / 180);
  }, []);

  return { speak, stop, speaking, engine, getAmplitude };
}
