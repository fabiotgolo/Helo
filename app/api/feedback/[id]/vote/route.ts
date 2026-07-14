import { logAudit } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { toggleFeedbackVote } from "@/lib/feedback";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!id) return Response.json({ error: "solicitação inválida" }, { status: 400 });
  try {
    const vote = await toggleFeedbackVote({ requestId: id, userId: auth.user.id });
    await logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      action: vote.hasVoted ? "feedback.vote.add" : "feedback.vote.remove",
      entityType: "feedbackRequest",
      entityId: id,
    });
    return Response.json(vote);
  } catch (error) {
    const message = error instanceof Error ? error.message : "não foi possível registrar o voto";
    return Response.json({ error: message }, { status: message === "solicitação não encontrada" ? 404 : 409 });
  }
}
