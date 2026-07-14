import { logAudit } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { resolveFeedbackConversation } from "@/lib/feedback";

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "não foi possível encerrar a conversa";
  const status =
    message === "solicitação não encontrada" ? 404 :
      message === "acesso negado" ? 403 :
        message === "esta conversa já está encerrada" ? 409 : 400;
  return Response.json({ error: message }, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!id) return Response.json({ error: "solicitação inválida" }, { status: 400 });
  try {
    const systemMessage = await resolveFeedbackConversation({ requestId: id, user: auth.user });
    await logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      action: auth.user.role === "admin" ? "feedback.conversation.resolved_by_admin" : "feedback.conversation.resolved_by_user",
      entityType: "feedbackRequest",
      entityId: id,
      metadata: { resolutionSource: auth.user.role === "admin" ? "admin" : "user" },
    });
    return Response.json({ systemMessage });
  } catch (error) {
    return errorResponse(error);
  }
}
