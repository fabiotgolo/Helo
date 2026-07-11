import { createSession, endSession, listRecentSessions } from "@/lib/store";
import { requirePatientAccess, requireUser } from "@/lib/auth";

// Sessões recentes de UM paciente, com métricas por sessão.
// GET exige viewSessions; POST (operar a Helo) exige createSession.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  if (!patientId || Number.isNaN(patientId)) {
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }
  const auth = await requirePatientAccess(request, patientId, "viewSessions");
  if (auth instanceof Response) return auth;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 50);
  const sessions = await listRecentSessions(patientId, limit);
  return Response.json({ sessions });
}

export async function POST(request: Request) {
  const { operator, mode, patientId } = (await request.json()) as {
    operator?: string;
    mode?: string;
    patientId?: number | null;
  };
  const auth = await requirePatientAccess(
    request,
    Number(patientId),
    "createSession"
  );
  if (auth instanceof Response) return auth;
  const id = await createSession(
    mode ?? "conversa",
    operator ?? auth.user.name,
    patientId
  );
  return Response.json({ id });
}

export async function PATCH(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const { id } = (await request.json()) as { id?: number };
  if (!id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  await endSession(id);
  return Response.json({ ok: true });
}
