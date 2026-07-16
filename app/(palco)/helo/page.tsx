"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import type { Conversation as ElevenLabsConversation, SessionConfig } from "@elevenlabs/client";
import { useRouter } from "next/navigation";
import { OverlayPanel, OverlayVeil } from "@/components/overlay-panel";
import { GestureTriplet } from "@/components/ui";
import { GESTURE_SEMANTIC_INTENTS, GESTURE_SEMANTIC_MESSAGES } from "@/lib/gestures";
import { useHelo } from "@/lib/helo-state";
import { usePatient } from "@/lib/patient";
import {
  HELO_AREA_ROUTES,
  isHeloNavigationArea,
  isHeloSettingsSection,
  type HeloClientToolAction,
} from "@/lib/helo-client-tools";
import {
  endSession as endLoggedSession,
  logEvent,
  startSession as startLoggedSession,
} from "@/lib/log";
import type { Gesture } from "@/lib/types";

type SessionError = string | null;
type ActivitySource = "control" | "gesture" | "typing" | "field-focus" | "heartbeat";
type HeloApiOverrides = { tts?: { voice_id?: string } };
type HeloSessionOverrides = NonNullable<SessionConfig["overrides"]>;

const ACTIVITY_THROTTLE_MS = 3000;
const ACTIVITY_HEARTBEAT_MS = 15000;
const ACTIVE_WINDOW_MS = 60000;
const GESTURE_RESPONSE_LOCK_MS = 1200;
const GESTURE_CHOICES_HIGHLIGHT_MS = 8000;
const ACTIVITY_DEBUG = process.env.NODE_ENV !== "production";

type ElevenLabsErrorEvent = {
  error_event?: {
    error_type?: string;
    message?: string;
    reason?: string;
    code?: unknown;
    debug_message?: unknown;
    details?: unknown;
  };
};
type PatchableConversation = ElevenLabsConversation & {
  handleErrorEvent?: (event: ElevenLabsErrorEvent) => void;
  __heloIncompleteErrorEventPatch?: boolean;
};

function patchIncompleteElevenLabsErrorEvent(conversation: ElevenLabsConversation) {
  const patched = conversation as PatchableConversation;
  if (patched.__heloIncompleteErrorEventPatch || typeof patched.handleErrorEvent !== "function") return;
  const handleErrorEvent = patched.handleErrorEvent.bind(patched);
  patched.handleErrorEvent = (event) => {
    if (event.error_event) {
      handleErrorEvent(event);
      return;
    }
    if (ACTIVITY_DEBUG) {
      console.warn("[HELO AGENT] ignored incomplete ElevenLabs error event", event);
    }
  };
  patched.__heloIncompleteErrorEventPatch = true;
}

function isBenignLiveKitDataChannelError(value: unknown) {
  return (
    typeof value === "string" &&
    (value === "Unknown DataChannel error on lossy" ||
      value === "Unknown DataChannel error on reliable")
  );
}

function toElevenLabsSessionOverrides(overrides?: HeloApiOverrides): HeloSessionOverrides | undefined {
  // @elevenlabs/client 1.15.0 recebe voiceId e serializa para o protocolo
  // oficial ElevenLabs como conversation_config_override.tts.voice_id.
  const voiceId = overrides?.tts?.voice_id?.trim();
  return voiceId ? { tts: { voiceId } } : undefined;
}

