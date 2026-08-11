import { requireAdmin } from "@/lib/auth";
import { logAudit } from "@/lib/access";
import { getPatient, getPatientSetting, setPatientSettings } from "@/lib/store";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import { validateElevenLabsVoice } from "@/lib/voice-catalog";
import { invalidateFavoritePhraseAudio } from "@/lib/favorite-phrases";
import { comPoliticaSemCache, jsonSemCache } from "@/lib/cache-policy";

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
  if (auth instanceof Response) return comPoliticaSemCache(auth);
  const body = (await request.json()) as {
    patientId?: number;
    elevenLabsVoiceId?: string;
    displayName?: string;
  };
  const patientId = Number(body.patientId);
  const voiceId = body.elevenLabsVoiceId?.trim();
  if (!patientId || !voiceId) {
    return jsonSemCache(
      { error: "patientId e elevenLabsVoiceId são obrigatórios" },
      { status: 400 }
    );
  }
  const patient = await getPatient(patientId);
  if (!patient) {
    return jsonSemCache({ error: "paciente não encontrado" }, { status: 404 });
  }
  const validation = await validateElevenLabsVoice(voiceId);
  if (validation.status === "invalid") {
    return jsonSemCache(
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
  // ——— Fase 5.4B ———
  //
  // A voz mudou; o que foi pré-sintetizado com a anterior deixa de valer. Sem
  // isto, uma frase gravada com o clone antigo continuaria tocando para sempre
  // como se fosse a voz atual da pessoa — e continuaria existindo no Storage
  // depois de o clone ter sido substituído.
  //
  // A invalidação não regenera nada e não muda tela nenhuma: sem áudio pronto,
  // a frase é sintetizada na hora pelo caminho do SpeechGrant, com a voz que
  // vale agora.
  const invalidadas = await invalidateFavoritePhraseAudio(patientId);
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
      // Quantidade, nunca o texto das frases.
      audiosInvalidados: String(invalidadas),
    },
  });
  return jsonSemCache({ ok: true, validation: validation.status });
}

/** Remover o vínculo do clone (o paciente volta ao catálogo aprovado). */
export async function DELETE(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return comPoliticaSemCache(auth);
  const { patientId: rawId } = (await request.json()) as { patientId?: number };
  const patientId = Number(rawId);
  if (!patientId) {
    return jsonSemCache({ error: "patientId obrigatório" }, { status: 400 });
  }
  const previous = await getPatientSetting(patientId, PATIENT_SETTING_KEYS.voiceId);
  if (!previous) {
    return jsonSemCache({ error: "paciente sem clone atribuído" }, { status: 404 });
  }
  // Sem clone, a fonte "clone" deixa de existir: normaliza para o catálogo
  // (a resolução no servidor já cai na voz padrão aprovada).
  await setPatientSettings(patientId, {
    [PATIENT_SETTING_KEYS.voiceId]: "",
    [PATIENT_SETTING_KEYS.voiceCloneName]: "",
    [PATIENT_SETTING_KEYS.patientVoiceSource]: "platform",
  });
  // Remover o clone é o caso mais forte: sem esta linha, o Helo apagaria o
  // vínculo com a voz e continuaria guardando MP3s feitos com ela.
  const invalidadas = await invalidateFavoritePhraseAudio(patientId);
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId,
    action: "voice.clone.remove",
    entityType: "patientVoiceClone",
    entityId: String(patientId),
    metadata: { before: mask(previous), after: "—", audiosInvalidados: String(invalidadas) },
  });
  return jsonSemCache({ ok: true });
}
