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
import {
  registerAgentSuppressor,
  setAgentConversationActive,
  setAgentSpeaking,
} from "@/lib/audio-coordinator";
import { usePatient } from "@/lib/patient";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
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

type HeloApiOverrides = { tts?: { voice_id?: string } };
type HeloSessionOverrides = NonNullable<SessionConfig["overrides"]>;
type ActivitySource = "gesture" | "typing" | "field-focus" | "heartbeat";
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

const ACTIVITY_THROTTLE_MS = 3000;
const ACTIVITY_HEARTBEAT_MS = 15000;
const ACTIVE_WINDOW_MS = 60000;
const GESTURE_RESPONSE_LOCK_MS = 1200;
const GESTURE_CHOICES_HIGHLIGHT_MS = 8000;
const MIC_ACTIVITY_THRESHOLD = 0.02;
const MIC_METER_UPDATE_MS = 160;
const MIC_DEBUG_LOG_MS = 1500;
const MIC_DEVICE_STORAGE_KEY = "heloAgentInputDeviceId";

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
  const [micLevel, setMicLevel] = useState(0);
  const [inputDevices, setInputDevices] = useState<MicInputDevice[]>([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState("");
  const [inputDeviceError, setInputDeviceError] = useState("");
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

  const clearLocalSessionState = useCallback(() => {
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
    startedRef.current = false;
    setMicLevel(0);
    setAgentAmplitude(null);
  }, [setAgentAmplitude]);

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
      if (typeof resolvedScreen === "string" && resolvedScreen.startsWith("routine")) {
        console.log("[HELO TOOL] routine actions returned", uiActions.length);
      }
      return toolResult({
        ok: true,
        screen: resolvedScreen,
        patientId: activePatientId ?? "debug",
        ...(screenContext?.extra ?? {}),
        actions: [debugAction, ...uiActions],
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
  }, [authorizeTool, navigateToArea, pathname, router, toolResult]);

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
      onError(null);
    },
    onDisconnect: (details) => {
      console.log("[HELO AUDIO] agent disconnected", details);
      clearLocalSessionState();
      if (details.reason !== "user") {
        onError("A conexão da Helo caiu. Se acontecer novamente, selecione o microfone físico e conecte de novo.");
      }
    },
    onError: (message, context) => {
      console.error("[HELO AUDIO] agent error", message, context);
      clearLocalSessionState();
      onError(message || "A conversa foi interrompida. Verifique sua conexão e tente novamente.");
    },
    onModeChange: ({ mode }) => {
      console.log("[HELO AUDIO] agent mode", mode);
    },
    onVadScore: ({ vadScore }) => {
      const now = Date.now();
      if (vadScore > MIC_ACTIVITY_THRESHOLD && now - lastMicDebugLogRef.current > MIC_DEBUG_LOG_MS) {
        lastMicDebugLogRef.current = now;
        console.log("[HELO AUDIO] voice activity detected", { vadScore: Number(vadScore.toFixed(3)) });
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

  const end = useCallback(() => {
    const wasStarted = startedRef.current;
    clearLocalSessionState();
    if (wasStarted) endSession();
  }, [clearLocalSessionState, endSession]);

  useEffect(() => {
    patientIdRef.current = patientId;
  }, [patientId]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(MIC_DEVICE_STORAGE_KEY) || "";
      selectedInputDeviceIdRef.current = stored;
      setSelectedInputDeviceId(stored);
    } catch {
      // Sem localStorage: usa o microfone padrão do navegador.
    }
    void refreshInputDevices(false);
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
    }
  }, [status]);

  useEffect(() => {
    if (status !== "connected" || !isMuted) return;
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
        setVolume({ volume: suppress ? 0 : 1 });
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
      await refreshInputDevices(true);
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
      // Diagnóstico: confirma QUAIS client tools o cliente registrou nesta
      // sessão. Se as três não aparecerem aqui, o problema é o objeto; se
      // aparecerem mas os logs "called" nunca dispararem, o problema é a
      // DECLARAÇÃO da tool no painel da ElevenLabs (o agente não a conhece).
      console.log("[HELO TOOL] registered client tools", Object.keys(clientTools));
      await refreshInputDevices(false);
      startSession({
        conversationToken: data.conversationToken,
        connectionType: "webrtc",
        inputDeviceId: selectedInputDeviceIdRef.current || undefined,
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
  }, [clientTools, onError, refreshInputDevices, startSession, stop]);

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
    const actions: HeloUIAction[] = [
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
    ];
    if (connected) {
      actions.push(
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
        }
      );
    }
    return actions;
  }, [connect, end, gesturePending, markGesture, pathname, restarting, starting, status]);
  useRegisterHeloUIActions(agentScreenActions);

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
  const micActive = status === "connected" && !isMuted && micLevel > MIC_ACTIVITY_THRESHOLD;
  const micStatusLabel = isMuted
    ? "Microfone mutado"
    : micActive
      ? "Microfone captando"
      : status === "connected"
        ? "Aguardando fala no microfone selecionado"
        : "Aguardando sinal do microfone";

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
    speakActivityQuestion,
    restartForVoiceChange,
  }), [activeSessionPatientId, restartForVoiceChange, restarting, speakActivityQuestion, status]);

  return (
    <HeloAgentContext.Provider value={agentContext}>
      {mount && createPortal(stage, mount)}
      {sessionVisible && (
        <aside aria-live="polite" className="fixed bottom-24 right-4 z-[70] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-2xl border border-line bg-card/95 px-4 py-3 shadow-soft backdrop-blur-sm sm:bottom-4">
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
