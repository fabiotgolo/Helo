"use client";

// Sessão única do Agent Helo, montada acima das páginas. Ela só permanece
// entre rotas quando a opção do paciente está ligada; fora disso, sair de
// /helo reproduz o comportamento anterior de encerrar a conversa.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { createPortal } from "react-dom";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import type { Conversation as ElevenLabsConversation, SessionConfig } from "@elevenlabs/client";
import { usePathname, useRouter } from "next/navigation";
import { OverlayPanel, OverlayVeil } from "@/components/overlay-panel";
import { GestureTriplet } from "@/components/ui";
import { GESTURE_SEMANTIC_INTENTS, GESTURE_SEMANTIC_MESSAGES } from "@/lib/gestures";
import { useHelo } from "@/lib/helo-state";
import {
  registerAgentSuppressor,
  setAgentConversationActive,
  setAgentSpeaking,
} from "@/lib/audio-coordinator";
import { usePatient } from "@/lib/patient";
import { isHeloPersistentAssistantEnabled } from "@/lib/defaults";
import {
  HELO_AREA_ROUTES,
  resolveHeloNavigationArea,
  isHeloSettingsSection,
  type HeloClientToolAction,
} from "@/lib/helo-client-tools";
import {
  findHeloUIAction,
  listHeloUIActions,
  useRegisterHeloUIActions,
  type HeloUIAction,
} from "@/lib/helo-action-registry";
import { getHeloScreenContext } from "@/lib/helo-screen-context";
import type { Permission } from "@/lib/access-types";
import {
  endSession as endLoggedSession,
  logEvent,
  startSession as startLoggedSession,
} from "@/lib/log";
import type { Gesture } from "@/lib/types";
import { PHRASE_AUDIO_EVENT } from "@/lib/phrase-audio";

type HeloApiOverrides = { tts?: { voice_id?: string } };
type HeloSessionOverrides = NonNullable<SessionConfig["overrides"]>;
type ActivitySource = "gesture" | "typing" | "field-focus" | "heartbeat";
type ConnectionStatus = "good" | "fair" | "poor" | "offline";
type MusicPlayerStatus = "idle" | "generating" | "playing" | "paused" | "ended" | "error";
type MusicTrackSource = "generated" | "history" | null;
type MusicPlayerState = {
  status: MusicPlayerStatus;
  prompt: string;
  genre: string;
  title: string;
  currentTime: number;
  duration: number;
  error: string;
  source: MusicTrackSource;
  period: "manhã" | "tarde" | "noite" | null;
};
type MusicToolOutcome = "ended" | "cancelled" | "replaced" | "failed" | "ready";
type ElevenLabsErrorEvent = { error_event?: Record<string, unknown> };
type MicInputDevice = { deviceId: string; label: string };
type PatchableConversation = ElevenLabsConversation & {
  handleErrorEvent?: (event: ElevenLabsErrorEvent) => void;
  __heloIncompleteErrorEventPatch?: boolean;
};

// Nome de tela reportado ao Agent por getCurrentHeloActions — derivado da
// rota, nunca declarado pelo Agent.
const SCREEN_BY_PATH: Record<string, string> = {
  "/": "home",
  "/helo": "helo",
  "/conversa": "conversar",
  "/rotina": "rotina",
  "/emergencia": "emergencia",
  "/atividades": "atividades",
  "/mensagem": "mensagem",
  "/ajustes": "ajustes",
  "/dashboard": "dashboard",
};

const GLOBAL_HELO_ROUTES = [
  { actionId: "navigate-home", label: "Ir para Home", path: "/" },
  { actionId: "navigate-helo", label: "Ir para Helo", path: "/helo", area: "helo" },
  { actionId: "navigate-conversar", label: "Ir para Conversar", path: "/conversa", area: "conversar" },
  { actionId: "navigate-rotina", label: "Ir para Rotina", path: "/rotina", area: "rotina" },
  { actionId: "navigate-emergencia", label: "Ir para Emergência", path: "/emergencia", area: "emergencia" },
  { actionId: "navigate-atividades", label: "Ir para Atividades", path: "/atividades", area: "atividades" },
  { actionId: "navigate-mensagem", label: "Ir para Mensagens", path: "/mensagem" },
  { actionId: "navigate-ajustes", label: "Ir para Ajustes", path: "/ajustes", area: "ajustes" },
  { actionId: "navigate-dashboard", label: "Ir para Dashboard", path: "/dashboard", area: "dashboard" },
] as const;

const ACTIVITY_THROTTLE_MS = 3000;
const ACTIVITY_HEARTBEAT_MS = 15000;
const ACTIVE_WINDOW_MS = 60000;
const GESTURE_RESPONSE_LOCK_MS = 1200;
const GESTURE_CHOICES_HIGHLIGHT_MS = 8000;
const MIC_ACTIVITY_THRESHOLD = 0.02;
const MIC_METER_UPDATE_MS = 160;
const MIC_DEBUG_LOG_MS = 1500;
const MIC_DEVICE_STORAGE_KEY = "heloAgentInputDeviceId";
const MAX_SILENCE_REMINDERS = 3;
const SILENCE_REMINDER_WAIT_MS = [0, 60_000, 120_000] as const;
const SILENCE_REMINDER_MESSAGES = [
  "Você ainda está por aqui?",
  "Ainda precisa de alguma ajuda?",
  "Tudo bem. Vou permanecer disponível quando você quiser continuar.",
] as const;
const GENERATE_MUSIC_ENDPOINT =
  process.env.NEXT_PUBLIC_GENERATE_MUSIC_URL ||
  "https://heloapp.web.app/generateMusic";
const INITIAL_MUSIC_PLAYER_STATE: MusicPlayerState = {
  status: "idle",
  prompt: "",
  genre: "",
  title: "",
  currentTime: 0,
  duration: 0,
  error: "",
  source: null,
  period: null,
};

type HeloConversationTokenResponse = {
  conversationToken?: string;
  dynamicVariables?: Record<string, string | number | boolean>;
  overrides?: HeloApiOverrides;
  voiceOverrideApplied?: boolean;
  error?: string;
};

const CONNECTION_STATUS_DETAILS: Record<ConnectionStatus, { label: string; dotClassName: string }> = {
  good: { label: "Conexão excelente", dotClassName: "bg-green-500" },
  fair: { label: "Conexão instável", dotClassName: "bg-yellow-500" },
  poor: { label: "Conexão fraca", dotClassName: "bg-red-500" },
  offline: { label: "Sem conexão", dotClassName: "bg-red-500" },
};

function connectionStatusFromLatency(latencyMs: number): ConnectionStatus {
  if (latencyMs < 150) return "good";
  if (latencyMs <= 400) return "fair";
  return "poor";
}

function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-4">
      <path d="M8 5.75v12.5L18 12 8 5.75Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-4">
      <path d="M7 5.75h3.5v12.5H7V5.75Zm6.5 0H17v12.5h-3.5V5.75Z" fill="currentColor" />
    </svg>
  );
}

function ReplayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-4">
      <path
        d="M7.9 7H14a5 5 0 1 1-4.2 7.72 1 1 0 1 0-1.68 1.08A7 7 0 1 0 14 5H7.9l1.35-1.35a1 1 0 0 0-1.42-1.42L4.78 5.3a1 1 0 0 0 0 1.4l3.05 3.07a1 1 0 0 0 1.42-1.42L7.9 7Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-4">
      <path
        d="m6.7 5.3 5.3 5.3 5.3-5.3a1 1 0 1 1 1.4 1.4L13.4 12l5.3 5.3a1 1 0 0 1-1.4 1.4L12 13.4l-5.3 5.3a1 1 0 0 1-1.4-1.4l5.3-5.3-5.3-5.3a1 1 0 0 1 1.4-1.4Z"
        fill="currentColor"
      />
    </svg>
  );
}

function Volume2Icon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-4">
      <path d="M4 10v4h4l5 4V6l-5 4H4Z" fill="currentColor" />
      <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function VolumeXIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-4">
      <path d="M4 10v4h4l5 4V6l-5 4H4Z" fill="currentColor" />
      <path d="m16 10 5 5m0-5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-3.5">
      <path d="M12 3a3 3 0 0 1 3 3v4.2m-2.1 2.72A3 3 0 0 1 9 10V8m-3 2a6 6 0 0 0 10.15 4.32M18 10a6 6 0 0 1-.45 2.28M12 19v2m-8-18 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type HeloAgentContextValue = {
  activeSessionPatientId: number | null;
  sessionStatus: string;
  restarting: boolean;
  speakActivityQuestion: (
    question: string,
    options?: { activityId?: string; itemId?: string; runId?: string }
  ) => boolean;
  restartForVoiceChange: (patientId: number) => Promise<{ ok: boolean; error?: string }>;
};

const HeloAgentContext = createContext<HeloAgentContextValue | null>(null);

function patchIncompleteElevenLabsErrorEvent(conversation: ElevenLabsConversation) {
  const patched = conversation as PatchableConversation;
  if (patched.__heloIncompleteErrorEventPatch || typeof patched.handleErrorEvent !== "function") return;
  const handleErrorEvent = patched.handleErrorEvent.bind(patched);
  patched.handleErrorEvent = (event) => {
    if (event.error_event) handleErrorEvent(event as never);
  };
  patched.__heloIncompleteErrorEventPatch = true;
}

function toSessionOverrides(overrides?: HeloApiOverrides): HeloSessionOverrides | undefined {
  // A API interna usa `voice_id`; @elevenlabs/client 1.15 recebe `voiceId`
  // e o serializa como `conversation_config_override.tts.voice_id`.
  const voiceId = overrides?.tts?.voice_id?.trim();
  return voiceId ? { tts: { voiceId } } : undefined;
}

function describeConversationError(caught: unknown): string {
  if (caught instanceof DOMException && caught.name === "NotAllowedError") {
    return "Permissão do microfone negada. Autorize o microfone e tente novamente.";
  }
  if (caught instanceof Error && caught.message) return caught.message;
  if (caught && typeof caught === "object") {
    const record = caught as Record<string, unknown>;
    for (const key of ["message", "error", "reason", "details"]) {
      if (typeof record[key] === "string" && record[key]) return record[key];
    }
  }
  return "Não foi possível iniciar a conversa.";
}

function canonicalAgentText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9👍✋✊]+/g, " ")
    .trim();
}

