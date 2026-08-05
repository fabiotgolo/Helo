import { requirePatientAccess } from "@/lib/auth";
import { logAudit } from "@/lib/access";
import {
  createRtqSession,
  getRtqSession,
  listRtqSessions,
  listTurns,
  runSessionAction,
} from "@/lib/realtime-question-store";
import { getActiveSessionContext } from "@/lib/session-context-store";
import { getOpenPatientControl } from "@/lib/patient-control-store";
import type { SessionAction } from "@/lib/realtime-question-machine";

// Sessões de Perguntas em tempo real. Criar/operar exige createSession;
// consultar exige viewSessions. A identidade do assistente vem SEMPRE da
// sessão autenticada — nunca do corpo da requisição. O paciente da sessão é
// definido na criação e nunca muda.

const SESSION_ACTIONS: SessionAction[] = [
  "PAUSE",
  "RESUME",
  "COMPLETE",
  "ABANDON",
];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const auth = await requirePatientAccess(request, patientId, "viewSessions");
  if (auth instanceof Response) return auth;

  const sessionId = url.searchParams.get("sessionId");
  if (sessionId) {
    const session = await getRtqSession(patientId, sessionId);
    if (!session) {
      return Response.json({ error: "sessão não encontrada" }, { status: 404 });
    }
    // Sessão + interações + contexto numa leitura só: é o que a restauração
    // após atualizar a página precisa para voltar exatamente onde estava.
    const [turns, context, controlRequest] = await Promise.all([
      listTurns(patientId, sessionId),
      getActiveSessionContext(patientId, sessionId),
      getOpenPatientControl(patientId, sessionId),
    ]);
    return Response.json({
      session,
      turns: turns ?? [],
      context,
      controlRequest,
    });
  }

  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const sessions = await listRtqSessions(patientId, limit);
  return Response.json({ sessions });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { patientId?: number };
  const patientId = Number(body.patientId);
  const auth = await requirePatientAccess(request, patientId, "createSession");
  if (auth instanceof Response) return auth;
  try {
    const session = await createRtqSession(patientId, {
      id: auth.user.id,
      name: auth.user.name,
    });
    void logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      patientId,
      action: "rtq_session.start",
      entityType: "conversationQuestionSession",
      entityId: session.id,
    });
    return Response.json({ session });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    sessionId?: string;
    action?: string;
    /** Chave de idempotência (Fase 4.9.3). */
    clientRequestId?: unknown;
  };
  const patientId = Number(body.patientId);
  if (!body.sessionId || !SESSION_ACTIONS.includes(body.action as SessionAction)) {
    return Response.json(
      { error: "patientId, sessionId e action válidos são obrigatórios" },
      { status: 400 }
    );
  }
  const auth = await requirePatientAccess(request, patientId, "createSession");
  if (auth instanceof Response) return auth;
  try {
    const session = await runSessionAction(
      patientId,
      body.sessionId,
      body.action as SessionAction,
      { id: auth.user.id, name: auth.user.name },
      body.clientRequestId
    );
    void logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      patientId,
      action: `rtq_session.${(body.action as string).toLowerCase()}`,
      entityType: "conversationQuestionSession",
      entityId: session.id,
    });
    return Response.json({ session });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
