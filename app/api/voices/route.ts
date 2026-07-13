import { requireUser, requirePatientAccess } from "@/lib/auth";
import { hasPermission } from "@/lib/access-types";
import {
  getDefaultPlatformVoice,
  getPatientVoiceState,
  listPlatformVoices,
  toPublicVoice,
} from "@/lib/voice-catalog";

// Vozes visíveis para o usuário autenticado — SOMENTE o catálogo interno
// aprovado pelo Admin, em projeção pública (nome amigável; nunca o voiceId
// técnico, nunca a biblioteca da conta ElevenLabs, nunca clones de outros
// pacientes). A antiga listagem direta da ElevenLabs foi removida daqui de
// propósito: o cadastro de vozes acontece só em /api/admin/voices.
//
// Com ?patientId= (exige vínculo), inclui o estado da voz DAQUELE paciente:
// clone existe? qual a fonte escolhida? o usuário pode alterá-la?
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const [voices, def] = await Promise.all([
    listPlatformVoices(),
    getDefaultPlatformVoice(),
  ]);

  const canSelectPlatformVoice =
    user.canSelectPlatformVoice || user.role === "admin";

  const payload: Record<string, unknown> = {
    voices: voices.map(toPublicVoice),
    defaultVoiceId: def?.id ?? null,
    // Pronta = existe voz aprovada no catálogo e a síntese está configurada.
    platformVoiceReady: Boolean(def) && Boolean(process.env.ELEVENLABS_API_KEY),
    canSelectPlatformVoice,
    // Preferência do usuário só vale (e só aparece como ativa) com permissão.
    myPlatformVoiceId: canSelectPlatformVoice ? user.platformVoiceId : null,
  };

  const patientIdRaw = new URL(request.url).searchParams.get("patientId");
  if (patientIdRaw) {
    const patientId = Number(patientIdRaw);
    // Vínculo ativo verificado no servidor — o estado de voz de um paciente
    // nunca sai para quem não o alcança.
    const patientAuth = await requirePatientAccess(request, patientId);
    if (patientAuth instanceof Response) return patientAuth;
    const state = await getPatientVoiceState(patientId);
    payload.patient = {
      patientId,
      hasClone: state.hasClone,
      cloneName: state.cloneName,
      source: state.source,
      platformVoiceId: state.platformVoiceId,
      canSelectPatientVoiceSource:
        user.role === "admin" ||
        hasPermission(patientAuth.link, "selectPatientVoiceSource"),
    };
  }

  return Response.json(payload);
}
