import { requirePatientAccess } from "@/lib/auth";
import { recordResponse } from "@/lib/activity-store";

// Resposta de UM item de UMA execução de Atividade.
//
// Cada alternativa da pergunta é uma proposição de sim/talvez/não — o corpo
// traz o gesto observado POR alternativa (`optionGestures`). Opção e gesto
// continuam conceitos distintos: a alternativa afirmada com 👍 e o resultado
// observacional (correta/incorreta/incerta/não respondida) são DERIVADOS no
// servidor, a partir do snapshot da execução. O documento tem id
// determinístico (runId_itemId): re-registro não duplica; a correção
// explícita sobrescreve com revision+1 — nunca silenciosamente.
export async function POST(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    runId?: string;
    itemId?: string;
    optionGestures?: { optionId: string; gesture: string }[];
    responseTimeMs?: number | null;
  };
  const patientId = Number(body.patientId);
  if (!body.runId || !body.itemId) {
    return Response.json(
      { error: "patientId, runId e itemId obrigatórios" },
      { status: 400 }
    );
  }
  const auth = await requirePatientAccess(request, patientId, "runActivities");
  if (auth instanceof Response) return auth;
  try {
    const response = await recordResponse(
      patientId,
      body.runId,
      {
        itemId: body.itemId,
        optionGestures: body.optionGestures,
        responseTimeMs: body.responseTimeMs,
      },
      { id: auth.user.id }
    );
    return Response.json({ response });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