function HeloSession({ onError }: { onError: (message: string) => void }) {
  const { stop, setAgentAmplitude } = useHelo();
  const { patientId } = usePatient();
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [lastGesture, setLastGesture] = useState<Gesture | null>(null);
  const [note, setNote] = useState("");
  const [noteFocused, setNoteFocused] = useState(false);
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null);
  const [interruptionDetected, setInterruptionDetected] = useState(false);
  const [gestureResponsePending, setGestureResponsePending] = useState(false);
  const [gestureChoicesHighlighted, setGestureChoicesHighlighted] = useState(false);
  const [toolFeedback, setToolFeedback] = useState<string | null>(null);
  const startedRef = useRef(false);
  const startingRef = useRef(false);
  const connectedRef = useRef(false);
  const mountedRef = useRef(true);
  const activeUntilRef = useRef(0);
  const lastActivitySentAtRef = useRef(0);
  const gestureResponseLockedRef = useRef(false);
  const gestureResponseUnlockRef = useRef<number | null>(null);
  const gestureChoicesHighlightRef = useRef<number | null>(null);
  const loggedSessionIdRef = useRef<number | null>(null);
  const sessionPatientIdRef = useRef<number | null>(null);
  const patientIdRef = useRef<number | null>(patientId);

  const toolResult = useCallback((value: Record<string, unknown>) => JSON.stringify(value), []);

  const authorizeTool = useCallback(
    async (
      action: HeloClientToolAction,
      options?: { area?: string; section?: string }
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const activePatientId = patientIdRef.current;
      if (activePatientId == null) {
        if (ACTIVITY_DEBUG) console.info("[HELO TOOL] no active patient");
        return { ok: false, error: "Paciente ativo não selecionado" };
      }
      try {
        const response = await fetch("/api/helo/client-tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patientId: activePatientId, action, ...options }),
        });
        const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !data?.ok) return { ok: false, error: data?.error ?? "Acesso negado" };
        // A troca de paciente durante a confirmação nunca pode navegar usando
        // a autorização do paciente anterior.
        if (patientIdRef.current !== activePatientId) return { ok: false, error: "O paciente ativo foi alterado" };
        return { ok: true };
      } catch {
        return { ok: false, error: "Não foi possível verificar o acesso" };
      }
    },
    []
  );

  const navigateToArea = useCallback(
    async (action: HeloClientToolAction, area: string, feedback: string) => {
      if (!isHeloNavigationArea(area)) {
        if (ACTIVITY_DEBUG) console.info("[HELO TOOL] invalid targetArea");
        return toolResult({ ok: false, error: "Área de navegação inválida" });
      }
      const access = await authorizeTool(action, { area });
      if (!access.ok) {
        if (ACTIVITY_DEBUG) console.info("[HELO TOOL] failed");
        return toolResult(access);
      }
      if (ACTIVITY_DEBUG) console.info(`[HELO TOOL] ${action} called`);
      setToolFeedback(feedback);
      router.push(HELO_AREA_ROUTES[area]);
      if (ACTIVITY_DEBUG) console.info("[HELO TOOL] success");
      return toolResult({ ok: true, action, targetArea: area });
    },
    [authorizeTool, router, toolResult]
  );

  const clientTools = useMemo(
    () => ({
      navigateHeloArea: async (parameters: Record<string, unknown>) => {
        const targetArea = parameters?.targetArea;
        if (typeof targetArea !== "string") return toolResult({ ok: false, error: "targetArea inválido" });
        return navigateToArea("navigateHeloArea", targetArea, `Abrindo ${targetArea}`);
      },
      openPatientSettings: async (parameters: Record<string, unknown>) => {
        const section = parameters?.section;
        if (!isHeloSettingsSection(section)) {
          if (ACTIVITY_DEBUG) console.info("[HELO TOOL] invalid settings section");
          return toolResult({ ok: false, error: "Seção de ajustes inválida" });
        }
        const access = await authorizeTool("openPatientSettings", { section });
        if (!access.ok) return toolResult(access);
        if (ACTIVITY_DEBUG) console.info("[HELO TOOL] openPatientSettings called");
        setToolFeedback("Abrindo Ajustes");
        router.push(`/ajustes?section=${encodeURIComponent(section)}`);
        if (ACTIVITY_DEBUG) console.info("[HELO TOOL] success");
        return toolResult({ ok: true, action: "openPatientSettings", section });
      },
      openRoutineMode: async (_parameters: Record<string, unknown>) =>
        navigateToArea("openRoutineMode", "rotina", "Abrindo Rotina"),
      openEmergencyMode: async (_parameters: Record<string, unknown>) => {
        const result = await navigateToArea("openEmergencyMode", "emergencia", "Abrindo Emergência");
        // O motivo recebido é deliberadamente ignorado: esta tool só navega.
        try {
          const data = JSON.parse(result) as Record<string, unknown>;
          return toolResult(data.ok ? { ...data, opened: "emergencia", requiresUserConfirmation: true } : data);
        } catch {
          return result;
        }
      },
      openActivitiesMode: async (_parameters: Record<string, unknown>) =>
        navigateToArea("openActivitiesMode", "atividades", "Abrindo Atividades"),
      showGestureChoices: async (_parameters: Record<string, unknown>) => {
        const access = await authorizeTool("showGestureChoices");
        if (!access.ok) return toolResult(access);
        if (ACTIVITY_DEBUG) console.info("[HELO TOOL] showGestureChoices called");
        if (gestureChoicesHighlightRef.current != null) window.clearTimeout(gestureChoicesHighlightRef.current);
        setGestureChoicesHighlighted(true);
        setToolFeedback("Mostrando gestos");
        gestureChoicesHighlightRef.current = window.setTimeout(() => {
          setGestureChoicesHighlighted(false);
          gestureChoicesHighlightRef.current = null;
        }, GESTURE_CHOICES_HIGHLIGHT_MS);
        if (ACTIVITY_DEBUG) console.info("[HELO TOOL] success");
        return toolResult({ ok: true, action: "showGestureChoices" });
      },
    }),
    [authorizeTool, navigateToArea, router, toolResult]
  );

  const {
    startSession,
    endSession,
    status,
    isSpeaking,
    isListening,
    sendUserMessage,
    sendUserActivity,
    getOutputByteFrequencyData,
  } = useConversation({
    onConversationCreated: patchIncompleteElevenLabsErrorEvent,
    onInterruption: () => setInterruptionDetected(true),
    clientTools,
    onUnhandledClientToolCall: (toolCall) => {
      // Não há fallback dinâmico: uma tool não registrada nunca ganha acesso
      // à interface. O log contém apenas o nome técnico, sem parâmetros.
      if (ACTIVITY_DEBUG) console.info("[HELO TOOL] unhandled", toolCall.tool_name);
    },
  });

  useEffect(() => {
    patientIdRef.current = patientId;
  }, [patientId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ACTIVITY_DEBUG) return;
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      if (isBenignLiveKitDataChannelError(args[0])) {
        console.debug("[HELO AGENT]", ...args);
        return;
      }
      originalError(...args);
    };
    return () => {
      console.error = originalError;
    };
  }, []);

  useEffect(() => {
    connectedRef.current = status === "connected";
    if (status !== "connected") {
      activeUntilRef.current = 0;
      lastActivitySentAtRef.current = 0;
    }
  }, [status]);

  useEffect(() => {
    return () => {
      if (gestureResponseUnlockRef.current != null) {
        window.clearTimeout(gestureResponseUnlockRef.current);
      }
      if (gestureChoicesHighlightRef.current != null) {
        window.clearTimeout(gestureChoicesHighlightRef.current);
      }
      gestureResponseLockedRef.current = false;
    };
  }, []);

  const logActivity = useCallback((message: string, source?: ActivitySource) => {
    if (!ACTIVITY_DEBUG) return;
    console.info(`[HELO ACTIVITY] ${message}${source ? ` - source: ${source}` : ""}`);
  }, []);

  const sendActivity = useCallback(
    (source: ActivitySource, options?: { immediate?: boolean; extendActiveWindow?: boolean }) => {
      if (!mountedRef.current) return false;
      if (!connectedRef.current) {
        logActivity("skipped - disconnected", source);
        return false;
      }

      const now = Date.now();
      if (!options?.immediate && now - lastActivitySentAtRef.current < ACTIVITY_THROTTLE_MS) {
        logActivity("throttled", source);
        if (options?.extendActiveWindow) activeUntilRef.current = now + ACTIVE_WINDOW_MS;
        return false;
      }

      try {
        sendUserActivity();
        lastActivitySentAtRef.current = now;
        if (options?.extendActiveWindow) activeUntilRef.current = now + ACTIVE_WINDOW_MS;
        setLastActivityAt(now);
        logActivity("sent", source);
        return true;
      } catch {
        logActivity("skipped - no active conversation", source);
        return false;
      }
    },
    [logActivity, sendUserActivity, setLastActivityAt]
  );

  useEffect(() => {
    if (status !== "connected") return;
    const interval = window.setInterval(() => {
      if (Date.now() <= activeUntilRef.current) {
        sendActivity("heartbeat");
      }
    }, ACTIVITY_HEARTBEAT_MS);
    return () => window.clearInterval(interval);
  }, [sendActivity, status]);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      const bytes = getOutputByteFrequencyData();
      let total = 0;
      for (const value of bytes) total += value * value;
      // RMS normalizado, suavizado pelo próprio loop do OrbStage.
      setAgentAmplitude(bytes.length ? Math.min(1, Math.sqrt(total / bytes.length) / 128) : 0);
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [getOutputByteFrequencyData, setAgentAmplitude]);

  useEffect(() => {
    return () => {
      setAgentAmplitude(null);
      activeUntilRef.current = 0;
      endLoggedSession(loggedSessionIdRef.current);
      loggedSessionIdRef.current = null;
      if (startedRef.current) endSession();
    };
  }, [endSession, setAgentAmplitude]);

  // Trocar o paciente encerra a conversa imediatamente. A próxima conexão
  // sempre busca um token e dynamic variables novos — contexto algum sobrevive.
  useEffect(() => {
    if (!startedRef.current || sessionPatientIdRef.current === patientId) return;
    activeUntilRef.current = 0;
    gestureResponseLockedRef.current = false;
    setGestureResponsePending(false);
    setGestureChoicesHighlighted(false);
    setToolFeedback(null);
    if (gestureChoicesHighlightRef.current != null) {
      window.clearTimeout(gestureChoicesHighlightRef.current);
      gestureChoicesHighlightRef.current = null;
    }
    setLastGesture(null);
    endLoggedSession(loggedSessionIdRef.current);
    loggedSessionIdRef.current = null;
    sessionPatientIdRef.current = null;
    startedRef.current = false;
    setAgentAmplitude(null);
    endSession();
  }, [endSession, patientId, setAgentAmplitude]);

  const connect = useCallback(async () => {
    if (startingRef.current || status !== "disconnected") return;
    startingRef.current = true;
    setStarting(true);
    setLastActivityAt(null);
    setLastGesture(null);
    setInterruptionDetected(false);
    stop(); // evita sobreposição com a camada TTS existente da plataforma
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Seu navegador não oferece acesso ao microfone.");
      }
      // Explica e pede consentimento antes de a SDK iniciar sua própria captura.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());

      const requestedPatientId = patientId;
      if (requestedPatientId == null) throw new Error("Selecione um paciente antes de iniciar a conversa.");
      const response = await fetch("/api/helo/conversation-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId: requestedPatientId }),
      });
      const data = (await response.json().catch(() => null)) as {
        conversationToken?: string;
        dynamicVariables?: Record<string, string | number | boolean>;
        overrides?: HeloApiOverrides;
        error?: string;
      } | null;
      if (!response.ok || !data?.conversationToken) {
        throw new Error(data?.error ?? "Não foi possível preparar a conversa.");
      }
      // Uma resposta antiga nunca pode iniciar a sessão do paciente recém-selecionado.
      if (patientIdRef.current !== requestedPatientId) return;
      const loggedSession = await startLoggedSession("helo", requestedPatientId);
      loggedSessionIdRef.current = loggedSession.id;
      sessionPatientIdRef.current = requestedPatientId;
      startedRef.current = true;
      const sessionOverrides = toElevenLabsSessionOverrides(data.overrides);
      startSession({
        conversationToken: data.conversationToken,
        connectionType: "webrtc",
        dynamicVariables: data.dynamicVariables,
        overrides: sessionOverrides,
      });
    } catch (error) {
      startedRef.current = false;
      const name = error instanceof DOMException ? error.name : "";
      onError(
        name === "NotAllowedError"
          ? "Permissão do microfone negada. Autorize o microfone e tente novamente."
          : name === "NotFoundError"
            ? "Nenhum microfone foi encontrado."
            : name === "NotReadableError"
              ? "O microfone está em uso por outro aplicativo."
              : error instanceof Error
                ? error.message
                : "Não foi possível iniciar a conversa."
      );
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [
    onError,
    setInterruptionDetected,
    setLastActivityAt,
    setLastGesture,
    setStarting,
    patientId,
    startSession,
    status,
    stop,
  ]);

  const end = useCallback(() => {
    activeUntilRef.current = 0;
    gestureResponseLockedRef.current = false;
    setGestureResponsePending(false);
    if (gestureResponseUnlockRef.current != null) {
      window.clearTimeout(gestureResponseUnlockRef.current);
      gestureResponseUnlockRef.current = null;
    }
    endLoggedSession(loggedSessionIdRef.current);
    loggedSessionIdRef.current = null;
    sessionPatientIdRef.current = null;
    if (status !== "disconnected" || startedRef.current) endSession();
    startedRef.current = false;
    setAgentAmplitude(null);
  }, [endSession, setAgentAmplitude, status]);

  const markGesture = useCallback(
    (gesture: Gesture) => {
      if (!connectedRef.current || gestureResponseLockedRef.current) return;
      gestureResponseLockedRef.current = true;
      setGestureResponsePending(true);
      if (gestureResponseUnlockRef.current != null) {
        window.clearTimeout(gestureResponseUnlockRef.current);
      }
      gestureResponseUnlockRef.current = window.setTimeout(() => {
        gestureResponseLockedRef.current = false;
        gestureResponseUnlockRef.current = null;
        setGestureResponsePending(false);
      }, GESTURE_RESPONSE_LOCK_MS);

      setLastGesture(gesture);
      sendActivity("gesture", { immediate: true, extendActiveWindow: true });
      try {
        // `user_message` é a via oficial do SDK para uma resposta do usuário.
        // O texto preserva a autoria observada e a intenção, não o emoji visual.
        sendUserMessage(GESTURE_SEMANTIC_MESSAGES[gesture]);
        if (patientId != null) {
          logEvent({
            sessionId: loggedSessionIdRef.current,
            patientId,
            type:
              gesture === "sim"
                ? "confirmacao"
                : gesture === "talvez"
                  ? "reformulacao"
                  : "descarte",
            category: "helo",
            gesture,
            detail: `semanticIntent=${GESTURE_SEMANTIC_INTENTS[gesture]}; inputMethod=gesture`,
          });
        }
      } catch {
        onError("Não foi possível registrar a resposta por gesto. Tente novamente.");
      }
    },
    [onError, patientId, sendActivity, sendUserMessage, setLastGesture]
  );

  const handlePanelPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!connectedRef.current) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-helo-gesture-controls]")) return;
      if (target.closest("button,a,input,textarea,select,[role='button']")) {
        sendActivity("control");
      }
    },
    [sendActivity]
  );

  const label =
    starting || status === "connecting"
      ? "Conectando..."
      : status === "connected" && isSpeaking
        ? "Helo está falando..."
        : status === "connected" && isListening
          ? "Ouvindo..."
          : status === "connected"
            ? "Conectada"
            : "Desconectada";
  const waitingLabel =
    status === "connected" && isListening
      ? "Aguardando sua resposta"
      : status === "connected" && !isSpeaking
        ? "Helo está aguardando"
        : null;
  const lastActivityLabel = lastActivityAt
    ? `Atividade registrada às ${new Date(lastActivityAt).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : "Nenhuma atividade de interface registrada nesta sessão.";
  const interruptionLabel = interruptionDetected ? "Interrupção natural detectada nesta sessão." : null;

  return (
    <div className="flex flex-col items-center gap-5 text-center" onPointerDownCapture={handlePanelPointerDown}>
      <div aria-live="polite" className="text-lg font-medium text-ink">{label}</div>
      {waitingLabel && (
        <div aria-live="polite" className="rounded-full border border-line bg-card/70 px-4 py-1.5 text-sm text-ink-soft">
          {waitingLabel}
        </div>
      )}
      <p className="max-w-md text-sm text-ink-soft">
        A conversa usa a voz oficial da Helo. O microfone só será solicitado ao conectar.
      </p>
      {status === "disconnected" ? (
        <button type="button" onClick={() => void connect()} disabled={starting} className="rounded-full bg-accent px-7 py-3 font-medium text-on-accent disabled:cursor-wait disabled:opacity-60">
          {starting ? "Conectando..." : "Conectar com Helo"}
        </button>
      ) : (
        <button type="button" onClick={end} className="rounded-full border border-line bg-card px-7 py-3 font-medium text-ink hover:border-ink-mute">
          Encerrar conversa
        </button>
      )}
      {status === "connected" && (
        <section className="flex w-full flex-col items-center gap-4 pt-2" aria-label="Atividade do paciente">
          <div data-helo-gesture-controls>
            <GestureTriplet
              onGesture={markGesture}
              size="compacto"
              disabled={gestureResponsePending}
              highlighted={gestureChoicesHighlighted}
            />
          </div>
          {toolFeedback && <p role="status" className="text-sm text-ink-soft">{toolFeedback}</p>}
          <div className="min-h-5 text-sm text-ink-soft" aria-live="polite">
            {gestureResponsePending
              ? "Registrando resposta..."
              : lastGesture
              ? `Resposta registrada: ${GESTURE_SEMANTIC_INTENTS[lastGesture]}.`
              : lastActivityLabel}
          </div>
          <label className="flex w-full max-w-md flex-col gap-2 text-left text-sm text-ink-soft">
            Observação em andamento
            <textarea
              value={note}
              onFocus={() => {
                setNoteFocused(true);
                if (note.trim()) sendActivity("field-focus", { extendActiveWindow: true });
              }}
              onBlur={() => setNoteFocused(false)}
              onChange={(event) => {
                setNote(event.target.value);
                sendActivity("typing", { extendActiveWindow: true });
              }}
              placeholder="Anote apenas para orientar o cuidado nesta tela."
              rows={3}
              className="w-full resize-none rounded-2xl border border-line bg-card/80 px-4 py-3 text-base text-ink outline-none transition-colors placeholder:text-ink-mute focus:border-ink-mute"
            />
          </label>
          {noteFocused && (
            <p className="max-w-md text-xs text-ink-mute">
              Enquanto há edição real, a Helo recebe apenas sinal de atividade.
            </p>
          )}
          {interruptionLabel && <p className="text-xs text-ink-mute">{interruptionLabel}</p>}
        </section>
      )}
    </div>
  );
}

export default function HeloPage() {
  const [error, setError] = useState<SessionError>(null);
  return (
    <main className="relative flex flex-1 items-center px-4 pb-8 sm:px-6">
      <OverlayVeil />
      <OverlayPanel label="Conversa com a Helo" variant="imersivo" className="relative z-10 max-w-xl">
        <ConversationProvider onError={() => setError("A conversa foi interrompida. Verifique sua conexão e tente novamente.") }>
          <HeloSession onError={setError} />
        </ConversationProvider>
        {error && <p role="alert" className="mt-5 text-center text-sm text-danger">{error}</p>}
      </OverlayPanel>
    </main>
  );
}
