import { requirePatientAccess } from "@/lib/auth";
import { logAudit } from "@/lib/access";
import { hasPermission } from "@/lib/access-types";
import { setPatientSettings } from "@/lib/store";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import {
  getPatientVoiceState,
  getPlatformVoice,
} from "@/lib/voice-catalog";

// Fonte da voz das FALAS DO PACIENTE (Emergência, mensagens confirmadas):
//   "clone"    → a voz clonada DESTE paciente (precisa existir);
//   "platform" → uma voz ATIVA do catálogo aprovado.
// Exige vínculo ativo. Paciente SEM clone: qualquer vínculo pode escolher
// uma voz do catálogo (baixa sensibilidade). Paciente COM clone: trocar a
// fonte exige a permissão selectPatientVoiceSource — protege a voz/
// identidade da pessoa (Admin passa em ambos).
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
  // concede acesso — o vínculo é verificado aqui. A permissão fina depende
  // de o paciente ter clone ou não (avaliada logo abaixo, já com o estado).
  const auth = await requirePatientAccess(request, patientId);
  if (auth instanceof Response) return auth;

  const state = await getPatientVoiceState(patientId);

  // Com clone, trocar a fonte é sensível → exige a permissão. Sem clone,
  // escolher uma voz de plataforma é liberado a qualquer vínculo ativo.
  const permitted =
    auth.user.role === "admin" ||
    !state.hasClone ||
    hasPermission(auth.link, "selectPatientVoiceSource");
  if (!permitted) {
    return Response.json(
      { error: "permissão necessária: escolher a voz das falas do paciente" },
      { status: 403 }
    );
  }

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
