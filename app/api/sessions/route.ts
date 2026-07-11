import { createSession, endSession } from "@/lib/store";

export async function POST(request: Request) {
  const { operator, mode, patientId } = (await request.json()) as {
    operator?: string;
    mode?: string;
    patientId?: number | null;
  };
  const id = await createSession(mode ?? "conversa", operator, patientId);
  return Response.json({ id });
}

export async function PATCH(request: Request) {
  const { id } = (await request.json()) as { id?: number };
  if (!id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  await endSession(id);
  return Response.json({ ok: true });
}
