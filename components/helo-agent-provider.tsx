"use client";

// Sessão única do Agent Helo, montada acima das páginas. Ela só permanece
// entre rotas quando a opção do paciente está ligada; fora disso, sair de
// /helo reproduz o comportamento anterior de encerrar a conversa.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import type { Conversation as ElevenLabsConversation, SessionConfig } from "@elevenlabs/client";
import { usePathname, useRouter } from "next/navigation";
import { OverlayPanel, OverlayVeil } from "@/components/overlay-panel";
import { GestureTriplet } from "@/components/ui";
import { GESTURE_SEMANTIC_INTENTS, GESTURE_SEMANTIC_MESSAGES } from "@/lib/gestures";
import { useHelo } from "@/lib/helo-state";
import { usePatient } from "@/lib/patient";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
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

type HeloApiOverrides = { tts?: { voice_id?: string } };
type HeloSessionOverrides = NonNullable<SessionConfig["overrides"]>;
type ActivitySource = "gesture" | "typing" | "field-focus" | "heartbeat";
type ElevenLabsErrorEvent = { error_event?: Record<string, unknown> };
type PatchableConversation = ElevenLabsConversation & {
  handleErrorEvent?: (event: ElevenLabsErrorEvent) => void;
  __heloIncompleteErrorEventPatch?: boolean;
};

const ACTIVITY_THROTTLE_MS = 3000;
const ACTIVITY_HEARTBEAT_MS = 15000;
const ACTIVE_WINDOW_MS = 60000;
const GESTURE_RESPONSE_LOCK_MS = 1200;
const GESTURE_CHOICES_HIGHLIGHT_MS = 8000;

