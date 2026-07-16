import { requirePatientAccess } from "@/lib/auth";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import { getPatientSettings } from "@/lib/store";
import type { HeloVoicePreference } from "@/lib/access-types";

type HeloDynamicVariables = Record<string, string | number | boolean>;
type HeloConversationOverrides = { tts?: { voice_id?: string } };
const HELO_GREETING_MAX_LENGTH = 200;

function gestureLabel(settings: Record<string, string>, key: "gestureSim" | "gestureTalvez" | "gestureNao", fallback: string) {
  return settings[PATIENT_SETTING_KEYS[key]]?.trim() || fallback;
}

function patientGreeting(settings: Record<string, string>, preferredName: string): string {
  const greeting = settings[PATIENT_SETTING_KEYS.heloGreeting]?.trim();
  return greeting && greeting.length <= HELO_GREETING_MAX_LENGTH
    ? greeting
    : `Olá, ${preferredName}. Eu sou a Helo. Como posso ajudar?`;
}

function buildDynamicVariables(input: {
  patientId: number;
  patientName: string;
  settings: Record<string, string>;
  operatorRole: string;
}): HeloDynamicVariables {
  const { patientId, patientName, settings, operatorRole } = input;
  const preferredName = settings[PATIENT_SETTING_KEYS.name]?.trim() || patientName || "paciente";
  return {
    // Contexto mínimo, configuracional e sem histórico, diagnóstico ou documentos.
    patientName: patientName || preferredName,
    preferredName,
    // A configuração do First Message do Agent deve usar
    // {{heloPatientGreeting}}. Nunca enviamos uma string vazia para que a
    // primeira fala continue segura quando não houver personalização.
    heloPatientGreeting: patientGreeting(settings, preferredName),
    communicationStyle: settings[PATIENT_SETTING_KEYS.speechStyle]?.trim() || "claro e respeitoso",
    responsePace: "calmo e pausado",
    confirmGestureLabel: gestureLabel(settings, "gestureSim", "Sim"),
    reformulateGestureLabel: gestureLabel(settings, "gestureTalvez", "Talvez"),
    rejectGestureLabel: gestureLabel(settings, "gestureNao", "Não"),
    activePatientId: patientId,
    currentOperatorRole: operatorRole,
    heloLanguage: "pt-BR",
    heloInteractionMode: "assistive",
  };
}

function patientVoicePreference(settings: Record<string, string>): HeloVoicePreference {
  const preference = settings[PATIENT_SETTING_KEYS.heloVoicePreference];
  return preference === "male" ? "male" : "female";
}

function resolveVoiceOverride(preference: HeloVoicePreference) {
  // O override só é enviado quando foi explicitamente habilitado na segurança
  // do Agent. Sem essa confirmação, a voz configurada no Agent prevalece.
  if (process.env.ELEVENLABS_HELO_VOICE_OVERRIDE_ENABLED !== "true") return null;
  // Os nomes PLATFORM são a interface atual da aplicação. Os aliases abaixo
  // mantêm compatibilidade com os secrets já existentes no App Hosting e com
  // ambientes locais que ainda usam os nomes anteriores.
  const candidates = preference === "male"
    ? [process.env.ELEVENLABS_HELO_PLATFORM_VOICE_MALE_ID, process.env.ELEVENLABS_HELO_VOICE_MALE_ID]
    : [process.env.ELEVENLABS_HELO_PLATFORM_VOICE_FEMALE_ID, process.env.ELEVENLABS_HELO_VOICE_FEMALE_ID];
  return candidates.map((value) => value?.trim()).find(Boolean) || null;
}

function buildVoiceOverrides(voiceId: string | null): HeloConversationOverrides | undefined {
  return voiceId ? { tts: { voice_id: voiceId } } : undefined;
}

// O SDK React usa WebRTC para conversas por voz. A credencial retornada aqui
// expira e não dá acesso à API da ElevenLabs nem aos demais recursos da conta.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { patientId?: unknown };
  const patientId = Number(body.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }
  // Não confiamos no patientId do cliente: só um vínculo ativo pode solicitar
  // o contexto daquele paciente. Isso impede contexto cruzado já no token.
  const patientAuth = await requirePatientAccess(request, patientId);
  if (patientAuth instanceof Response) return patientAuth;

  const agentId = process.env.ELEVENLABS_HELO_AGENT_ID?.trim();
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!agentId) return Response.json({ error: "Agent Helo não configurado" }, { status: 503 });
  if (!apiKey) return Response.json({ error: "Serviço de voz não configurado" }, { status: 503 });

  try {
    const [settings] = await Promise.all([getPatientSettings(patientId)]);
    const dynamicVariables = buildDynamicVariables({
      patientId,
      patientName: settings[PATIENT_SETTING_KEYS.name]?.trim() || "paciente",
      settings,
      operatorRole: patientAuth.user.role,
    });
    const heloVoicePreference = patientVoicePreference(settings);
    const voiceId = resolveVoiceOverride(heloVoicePreference);
    const voiceOverrideApplied = Boolean(voiceId);
    console.info("[HELO AGENT] voice override", {
      voiceOverrideApplied,
      voicePreference: heloVoicePreference,
      voiceIdPresent: Boolean(voiceId),
    });

    const params = new URLSearchParams({ agent_id: agentId });
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?${params}`,
      { headers: { "xi-api-key": apiKey }, cache: "no-store" }
    );
    if (!response.ok) {
      console.error("Falha ao obter token temporário do Agent Helo:", response.status);
      return Response.json({ error: "Não foi possível conectar com a Helo" }, { status: 502 });
    }
    const tokenBody = (await response.json()) as { token?: unknown };
    if (typeof tokenBody.token !== "string" || !tokenBody.token) {
      return Response.json({ error: "Resposta inválida do serviço de voz" }, { status: 502 });
    }
    return Response.json({
      conversationToken: tokenBody.token,
      dynamicVariables,
      // ID técnico só é devolvido transitoriamente quando o próprio servidor
      // o resolveu e o override do Agent foi habilitado.
      overrides: buildVoiceOverrides(voiceId),
      voiceOverrideApplied,
    });
  } catch (error) {
    console.error("Erro ao obter token temporário do Agent Helo:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Serviço de voz indisponível" }, { status: 502 });
  }
}
