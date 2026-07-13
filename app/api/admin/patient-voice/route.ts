import { requireAdmin } from "@/lib/auth";
import { logAudit } from "@/lib/access";
import { getPatient, getPatientSetting, setPatientSettings } from "@/lib/store";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import { validateElevenLabsVoice } from "@/lib/voice-catalog";

// Voz CLONADA do paciente — atribuição EXCLUSIVA do Admin.
// Nenhum outro papel (cuidador, profissional, familiar, paciente) informa
// voiceId livremente: usuários autorizados apenas ESCOLHEM entre o clone
// já atribuído e o catálogo aprovado (/api/patient-voice-source).
// O vínculo é por patientId (subcoleção do paciente) — o clone de um
// paciente nunca alcança outro por construção.

function mask(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/** Atribuir ou substituir o clone do paciente. */
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const body = (await request.json()) as {
    patientId?: number;
    elevenLabsVoiceId?: string;
    displayName?: string;
  };
  const patientId = Number(body.patientId);
  const voiceId = body.elevenLabsVoiceId?.trim();
  if (!patientId || !voiceId) {
    return Response.json(
      { error: "patientId e elevenLabsVoiceId são obrigatórios" },
      { status: 400 }
    );
  }
  const patient = await getPatient(patientId);
  if (!patient) {
    return Response.json({ error: "paciente não encontrado" }, { status: 404 });
  }
  const validation = await validateElevenLabsVoice(voiceId);
  if (validation.status === "invalid") {
    return Response.json(
      { error: "voiceId não encontrado na conta ElevenLabs" },
      { status: 422 }
    );
  }
  const previous = await getPatientSetting(patientId, PATIENT_SETTING_KEYS.voiceId);
  await setPatientSettings(patientId, {
    [PATIENT_SETTING_KEYS.voiceId]: voiceId,
    [PATIENT_SETTING_KEYS.voiceCloneName]:
      body.displayName?.trim() || `Voz clonada de ${patient.name}`,
  });
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId,
    action: previous ? "voice.clone.replace" : "voice.clone.assign",
    entityType: "patientVoiceClone",
    entityId: String(patientId),
    // IDs técnicos mascarados até na auditoria — rastreável sem exposição.
    metadata: {
      before: previous ? mask(previous) : "—",
      after: mask(voiceId),
      validated: validation.status,
    },
  });
  return Response.json({ ok: true, validation: validation.status });
}

/** Remover o vínculo do clone (o paciente volta ao catálogo aprovado). */
export async function DELETE(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const { patientId: rawId } = (await request.json()) as { patientId?: number };
  const patientId = Number(rawId);
  if (!patientId) {
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }
  const previous = await getPatientSetting(patientId, PATIENT_SETTING_KEYS.voiceId);
  if (!previous) {
    return Response.json({ error: "paciente sem clone atribuído" }, { status: 404 });
  }
  // Sem clone, a fonte "clone" deixa de existir: normaliza para o catálogo
  // (a resolução no servidor já cai na voz padrão aprovada).
  await setPatientSettings(patientId, {
    [PATIENT_SETTING_KEYS.voiceId]: "",
    [PATIENT_SETTING_KEYS.voiceCloneName]: "",
    [PATIENT_SETTING_KEYS.patientVoiceSource]: "platform",
  });
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId,
    action: "voice.clone.remove",
    entityType: "patientVoiceClone",
    entityId: String(patientId),
    metadata: { before: mask(previous), after: "—" },
  });
  return Response.json({ ok: true });
}
