"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ——— Áudio de boas-vindas da Helo (pré-login) ———
// Reproduz UMA ÚNICA VEZ, na primeira interação válida do usuário, o MP3
// oficial da plataforma (public/bem-vindo.mp3 → /bem-vindo.mp3).
//
// Regra do produto: antes do login a identidade vocal vem EXCLUSIVAMENTE do
// arquivo pré-gravado. Não passa pela ElevenLabs (indisponível sem sessão,
// exigiria /api/tts autenticado) nem cai para a voz nativa do navegador
// (speechSynthesis) em nenhuma hipótese.
//
// Expõe getAmplitude(): volume instantâneo 0–1 medido por AnalyserNode,
// reaproveitando a mesma medição de useSpeech para o Orb reagir à voz pelo
// uniform uAudio do shader existente.

const WELCOME_AUDIO_SRC = "/bem-vindo.mp3";

// sessionStorage (não localStorage): impede nova reprodução durante a mesma
// sessão do navegador, inclusive após reload — mas volta a tocar numa sessão
// nova. localStorage silenciaria também sessões futuras, o que não se quer.
const SESSION_KEY = "heloWelcomeAudioPlayed";

export type WelcomeAudioState =
  | "idle" // carregando o elemento de áudio
  | "ready" // pré-carregado, aguardando a primeira interação
  | "starting" // play() em curso
  | "playing" // tocando
  | "ended" // terminou naturalmente
  | "error"; // falhou (MP3 ausente, play() rejeitado, etc.)

// Desfecho de play(), consumido por quem detecta a primeira interação:
//   started  — começou agora (remover listeners globais);
//   already  — já tocou nesta sessão (remover listeners, nada a fazer);
//   busy     — outra chamada de play() ainda em curso (ignorar);
//   error    — não tocou (manter armado para nova tentativa; sem fallback).
export type PlayOutcome = "started" | "already" | "busy" | "error";

function alreadyPlayedThisSession(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "true";
  } catch {
    return false;
  }
}

function markPlayedThisSession(): void {
  try {
    sessionStorage.setItem(SESSION_KEY, "true");
  } catch {
    // sessionStorage indisponível: a proteção em memória (hasPlayedRef) ainda
    // garante uma única reprodução enquanto a página estiver montada.
  }
}

