"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ACTIVE_PATIENT_KEY } from "@/lib/patient";
import {
  canPlatformSpeak,
  isPlatformMuted,
  registerPlatformStop,
} from "@/lib/audio-coordinator";
import {
  audioCacheKey,
  patientCloneAllowed,
  type ActiveSpeaker,
  type SpeakOptions,
  type VoiceSource,
} from "@/lib/voice";

// Paciente ativo lido do espelho local (e não do contexto React) para a fala
// funcionar em qualquer camada, inclusive offline.
function activePatientId(): number | null {
  try {
    const v = Number(localStorage.getItem(ACTIVE_PATIENT_KEY));
    return v || null;
  } catch {
    return null;
  }
}

// Interrompe toda fala em curso, em qualquer instância de voz. O registro dos
// stops ativos e o silenciamento global vivem no gerenciador de áudio (a
// mesma trava usada pelo mute e pela prioridade do Agente). Reexportado com o
// nome histórico para o logout (use-auth) que já o consumia.
export { stopAllPlatformAudio as stopAllSpeech } from "@/lib/audio-coordinator";

// Desfecho real de uma fala, derivado dos eventos de reprodução — nunca de
// timers estimados. "bloqueada" = política de autoplay do navegador negou
// a reprodução sem gesto do usuário (não é erro; tentar após interação).
// "silenciada" = o gerenciador global negou a fala (Agente Helo ativo ou
// plataforma mutada); não é erro nem falha de reprodução — a fala é
// simplesmente descartada.
export type SpeakResult = "concluida" | "interrompida" | "bloqueada" | "erro" | "silenciada";

