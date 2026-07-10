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
      let watchdog = 0;
      const settle = (r: SpeakResult) => {
        if (settled) return; // eventos duplicados são ignorados
        settled = true;
        window.clearTimeout(watchdog);
        if (settleRef.current === settle) settleRef.current = null;
        resolve(r);
      };
      // A síntese também pode nunca começar (aba oculta, voz indisponível):
      // sem início em 3s, resolve como erro — a interface mostra o aviso.
      watchdog = window.setTimeout(() => {
        console.error("[EMERGENCY ERROR] speechSynthesis não iniciou em 3s — abortando");
        settle("erro");
        synth.cancel();
      }, 3000);
      settleRef.current = settle;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "pt-BR";
      u.rate = 0.92;
      const voice = synth
        .getVoices()
        .find((v) => v.lang.startsWith("pt-BR") || v.lang.startsWith("pt"));
      if (voice) u.voice = voice;
      console.log("[EMERGENCY] voz do navegador — voz selecionada:", voice?.name ?? "(padrão do sistema)");
      u.onstart = () => {
        console.log("[EMERGENCY] playback started (navegador)");
        window.clearTimeout(watchdog);
      };
      u.onend = () => {
        console.log("[EMERGENCY] playback ended (navegador)");
        settle("concluida");
      };
      u.onerror = (e) => {
        console.error("[EMERGENCY ERROR] speechSynthesis:", e.error);
        if (e.error === "not-allowed") settle("bloqueada");
        else if (e.error === "interrupted" || e.error === "canceled") settle("interrompida");
        else settle("erro");
      };
      console.log("[EMERGENCY] speechSynthesis.speak chamado");
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
        console.log("[EMERGENCY] cache lookup:", url ? "HIT" : "MISS");
        if (!url && elevenAvailable.current !== false) {
          try {
            console.log("[EMERGENCY] TTS request started");
            const res = await fetch("/api/tts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text }),
            });
            console.log("[EMERGENCY] TTS response received:", res.status);
            if (res.ok) {
              elevenAvailable.current = true;
              const blob = await res.blob();
              url = URL.createObjectURL(blob);
              cache.current.set(text, url);
            } else if (res.status === 503) {
              elevenAvailable.current = false;
            }
          } catch (err) {
            // Rede indisponível: a fala não pode falhar — segue para a
            // voz local do navegador, que funciona offline.
            console.error("[EMERGENCY ERROR] TTS fetch:", (err as Error)?.message ?? err);
          }
        }
        // stop() chegou enquanto o áudio ainda era preparado — não toca
        if (genRef.current !== gen) {
          console.warn("[EMERGENCY] interrompida antes de tocar (stop durante preparação)");
          return "interrompida";
        }
        if (url) {
          setEngine("elevenlabs");
          const audio = ensureAudio();
          console.log("[EMERGENCY] audio object created; AudioContext:", audioCtxRef.current?.state ?? "sem Web Audio");
          // AudioContext suspenso = play() "funciona" mas SEM som — o áudio
          // é roteado por ele. Retomar antes de tocar; num toque real há
          // gesto do usuário, então o resume é permitido.
          if (audioCtxRef.current && audioCtxRef.current.state !== "running") {
            try {
              await audioCtxRef.current.resume();
              console.log("[EMERGENCY] AudioContext retomado:", audioCtxRef.current.state);
            } catch (err) {
              console.error("[EMERGENCY ERROR] AudioContext resume:", (err as Error)?.message ?? err);
            }
          }
          if (genRef.current !== gen) {
            console.warn("[EMERGENCY] interrompida durante resume do AudioContext");
            return "interrompida";
          }
          const r = await new Promise<SpeakResult>((resolve) => {
            let settled = false;
            let watchdog = 0;
            const settle = (r: SpeakResult) => {
              if (settled) return; // eventos duplicados são ignorados
              settled = true;
              window.clearTimeout(watchdog);
              if (settleRef.current === settle) settleRef.current = null;
              resolve(r);
            };
            // Watchdog: play() pode ficar PENDENTE para sempre sem erro
            // (ex.: aba oculta — o Chrome adia o carregamento de mídia).
            // Se a reprodução não COMEÇAR em 2,5s, aborta e cai no fallback.
            watchdog = window.setTimeout(() => {
              console.error("[EMERGENCY ERROR] playback não iniciou em 2.5s (readyState:", audio.readyState + ") — abortando");
              settle("erro");
              audio.pause();
            }, 2500);
            settleRef.current = settle;
            audio.src = url;
            audio.muted = false;
            audio.volume = 1;
            audio.onplaying = () => {
              console.log("[EMERGENCY] playback started");
              window.clearTimeout(watchdog);
            };
            audio.onended = () => {
              console.log("[EMERGENCY] playback ended");
              settle("concluida");
            };
            audio.onpause = () => {
              // Evento de pausa atrasado de uma fala anterior: ignora
              if (!audio.paused) return;
              settle(audio.ended ? "concluida" : "interrompida");
            };
            audio.onerror = () => {
              console.error("[EMERGENCY ERROR] elemento de áudio:", audio.error?.code, audio.error?.message);
              settle("erro");
            };
            console.log("[EMERGENCY] play called");
            audio.play().catch((err: unknown) => {
              // Autoplay negado pelo navegador — não é falha, é política
              const name = err instanceof DOMException ? err.name : "";
              console.error("[EMERGENCY ERROR] play() rejeitou:", name, (err as Error)?.message ?? err);
              settle(name === "NotAllowedError" ? "bloqueada" : "erro");
            });
          });
          // Falha de reprodução (não interrupção/autoplay): a fala não pode
          // morrer em silêncio — tenta a voz local do navegador.
          if (r !== "erro") return r;
          if (genRef.current !== gen) return "interrompida";
          console.warn("[EMERGENCY] áudio ElevenLabs falhou — tentando voz do navegador");
        }
        console.log("[EMERGENCY] fallback: voz local do navegador");
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

  // Pré-aquece o cache de áudio para frases conhecidas (ex.: as ações de
  // emergência ao entrar no modo): o toque reproduz na hora, com a voz
  // clonada, e as frases seguem faladas mesmo se a rede cair depois.
  // Sequencial de propósito — sem rajada na API de TTS; qualquer falha
  // apenas interrompe o aquecimento (o toque cai no fallback normal).
  const prime = useCallback(async (texts: string[]): Promise<void> => {
    for (const text of texts) {
      if (elevenAvailable.current === false) return;
      if (!text.trim() || cache.current.has(text)) continue;
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (res.ok) {
          elevenAvailable.current = true;
          cache.current.set(text, URL.createObjectURL(await res.blob()));
        } else if (res.status === 503) {
          elevenAvailable.current = false;
        }
      } catch {
        return; // rede indisponível agora — o toque decide na hora
      }
    }
  }, []);

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

  return { speak, stop, speaking, engine, getAmplitude, prime };
}
