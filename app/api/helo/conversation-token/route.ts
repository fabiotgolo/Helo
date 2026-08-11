import { requirePatientAccess } from "@/lib/auth";
import { comPoliticaSemCache, jsonSemCache } from "@/lib/cache-policy";
import { consomeLimite, respostaDeLimite } from "@/lib/rate-limit";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import { getPatient, getPatientSettings } from "@/lib/store";
import {
  chamaElevenLabsJson,
  PRAZOS_ELEVENLABS,
  statusParaCliente,
} from "@/lib/voice/eleven-fetch";
import type { HeloVoicePreference } from "@/lib/access-types";

type HeloDynamicVariables = Record<string, string | number | boolean>;
type HeloConversationOverrides = { tts?: { voice_id?: string } };
const HELO_GREETING_MAX_LENGTH = 200;

function gestureLabel(settings: Record<string, string>, key: "gestureSim" | "gestureTalvez" | "gestureNao", fallback: string) {
  return settings[PATIENT_SETTING_KEYS[key]]?.trim() || fallback;
}

function patientGreeting(settings: Record<string, string>, preferredName: string): string {
  const greeting = settings[PATIENT_SETTING_KEYS.heloGreeting]?.trim();
  if (greeting && greeting.length <= HELO_GREETING_MAX_LENGTH) return greeting;
  return preferredName
    ? `Olá, ${preferredName}. Eu sou a Helo. Como posso ajudar?`
    : "Olá. Eu sou a Helo. Como posso ajudar?";
}

function buildDynamicVariables(input: {
  patientId: number;
  patientName: string;
  settings: Record<string, string>;
  operatorRole: string;
}): HeloDynamicVariables {
  const { patientId, patientName, settings, operatorRole } = input;
  // `patient_name` é o nome de tratamento/preferido configurado em Ajustes.
  // O nome do perfil do paciente é o fallback seguinte; ambos podem estar
  // ausentes em dados antigos, caso em que a saudação continua preenchida.
  const preferredName = settings[PATIENT_SETTING_KEYS.name]?.trim() || patientName.trim();
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
  // ——— A-13: os aliases saíram ———
  //
  // Havia aqui um segundo candidato por preferência —
  // `ELEVENLABS_HELO_VOICE_MALE_ID` e `_FEMALE_ID` —, descrito como
  // compatibilidade com "os secrets já existentes no App Hosting". A 5.4C
  // conferiu os três lugares onde uma variável de ambiente pode nascer neste
  // projeto e eles **não existem em nenhum**: no `apphosting.yaml` esses dois
  // nomes são os nomes dos SECRETS no Secret Manager, e o valor deles é
  // entregue ao processo sob os nomes PLATFORM (é o que `variable:` declara);
  // no `.env` e no `.env.example` não aparecem; no `.env.local` também não.
  //
  // Eram, portanto, um fallback para uma variável que nenhuma configuração
  // preenche. Os secrets do App Hosting continuam intocados — o que saiu foi
  // a leitura de um nome que nunca chega ao processo.
  //
  // O resto desta função é o R-12 e **fica**: é um recurso pronto, bloqueado
  // por uma configuração do painel da ElevenLabs que ainda não foi verificada.
  const escolhida = preference === "male"
    ? process.env.ELEVENLABS_HELO_PLATFORM_VOICE_MALE_ID
    : process.env.ELEVENLABS_HELO_PLATFORM_VOICE_FEMALE_ID;
  return escolhida?.trim() || null;
}

function buildVoiceOverrides(voiceId: string | null): HeloConversationOverrides | undefined {
  return voiceId ? { tts: { voice_id: voiceId } } : undefined;
}

// O SDK React usa WebRTC para conversas por voz. A credencial retornada aqui
// expira e não dá acesso à API da ElevenLabs nem aos demais recursos da conta.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    patientId?: unknown;
    disableVoiceOverride?: unknown;
  };
  const patientId = Number(body.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return jsonSemCache({ error: "patientId obrigatório" }, { status: 400 });
  }
  // Não confiamos no patientId do cliente: só um vínculo ativo pode solicitar
  // o contexto daquele paciente. Isso impede contexto cruzado já no token.
  const patientAuth = await requirePatientAccess(request, patientId);
  if (patientAuth instanceof Response) return comPoliticaSemCache(patientAuth);

  // ——— A-10 ———
  //
  // Cada token abre uma sessão de conversa paga do lado do provedor. O uso
  // real é UMA sessão por vez; doze em cinco minutos cobre reconexões
  // seguidas numa rede ruim, que é o único caminho legítimo que repete este
  // pedido. Vem antes de qualquer chamada externa: recusar é de graça.
  const limite = await consomeLimite("conversa", { userId: patientAuth.user.id });
  if (!limite.permitido) return respostaDeLimite(limite);

  const agentId = process.env.ELEVENLABS_HELO_AGENT_ID?.trim();
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!agentId) return jsonSemCache({ error: "Agent Helo não configurado" }, { status: 503 });
  if (!apiKey) return jsonSemCache({ error: "Serviço de voz não configurado" }, { status: 503 });

  try {
    const [settings, patient] = await Promise.all([
      getPatientSettings(patientId),
      getPatient(patientId),
    ]);
    const dynamicVariables = buildDynamicVariables({
      patientId,
      patientName: patient?.name ?? "",
      settings,
      operatorRole: patientAuth.user.role,
    });
    const heloVoicePreference = patientVoicePreference(settings);
    const voiceId = body.disableVoiceOverride === true ? null : resolveVoiceOverride(heloVoicePreference);
    const voiceOverrideApplied = Boolean(voiceId);
    console.info("[HELO AGENT] voice override", {
      voiceOverrideApplied,
      voicePreference: heloVoicePreference,
      voiceIdPresent: Boolean(voiceId),
    });

    const params = new URLSearchParams({ agent_id: agentId });
    // Prazo TOTAL: o corpo é um JSON curto. Um token que demora mais que isso
    // não vai abrir uma sessão utilizável — e sem prazo a requisição prendia o
    // handler indefinidamente.
    const chamada = await chamaElevenLabsJson<{ token?: unknown }>(
      `https://api.elevenlabs.io/v1/convai/conversation/token?${params}`,
      { headers: { "xi-api-key": apiKey }, cache: "no-store" },
      { prazoMs: PRAZOS_ELEVENLABS.conversationToken, rotulo: "conversationToken" }
    );
    if (!chamada.ok) {
      // A categoria já foi registrada em chamaElevenLabsJson. Aqui ela vira o
      // status que o cliente entende — e "timeout" nunca vira 401: quem opera
      // precisa distinguir "demorou" de "credencial recusada".
      return jsonSemCache(
        { error: "Não foi possível conectar com a Helo", reason: chamada.falha },
        { status: statusParaCliente(chamada.falha) }
      );
    }
    const tokenBody = chamada.dados;
    if (typeof tokenBody.token !== "string" || !tokenBody.token) {
      return jsonSemCache({ error: "Resposta inválida do serviço de voz" }, { status: 502 });
    }
    return jsonSemCache({
      conversationToken: tokenBody.token,
      dynamicVariables,
      // ID técnico só é devolvido transitoriamente quando o próprio servidor
      // o resolveu e o override do Agent foi habilitado.
      overrides: buildVoiceOverrides(voiceId),
      voiceOverrideApplied,
    });
  } catch (error) {
    console.error("Erro ao obter token temporário do Agent Helo:", error instanceof Error ? error.message : error);
    return jsonSemCache({ error: "Serviço de voz indisponível" }, { status: 502 });
  }
}
