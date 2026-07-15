import { logAudit } from "@/lib/access";
import { requireAdmin } from "@/lib/auth";
import { deleteFeedback, listFeedbackForAdmin, updateFeedback } from "@/lib/feedback";
import { isFeedbackStatus, type FeedbackVisibility } from "@/lib/feedback-types";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  return Response.json({ requests: await listFeedbackForAdmin() });
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const body = (await request.json()) as {
    id?: unknown;
    status?: unknown;
    visibility?: unknown;
    archived?: unknown;
  };
  if (typeof body.id !== "string" || !body.id) {
    return Response.json({ error: "id obrigatório" }, { status: 400 });
  }
  if (body.status !== undefined && !isFeedbackStatus(body.status)) {
    return Response.json({ error: "status inválido" }, { status: 400 });
  }
  const visibility: FeedbackVisibility | undefined =
    body.visibility === "public" || body.visibility === "private" ? body.visibility : undefined;
  if (body.visibility !== undefined && !visibility) {
    return Response.json({ error: "visibilidade inválida" }, { status: 400 });
  }
  if (body.archived !== undefined && typeof body.archived !== "boolean") {
    return Response.json({ error: "arquivo inválido" }, { status: 400 });
  }
  try {
    await updateFeedback({
      id: body.id,
      status: body.status,
      visibility,
      archived: body.archived,
    });
    await logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      action: "feedback.update",
      entityType: "feedbackRequest",
      entityId: body.id,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "não foi possível atualizar" },
      { status: 404 }
    );
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const body = (await request.json()) as { id?: unknown };
  if (typeof body.id !== "string" || !body.id) {
    return Response.json({ error: "id obrigatório" }, { status: 400 });
  }
  try {
    await deleteFeedback(body.id);
    await logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      action: "feedback.delete",
      entityType: "feedbackRequest",
      entityId: body.id,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "não foi possível excluir" },
      { status: 404 }
    );
  }
}
