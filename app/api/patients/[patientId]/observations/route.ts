import { requirePatientAccess } from "@/lib/auth";
import { insertEvent } from "@/lib/store";

type ObservationPayload = {
  patientId?: string | number;
  authorRole?: string;
  message?: string;
  timestamp?: string;
  source?: string;
  sessionId?: number | null;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ patientId: string }> }
) {
  const { patientId: rawPatientId } = await params;
  const patientId = Number(rawPatientId);
  if (!patientId || Number.isNaN(patientId)) {
    return Response.json({ error: "patientId inválido" }, { status: 400 });
  }

  const payload = (await request.json()) as ObservationPayload;
  const message = payload.message?.trim() ?? "";
  if (!message) {
    return Response.json({ error: "mensagem obrigatória" }, { status: 400 });
  }
  if (message.length > 2_000) {
    return Response.json({ error: "mensagem deve ter no máximo 2.000 caracteres" }, { status: 400 });
  }
  if (payload.patientId != null && Number(payload.patientId) !== patientId) {
    return Response.json({ error: "patientId divergente" }, { status: 400 });
  }
  if (payload.authorRole !== "caregiver" || payload.source !== "live_session_observation") {
    return Response.json({ error: "origem da observação inválida" }, { status: 400 });
  }

  const auth = await requirePatientAccess(request, patientId, "createSession");
  if (auth instanceof Response) return auth;

  const timestamp = new Date().toISOString();
  await insertEvent({
    sessionId: typeof payload.sessionId === "number" ? payload.sessionId : null,
    patientId,
    type: "observacao_acompanhante",
    category: "live_session_observation",
    detail: message,
    authorRole: "caregiver",
    source: "live_session_observation",
  });
  return Response.json({ ok: true, timestamp });
}