export function useWelcomeAudio() {
  const [state, setState] = useState<WelcomeAudioState>("idle");
  // Sinal para a UI: a apresentação por voz terminou (evento real `ended`),
  // falhou, ou já ocorreu nesta sessão — a partir daqui o login pode surgir.
  const [revealReady, setRevealReady] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserData = useRef<Uint8Array<ArrayBuffer> | null>(null);

  // Proteção robusta contra múltiplos disparos (cliques rápidos, pointer +
  // touch no mesmo toque, envio do formulário): idempotente, não só debounce.
  const hasPlayedRef = useRef(false);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);

  const reveal = useCallback(() => {
    if (mountedRef.current) setRevealReady(true);
  }, []);

  // Monta o elemento de áudio e o grafo Web Audio uma única vez.
  useEffect(() => {
    mountedRef.current = true;

    // Já tocou nesta sessão (ex.: reload): nasce "gasto" — não rearma nem toca,
    // e o login aparece de imediato (sem esperar ~7s por um áudio que não vem).
    if (alreadyPlayedThisSession()) {
      hasPlayedRef.current = true;
      reveal();
    }

    const audio = new Audio(WELCOME_AUDIO_SRC);
    audio.preload = "auto"; // pré-carrega, mas NÃO toca até a interação
    audioRef.current = audio;

    try {
      // Mesmo domínio (public/) → mídia CORS-limpa: o AnalyserNode lê a forma
      // de onda sem taint. createMediaElementSource é irrevogável, por isso o
      // grafo é montado uma vez e reaproveitado.
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
      // Sem Web Audio: o áudio ainda toca direto; a amplitude vira 0 (o Orb
      // apenas respira). Nunca há queda para a voz do navegador.
    }

    const onEnded = () => {
      // Só registra o término da fala — a revelação do form já aconteceu no
      // clique do usuário (ver play()).
      if (mountedRef.current) setState("ended");
    };
    const onError = () => {
      // MP3 ausente/falho: registra o erro. O form não depende disto — já foi
      // revelado no clique (ou na montagem, se a sessão já tinha tocado).
      if (mountedRef.current) setState("error");
      reveal();
    };
    const onReady = () => {
      if (mountedRef.current) setState((s) => (s === "idle" ? "ready" : s));
    };
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    audio.addEventListener("canplaythrough", onReady);
    audio.addEventListener("loadeddata", onReady);
    // Elemento recém-criado: loadeddata/canplaythrough disparam mesmo com o
    // arquivo em cache, então o estado "ready" chega por evento — sem setState
    // síncrono dentro do efeito.

    return () => {
      // Desmontagem (ex.: login concluído → sai da área pública): interrompe de
      // forma limpa. Evita qualquer sobreposição com a voz ElevenLabs depois
      // do login — nunca duas vozes ao mesmo tempo.
      mountedRef.current = false;
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("canplaythrough", onReady);
      audio.removeEventListener("loadeddata", onReady);
      audio.pause();
      audio.src = "";
      try {
        void audioCtxRef.current?.close();
      } catch {
        // já fechado / indisponível
      }
      audioCtxRef.current = null;
      analyserRef.current = null;
      analyserData.current = null;
      audioRef.current = null;
    };
  }, [reveal]);

  // Inicia a reprodução — idempotente e seguro sob disparos concorrentes.
  const play = useCallback(async (): Promise<PlayOutcome> => {
    if (hasPlayedRef.current) return "already";
    if (startingRef.current) return "busy";
    if (alreadyPlayedThisSession()) {
      hasPlayedRef.current = true;
      return "already";
    }
    const audio = audioRef.current;
    if (!audio) return "error";

    startingRef.current = true;
    setState("starting");

    // Regra do produto: o clique do usuário é o gatilho da revelação. O form
    // surge JÁ neste toque — o áudio toca em paralelo e o Orb reage à voz, mas
    // o acesso não espera o fim da fala. (Antes gatilhávamos no evento `ended`,
    // que no Safari iOS — áudio roteado por Web Audio — muitas vezes não chega,
    // prendendo o usuário no Orb.)
    reveal();

    // No iOS o vínculo com o gesto do usuário é estrito: `audio.play()` precisa
    // ser chamado de forma síncrona dentro do handler. Disparamos o play ANTES
    // de aguardar `ctx.resume()` — aguardar o resume primeiro rompe a cadeia do
    // gesto e o Safari rejeita a reprodução.
    const playPromise = audio.play();

    // AudioContext suspenso roteia o áudio SEM som — retomar em paralelo. Há
    // gesto real do usuário aqui, então o resume é permitido.
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state !== "running") {
      void ctx.resume().catch(() => {
        // segue mesmo assim: sem Web Audio o áudio toca direto
      });
    }

    try {
      await playPromise;
      // Só marca como tocado DEPOIS que a reprodução foi aceita — assim uma
      // rejeição de autoplay não "queima" a única reprodução da sessão.
      hasPlayedRef.current = true;
      markPlayedThisSession();
      startingRef.current = false;
      if (mountedRef.current) setState("playing");
      return "started";
    } catch {
      // Autoplay negado (improvável num gesto real) ou falha de mídia: não
      // marca como tocado, permite nova tentativa. Sem voz do navegador — o
      // form já foi revelado acima, então o usuário nunca fica preso no Orb.
      startingRef.current = false;
      if (mountedRef.current) setState("error");
      return "error";
    }
  }, [reveal]);

  // Chamado a cada frame pelo Orb — usa refs, nunca estado React.
  const getAmplitude = useCallback((): number => {
    const audio = audioRef.current;
    if (!audio || audio.paused || audio.ended) return 0;
    const analyser = analyserRef.current;
    const data = analyserData.current;
    if (analyser && data) {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / data.length) * 3);
    }
    return 0;
  }, []);

  return { play, getAmplitude, state, revealReady };
}
