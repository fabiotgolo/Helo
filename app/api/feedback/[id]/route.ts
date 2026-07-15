import { logAudit } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { deleteFeedbackForUser, updateFeedbackContent } from "@/lib/feedback";

const MAX_TITLE = 140;
const MAX_DESCRIPTION = 5000;

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "não foi possível concluir a ação";
  const status = message === "solicitação não encontrada" ? 404 : 403;
  return Response.json({ error: message }, { status });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = (await request.json()) as { title?: unknown; description?: unknown };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!title || !description) {
    return Response.json({ error: "título e descrição são obrigatórios" }, { status: 400 });
  }
  if (title.length > MAX_TITLE || description.length > MAX_DESCRIPTION) {
    return Response.json({ error: "a solicitação excede o tamanho permitido" }, { status: 400 });
  }
  try {
    await updateFeedbackContent({ id, userId: auth.user.id, title, description });
    await logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      action: "feedback.content.update",
      entityType: "feedbackRequest",
      entityId: id,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  try {
    await deleteFeedbackForUser({ id, user: auth.user });
    await logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      action: "feedback.delete",
      entityType: "feedbackRequest",
      entityId: id,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
