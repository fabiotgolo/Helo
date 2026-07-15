import { requireAdmin } from "@/lib/auth";
import { logAudit, setUserPlatformVoice } from "@/lib/access";
import { listPatients, getPatientSettings, setPatientSettings } from "@/lib/store";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import {
  addPlatformVoice,
  getPlatformVoice,
  getVoiceUsage,
  listPlatformVoices,
  removePlatformVoice,
  updatePlatformVoice,
  validateElevenLabsVoice,
} from "@/lib/voice-catalog";

// Catálogo de vozes da plataforma — EXCLUSIVO do Admin.
// É o ÚNICO lugar onde um voiceId ElevenLabs entra no sistema para a
// plataforma: o Admin cadastra, o sistema valida, e os usuários passam a
// ver apenas o catálogo interno aprovado (nomes amigáveis, nunca a
// biblioteca completa da conta).

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const [voices, patients] = await Promise.all([
    listPlatformVoices(true),
    listPatients(true),
  ]);
  // Uso por voz (quem escolheu) + estado da voz clonada de cada paciente —
  // tudo que a aba Vozes do Admin precisa, numa única resposta.
  const usage = Object.fromEntries(
    await Promise.all(
      voices.map(async (v) => [v.id, await getVoiceUsage(v.id, patients)])
    )
  );
  const patientVoices = await Promise.all(
    patients.map(async (p) => {
      const settings = await getPatientSettings(p.id);
      const cloneId = settings[PATIENT_SETTING_KEYS.voiceId]?.trim() || null;
      return {
        patientId: p.id,
        name: p.name,
        hasClone: Boolean(cloneId),
        cloneName: settings[PATIENT_SETTING_KEYS.voiceCloneName]?.trim() || null,
        // Contexto de Admin: o id técnico aparece mascarado mesmo aqui.
        cloneIdMasked: cloneId ? `${cloneId.slice(0, 4)}…${cloneId.slice(-4)}` : null,
        source:
          settings[PATIENT_SETTING_KEYS.patientVoiceSource] === "platform"
            ? "platform"
            : cloneId
              ? "clone"
              : "platform",
        platformVoiceId:
          settings[PATIENT_SETTING_KEYS.patientVoicePlatformId]?.trim() || null,
      };
    })
  );
  return Response.json({ voices, usage, patientVoices });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const body = (await request.json()) as {
    elevenLabsVoiceId?: string;
    displayName?: string;
    description?: string;
    enabled?: boolean;
    isDefault?: boolean;
  };
  const voiceId = body.elevenLabsVoiceId?.trim();
  const displayName = body.displayName?.trim();
  if (!voiceId || !displayName) {
    return Response.json(
      { error: "ElevenLabs Voice ID e nome de exibição são obrigatórios" },
      { status: 400 }
    );
  }
  const existing = await listPlatformVoices(true);
  if (existing.some((v) => v.elevenLabsVoiceId === voiceId)) {
    return Response.json(
      { error: "esta voz já está cadastrada no catálogo" },
      { status: 409 }
    );
  }
  // Validação na ElevenLabs quando tecnicamente possível; um voiceId
  // comprovadamente inexistente não entra no catálogo.
  const validation = await validateElevenLabsVoice(voiceId);
  if (validation.status === "invalid") {
    return Response.json(
      { error: "voiceId não encontrado na conta ElevenLabs" },
      { status: 422 }
    );
  }
  const voice = await addPlatformVoice({
    elevenLabsVoiceId: voiceId,
    displayName,
    description: body.description,
    enabled: body.enabled,
    isDefault: body.isDefault,
    createdBy: auth.user.id,
  });
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    action: "voice.catalog.add",
    entityType: "platformVoice",
    entityId: voice.id,
    metadata: {
      displayName,
      validated: validation.status,
      isDefault: String(voice.isDefault),
    },
  });
  return Response.json({ voice, validation: validation.status });
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const body = (await request.json()) as {
    id?: string;
    displayName?: string;
    description?: string;
    enabled?: boolean;
    isDefault?: boolean;
  };
  if (!body.id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  const voice = await getPlatformVoice(body.id);
  if (!voice) return Response.json({ error: "voz não encontrada" }, { status: 404 });
  // A voz padrão precisa ser utilizável: nunca definir como padrão uma voz
  // desativada, nem desativar a voz que é o padrão atual.
  const willBeEnabled = body.enabled ?? voice.enabled;
  const willBeDefault = body.isDefault ?? voice.isDefault;
  if (willBeDefault && !willBeEnabled) {
    return Response.json(
      { error: "a voz padrão da plataforma precisa estar ativa" },
      { status: 400 }
    );
  }
  await updatePlatformVoice(body.id, body);
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    action:
      body.enabled !== undefined && body.enabled !== voice.enabled
        ? body.enabled
          ? "voice.catalog.enable"
          : "voice.catalog.disable"
        : body.isDefault
          ? "voice.catalog.setDefault"
          : "voice.catalog.update",
    entityType: "platformVoice",
    entityId: body.id,
    metadata: {
      before: voice.displayName,
      after: body.displayName ?? voice.displayName,
    },
  });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const { id } = (await request.json()) as { id?: string };
  if (!id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  const voice = await getPlatformVoice(id);
  if (!voice) return Response.json({ error: "voz não encontrada" }, { status: 404 });
  if (voice.isDefault) {
    return Response.json(
      { error: "defina outra voz padrão antes de remover esta" },
      { status: 400 }
    );
  }
  // O Admin pode remover mesmo em uso: as preferências que apontavam para
  // esta voz caem para a voz padrão da Helo. Nada pode ficar apontando para
  // uma voz inexistente — por isso zeramos as referências ANTES de apagar.
  //   - usuário: preferência de voz da plataforma volta ao padrão;
  //   - paciente: a voz do catálogo escolhida para as falas é limpa; com a
  //     fonte ainda "platform" mas sem id, a resolução usa a voz padrão.
  const usage = await getVoiceUsage(id, await listPatients(true));
  await Promise.all([
    ...usage.userIds.map((uid) => setUserPlatformVoice(uid, null)),
    ...usage.patientIds.map((pid) =>
      setPatientSettings(pid, {
        [PATIENT_SETTING_KEYS.patientVoicePlatformId]: "",
      })
    ),
  ]);
  await removePlatformVoice(id);
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    action: "voice.catalog.remove",
    entityType: "platformVoice",
    entityId: id,
    metadata: {
      displayName: voice.displayName,
      reassignedUsers: String(usage.userIds.length),
      reassignedPatients: String(usage.patientIds.length),
    },
  });
  return Response.json({
    ok: true,
    reassigned: { users: usage.userIds.length, patients: usage.patientIds.length },
  });
}