function resolveGestureIntent(value: unknown): Gesture | undefined {
  if (typeof value !== "string") return undefined;
  const text = canonicalAgentText(value);
  if (!text) return undefined;
  if (text.includes("👍") || /\b(sim|yes|positivo|confirmar|confirma|joinha|polegar)\b/.test(text)) return "sim";
  if (text.includes("✋") || /\b(talvez|maybe|reformular|mao aberta|meio termo)\b/.test(text)) return "talvez";
  if (text.includes("✊") || /\b(nao|no|negativo|recusar|recusa|punho)\b/.test(text)) return "nao";
  return undefined;
}

function stringFromFields(source: Record<string, unknown> | undefined, fields: readonly string[]): string | undefined {
  if (!source) return undefined;
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function collectRequestStrings(source: Record<string, unknown> | undefined): string[] {
  if (!source) return [];
  const values: string[] = [];
  for (const value of Object.values(source)) {
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  }
  return values;
}

function resolveRequestedUIAction(
  actionId: string,
  parameters: Record<string, unknown>,
  payload?: Record<string, unknown>
): HeloUIAction | undefined {
  const direct = findHeloUIAction(actionId);
  if (direct) return direct;

  const allStrings = [
    actionId,
    ...collectRequestStrings(parameters),
    ...collectRequestStrings(payload),
  ].filter(Boolean);
  const gesture =
    resolveGestureIntent(stringFromFields(payload, ["gesto", "gesture", "resposta", "answer", "response", "choice", "value"])) ??
    resolveGestureIntent(stringFromFields(parameters, ["gesto", "gesture", "resposta", "answer", "response", "choice", "value"])) ??
    allStrings.map(resolveGestureIntent).find(Boolean);
  const option =
    stringFromFields(payload, ["opcao", "option", "alternativa", "alternative", "item", "itemLabel", "targetLabel", "label"]) ??
    stringFromFields(parameters, ["opcao", "option", "alternativa", "alternative", "item", "itemLabel", "targetLabel"]);

  const candidates = new Set<string>();
  if (gesture) {
    candidates.add(`${actionId}.${gesture}`);
    if (option) {
      candidates.add(`${gesture} de ${option}`);
      candidates.add(`${gesture} em ${option}`);
      candidates.add(`clique em ${gesture} em ${option}`);
      candidates.add(`clique em ${gesture} de ${option}`);
      candidates.add(`${actionId} ${gesture} ${option}`);
    }
  }
  for (const text of allStrings) candidates.add(text);

  for (const candidate of candidates) {
    const action = findHeloUIAction(candidate);
    if (action) return action;
  }
  return undefined;
}

function HeloAgentSession({
  children,
  error,
  onError,
}: {
  children: ReactNode;
  error: string | null;
  onError: (message: string | null) => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { stop, setAgentAmplitude } = useHelo();
  const { patientId, settings } = usePatient();
  const persistentEnabled = isHeloPersistentAssistantEnabled(settings);
  const [starting, setStarting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [activeSessionPatientId, setActiveSessionPatientId] = useState<number | null>(null);
  const [lastGesture, setLastGesture] = useState<Gesture | null>(null);
  const [gesturePending, setGesturePending] = useState(false);
  const [gesturesHighlighted, setGesturesHighlighted] = useState(false);
  const [caregiverMessage, setCaregiverMessage] = useState("");
  const [messageFocused, setMessageFocused] = useState(false);
  const [messageSending, setMessageSending] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [inputDevices, setInputDevices] = useState<MicInputDevice[]>([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState("");
  const [inputDeviceError, setInputDeviceError] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("offline");
  const [isAgentMuted, setIsAgentMuted] = useState(false);
  const [musicPlayer, setMusicPlayer] = useState<MusicPlayerState>(INITIAL_MUSIC_PLAYER_STATE);
  const startedRef = useRef(false);
  const startingRef = useRef(false);
  const connectedRef = useRef(false);
  const statusRef = useRef("disconnected");
  const patientIdRef = useRef<number | null>(patientId);
  const sessionPatientIdRef = useRef<number | null>(null);
  const loggedSessionIdRef = useRef<number | null>(null);
  const activeUntilRef = useRef(0);
  const lastActivitySentAtRef = useRef(0);
  const gestureLockRef = useRef(false);
  const gestureUnlockRef = useRef<number | null>(null);
  const gestureHighlightRef = useRef<number | null>(null);
  const lastMicMeterUpdateRef = useRef(0);
  const lastMicDebugLogRef = useRef(0);
  const selectedInputDeviceIdRef = useRef("");
  const generatedMusicRef = useRef<HTMLAudioElement | null>(null);
  const musicSeekBarRef = useRef<HTMLDivElement | null>(null);
  const musicSeekingRef = useRef(false);
  const musicGenerationAbortRef = useRef<AbortController | null>(null);
  const musicToolCompletionRef = useRef<((outcome: MusicToolOutcome) => void) | null>(null);
  const musicMicSuspendedRef = useRef(false);
  const phraseMicSuspendedRef = useRef(false);
  const musicPreviousMutedRef = useRef(false);
  const currentMutedRef = useRef(false);
  const agentOutputMutedRef = useRef(false);
  const agentInputMutedRef = useRef(false);
  const agentSuppressedRef = useRef(false);
  const conversationAudioControlsRef = useRef<{
    setMuted: (muted: boolean) => void;
    setVolume: (options: { volume: number }) => void;
  } | null>(null);
  const conversationTextControlsRef = useRef<{
    sendContextualUpdate: (text: string, options?: { contextId?: string }) => void;
  } | null>(null);
  const silenceReminderCountRef = useRef(0);
  const nextSilenceReminderAtRef = useRef(0);

  const resetSilenceReminderState = useCallback(() => {
    silenceReminderCountRef.current = 0;
    nextSilenceReminderAtRef.current = 0;
  }, []);

  const clearLocalSessionState = useCallback(() => {
    resetSilenceReminderState();
    activeUntilRef.current = 0;
    lastActivitySentAtRef.current = 0;
    gestureLockRef.current = false;
    if (gestureUnlockRef.current != null) window.clearTimeout(gestureUnlockRef.current);
    gestureUnlockRef.current = null;
    setGesturePending(false);
    endLoggedSession(loggedSessionIdRef.current);
    loggedSessionIdRef.current = null;
    sessionPatientIdRef.current = null;
    setActiveSessionPatientId(null);
    agentOutputMutedRef.current = false;
    agentInputMutedRef.current = false;
    agentSuppressedRef.current = false;
    setIsAgentMuted(false);
    startedRef.current = false;
    setMicLevel(0);
    setAgentAmplitude(null);
  }, [resetSilenceReminderState, setAgentAmplitude]);

  const refreshInputDevices = useCallback(async (requestPermission = false) => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setInputDeviceError("Este navegador não permite listar microfones.");
      return;
    }
    let permissionStream: MediaStream | null = null;
    try {
      if (requestPermission) {
        permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const microphones = devices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Microfone ${index + 1}`,
        }));
      setInputDevices(microphones);
      setInputDeviceError("");
      if (
        selectedInputDeviceIdRef.current &&
        !microphones.some((device) => device.deviceId === selectedInputDeviceIdRef.current)
      ) {
        selectedInputDeviceIdRef.current = "";
        setSelectedInputDeviceId("");
      }
    } catch (caught) {
      const name = caught instanceof DOMException ? caught.name : "";
      setInputDeviceError(
        name === "NotAllowedError"
          ? "Permissão do microfone negada pelo navegador."
          : "Não foi possível listar os microfones."
      );
    } finally {
      permissionStream?.getTracks().forEach((track) => track.stop());
    }
  }, []);

  const finishMusicPlayback = useCallback((
    outcome: MusicToolOutcome,
    options?: { error?: string; restoreConversation?: boolean; updateState?: boolean; persistent?: boolean }
  ) => {
    const audio = generatedMusicRef.current;
    const persistent = options?.persistent === true && audio != null;
    if (audio && !persistent) {
      generatedMusicRef.current = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } else if (audio) {
      audio.pause();
      if (outcome === "ended") audio.currentTime = 0;
    }

    const restoreConversation = options?.restoreConversation !== false;
    if (musicMicSuspendedRef.current) {
      musicMicSuspendedRef.current = false;
      if (restoreConversation) {
        const controls = conversationAudioControlsRef.current;
        try {
          controls?.setVolume({ volume: agentOutputMutedRef.current ? 0 : 1 });
          controls?.setMuted(agentInputMutedRef.current || musicPreviousMutedRef.current);
        } catch (caught) {
          console.warn("[HELO MUSIC] não foi possível restaurar o áudio da conversa", caught);
        }
      }
    }

    const completeTool = musicToolCompletionRef.current;
    musicToolCompletionRef.current = null;
    completeTool?.(outcome);

    if (options?.updateState === false) return;
    if (persistent) {
      setMusicPlayer((current) => ({
        ...current,
        status: outcome === "ended" ? "ended" : "paused",
        currentTime: outcome === "ended" ? 0 : audio.currentTime,
      }));
      return;
    }
    setMusicPlayer(
      outcome === "failed"
        ? {
            ...INITIAL_MUSIC_PLAYER_STATE,
            status: "error",
            error: options?.error || "Não foi possível reproduzir a música.",
          }
        : INITIAL_MUSIC_PLAYER_STATE
    );
  }, []);

  const stopGeneratedMusic = useCallback(() => {
    musicGenerationAbortRef.current?.abort();
    musicGenerationAbortRef.current = null;
    finishMusicPlayback("cancelled");
  }, [finishMusicPlayback]);

  const pauseMusicPlayback = useCallback(() => {
    finishMusicPlayback("cancelled", { persistent: true });
  }, [finishMusicPlayback]);

  const resumeMusicPlayback = useCallback(async () => {
    const audio = generatedMusicRef.current;
    if (!audio) return;
    try {
      if (musicPlayer.status === "ended") audio.currentTime = 0;
      musicPreviousMutedRef.current = currentMutedRef.current;
      musicMicSuspendedRef.current = true;
      conversationAudioControlsRef.current?.setMuted(true);
      conversationAudioControlsRef.current?.setVolume({ volume: 0 });
      setMusicPlayer((current) => ({
        ...current,
        status: "playing",
        currentTime: audio.currentTime,
        error: "",
      }));
      await audio.play();
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : "Não foi possível retomar a música.";
      finishMusicPlayback("failed", { error });
    }
  }, [finishMusicPlayback, musicPlayer.status]);

  const replayMusicPlayback = useCallback(async () => {
    const audio = generatedMusicRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    setMusicPlayer((current) => ({ ...current, currentTime: 0 }));
    await resumeMusicPlayback();
  }, [resumeMusicPlayback]);

  const seekMusicPlayback = useCallback((time: number) => {
    const audio = generatedMusicRef.current;
    if (!audio || !Number.isFinite(time)) return;
    audio.currentTime = Math.max(0, Math.min(time, Number.isFinite(audio.duration) ? audio.duration : time));
    setMusicPlayer((current) => ({ ...current, currentTime: audio.currentTime }));
  }, []);

  const seekMusicFromClientX = useCallback((clientX: number) => {
    const bar = musicSeekBarRef.current;
    const audio = generatedMusicRef.current;
    const duration = audio && Number.isFinite(audio.duration) ? audio.duration : musicPlayer.duration;
    if (!bar || !Number.isFinite(clientX) || !Number.isFinite(duration) || duration <= 0) return;

    const bounds = bar.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const progress = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
    seekMusicPlayback(progress * duration);
  }, [musicPlayer.duration, seekMusicPlayback]);

  const beginMusicSeek = useCallback((clientX: number) => {
    musicSeekingRef.current = true;
    seekMusicFromClientX(clientX);
  }, [seekMusicFromClientX]);

  const endMusicSeek = useCallback(() => {
    musicSeekingRef.current = false;
  }, []);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (musicSeekingRef.current) seekMusicFromClientX(event.clientX);
    };
    const onMouseUp = () => endMusicSeek();
    const onTouchMove = (event: TouchEvent) => {
      if (!musicSeekingRef.current || !event.touches[0]) return;
      event.preventDefault();
      seekMusicFromClientX(event.touches[0].clientX);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onMouseUp);
    window.addEventListener("touchcancel", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onMouseUp);
      window.removeEventListener("touchcancel", onMouseUp);
    };
  }, [endMusicSeek, seekMusicFromClientX]);

  const playMusicTrack = useCallback(async (track: {
    audioUrl: string;
    title: string;
    prompt: string;
    genre: string;
    source: Exclude<MusicTrackSource, null>;
    period?: "manhã" | "tarde" | "noite";
  }) => {
    const audio = new Audio(track.audioUrl);
    audio.preload = "auto";
    generatedMusicRef.current = audio;
    const playbackFinished = new Promise<MusicToolOutcome>((resolve) => {
      musicToolCompletionRef.current = resolve;
    });
    audio.addEventListener("loadedmetadata", () => {
      if (generatedMusicRef.current !== audio) return;
      setMusicPlayer((current) => ({
        ...current,
        duration: Number.isFinite(audio.duration) ? audio.duration : 0,
      }));
    });
    audio.addEventListener("timeupdate", () => {
      if (generatedMusicRef.current !== audio) return;
      setMusicPlayer((current) => ({
        ...current,
        currentTime: audio.currentTime,
        duration: Number.isFinite(audio.duration) ? audio.duration : current.duration,
      }));
    });
    audio.addEventListener("ended", () => {
      if (generatedMusicRef.current === audio) finishMusicPlayback("ended", { persistent: true });
    });
    audio.addEventListener("error", () => {
      if (generatedMusicRef.current === audio) {
        finishMusicPlayback("failed", { error: "O arquivo da música não pôde ser reproduzido." });
      }
    }, { once: true });

    musicPreviousMutedRef.current = currentMutedRef.current;
    musicMicSuspendedRef.current = true;
    conversationAudioControlsRef.current?.setMuted(true);
    conversationAudioControlsRef.current?.setVolume({ volume: 0 });
    setMusicPlayer({
      status: "playing",
      prompt: track.prompt,
      genre: track.genre,
      title: track.title,
      currentTime: 0,
      duration: 0,
      error: "",
      source: track.source,
      period: track.period ?? null,
    });
    try {
      await audio.play();
    } catch (caught) {
      // Chamadas de Client Tool chegam pelo WebSocket, e portanto não contam
      // como um gesto direto do usuário para a política de autoplay. A faixa
      // já foi gerada e carregada: mantemos o player pronto para o cuidador
      // iniciar a reprodução com o botão Tocar, em vez de descartar o áudio.
      if (caught instanceof DOMException && caught.name === "NotAllowedError") {
        console.info("[HELO MUSIC] reprodução aguardando gesto do usuário");
        finishMusicPlayback("ready", { persistent: true });
        return await playbackFinished;
      }
      throw caught;
    }
    console.log("[HELO MUSIC] playback started", { source: track.source, audioUrl: track.audioUrl });
    return await playbackFinished;
  }, [finishMusicPlayback]);

  const generateMusicClientTool = useCallback(async (parameters: { prompt?: string; genre?: string; duration_seconds?: unknown }) => {
    const prompt = parameters.prompt?.trim() || "";
    const genre = parameters.genre?.trim() || "";
    const durationSeconds = Number(parameters.duration_seconds) || 240;
    if (!prompt) {
      return { ok: false, reason: "O prompt da música é obrigatório." };
    }

    // Uma nova solicitação substitui qualquer faixa ainda ativa.
    if (generatedMusicRef.current || musicGenerationAbortRef.current) {
      musicGenerationAbortRef.current?.abort();
      musicGenerationAbortRef.current = null;
      finishMusicPlayback("replaced");
    }

    const abortController = new AbortController();
    musicGenerationAbortRef.current = abortController;
    setMusicPlayer({
      ...INITIAL_MUSIC_PLAYER_STATE,
      status: "generating",
      prompt,
      genre,
      title: "Compondo uma música especial para você...",
    });

    try {
      const response = await fetch(GENERATE_MUSIC_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: patientIdRef.current,
          prompt,
          genre: genre || undefined,
          duration_seconds: durationSeconds,
        }),
        signal: abortController.signal,
      });
      const data = (await response.json().catch(() => null)) as {
        audioUrl?: unknown;
        audio_url?: unknown;
        title?: unknown;
        error?: unknown;
      } | null;
      const audioUrl =
        typeof data?.audioUrl === "string"
          ? data.audioUrl
          : typeof data?.audio_url === "string"
            ? data.audio_url
            : "";
      const title =
        typeof data?.title === "string" && data.title.trim()
          ? data.title.trim()
          : genre
            ? `Música ${genre}`
            : "Música especial da Helo";

      if (!response.ok || !audioUrl) {
        const reason =
          typeof data?.error === "string"
            ? data.error
            : "O servidor não retornou a música gerada.";
        throw new Error(reason);
      }

      musicGenerationAbortRef.current = null;
      const outcome = await playMusicTrack({
        audioUrl,
        title,
        prompt,
        genre,
        source: "generated",
      });
      return {
        ok: outcome === "ended" || outcome === "ready",
        audioUrl,
        title,
        outcome,
        message:
          outcome === "ended"
            ? "A música terminou e a conversa por voz foi retomada."
            : outcome === "ready"
              ? "A música está pronta. Toque em Tocar para iniciar a reprodução."
              : "A música foi interrompida e a conversa por voz foi retomada.",
      };
    } catch (caught) {
      musicGenerationAbortRef.current = null;
      if (caught instanceof DOMException && caught.name === "AbortError") {
        finishMusicPlayback("cancelled");
        return { ok: false, outcome: "cancelled", reason: "A geração da música foi cancelada." };
      }
      const reason = caught instanceof Error && caught.message
        ? caught.message
        : "O navegador bloqueou a reprodução ou houve uma falha na rede.";
      console.warn("[HELO MUSIC] music generation or playback failed", caught);
      finishMusicPlayback("failed", { error: reason });
      return {
        ok: false,
        outcome: "failed",
        reason,
      };
    }
  }, [finishMusicPlayback, playMusicTrack]);

  const playExistingMusicClientTool = useCallback(async (parameters: {
    date_reference?: string;
    period?: string;
    genre?: string;
  }) => {
    const activePatientId = patientIdRef.current;
    if (!activePatientId) return { ok: false, found: false, reason: "Nenhum paciente está ativo." };
    try {
      const search = new URLSearchParams();
      if (parameters.date_reference?.trim()) search.set("dateReference", parameters.date_reference.trim());
      if (parameters.period?.trim()) search.set("period", parameters.period.trim());
      if (parameters.genre?.trim()) search.set("genre", parameters.genre.trim());
      const response = await fetch(`/api/patients/${activePatientId}/playlist?${search.toString()}`);
      const data = (await response.json().catch(() => null)) as {
        tracks?: Array<{
          id: string;
          title: string;
          prompt: string;
          genre: string;
          audioUrl: string;
          period: "manhã" | "tarde" | "noite";
        }>;
        error?: string;
      } | null;
      const track = data?.tracks?.[0];
      if (!response.ok || !track) {
        const details = [parameters.date_reference, parameters.period, parameters.genre]
          .filter((value): value is string => Boolean(value?.trim()))
          .join(", ");
        const message = details
          ? `Não encontrei na playlist uma música correspondente a: ${details}.`
          : "Não encontrei músicas anteriores na playlist deste paciente.";
        conversationTextControlsRef.current?.sendContextualUpdate(message, {
          contextId: `playlist-not-found:${Date.now()}`,
        });
        return { ok: false, found: false, reason: message };
      }
      if (generatedMusicRef.current || musicGenerationAbortRef.current) stopGeneratedMusic();
      const outcome = await playMusicTrack({
        audioUrl: track.audioUrl,
        title: track.title,
        prompt: track.prompt,
        genre: track.genre,
        source: "history",
        period: track.period,
      });
      return {
        ok: outcome === "ended",
        found: true,
        title: track.title,
        period: track.period,
        outcome,
      };
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : "Não foi possível buscar a playlist.";
      console.warn("[HELO MUSIC] existing music playback failed", caught);
      return { ok: false, found: false, reason };
    }
  }, [playMusicTrack, stopGeneratedMusic]);

  useEffect(() => () => {
    musicGenerationAbortRef.current?.abort();
    musicGenerationAbortRef.current = null;
    finishMusicPlayback("cancelled", { restoreConversation: false, updateState: false });
  }, [finishMusicPlayback]);

  const toolResult = useCallback((value: Record<string, unknown>) => JSON.stringify(value), []);
  const authorizeTool = useCallback(async (
    action: HeloClientToolAction,
    options?: { area?: string; section?: string; permission?: Permission }
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    const activePatientId = patientIdRef.current;
    if (activePatientId == null) return { ok: false, error: "Paciente ativo não selecionado" };
    try {
      const response = await fetch("/api/helo/client-tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId: activePatientId, action, ...options }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !data?.ok) return { ok: false, error: data?.error ?? "Acesso negado" };
      return patientIdRef.current === activePatientId
        ? { ok: true }
        : { ok: false, error: "O paciente ativo foi alterado" };
    } catch {
      return { ok: false, error: "Não foi possível verificar o acesso" };
    }
  }, []);

  const navigateToArea = useCallback(async (action: HeloClientToolAction, area: string) => {
    // Resolução tolerante: aceita nome canônico, plural, inglês e frases com
    // verbo ("abrir rotina", "ir para as rotinas", "modo rotina"). Nunca
    // confunde áreas — o casamento é por token inteiro de sinônimo.
    console.log("[HELO NAV] requested area", area);
    const resolved = resolveHeloNavigationArea(area);
    console.log("[HELO NAV] normalized area", resolved ?? "(não reconhecida)");
    if (!resolved) return toolResult({ ok: false, error: "Área de navegação inválida" });
    if (resolved === "rotina") console.log("[HELO NAV] opening routine");
    const access = await authorizeTool(action, { area: resolved });
    if (!access.ok) return toolResult(access);
    if (resolved === "atividades") {
      const activityMenuAction = findHeloUIAction("activity.goToActivityMenu");
      if (activityMenuAction?.enabled) {
        await activityMenuAction.run({ __source: "agent" });
        return toolResult({
          ok: true,
          action,
          targetArea: resolved,
          delegatedActionId: activityMenuAction.actionId,
          suppressAssistantNarration: true,
        });
      }
    }
    router.push(HELO_AREA_ROUTES[resolved]);
    return toolResult({ ok: true, action, targetArea: resolved });
  }, [authorizeTool, router, toolResult]);

  const clientTools = useMemo(() => {
    // Descoberta: o que está clicável AGORA na tela, direto do Action
    // Registry — leitura local, sem efeito colateral (o que o operador já vê).
    // debug.ping vai SEMPRE na frente: valida o round-trip ElevenLabs →
    // client tool sem depender de login, tela ou registry. Handler único
    // compartilhado pelos dois nomes que o painel pode usar.
    const discoverActions = async () => {
      console.log("[HELO TOOL] getCurrentHeloActions called");
      const activePatientId = patientIdRef.current;
      const debugAction = { actionId: "debug.ping", label: "Ping de teste", type: "debug", enabled: true };
      // A tela montada pode publicar um sub-estado (ex.: a Rotina distingue
      // routine_menu de routine_question e informa a pergunta atual). Quando
      // publicado, ele sobrepõe o nome derivado da rota e mescla campos extras.
      const screenContext = activePatientId == null ? null : getHeloScreenContext();
      const resolvedScreen =
        activePatientId == null
          ? "debug"
          : screenContext?.screen ?? SCREEN_BY_PATH[pathname] ?? pathname;
      const uiActions = listHeloUIActions();
      const localElements = typeof document === "undefined"
        ? []
        : Array.from(document.querySelectorAll<HTMLElement>("button, a"))
          .map((element, index) => {
            const label = element.textContent?.trim();
            if (!label) return null;
            return {
              actionId: element.id || label || `local-${index + 1}`,
              label,
              source: "local" as const,
              ...(element instanceof HTMLAnchorElement ? { path: element.pathname } : {}),
            };
          })
          .filter((element): element is NonNullable<typeof element> => element != null);
      if (typeof resolvedScreen === "string" && resolvedScreen.startsWith("routine")) {
        console.log("[HELO TOOL] routine actions returned", uiActions.length);
      }
      return toolResult({
        ok: true,
        currentPath: pathname,
        screen: resolvedScreen,
        patientId: activePatientId ?? "debug",
        ...(screenContext?.extra ?? {}),
        globalRoutes: GLOBAL_HELO_ROUTES,
        localElements,
        availableActions: [
          ...GLOBAL_HELO_ROUTES.map((route) => ({ ...route, source: "global" as const })),
          ...localElements,
        ],
        actions: [debugAction, ...GLOBAL_HELO_ROUTES, ...uiActions],
      });
    };
    // Execução: encontra o actionId no registry, autoriza no servidor (com a
    // permissão declarada pela ação) e chama o MESMO handler do clique manual.
    const interactWithUI = async (parameters: Record<string, unknown>) => {
      // O parâmetro do actionId pode chegar com nomes diferentes conforme a
      // declaração da tool no painel — aceitamos os mais prováveis.
      const rawId =
        parameters.actionId ??
        parameters.action ??
        parameters.id ??
        parameters.name ??
        parameters.label ??
        parameters.target ??
        parameters.command;
      console.log("[HELO TOOL] interactWithHeloUI called", rawId, parameters);
      const actionId = typeof rawId === "string" ? rawId : "";
      console.log("[HELO TOOL] actionId received", actionId || "(vazio)");
      if (!actionId.trim()) {
        return toolResult({ ok: false, reason: "actionId inválido" });
      }
      // Curto-circuito de diagnóstico: prova a execução ponta a ponta sem
      // tocar no registry nem exigir sessão/permissão.
      if (actionId === "debug.ping") {
        return toolResult({ ok: true, actionId, message: "Tool interactWithHeloUI executada em modo debug." });
      }
      const globalRoute = GLOBAL_HELO_ROUTES.find((route) => route.actionId === actionId);
      if (globalRoute) {
        if ("area" in globalRoute) {
          return navigateToArea("navigateHeloArea", globalRoute.area);
        }
        const access = await authorizeTool("navigateHeloArea");
        if (!access.ok) return toolResult(access);
        router.push(globalRoute.path);
        return toolResult({ ok: true, actionId, path: globalRoute.path });
      }
      const payload =
        parameters.payload && typeof parameters.payload === "object" && !Array.isArray(parameters.payload)
          ? (parameters.payload as Record<string, unknown>)
          : undefined;
      const action = resolveRequestedUIAction(actionId, parameters, payload);
      if (!action) {
        return toolResult({ ok: false, reason: "Ação não encontrada na tela atual." });
      }
      if (!action.enabled) {
        return toolResult({ ok: false, reason: `A ação "${action.label}" está indisponível agora.` });
      }
      // Abertura de card da Rotina: sinaliza o caminho e a supressão de
      // narração (a fala do paciente só vem ao selecionar SIM/TALVEZ/NÃO).
      if (action.actionId.startsWith("routine.open.")) {
        console.log("[HELO TOOL] opening routine card", action.actionId);
        console.log("[HELO AGENT] suppress narration for routine card open");
      }
      const access = await authorizeTool(
        "interactWithHeloUI",
        action.requiredPermission ? { permission: action.requiredPermission } : undefined
      );
      if (!access.ok) return toolResult({ ok: false, reason: access.error });
      try {
        await action.run({ ...(payload ?? {}), __source: "agent" });
        // Retorno silencioso quando a ação o declara (Emergência): técnico e
        // curto, para o Agente NÃO narrar em voz alta que registrou.
        if (action.toolSuccess) {
          return toolResult({ ok: true, actionId, ...action.toolSuccess });
        }
        return toolResult({ ok: true, actionId, message: `${action.label}: executado.` });
      } catch (caught) {
        return toolResult({
          ok: false,
          reason: caught instanceof Error && caught.message ? caught.message : "A ação falhou.",
        });
      }
    };
    const checkUserSilence = async () => {
      const now = Date.now();
      const reminderCount = silenceReminderCountRef.current;
      const nextReminderAt = nextSilenceReminderAtRef.current;

      if (reminderCount >= MAX_SILENCE_REMINDERS) {
        console.log("[HELO SILENCE] reminder blocked: maximum reached", { reminderCount });
        return toolResult({
          ok: true,
          shouldSpeak: false,
          reminderCount,
          maximumReminders: MAX_SILENCE_REMINDERS,
          instruction: "Não fale. Use a ferramenta de sistema skip_turn e aguarde uma nova fala do paciente.",
        });
      }

      if (now < nextReminderAt) {
        const waitSeconds = Math.ceil((nextReminderAt - now) / 1000);
        console.log("[HELO SILENCE] reminder blocked: waiting", { reminderCount, waitSeconds });
        return toolResult({
          ok: true,
          shouldSpeak: false,
          reminderCount,
          maximumReminders: MAX_SILENCE_REMINDERS,
          retryAfterSeconds: waitSeconds,
          instruction: "Ainda não é hora de falar. Use a ferramenta de sistema skip_turn e permaneça em silêncio.",
        });
      }

      const nextReminderCount = reminderCount + 1;
      silenceReminderCountRef.current = nextReminderCount;
      nextSilenceReminderAtRef.current = nextReminderCount === MAX_SILENCE_REMINDERS
        ? Number.POSITIVE_INFINITY
        : now + SILENCE_REMINDER_WAIT_MS[nextReminderCount];
      const message = SILENCE_REMINDER_MESSAGES[reminderCount];
      console.log("[HELO SILENCE] reminder allowed", { reminderCount: nextReminderCount });
      return toolResult({
        ok: true,
        shouldSpeak: true,
        reminderCount: nextReminderCount,
        maximumReminders: MAX_SILENCE_REMINDERS,
        message,
        instruction: `Fale somente esta mensagem, sem acrescentar outra pergunta: \"${message}\"`,
      });
    };
    return {
    navigateHeloArea: async (parameters: Record<string, unknown>) => {
      // O nome do parâmetro varia conforme a declaração da tool no painel —
      // aceitamos os mais prováveis. A resolução da área é tolerante depois.
      const raw = parameters.targetArea ?? parameters.area ?? parameters.target ?? parameters.name;
      return typeof raw === "string"
        ? navigateToArea("navigateHeloArea", raw)
        : toolResult({ ok: false, error: "targetArea inválido" });
    },
    openPatientSettings: async (parameters: Record<string, unknown>) => {
      const section = parameters.section;
      if (!isHeloSettingsSection(section)) return toolResult({ ok: false, error: "Seção de ajustes inválida" });
      const access = await authorizeTool("openPatientSettings", { section });
      if (!access.ok) return toolResult(access);
      router.push(`/ajustes?section=${encodeURIComponent(section)}`);
      return toolResult({ ok: true, action: "openPatientSettings", section });
    },
    openRoutineMode: async () => navigateToArea("openRoutineMode", "rotina"),
    openEmergencyMode: async () => {
      const result = await navigateToArea("openEmergencyMode", "emergencia");
      try {
        const data = JSON.parse(result) as Record<string, unknown>;
        return toolResult(data.ok ? { ...data, opened: "emergencia", requiresUserConfirmation: true } : data);
      } catch {
        return result;
      }
    },
    openActivitiesMode: async () => navigateToArea("openActivitiesMode", "atividades"),
    showGestureChoices: async () => {
      const access = await authorizeTool("showGestureChoices");
      if (!access.ok) return toolResult(access);
      if (pathname !== "/helo") router.push("/helo");
      if (gestureHighlightRef.current != null) window.clearTimeout(gestureHighlightRef.current);
      setGesturesHighlighted(true);
      gestureHighlightRef.current = window.setTimeout(() => {
        setGesturesHighlighted(false);
        gestureHighlightRef.current = null;
      }, GESTURE_CHOICES_HIGHLIGHT_MS);
      return toolResult({ ok: true, action: "showGestureChoices" });
    },
    generate_and_play_music: async (parameters: Record<string, unknown>) => {
      return toolResult(await generateMusicClientTool({
        prompt: typeof parameters.prompt === "string" ? parameters.prompt : undefined,
        genre: typeof parameters.genre === "string" ? parameters.genre : undefined,
        duration_seconds: parameters.duration_seconds,
      }));
    },
    // Alias temporário para sessões que ainda usam o nome anterior no painel.
    generate_music: async (parameters: Record<string, unknown>) => {
      return toolResult(await generateMusicClientTool({
        prompt: typeof parameters.prompt === "string" ? parameters.prompt : undefined,
        genre: typeof parameters.genre === "string" ? parameters.genre : undefined,
        duration_seconds: parameters.duration_seconds,
      }));
    },
    play_existing_music: async (parameters: Record<string, unknown>) => {
      return toolResult(await playExistingMusicClientTool({
        date_reference: typeof parameters.date_reference === "string" ? parameters.date_reference : undefined,
        period: typeof parameters.period === "string" ? parameters.period : undefined,
        genre: typeof parameters.genre === "string" ? parameters.genre : undefined,
      }));
    },
    checkUserSilence,
    // O painel declara as tools como getVisibleHeloActions /
    // interactWithVisibleHeloUI; registramos ESSES nomes E os da spec para o
    // MESMO handler — o nome do painel não precisa mudar e a tool funciona
    // dos dois jeitos.
    getCurrentHeloActions: discoverActions,
    getVisibleHeloActions: discoverActions,
    interactWithHeloUI: interactWithUI,
    interactWithVisibleHeloUI: interactWithUI,
    executeHeloAction: interactWithUI,
    };
  }, [authorizeTool, generateMusicClientTool, navigateToArea, pathname, playExistingMusicClientTool, router, toolResult]);

  const {
    startSession,
    endSession,
    status,
    isSpeaking,
    isListening,
    isMuted,
    sendUserMessage,
    sendContextualUpdate,
    sendUserActivity,
    setVolume,
    setMuted,
    changeInputDevice,
    getInputVolume,
    getOutputByteFrequencyData,
  } = useConversation({
    onConversationCreated: patchIncompleteElevenLabsErrorEvent,
    clientTools,
    onConnect: ({ conversationId }) => {
      console.log("[HELO AUDIO] agent connected", { conversationId });
      resetSilenceReminderState();
      // Uma sessão conectada e com o navegador online começa saudável. O RTT
      // real do stream, recebido em onPing, pode rebaixá-la para amarelo ou vermelho.
      setConnectionStatus(navigator.onLine ? "good" : "offline");
      onError(null);
    },
    onDisconnect: (details) => {
      console.log("[HELO AUDIO] agent disconnected", details);
      setConnectionStatus("offline");
      clearLocalSessionState();
      if (details.reason !== "user") {
        onError("A conexão da Helo caiu. Se acontecer novamente, selecione o microfone físico e conecte de novo.");
      }
    },
    onError: (message, context) => {
      console.error("[HELO AUDIO] agent error", message, context);
      setConnectionStatus("offline");
      clearLocalSessionState();
      onError(message || "A conversa foi interrompida. Verifique sua conexão e tente novamente.");
    },
    onModeChange: ({ mode }) => {
      console.log("[HELO AUDIO] agent mode", mode);
    },
    onMessage: ({ message, role }) => {
      if (role !== "user" || !message.trim()) return;
      resetSilenceReminderState();
      console.log("[HELO SILENCE] reminder state reset by patient speech");
    },
    onVadScore: ({ vadScore }) => {
      const now = Date.now();
      if (vadScore > MIC_ACTIVITY_THRESHOLD && now - lastMicDebugLogRef.current > MIC_DEBUG_LOG_MS) {
        lastMicDebugLogRef.current = now;
        console.log("[HELO AUDIO] voice activity detected", { vadScore: Number(vadScore.toFixed(3)) });
      }
    },
    onPing: ({ ping_ms }) => {
      if (statusRef.current !== "connected") return;
      if (!navigator.onLine) {
        setConnectionStatus("offline");
        return;
      }
      if (typeof ping_ms === "number" && Number.isFinite(ping_ms)) {
        setConnectionStatus(connectionStatusFromLatency(ping_ms));
      }
    },
    onDebug: (event: unknown) => {
      console.log("[HELO AUDIO] sdk debug", typeof event === "object" && event && "type" in event ? { type: event.type } : { type: typeof event });
    },
    // Dispara quando o agente chama uma tool que NÃO existe no objeto
    // clientTools — normalmente por divergência de nome. Se este log
    // aparecer com "getCurrentHeloActions"/"interactWithHeloUI", o painel e
    // o código estão com nomes diferentes; se NENHUM log de tool aparecer, o
    // agente não está declarando/chamando a tool no painel da ElevenLabs.
    onUnhandledClientToolCall: (call: unknown) => {
      console.warn("[HELO TOOL] unhandled client tool call", call);
    },
  });
  useEffect(() => {
    conversationAudioControlsRef.current = { setMuted, setVolume };
    currentMutedRef.current = isMuted;
  }, [isMuted, setMuted, setVolume]);

  // Mute exclusivo da SAÍDA do Agente: não altera o microfone, WebSocket ou
  // status da conversa. Supressões temporárias (música/voz do paciente) ainda
  // vencem o volume, e ao terminar respeitam a escolha manual do operador.
  const toggleAgentMute = useCallback(() => {
    const nextMuted = !agentOutputMutedRef.current;
    agentOutputMutedRef.current = nextMuted;
    agentInputMutedRef.current = nextMuted;
    setIsAgentMuted(nextMuted);
    try {
      setVolume({ volume: nextMuted || agentSuppressedRef.current ? 0 : 1 });
      // `setMuted` controla o stream de entrada do SDK sem encerrar a sessão:
      // enquanto ativo, nenhuma fala/ruído é encaminhado à Helo.
      if (nextMuted) {
        setMuted(true);
      } else if (!musicMicSuspendedRef.current && !phraseMicSuspendedRef.current) {
        setMuted(false);
      }
    } catch {
      // A sessão pode ser encerrada no instante do toque; o estado visual
      // continua pronto para a próxima conexão.
    }
  }, [setMuted, setVolume]);

  useEffect(() => {
    if (status !== "connected") return;
    try {
      setVolume({ volume: agentOutputMutedRef.current || agentSuppressedRef.current ? 0 : 1 });
    } catch {
      // A conexão pode mudar de estado antes do SDK aceitar o volume.
    }
  }, [setVolume, status]);

  // Áudio gravado de uma frase não pode retornar ao microfone de uma sessão
  // ElevenLabs ativa. A própria atividade emite este evento no início/fim,
  // inclusive em erro e desmontagem.
  useEffect(() => {
    let mutedByPhrase = false;
    const onPhraseAudio = (event: Event) => {
      const playing = (event as CustomEvent<{ playing?: boolean }>).detail?.playing === true;
      if (playing && statusRef.current === "connected" && !currentMutedRef.current) {
        mutedByPhrase = true;
        phraseMicSuspendedRef.current = true;
        setMuted(true);
      } else if (!playing && statusRef.current === "connected") {
        phraseMicSuspendedRef.current = false;
        if (mutedByPhrase) mutedByPhrase = false;
        if (!agentInputMutedRef.current && !musicMicSuspendedRef.current) setMuted(false);
      }
    };
    window.addEventListener(PHRASE_AUDIO_EVENT, onPhraseAudio);
    return () => window.removeEventListener(PHRASE_AUDIO_EVENT, onPhraseAudio);
  }, [setMuted]);

  useEffect(() => {
    conversationTextControlsRef.current = { sendContextualUpdate };
  }, [sendContextualUpdate]);

  const end = useCallback(() => {
    const wasStarted = startedRef.current;
    stopGeneratedMusic();
    clearLocalSessionState();
    if (wasStarted) endSession();
  }, [clearLocalSessionState, endSession, stopGeneratedMusic]);

  useEffect(() => {
    patientIdRef.current = patientId;
  }, [patientId]);

  useEffect(() => {
    let selectedDeviceFrame = 0;
    let refreshDevicesFrame = 0;
    try {
      const stored = localStorage.getItem(MIC_DEVICE_STORAGE_KEY) || "";
      selectedInputDeviceIdRef.current = stored;
      selectedDeviceFrame = window.requestAnimationFrame(() => setSelectedInputDeviceId(stored));
    } catch {
      // Sem localStorage: usa o microfone padrão do navegador.
    }
    refreshDevicesFrame = window.requestAnimationFrame(() => {
      void refreshInputDevices(false);
    });
    return () => {
      if (selectedDeviceFrame) window.cancelAnimationFrame(selectedDeviceFrame);
      if (refreshDevicesFrame) window.cancelAnimationFrame(refreshDevicesFrame);
    };
  }, [refreshInputDevices]);

  useEffect(() => {
    selectedInputDeviceIdRef.current = selectedInputDeviceId;
    try {
      if (selectedInputDeviceId) localStorage.setItem(MIC_DEVICE_STORAGE_KEY, selectedInputDeviceId);
      else localStorage.removeItem(MIC_DEVICE_STORAGE_KEY);
    } catch {
      // Preferência não persistida, mas a sessão atual continua válida.
    }
  }, [selectedInputDeviceId]);

  useEffect(() => {
    connectedRef.current = status === "connected";
    statusRef.current = status;
    if (status === "disconnected") {
      activeUntilRef.current = 0;
      lastActivitySentAtRef.current = 0;
      setConnectionStatus("offline");
    } else if (!navigator.onLine) {
      setConnectionStatus("offline");
    } else if (status === "connecting") {
      // Enquanto o primeiro ping do SDK não chega, a conexão ainda está em avaliação.
      setConnectionStatus("fair");
    } else if (status === "connected") {
      // Confirma a saúde inicial também pelo estado reativo do SDK. Isso cobre
      // sessões nas quais o evento onConnect aconteceu antes de o listener montar.
      setConnectionStatus("good");
    }
  }, [status]);

  useEffect(() => {
    if (status !== "disconnected") return;
    if (generatedMusicRef.current || musicGenerationAbortRef.current) {
      stopGeneratedMusic();
    }
  }, [status, stopGeneratedMusic]);

  useEffect(() => {
    const markOnline = () => {
      setConnectionStatus(statusRef.current === "connected" ? "good" : "offline");
    };
    const markOffline = () => setConnectionStatus("offline");

    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    if (!navigator.onLine) markOffline();
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  useEffect(() => {
    if (
      status !== "connected" ||
      !isMuted ||
      agentInputMutedRef.current ||
      musicMicSuspendedRef.current ||
      phraseMicSuspendedRef.current
    ) return;
    try {
      setMuted(false);
    } catch {
      // A sessão pode ter encerrado entre o status e a chamada.
    }
  }, [isMuted, setMuted, status]);

  // Prioridade de voz: enquanto o Agente Helo está conectando/ativo, ele tem
  // prioridade TOTAL — o gerenciador global bloqueia (e interrompe) qualquer
  // voz automática da plataforma. Ao encerrar/erro/desconexão, o status volta
  // a "disconnected" e a voz assistente da plataforma é liberada. Derivar do
  // estado real (em vez de marcar em cada handler) cobre todos os caminhos de
  // saída, inclusive falha de conexão e erro do provider.
  useEffect(() => {
    const agentActive =
      starting || restarting || status === "connecting" || status === "connected";
    setAgentConversationActive(agentActive);
  }, [starting, restarting, status]);

  // O Agente está FALANDO agora — alimenta o orbe/telemetria do Audio Manager.
  useEffect(() => {
    setAgentSpeaking(status === "connected" && isSpeaking);
  }, [isSpeaking, status]);

  // Prioridade MÁXIMA da voz do paciente: ao acionar uma frase de emergência,
  // o Audio Manager pede para suprimirmos a voz do Agente — zeramos o volume de
  // saída do SDK e restauramos ao término. Assim a voz clonada do paciente
  // interrompe/silencia o Agente e nunca soa por baixo dele.
  useEffect(() => {
    return registerAgentSuppressor((suppress) => {
      try {
        agentSuppressedRef.current = suppress;
        setVolume({ volume: suppress || agentOutputMutedRef.current ? 0 : 1 });
        console.log(
          suppress
            ? "[HELO AUDIO] suppressing agent speech"
            : "[HELO AUDIO] agent speech restored"
        );
      } catch {
        // Sem sessão ativa: não há voz do Agente a suprimir.
      }
    });
  }, [setVolume]);

  // Rede de segurança: se este provider desmontar (ex.: logout), a trava do
  // Agente não pode ficar presa impedindo a plataforma de falar.
  useEffect(
    () => () => {
      setAgentSpeaking(false);
      setAgentConversationActive(false);
    },
    []
  );

  useEffect(() => {
    // A página é apenas o ponto visual. Com a persistência desligada, sair
    // dela conserva exatamente a regra anterior de encerrar a conversa.
    if (!persistentEnabled && pathname !== "/helo" && startedRef.current) end();
  }, [end, pathname, persistentEnabled]);

  useEffect(() => {
    if (!startedRef.current || sessionPatientIdRef.current === patientId) return;
    setLastGesture(null);
    setCaregiverMessage("");
    setMessageError("");
    setGesturesHighlighted(false);
    end();
    onError("A conversa foi encerrada porque o paciente ativo foi alterado.");
  }, [end, onError, patientId]);

  useEffect(() => {
    const stopAgent = () => end();
    window.addEventListener("helo-agent-stop", stopAgent);
    window.addEventListener("beforeunload", stopAgent);
    return () => {
      window.removeEventListener("helo-agent-stop", stopAgent);
      window.removeEventListener("beforeunload", stopAgent);
      if (gestureUnlockRef.current != null) window.clearTimeout(gestureUnlockRef.current);
      if (gestureHighlightRef.current != null) window.clearTimeout(gestureHighlightRef.current);
      end();
    };
  }, [end]);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      const bytes = getOutputByteFrequencyData();
      let total = 0;
      for (const value of bytes) total += value * value;
      setAgentAmplitude(bytes.length ? Math.min(1, Math.sqrt(total / bytes.length) / 128) : 0);
      if (statusRef.current === "connected") {
        const now = Date.now();
        if (now - lastMicMeterUpdateRef.current >= MIC_METER_UPDATE_MS) {
          lastMicMeterUpdateRef.current = now;
          setMicLevel(getInputVolume());
        }
      }
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [getInputVolume, getOutputByteFrequencyData, setAgentAmplitude]);

  const sendActivity = useCallback((source: ActivitySource, immediate = false) => {
    if (!connectedRef.current) return;
    const now = Date.now();
    if (!immediate && now - lastActivitySentAtRef.current < ACTIVITY_THROTTLE_MS) {
      activeUntilRef.current = now + ACTIVE_WINDOW_MS;
      return;
    }
    try {
      sendUserActivity();
      lastActivitySentAtRef.current = now;
      activeUntilRef.current = now + ACTIVE_WINDOW_MS;
    } catch {
      // A sessão pode ter encerrado entre o estado React e o envio.
    }
  }, [sendUserActivity]);

  const sendCaregiverMessage = useCallback(async () => {
    const message = caregiverMessage.trim();
    const activePatientId = patientIdRef.current;
    if (!message || messageSending || !activePatientId || statusRef.current !== "connected") return;

    setMessageSending(true);
    setMessageError("");
    let deliveredToAgent = false;
    try {
      // A atualização contextual chega à sessão atual sem interromper a fala
      // ou o fluxo de escuta do paciente.
      sendContextualUpdate(
        `Observação do acompanhante em tempo real: ${message}`,
        { contextId: `caregiver-observation:${Date.now()}` }
      );
      // contextual_update mantém o contexto da sessão, mas não cria um turno
      // de resposta. A mensagem do acompanhante abaixo pede que a Helo a
      // responda em voz, sem confundi-la com uma fala do paciente.
      sendUserMessage(
        `Mensagem escrita pelo acompanhante: "${message}". Responda diretamente ao acompanhante em voz, de forma breve e adequada ao contexto atual.`
      );
      deliveredToAgent = true;

      const response = await fetch(`/api/patients/${activePatientId}/observations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: String(activePatientId),
          authorRole: "caregiver",
          message,
          timestamp: new Date().toISOString(),
          source: "live_session_observation",
          sessionId: loggedSessionIdRef.current,
        }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(data?.error ?? "Não foi possível registrar a mensagem.");

      setCaregiverMessage("");
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : "Não foi possível enviar a mensagem.";
      setMessageError(
        deliveredToAgent
          ? `A Helo recebeu a mensagem, mas ela não foi registrada no dashboard: ${detail}`
          : detail
      );
      if (deliveredToAgent) setCaregiverMessage("");
    } finally {
      setMessageSending(false);
    }
  }, [caregiverMessage, messageSending, sendContextualUpdate, sendUserMessage]);

  const speakActivityQuestion = useCallback(
    (question: string, options?: { activityId?: string; itemId?: string; runId?: string }) => {
      const text = question.trim();
      if (!text || !connectedRef.current) return false;
      const contextId = ["activity-question", options?.runId, options?.activityId, options?.itemId]
        .filter(Boolean)
        .join(":");
      try {
        sendContextualUpdate(
          `Pergunta atual dirigida ao paciente: "${text}". A próxima fala deve ser a Helo lendo essa pergunta para o paciente, sem explicar nem responder por ele.`,
          contextId ? { contextId } : undefined
        );
        sendUserMessage(
          `Leia agora para o paciente, com a voz da Helo, exatamente esta pergunta e nada mais: "${text}"`
        );
        return true;
      } catch (caught) {
        console.warn("[HELO AUDIO] activity question prompt failed", caught);
        return false;
      }
    },
    [sendContextualUpdate, sendUserMessage]
  );

  const handleInputDeviceChange = useCallback(async (deviceId: string) => {
    selectedInputDeviceIdRef.current = deviceId;
    setSelectedInputDeviceId(deviceId);
    setInputDeviceError("");
    if (statusRef.current !== "connected") return;
    setMicLevel(0);
    try {
      await changeInputDevice({ inputDeviceId: deviceId || undefined });
    } catch (caught) {
      console.warn("[HELO AUDIO] input device change failed", caught);
      setInputDeviceError("Não foi possível trocar o microfone nesta sessão. Encerre e conecte novamente.");
    }
  }, [changeInputDevice]);

  useEffect(() => {
    if (status !== "connected") return;
    const interval = window.setInterval(() => {
      if (Date.now() <= activeUntilRef.current) sendActivity("heartbeat");
    }, ACTIVITY_HEARTBEAT_MS);
    return () => window.clearInterval(interval);
  }, [sendActivity, status]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setMount(pathname === "/helo" ? document.getElementById("helo-agent-stage") : null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  const connect = useCallback(async () => {
    if (startingRef.current || startedRef.current || statusRef.current !== "disconnected") return false;
    startingRef.current = true;
    setStarting(true);
    onError(null);
    setLastGesture(null);
    stop();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Seu navegador não oferece acesso ao microfone.");
      await refreshInputDevices(true);
      const requestedPatientId = patientIdRef.current;
      if (requestedPatientId == null) throw new Error("Selecione um paciente antes de iniciar a conversa.");
      const requestToken = async (disableVoiceOverride = false) => {
        const response = await fetch("/api/helo/conversation-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patientId: requestedPatientId, disableVoiceOverride }),
        });
        const data = (await response.json().catch(() => null)) as HeloConversationTokenResponse | null;
        if (!response.ok || !data?.conversationToken) {
          throw new Error(data?.error ?? "Não foi possível preparar a conversa.");
        }
        return data;
      };
      const startConversation = async (data: HeloConversationTokenResponse) => {
        await startSession({
          conversationToken: data.conversationToken!,
          connectionType: "webrtc",
          inputDeviceId: selectedInputDeviceIdRef.current || undefined,
          dynamicVariables: data.dynamicVariables,
          overrides: toSessionOverrides(data.overrides),
        });
      };
      // O LiveKit aceita a sessão, mas derruba o socket poucos segundos depois
      // quando recebe o override de voz remoto. A voz oficial configurada no
      // próprio Agent continua sendo usada; não enviamos override por sessão.
      let data = await requestToken(true);
      try {
        await startConversation(data);
      } catch (caught) {
        if (!data.voiceOverrideApplied) throw caught;
        console.warn("[HELO AUDIO] agent start failed with voice override; retrying without override", caught);
        try {
          endSession();
        } catch {
          // A primeira tentativa pode falhar antes de abrir uma sessão WebRTC completa.
        }
        data = await requestToken(true);
        await startConversation(data);
      }
      if (patientIdRef.current !== requestedPatientId) {
        endSession();
        return false;
      }
      const logged = await startLoggedSession("helo", requestedPatientId);
      loggedSessionIdRef.current = logged.id;
      sessionPatientIdRef.current = requestedPatientId;
      setActiveSessionPatientId(requestedPatientId);
      startedRef.current = true;
      // Diagnóstico: confirma QUAIS client tools o cliente registrou nesta
      // sessão. Se as três não aparecerem aqui, o problema é o objeto; se
      // aparecerem mas os logs "called" nunca dispararem, o problema é a
      // DECLARAÇÃO da tool no painel da ElevenLabs (o agente não a conhece).
      console.log("[HELO TOOL] registered client tools", Object.keys(clientTools));
      await refreshInputDevices(false);
      return true;
    } catch (caught) {
      startedRef.current = false;
      onError(describeConversationError(caught));
      return false;
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [clientTools, endSession, onError, refreshInputDevices, startSession, stop]);

  const restartForVoiceChange = useCallback(async (targetPatientId: number) => {
    if (
      !persistentEnabled ||
      !startedRef.current ||
      sessionPatientIdRef.current !== targetPatientId ||
      patientIdRef.current !== targetPatientId
    ) {
      return { ok: false, error: "A sessão atual não pode ser reiniciada para este paciente." };
    }
    setRestarting(true);
    onError(null);
    end();
    const deadline = Date.now() + 5000;
    while (statusRef.current !== "disconnected" && Date.now() < deadline) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    }
    if (statusRef.current !== "disconnected") {
      setRestarting(false);
      const message = "Não foi possível encerrar a conversa atual para trocar a voz.";
      onError(message);
      return { ok: false, error: message };
    }
    if (patientIdRef.current !== targetPatientId) {
      setRestarting(false);
      return { ok: false, error: "O paciente ativo foi alterado." };
    }
    const started = await connect();
    setRestarting(false);
    return started ? { ok: true } : { ok: false, error: "Não foi possível reconectar a Helo." };
  }, [connect, end, onError, persistentEnabled]);

  const markGesture = useCallback((gesture: Gesture) => {
    if (!connectedRef.current || gestureLockRef.current) return;
    gestureLockRef.current = true;
    setGesturePending(true);
    if (gestureUnlockRef.current != null) window.clearTimeout(gestureUnlockRef.current);
    gestureUnlockRef.current = window.setTimeout(() => {
      gestureLockRef.current = false;
      gestureUnlockRef.current = null;
      setGesturePending(false);
    }, GESTURE_RESPONSE_LOCK_MS);
    setLastGesture(gesture);
    sendActivity("gesture", true);
    try {
      sendUserMessage(GESTURE_SEMANTIC_MESSAGES[gesture]);
      if (patientIdRef.current != null) {
        logEvent({
          sessionId: loggedSessionIdRef.current,
          patientId: patientIdRef.current,
          type: gesture === "sim" ? "confirmacao" : gesture === "talvez" ? "reformulacao" : "descarte",
          category: "helo",
          gesture,
          detail: `semanticIntent=${GESTURE_SEMANTIC_INTENTS[gesture]}; inputMethod=gesture`,
        });
      }
    } catch {
      onError("Não foi possível registrar a resposta por gesto. Tente novamente.");
    }
  }, [onError, sendActivity, sendUserMessage]);

  // Ações da tela /helo no Action Registry: os mesmos handlers dos botões
  // (connect/end) e dos gestos (markGesture — o operador RELATA o gesto do
  // paciente; a semântica registrada é idêntica ao toque manual).
  const agentScreenActions = useMemo<HeloUIAction[]>(() => {
    if (pathname !== "/helo") return [];
    const connected = status === "connected";
    return [
      {
        actionId: "helo.conectar",
        label: "Conectar com Helo",
        type: "connect",
        enabled: status === "disconnected" && !starting && !restarting,
        run: async () => {
          const ok = await connect();
          if (!ok) throw new Error("Não foi possível conectar com a Helo.");
        },
      },
      {
        actionId: "helo.solicitarMicrofone",
        label: "Solicitar acesso ao microfone",
        type: "connect",
        enabled: status === "disconnected",
        run: async () => {
          if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error("Seu navegador não oferece acesso ao microfone.");
          }
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((track) => track.stop());
        },
      },
      {
        actionId: "helo.encerrar",
        label: "Encerrar conversa",
        type: "connect",
        enabled: connected,
        run: () => end(),
      },
      ...(connected
        ? [
            {
              actionId: "gesto.confirmar",
              label: "Registrar gesto do paciente: sim",
              type: "gesture",
              enabled: !gesturePending,
              run: () => markGesture("sim"),
            },
            {
              actionId: "gesto.reformular",
              label: "Registrar gesto do paciente: não é bem isso",
              type: "gesture",
              enabled: !gesturePending,
              run: () => markGesture("talvez"),
            },
            {
              actionId: "gesto.recusar",
              label: "Registrar gesto do paciente: não",
              type: "gesture",
              enabled: !gesturePending,
              run: () => markGesture("nao"),
            },
          ] satisfies HeloUIAction[]
        : []),
    ];
  }, [connect, end, gesturePending, markGesture, pathname, restarting, starting, status]);
  useRegisterHeloUIActions(agentScreenActions);

  const label = musicPlayer.status === "generating"
    ? "Compondo uma música especial para você..."
    : musicPlayer.status === "playing"
      ? musicPlayer.source === "history"
        ? `Reproduzindo música do histórico: ${musicPlayer.title} (${musicPlayer.period ?? "histórico"})`
        : "Helo tocando música"
      : restarting
        ? "Reconectando Helo"
        : starting || status === "connecting"
          ? "Conectando"
          : status === "connected" && isSpeaking
            ? "Helo falando"
            : status === "connected" && isListening
              ? "Helo ouvindo"
              : status === "connected"
                ? "Helo aguardando"
                : "Helo encerrada";
  const sessionVisible = restarting || starting || status !== "disconnected";
  const musicIsPlaying = musicPlayer.status === "playing";
  const musicProgressPercent = musicPlayer.duration > 0
    ? Math.min(100, Math.max(0, (musicPlayer.currentTime / musicPlayer.duration) * 100))
    : 0;
  const micActive =
    status === "connected" && !isMuted && !musicIsPlaying && micLevel > MIC_ACTIVITY_THRESHOLD;
  const micStatusLabel = musicIsPlaying
    ? "Microfone pausado durante a música"
    : isMuted
    ? "Microfone mutado"
    : micActive
      ? "Microfone captando"
      : status === "connected"
        ? "Aguardando fala no microfone selecionado"
        : "Aguardando sinal do microfone";
  const connectionStatusDetails = CONNECTION_STATUS_DETAILS[connectionStatus];
  const canSendCaregiverMessage =
    caregiverMessage.trim().length > 0 && !messageSending && status === "connected";

  const stage = (
    <main className="relative flex flex-1 items-center px-4 pb-8 sm:px-6">
      <OverlayVeil />
      <OverlayPanel label="Conversa com a Helo" variant="imersivo" className="relative z-10 max-w-xl">
        <div className="flex flex-col items-center gap-5 text-center">
          <div aria-live="polite" className="text-lg font-medium text-ink">{label}</div>
          <p className="max-w-md text-sm text-ink-soft">A conversa usa a voz oficial da Helo. O microfone só será solicitado ao conectar.</p>
          {status === "disconnected" ? (
            <button type="button" onClick={() => void connect()} disabled={starting} className="rounded-full bg-accent px-7 py-3 font-medium text-on-accent disabled:cursor-wait disabled:opacity-60">
              {starting ? "Conectando..." : "Conectar com Helo"}
            </button>
          ) : (
            <button type="button" onClick={end} className="rounded-full border border-line bg-card px-7 py-3 font-medium text-ink hover:border-ink-mute">Encerrar conversa</button>
          )}
          {status === "connected" && (
            <section className="flex w-full flex-col items-center gap-4 pt-2" aria-label="Atividade do paciente">
              {musicPlayer.status !== "idle" && (
                <div
                  className="relative flex w-full max-w-md flex-col gap-4 rounded-2xl border border-line bg-card/90 p-4 text-left shadow-soft"
                  aria-live="polite"
                  aria-label="Reprodutor de música da Helo"
                >
                  <button
                    type="button"
                    onClick={stopGeneratedMusic}
                    className="absolute right-3 top-3 grid size-10 place-items-center rounded-full text-ink-mute transition-colors hover:bg-line/60 hover:text-ink"
                    aria-label="Fechar reprodutor de música"
                    title="Fechar"
                  >
                    <CloseIcon />
                  </button>
                  {musicPlayer.status === "generating" ? (
                    <div className="flex items-center gap-3 pr-12">
                      <span
                        className="size-5 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent"
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">
                          Compondo uma música especial para você...
                        </p>
                        <p className="mt-1 line-clamp-2 text-xs text-ink-soft">{musicPlayer.prompt}</p>
                      </div>
                    </div>
                  ) : musicPlayer.status === "playing" || musicPlayer.status === "paused" || musicPlayer.status === "ended" ? (
                    <>
                      <div className="min-w-0 pr-12">
                        <p className="truncate text-sm font-medium text-ink">{musicPlayer.title}</p>
                        <p className="mt-1 line-clamp-2 text-xs text-ink-soft">
                          {musicPlayer.source === "history" && musicPlayer.period
                            ? `Histórico · ${musicPlayer.period} · `
                            : ""}
                          {musicPlayer.genre ? `${musicPlayer.genre} · ` : ""}
                          {musicPlayer.prompt}
                        </p>
                        {musicPlayer.status === "paused" && musicPlayer.currentTime === 0 && (
                          <p className="mt-2 text-xs font-medium text-ink-soft">
                            Música pronta. Toque em Tocar para iniciar.
                          </p>
                        )}
                      </div>
                      <div>
                        <div className="mb-2 flex items-center justify-between text-xs tabular-nums text-ink-mute">
                          <span>
                            {formatPlaybackTime(musicPlayer.currentTime)} / {formatPlaybackTime(musicPlayer.duration)}
                          </span>
                          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                            {musicPlayer.status === "playing"
                              ? "Tocando"
                              : musicPlayer.status === "ended"
                                ? "Finalizada"
                                : "Pausada"}
                          </span>
                        </div>
                        <div
                          ref={musicSeekBarRef}
                          role="slider"
                          tabIndex={0}
                          aria-label="Posição da música"
                          aria-valuemin={0}
                          aria-valuemax={Math.round(musicPlayer.duration)}
                          aria-valuenow={Math.round(musicPlayer.currentTime)}
                          aria-valuetext={`${formatPlaybackTime(musicPlayer.currentTime)} de ${formatPlaybackTime(musicPlayer.duration)}`}
                          onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
                            event.preventDefault();
                            beginMusicSeek(event.clientX);
                          }}
                          onTouchStart={(event: ReactTouchEvent<HTMLDivElement>) => {
                            if (!event.touches[0]) return;
                            event.preventDefault();
                            beginMusicSeek(event.touches[0].clientX);
                          }}
                          onTouchMove={(event: ReactTouchEvent<HTMLDivElement>) => {
                            if (!musicSeekingRef.current || !event.touches[0]) return;
                            event.preventDefault();
                            seekMusicFromClientX(event.touches[0].clientX);
                          }}
                          onTouchEnd={endMusicSeek}
                          onKeyDown={(event) => {
                            if (musicPlayer.duration <= 0) return;
                            const step = Math.max(1, musicPlayer.duration / 100);
                            if (event.key === "ArrowLeft") {
                              event.preventDefault();
                              seekMusicPlayback(musicPlayer.currentTime - step);
                            } else if (event.key === "ArrowRight") {
                              event.preventDefault();
                              seekMusicPlayback(musicPlayer.currentTime + step);
                            } else if (event.key === "Home") {
                              event.preventDefault();
                              seekMusicPlayback(0);
                            } else if (event.key === "End") {
                              event.preventDefault();
                              seekMusicPlayback(musicPlayer.duration);
                            }
                          }}
                          className="group relative mt-1 flex h-10 w-full cursor-pointer touch-none select-none items-center"
                        >
                          <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800/80 shadow-inner">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-[width] duration-100"
                              style={{ width: `${musicProgressPercent}%` }}
                            />
                          </div>
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-emerald-500 bg-white shadow-md transition-transform duration-150 group-hover:scale-125 group-active:scale-125"
                            style={{ left: `${musicProgressPercent}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-xs tabular-nums text-ink-mute">
                          <span>{formatPlaybackTime(musicPlayer.currentTime)}</span>
                          <span>{formatPlaybackTime(musicPlayer.duration)}</span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p role="alert" className="text-sm text-danger">{musicPlayer.error}</p>
                  )}
                  {musicPlayer.status === "generating" ? (
                    <button
                      type="button"
                      onClick={stopGeneratedMusic}
                      className="min-h-11 rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong"
                      aria-label="Cancelar geração da música"
                    >
                      Cancelar
                    </button>
                  ) : musicPlayer.status !== "error" ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={
                          musicPlayer.status === "playing"
                            ? pauseMusicPlayback
                            : () => void resumeMusicPlayback()
                        }
                        className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong"
                          aria-label={
                            musicPlayer.status === "playing"
                              ? "Pausar música e reativar a conversa com a Helo"
                              : musicPlayer.status === "ended"
                                ? "Tocar música novamente desde o começo"
                                : musicPlayer.currentTime === 0
                                  ? "Tocar música"
                                : "Retomar música"
                          }
                          title={
                            musicPlayer.status === "playing"
                              ? "Pausar"
                              : musicPlayer.status === "ended"
                                ? "Tocar novamente"
                                : musicPlayer.currentTime === 0
                                  ? "Tocar"
                                : "Retomar"
                          }
                      >
                        {musicPlayer.status === "playing"
                          ? <PauseIcon />
                          : musicPlayer.status === "ended"
                            ? <ReplayIcon />
                            : <PlayIcon />}
                        <span>
                          {musicPlayer.status === "playing"
                            ? "Pausar"
                            : musicPlayer.status === "ended"
                              ? "Tocar novamente"
                              : musicPlayer.currentTime === 0
                                ? "Tocar"
                              : "Retomar"}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void replayMusicPlayback()}
                        className="grid size-11 shrink-0 place-items-center rounded-full border border-line bg-card text-ink transition-colors hover:border-ink-mute hover:bg-line/30"
                        aria-label="Tocar novamente desde o início"
                        title="Tocar novamente"
                      >
                        <ReplayIcon />
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
              <GestureTriplet onGesture={markGesture} size="compacto" disabled={gesturePending} highlighted={gesturesHighlighted} />
              <div className="flex w-full max-w-md flex-col gap-2 text-left">
                <label className="text-sm font-medium text-ink-soft" htmlFor="helo-input-device">Microfone</label>
                <div className="flex gap-2">
                  <select
                    id="helo-input-device"
                    className="min-w-0 flex-1 rounded-2xl border border-line bg-card/80 px-4 py-3 text-sm text-ink outline-none focus:border-ink-mute"
                    value={selectedInputDeviceId}
                    onChange={(event) => void handleInputDeviceChange(event.target.value)}
                  >
                    <option value="">Microfone padrão do navegador</option>
                    {inputDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="shrink-0 rounded-2xl border border-line bg-card px-4 text-sm font-medium text-ink hover:border-ink-mute"
                    onClick={() => void refreshInputDevices(true)}
                  >
                    Atualizar
                  </button>
                </div>
                {inputDeviceError && <p role="alert" className="text-xs text-danger">{inputDeviceError}</p>}
              </div>
              <div className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-line bg-card/70 px-4 py-3 text-left">
                <span className={`size-2.5 shrink-0 rounded-full ${micActive ? "bg-sim" : "bg-ink-mute"}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{micStatusLabel}</p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
                    <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${Math.min(100, Math.round(micLevel * 100))}%` }} />
                  </div>
                </div>
              </div>
              <div className="min-h-5 text-sm text-ink-soft" aria-live="polite">
                {gesturePending ? "Registrando resposta..." : lastGesture ? `Resposta registrada: ${GESTURE_SEMANTIC_INTENTS[lastGesture]}.` : "Helo continua disponível durante a navegação quando o assistente persistente está ativado."}
              </div>
              <div className="flex w-full max-w-md flex-col gap-2 text-left">
                <label className="text-sm text-ink-soft" htmlFor="helo-caregiver-message">
                  Mensagem para a Helo
                </label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                  <textarea
                    id="helo-caregiver-message"
                    aria-label="Mensagem para a Helo"
                    value={caregiverMessage}
                    onFocus={() => setMessageFocused(true)}
                    onBlur={() => setMessageFocused(false)}
                    onChange={(event) => {
                      setCaregiverMessage(event.target.value);
                      setMessageError("");
                      sendActivity("typing");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendCaregiverMessage();
                      }
                    }}
                    placeholder="Escreva uma mensagem para orientar a Helo."
                    rows={3}
                    className="min-h-24 w-full resize-none rounded-2xl border border-line bg-card/80 px-4 py-3 text-base text-ink outline-none focus:border-ink-mute"
                  />
                  <button
                    type="button"
                    aria-label="Enviar mensagem para a Helo"
                    onClick={() => void sendCaregiverMessage()}
                    disabled={!canSendCaregiverMessage}
                    className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-2xl bg-accent px-4 py-3 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60 sm:self-end"
                  >
                    {messageSending ? (
                      <svg aria-hidden="true" className="size-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M12 3a9 9 0 0 1 9 9h-3a6 6 0 0 0-6-6V3Z" />
                      </svg>
                    ) : (
                      <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m22 2-7 20-4-9-9-4Z" />
                        <path d="M22 2 11 13" />
                      </svg>
                    )}
                    {messageSending ? "Enviando" : "Enviar"}
                  </button>
                </div>
                <p className="text-xs text-ink-mute">Pressione Enter para enviar ou Shift+Enter para uma nova linha.</p>
                {messageFocused && <p className="text-xs text-ink-mute">A Helo recebe a mensagem durante a conversa e ela é registrada no dashboard do paciente.</p>}
                {messageError && <p role="alert" className="text-xs text-danger">{messageError}</p>}
              </div>
            </section>
          )}
          {error && <p role="alert" className="text-center text-sm text-danger">{error}</p>}
        </div>
      </OverlayPanel>
    </main>
  );

  const agentContext = useMemo<HeloAgentContextValue>(() => ({
    activeSessionPatientId,
    sessionStatus: status,
    restarting,
    speakActivityQuestion,
    restartForVoiceChange,
  }), [activeSessionPatientId, restartForVoiceChange, restarting, speakActivityQuestion, status]);

  return (
    <HeloAgentContext.Provider value={agentContext}>
      {mount && createPortal(stage, mount)}
      {sessionVisible && (
        <aside aria-live="polite" className="fixed bottom-24 right-4 z-[70] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-2xl border border-line bg-card/95 px-4 py-3 shadow-soft backdrop-blur-sm sm:bottom-4">
          <span
            role="img"
            aria-label={connectionStatusDetails.label}
            title={connectionStatusDetails.label}
            className={`size-2 shrink-0 rounded-full transition-colors duration-300 ${connectionStatusDetails.dotClassName}`}
          />
          <div className="min-w-0"><p className="text-sm font-medium text-ink">{label}</p><p className="text-xs text-ink-soft">Helo ativa</p></div>
          <button
            type="button"
            onClick={toggleAgentMute}
            title={isAgentMuted ? "Agente silenciado e microfone desativado (Clique para desmutar)" : "Silenciar agente e desativar microfone"}
            aria-label={isAgentMuted ? "Agente silenciado e microfone desativado (Clique para desmutar)" : "Silenciar agente e desativar microfone"}
            aria-pressed={isAgentMuted}
            className={`grid size-9 shrink-0 place-items-center rounded-lg p-1.5 transition-colors ${
              isAgentMuted
                ? "border border-red-500/20 bg-red-500/10 text-red-400"
                : "text-neutral-400 hover:bg-white/5 hover:text-emerald-400"
            }`}
          >
            {isAgentMuted ? <VolumeXIcon /> : <Volume2Icon />}
          </button>
          {isAgentMuted && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-red-500/20 bg-red-500/10 px-2 py-1 text-[10px] font-medium text-red-400">
              <MicOffIcon />
              Microfone desligado
            </span>
          )}
          <button type="button" onClick={end} className="shrink-0 rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink hover:border-ink-mute">Encerrar Helo</button>
        </aside>
      )}
      {children}
    </HeloAgentContext.Provider>
  );
}

export function HeloAgentProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <ConversationProvider onError={() => setError("A conversa foi interrompida. Verifique sua conexão e tente novamente.")}>
      <HeloAgentSession error={error} onError={setError}>{children}</HeloAgentSession>
    </ConversationProvider>
  );
}

export function useHeloAgent(): HeloAgentContextValue {
  const context = useContext(HeloAgentContext);
  if (!context) throw new Error("useHeloAgent precisa estar dentro de <HeloAgentProvider>");
  return context;
}
