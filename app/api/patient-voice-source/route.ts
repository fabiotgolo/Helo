import { requirePatientAccess } from "@/lib/auth";
import { logAudit } from "@/lib/access";
import { setPatientSettings } from "@/lib/store";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import {
  getPatientVoiceState,
  getPlatformVoice,
} from "@/lib/voice-catalog";

// Fonte da voz das FALAS DO PACIENTE (Emergência, mensagens confirmadas):
//   "clone"    → a voz clonada DESTE paciente (precisa existir);
//   "platform" → uma voz ATIVA do catálogo aprovado.
// Exige vínculo ativo + permissão selectPatientVoiceSource (Admin passa).
// A autoria da fala (speakerRole = patient) não muda com a fonte técnica.

export async function POST(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    source?: "clone" | "platform";
    platformVoiceId?: string;
  };
  const patientId = Number(body.patientId);
  if (!patientId) {
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }
  // Autorização REAL no servidor: manipular o patientId no cliente não
  // concede acesso — o vínculo e a permissão são verificados aqui.
  const auth = await requirePatientAccess(
    request,
    patientId,
    "selectPatientVoiceSource"
  );
  if (auth instanceof Response) return auth;

  const state = await getPatientVoiceState(patientId);
  const updates: Record<string, string> = {};

  if (body.source === "clone") {
    // Nunca oferecer (nem aceitar) um clone inexistente.
    if (!state.hasClone) {
      return Response.json(
        { error: "voz clonada não configurada para este paciente" },
        { status: 422 }
      );
    }
    updates[PATIENT_SETTING_KEYS.patientVoiceSource] = "clone";
  } else if (body.source === "platform") {
    const chosen = body.platformVoiceId?.trim();
    if (!chosen) {
      return Response.json(
        { error: "platformVoiceId obrigatório para fonte platform" },
        { status: 400 }
      );
    }
    const voice = await getPlatformVoice(chosen);
    if (!voice || !voice.enabled) {
      return Response.json(
        { error: "voz inexistente ou não aprovada" },
        { status: 422 }
      );
    }
    updates[PATIENT_SETTING_KEYS.patientVoiceSource] = "platform";
    updates[PATIENT_SETTING_KEYS.patientVoicePlatformId] = chosen;
  } else {
    return Response.json({ error: "source inválida" }, { status: 400 });
  }

  await setPatientSettings(patientId, updates);
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId,
    action: "voice.patientSource.set",
    entityType: "patientVoiceSource",
    entityId: String(patientId),
    metadata: {
      before: `${state.source}${state.platformVoiceId ? `:${state.platformVoiceId}` : ""}`,
      after: `${body.source}${body.source === "platform" ? `:${body.platformVoiceId}` : ""}`,
    },
  });
  return Response.json({ ok: true });
}