// ——— Orquestrador de voz da Helo (VoiceOrchestrator) ———
// Duas vozes, ambas ElevenLabs, escolhidas pela AUTORIA da fala (não pela tela):
//   speak(text)                              → voz oficial da plataforma Helo;
//   speak(text, { speakerRole: "patient",
//                 confirmationStatus, patientId }) → voz clonada do paciente,
//                 somente com a confirmação exigida pelo fluxo.
// A resolução do voiceId é do servidor (/api/tts); aqui ficam o bloqueio de
// domínio da confirmação, a validação do paciente ativo, o cache por
// papel+paciente e os estados consumidos pela interface e pelo Orb.
//
// Fallback aprovado (nunca substituição silenciosa): se a ElevenLabs estiver
// indisponível, a voz local do navegador entra CLARAMENTE identificada
// (engine "navegador", activeVoiceSource "approvedFallback") — regra do
// produto: uma frase de socorro nunca morre em silêncio.
//
// Expõe também getAmplitude(): volume instantâneo 0–1 da fala em curso,
// para o orbe reagir à voz. Com ElevenLabs a medição é real (AnalyserNode);
// com a voz do navegador (sem acesso à forma de onda) é um pulso sintético.
export function useSpeech() {
  const [speaking, setSpeaking] = useState(false);
  const [engine, setEngine] = useState<"elevenlabs" | "navegador">("navegador");
  const [activeSpeaker, setActiveSpeaker] = useState<ActiveSpeaker>("none");
  const [activeVoiceSource, setActiveVoiceSource] = useState<VoiceSource>("none");
  const cache = useRef<Map<string, { url: string; source: VoiceSource }>>(new Map());
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
    if (!v) {
      setActiveSpeaker("none");
      setActiveVoiceSource("none");
    }
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

  // Registra este stop no gerenciador de áudio enquanto a instância viver: o
  // logout, o mute e a ativação do Agente Helo silenciam por aqui QUALQUER voz
  // em curso, sem depender de qual árvore React disparou.
  useEffect(() => registerPlatformStop(stop), [stop]);

  // Fallback aprovado: voz local do navegador em pt-BR, claramente
  // identificada — nunca apresentada como voz da Helo nem do paciente.
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

  // Resolve a autoria e busca (ou reaproveita) o áudio ElevenLabs da fala.
  // Devolve null quando a ElevenLabs não pôde atender — o chamador decide o
  // fallback. Nunca devolve áudio de outro paciente: a chave de cache inclui
  // papel e paciente, e o patientId é validado contra o paciente ativo.
  const fetchElevenAudio = useCallback(
    async (
      text: string,
      opts: Required<Pick<SpeakOptions, "speakerRole" | "confirmationStatus">> & {
        patientId: number | null;
      }
    ): Promise<{ url: string; source: VoiceSource } | null> => {
      const { speakerRole, confirmationStatus, patientId } = opts;
      const cacheKey = audioCacheKey(speakerRole, patientId, text);
      const cached = cache.current.get(cacheKey);
      console.log("[EMERGENCY] cache lookup:", cached ? "HIT" : "MISS");
      if (cached) return cached;
      if (elevenAvailable.current === false) return null;
      try {
        console.log("[EMERGENCY] TTS request started");
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            speakerRole,
            confirmationStatus,
            patientId: speakerRole === "patient" ? patientId : undefined,
          }),
        });
        console.log("[EMERGENCY] TTS response received:", res.status);
        if (res.ok) {
          elevenAvailable.current = true;
          const source =
            (res.headers.get("X-Voice-Source") as VoiceSource | null) ??
            (speakerRole === "patient" ? "patientElevenLabsClone" : "heloElevenLabs");
          const entry = { url: URL.createObjectURL(await res.blob()), source };
          cache.current.set(cacheKey, entry);
          return entry;
        }
        if (res.status === 503) elevenAvailable.current = false;
      } catch (err) {
        // Rede indisponível: a fala não pode falhar — o chamador segue para
        // o fallback aprovado (voz local do navegador, identificada).
        console.error("[EMERGENCY ERROR] TTS fetch:", (err as Error)?.message ?? err);
      }
      return null;
    },
    []
  );

  const speak = useCallback(
    async (text: string, options?: SpeakOptions): Promise<SpeakResult> => {
      if (!text.trim()) return "concluida";
      // Gate global (ANTES de qualquer mecanismo de voz — ElevenLabs OU
      // fallback speechSynthesis): a plataforma nunca fala por cima do Agente
      // Helo nem quando o usuário mutou a voz. Vale para TODA fala automática,
      // inclusive a da Emergência — a ação da tela executa à parte; só a voz é
      // suprimida. Falas negadas são descartadas, não enfileiradas.
      console.log("[HELO AUDIO] platform speak requested");
      const gate = canPlatformSpeak();
      if (!gate.ok) {
        // Exceção da voz DO PACIENTE: a fala dele tem prioridade sobre o Agente
        // e assume o áudio durante uma conversa (o Agente já foi suprimido pelo
        // Audio Manager via beginPatientVoiceOverride). Vale tanto para a
        // EMERGÊNCIA ("patientEmergency") quanto para a resposta da ROTINA
        // ("patientResponse") — as duas são fala do paciente. O mute, porém,
        // SEMPRE vence (mutar a plataforma silencia até a emergência).
        const patientPriority =
          options?.priority === "patientEmergency" ||
          options?.priority === "patientResponse";
        if (isPlatformMuted()) {
          console.log("[HELO AUDIO] blocked by mute");
          return "silenciada";
        }
        if (!patientPriority) {
          console.log(
            gate.reason === "agent_active"
              ? "[HELO AUDIO] blocked: agent active"
              : gate.reason === "patient_voice_active"
                ? "[HELO AUDIO] blocked: patient voice active"
                : "[HELO AUDIO] blocked: platform muted"
          );
          return "silenciada";
        }
        // Fala do paciente (emergência ou resposta da Rotina) autorizada a
        // atravessar (assume o áudio, interrompendo/suprimindo Agente e plataforma).
      }
      const speakerRole = options?.speakerRole ?? "helo";
      const confirmationStatus = options?.confirmationStatus ?? "notRequired";
      // Fallback do navegador é EXCLUSIVO da Emergência ("uma frase de
      // socorro nunca morre em silêncio"). Fora dela, uma falha da
      // ElevenLabs falha em silêncio — a voz do sistema nunca representa
      // a Helo nem o paciente em fluxos não vitais.
      const fallbackAllowed = options?.mode === "emergencia";
      // Fala do paciente sempre valida o contexto do paciente ATIVO — uma
      // troca rápida de paciente nunca reproduz a voz (ou o cache) errado.
      const patientId =
        speakerRole === "patient"
          ? options?.patientId ?? activePatientId()
          : null;
      if (speakerRole === "patient" && patientId !== activePatientId()) {
        console.error("[VOZ] fala do paciente com patientId fora do contexto ativo — bloqueada");
        return "erro";
      }
      // Bloqueio de domínio (regra obrigatória): a voz clonada do paciente
      // nunca soa antes da confirmação exigida pelo fluxo. O servidor aplica
      // o mesmo bloqueio — a interface não é a única barreira.
      if (speakerRole === "patient" && !patientCloneAllowed(speakerRole, confirmationStatus)) {
        console.error("[VOZ] fala do paciente sem confirmação exigida — bloqueada");
        return "erro";
      }
      stop();
      const gen = ++genRef.current;
      setSpeakingBoth(true);
      setActiveSpeaker(speakerRole === "patient" ? "patient" : "platform");
      try {
        const entry = await fetchElevenAudio(text, {
          speakerRole,
          confirmationStatus,
          patientId,
        });
        // stop() chegou enquanto o áudio ainda era preparado — não toca
        if (genRef.current !== gen) {
          console.warn("[EMERGENCY] interrompida antes de tocar (stop durante preparação)");
          return "interrompida";
        }
        if (entry) {
          setEngine("elevenlabs");
          setActiveVoiceSource(entry.source);
          if (speakerRole === "patient") {
            // Diagnóstico temporário: qual voz o SERVIDOR resolveu para a fala
            // do paciente — clone dele, voz do catálogo configurada, ou
            // fallback aprovado (transparente; nunca finge ser a voz do
            // paciente).
            if (entry.source === "patientElevenLabsClone") {
              console.log("[HELO VOICE] patient cloned voice selected");
            } else if (entry.source === "approvedFallback") {
              console.log("[HELO VOICE] patientVoiceId missing, using fallback");
            } else {
              console.log("[HELO AUDIO] speaking with patient voice");
            }
          }
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
            audio.src = entry.url;
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
          // morrer em silêncio — tenta o fallback aprovado do navegador.
          if (r !== "erro") return r;
          if (genRef.current !== gen) return "interrompida";
          console.warn("[EMERGENCY] áudio ElevenLabs falhou — fallback aprovado (voz do navegador)");
        }
        if (!fallbackAllowed) {
          console.warn("[VOZ] ElevenLabs indisponível fora da Emergência — fala falha em silêncio (sem fallback)");
          return "erro";
        }
        console.log("[EMERGENCY] fallback aprovado: voz local do navegador");
        setEngine("navegador");
        setActiveVoiceSource("approvedFallback");
        return await speakBrowser(text);
      } finally {
        // Só a fala mais recente encerra o estado — uma fala antiga
        // interrompida não desliga o "speaking" da que a substituiu
        if (genRef.current === gen) setSpeakingBoth(false);
      }
    },
    [stop, speakBrowser, ensureAudio, setSpeakingBoth, fetchElevenAudio]
  );

  // Pré-aquece o cache de áudio para frases conhecidas (ex.: as ações de
  // emergência ao entrar no modo): o toque reproduz na hora, com a voz
  // certa, e as frases seguem faladas mesmo se a rede cair depois.
  // Sequencial de propósito — sem rajada na API de TTS; qualquer falha
  // apenas interrompe o aquecimento (o toque cai no fallback normal).
  const prime = useCallback(
    async (texts: string[], options?: SpeakOptions): Promise<void> => {
      const speakerRole = options?.speakerRole ?? "helo";
      const confirmationStatus = options?.confirmationStatus ?? "notRequired";
      const patientId =
        speakerRole === "patient"
          ? options?.patientId ?? activePatientId()
          : null;
      if (speakerRole === "patient" && patientId !== activePatientId()) return;
      if (speakerRole === "patient" && !patientCloneAllowed(speakerRole, confirmationStatus)) return;
      for (const text of texts) {
        if (elevenAvailable.current === false) return;
        if (!text.trim()) continue;
        // Troca de paciente durante o aquecimento: para na hora — nenhum
        // áudio é gerado (nem cacheado) fora do contexto ativo.
        if (speakerRole === "patient" && patientId !== activePatientId()) return;
        // Falhou (rede ou 503): o topo do laço decide se ainda vale insistir.
        await fetchElevenAudio(text, { speakerRole, confirmationStatus, patientId });
      }
    },
    [fetchElevenAudio]
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

  return { speak, stop, speaking, engine, activeSpeaker, activeVoiceSource, getAmplitude, prime };
}
