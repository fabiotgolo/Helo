import { logAudit } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { createFeedbackMessage, listFeedbackMessages } from "@/lib/feedback";
import type { FeedbackVisibility } from "@/lib/feedback-types";

const MAX_MESSAGE = 5000;

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "não foi possível concluir a ação";
  const status = message === "solicitação não encontrada" ? 404 : message === "acesso negado" ? 403 : 400;
  return Response.json({ error: message }, { status });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!id) return Response.json({ error: "solicitação inválida" }, { status: 400 });
  try {
    const messages = await listFeedbackMessages({ requestId: id, user: auth.user });
    return Response.json({ messages });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = (await request.json()) as { message?: unknown; visibility?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!id || !message) return Response.json({ error: "mensagem obrigatória" }, { status: 400 });
  if (message.length > MAX_MESSAGE) {
    return Response.json({ error: "a mensagem excede o tamanho permitido" }, { status: 400 });
  }
  const visibility: FeedbackVisibility | undefined =
    body.visibility === "public" || body.visibility === "private" ? body.visibility : undefined;
  if (body.visibility !== undefined && !visibility) {
    return Response.json({ error: "visibilidade inválida" }, { status: 400 });
  }
  try {
    const feedbackMessage = await createFeedbackMessage({
      requestId: id,
      user: auth.user,
      message,
      visibility,
    });
    await logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      action: "feedback.message.create",
      entityType: "feedbackRequest",
      entityId: id,
      metadata: { visibility: feedbackMessage.visibility },
    });
    return Response.json({ message: feedbackMessage }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
