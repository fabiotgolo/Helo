"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Voz do Helo: tenta ElevenLabs via /api/tts; sem chave ou em caso de
// falha, cai para a voz local do navegador em pt-BR. Áudios já gerados
// ficam em cache para repetição instantânea ("Repita, por favor").
export function useSpeech() {
  const [speaking, setSpeaking] = useState(false);
  const [engine, setEngine] = useState<"elevenlabs" | "navegador">("navegador");
  const cache = useRef<Map<string, string>>(new Map());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const elevenAvailable = useRef<boolean | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  useEffect(() => stop, [stop]);

  const speakBrowser = useCallback((text: string) => {
    return new Promise<void>((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "pt-BR";
      u.rate = 0.92;
      const voice = synth
        .getVoices()
        .find((v) => v.lang.startsWith("pt-BR") || v.lang.startsWith("pt"));
      if (voice) u.voice = voice;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      synth.speak(u);
    });
  }, []);

  const speak = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      stop();
      setSpeaking(true);
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
        if (url) {
          setEngine("elevenlabs");
          await new Promise<void>((resolve) => {
            const audio = new Audio(url);
            audioRef.current = audio;
            audio.onended = () => resolve();
            audio.onerror = () => resolve();
            audio.play().catch(() => resolve());
          });
        } else {
          setEngine("navegador");
          await speakBrowser(text);
        }
      } finally {
        setSpeaking(false);
      }
    },
    [stop, speakBrowser]
  );

  return { speak, stop, speaking, engine };
}
