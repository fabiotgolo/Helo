import { requireUser } from "@/lib/auth";
import { logAudit, setUserPlatformVoice } from "@/lib/access";
import { getPlatformVoice } from "@/lib/voice-catalog";

// Preferência de voz da PLATAFORMA do próprio usuário.
// Escopo: SÓ a experiência dele — nunca altera a voz padrão global nem a
// escolha de outros usuários. Exige a permissão canSelectPlatformVoice
// (concedida pelo Admin); sem ela, o usuário segue na voz padrão da Helo.

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const { user } = auth;
  if (!user.canSelectPlatformVoice && user.role !== "admin") {
    return Response.json(
      { error: "permissão necessária: escolher voz da plataforma" },
      { status: 403 }
    );
  }
  const { platformVoiceId } = (await request.json()) as {
    platformVoiceId?: string | null;
  };
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
