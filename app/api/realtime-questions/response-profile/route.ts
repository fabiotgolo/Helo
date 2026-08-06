import { requirePatientAccess } from "@/lib/auth";
import { logAudit } from "@/lib/access";
import {
  getResponseProfile,
  respostaDeErro,
  setResponseProfile,
} from "@/lib/realtime-question-store";

// Configuração POR PACIENTE do modo Perguntas em tempo real: qual sinal
// físico observável corresponde a qual resposta semântica (YES/MAYBE/NO).
//
// Esta configuração vale SOMENTE dentro deste modo. Os gestos das demais
// atividades do Helo continuam com o significado atual (lib/types.ts e
// lib/gestures.tsx), que este recurso não toca.
//
// O sistema não detecta nem interpreta o sinal nesta fase — o assistente
// continua selecionando manualmente a resposta observada.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const auth = await requirePatientAccess(request, patientId);
  if (auth instanceof Response) return auth;
  const profile = await getResponseProfile(patientId);
  return Response.json({ profile });
}

export async function PUT(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    mappings?: unknown;
  };
  const patientId = Number(body.patientId);
  const auth = await requirePatientAccess(request, patientId, "editGestures");
  if (auth instanceof Response) return auth;
  try {
    const profile = await setResponseProfile(patientId, body.mappings, {
      id: auth.user.id,
    });
    void logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      patientId,
      action: "rtq_response_profile.update",
      entityType: "patientResponseProfile",
      entityId: String(patientId),
    });
    return Response.json({ profile });
  } catch (e) {
    return respostaDeErro(e, 400);
  }
}
