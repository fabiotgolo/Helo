import { requireUser } from "@/lib/auth";
import { logAudit, setUserHeloVoicePreference, setUserPlatformVoice } from "@/lib/access";
import type { HeloVoicePreference } from "@/lib/access-types";
import { getPlatformVoice } from "@/lib/voice-catalog";

// Preferência de voz da PLATAFORMA do próprio usuário.
// Escopo: SÓ a experiência dele — nunca altera a voz padrão global nem a
// escolha de outros usuários. Por ser apenas a voz da INTERFACE do próprio
// usuário (não toca na voz/identidade do paciente, protegida à parte por
// selectPatientVoiceSource), qualquer usuário autenticado pode escolher
// entre as vozes ativas do catálogo aprovado pelo Admin.

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const { user } = auth;
  const { platformVoiceId, heloVoicePreference } = (await request.json()) as {
    platformVoiceId?: string | null;
    heloVoicePreference?: unknown;
  };
  // Preferência explícita do Agent: feminina/masculina. É tratada antes do
  // catálogo histórico para manter a seleção simples e independente do paciente.
  if (heloVoicePreference !== undefined) {
    if (heloVoicePreference !== "female" && heloVoicePreference !== "male") {
      return Response.json({ error: "preferência de voz inválida" }, { status: 400 });
    }
    await setUserHeloVoicePreference(user.id, heloVoicePreference as HeloVoicePreference);
    await logAudit({
      userId: user.id,
      userName: user.name,
      action: "helo.voice_preference.set",
      entityType: "user",
      entityId: user.id,
      metadata: { before: user.heloVoicePreference ?? "female", after: heloVoicePreference },
    });
    return Response.json({ ok: true, heloVoicePreference });
  }
  // null/"" limpa a preferência — volta à voz padrão definida pelo Admin.
  const chosen = platformVoiceId?.trim() || null;
  if (chosen) {
    const voice = await getPlatformVoice(chosen);
    // Só vozes ATIVAS do catálogo aprovado são elegíveis — um id manipulado
    // no cliente não passa daqui.
    if (!voice || !voice.enabled) {
      return Response.json(
        { error: "voz inexistente ou não aprovada" },
        { status: 422 }
      );
    }
  }
  await setUserPlatformVoice(user.id, chosen);
  await logAudit({
    userId: user.id,
    userName: user.name,
    action: "voice.preference.set",
    entityType: "user",
    entityId: user.id,
    metadata: {
      before: user.platformVoiceId ?? "padrão",
      after: chosen ?? "padrão",
    },
  });
  return Response.json({ ok: true });
}