type HeloAgentContextValue = {
  activeSessionPatientId: number | null;
  sessionStatus: string;
  restarting: boolean;
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
  const persistentEnabled = settings[PATIENT_SETTING_KEYS.heloPersistentAssistantEnabled] === "true";
  const [starting, setStarting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [activeSessionPatientId, setActiveSessionPatientId] = useState<number | null>(null);
  const [lastGesture, setLastGesture] = useState<Gesture | null>(null);
  const [gesturePending, setGesturePending] = useState(false);
  const [gesturesHighlighted, setGesturesHighlighted] = useState(false);
  const [note, setNote] = useState("");
  const [noteFocused, setNoteFocused] = useState(false);
  const [mount, setMount] = useState<HTMLElement | null>(null);
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

  const toolResult = useCallback((value: Record<string, unknown>) => JSON.stringify(value), []);
  const authorizeTool = useCallback(async (
    action: HeloClientToolAction,
    options?: { area?: string; section?: string }
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
    if (!isHeloNavigationArea(area)) return toolResult({ ok: false, error: "Área de navegação inválida" });
    const access = await authorizeTool(action, { area });
    if (!access.ok) return toolResult(access);
    router.push(HELO_AREA_ROUTES[area]);
    return toolResult({ ok: true, action, targetArea: area });
  }, [authorizeTool, router, toolResult]);

  const clientTools = useMemo(() => ({
    navigateHeloArea: async (parameters: Record<string, unknown>) =>
      typeof parameters.targetArea === "string"
        ? navigateToArea("navigateHeloArea", parameters.targetArea)
        : toolResult({ ok: false, error: "targetArea inválido" }),
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
  }), [authorizeTool, navigateToArea, pathname, router, toolResult]);

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
    clientTools,
    onUnhandledClientToolCall: () => {},
  });

  const end = useCallback(() => {
    activeUntilRef.current = 0;
    gestureLockRef.current = false;
    if (gestureUnlockRef.current != null) window.clearTimeout(gestureUnlockRef.current);
    gestureUnlockRef.current = null;
    setGesturePending(false);
    endLoggedSession(loggedSessionIdRef.current);
    loggedSessionIdRef.current = null;
    sessionPatientIdRef.current = null;
    setActiveSessionPatientId(null);
    if (startedRef.current) endSession();
    startedRef.current = false;
    setAgentAmplitude(null);
  }, [endSession, setAgentAmplitude]);

  useEffect(() => {
    patientIdRef.current = patientId;
  }, [patientId]);

  useEffect(() => {
    connectedRef.current = status === "connected";
    statusRef.current = status;
    if (status === "disconnected") {
      activeUntilRef.current = 0;
      lastActivitySentAtRef.current = 0;
    }
  }, [status]);

  useEffect(() => {
    // A página é apenas o ponto visual. Com a persistência desligada, sair
    // dela conserva exatamente a regra anterior de encerrar a conversa.
    if (!persistentEnabled && pathname !== "/helo" && startedRef.current) end();
  }, [end, pathname, persistentEnabled]);

  useEffect(() => {
    if (!startedRef.current || sessionPatientIdRef.current === patientId) return;
    setLastGesture(null);
    setNote("");
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
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [getOutputByteFrequencyData, setAgentAmplitude]);

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

  useEffect(() => {
    if (status !== "connected") return;
    const interval = window.setInterval(() => {
      if (Date.now() <= activeUntilRef.current) sendActivity("heartbeat");
    }, ACTIVITY_HEARTBEAT_MS);
    return () => window.clearInterval(interval);
  }, [sendActivity, status]);

  useEffect(() => {
    if (pathname !== "/helo") {
      setMount(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => setMount(document.getElementById("helo-agent-stage")));
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      const requestedPatientId = patientIdRef.current;
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
      if (!response.ok || !data?.conversationToken) throw new Error(data?.error ?? "Não foi possível preparar a conversa.");
      if (patientIdRef.current !== requestedPatientId) return false;
      const logged = await startLoggedSession("helo", requestedPatientId);
      loggedSessionIdRef.current = logged.id;
      sessionPatientIdRef.current = requestedPatientId;
      setActiveSessionPatientId(requestedPatientId);
      startedRef.current = true;
      startSession({
        conversationToken: data.conversationToken,
        connectionType: "webrtc",
        dynamicVariables: data.dynamicVariables,
        overrides: toSessionOverrides(data.overrides),
      });
      return true;
    } catch (caught) {
      startedRef.current = false;
      const name = caught instanceof DOMException ? caught.name : "";
      onError(
        name === "NotAllowedError"
          ? "Permissão do microfone negada. Autorize o microfone e tente novamente."
          : caught instanceof Error ? caught.message : "Não foi possível iniciar a conversa."
      );
      return false;
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [onError, startSession, stop]);

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

  const label = restarting
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
              <GestureTriplet onGesture={markGesture} size="compacto" disabled={gesturePending} highlighted={gesturesHighlighted} />
              <div className="min-h-5 text-sm text-ink-soft" aria-live="polite">
                {gesturePending ? "Registrando resposta..." : lastGesture ? `Resposta registrada: ${GESTURE_SEMANTIC_INTENTS[lastGesture]}.` : "Helo continua disponível durante a navegação quando o assistente persistente está ativado."}
              </div>
              <label className="flex w-full max-w-md flex-col gap-2 text-left text-sm text-ink-soft">
                Observação em andamento
                <textarea value={note} onFocus={() => setNoteFocused(true)} onBlur={() => setNoteFocused(false)} onChange={(event) => { setNote(event.target.value); sendActivity("typing"); }} placeholder="Anote apenas para orientar o cuidado nesta tela." rows={3} className="w-full resize-none rounded-2xl border border-line bg-card/80 px-4 py-3 text-base text-ink outline-none focus:border-ink-mute" />
              </label>
              {noteFocused && <p className="max-w-md text-xs text-ink-mute">Enquanto há edição real, a Helo recebe apenas sinal de atividade.</p>}
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
    restartForVoiceChange,
  }), [activeSessionPatientId, restartForVoiceChange, restarting, status]);

  return (
    <HeloAgentContext.Provider value={agentContext}>
      {mount && createPortal(stage, mount)}
      {sessionVisible && (
        <aside aria-live="polite" className="fixed bottom-4 right-4 z-[70] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-2xl border border-line bg-card/95 px-4 py-3 shadow-soft backdrop-blur-sm">
          <span className="size-2 shrink-0 rounded-full bg-accent" aria-hidden="true" />
          <div className="min-w-0"><p className="text-sm font-medium text-ink">{label}</p><p className="text-xs text-ink-soft">Helo ativa</p></div>
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
