import { requirePatientAccess } from "@/lib/auth";
import {
  getActiveSessionContext,
  listSessionContextVersions,
  recordSessionContextView,
  saveSessionContext,
} from "@/lib/session-context-store";
import { respostaDeErro } from "@/lib/realtime-question-store";

// Contexto da conversa (Fase 4.8), dentro de uma sessão de Perguntas em tempo
// real. Gravar exige createSession; consultar exige viewSessions.
//
// O contexto é anotação do cuidador sobre a circunstância — nunca fala do
// paciente e nunca confirmação. O paciente vem da sessão e o assistente vem da
// autenticação; nenhum dos dois é aceito do corpo da requisição, e tampouco
// versão, status ou horário.
//
// Não existe DELETE: uma versão anterior continua legível para sempre.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const auth = await requirePatientAccess(request, patientId, "viewSessions");
  if (auth instanceof Response) return auth;
  if (!sessionId) {
    return Response.json({ error: "sessionId obrigatório" }, { status: 400 });
  }

  // `all=1` devolve a trilha de versões — o histórico mostra o que valia em
  // cada momento da conversa.
  if (url.searchParams.get("all") === "1") {
    const versions = await listSessionContextVersions(patientId, sessionId);
    return Response.json({ versions });
  }

  const context = await getActiveSessionContext(patientId, sessionId);
  return Response.json({ context });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    /** Dono da fila offline (R6). Conferido em requirePatientAccess. */
    expectedUserId?: unknown;
    sessionId?: string;
    clientRequestId?: unknown;
    skipped?: unknown;
    interlocutorPersonId?: unknown;
    interlocutorName?: unknown;
    interlocutorRelation?: unknown;
    intention?: unknown;
    environment?: unknown;
    initialTopic?: unknown;
    notes?: unknown;
    /** `updatedAt` da versão vigente quando o cuidador escreveu (§10 caso 7). */
    baseVersion?: unknown;
  };
  const patientId = Number(body.patientId);
  if (!body.sessionId) {
    return Response.json(
      { error: "patientId e sessionId obrigatórios" },
      { status: 400 }
    );
  }
  const auth = await requirePatientAccess(
    request,
    patientId,
    "createSession",
    body.expectedUserId
  );
  if (auth instanceof Response) return auth;

  try {
    const context = await saveSessionContext(
      patientId,
      body.sessionId,
      {
        clientRequestId: body.clientRequestId,
        skipped: body.skipped,
        interlocutorPersonId: body.interlocutorPersonId,
        interlocutorName: body.interlocutorName,
        interlocutorRelation: body.interlocutorRelation,
        intention: body.intention,
        environment: body.environment,
        initialTopic: body.initialTopic,
        notes: body.notes,
        baseVersion: body.baseVersion,
      },
      { id: auth.user.id, name: auth.user.name }
    );
    return Response.json({ context });
  } catch (e) {
    return respostaDeErro(e, 400);
  }
}

/** Registra a consulta ao contexto — mesma convenção do PUT de /paths. */
export async function PUT(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    /** Dono da fila offline (R6). Conferido em requirePatientAccess. */
    expectedUserId?: unknown;
    sessionId?: string;
    contextId?: string;
  };
  const patientId = Number(body.patientId);
  if (!body.sessionId || !body.contextId) {
    return Response.json(
      { error: "patientId, sessionId e contextId obrigatórios" },
      { status: 400 }
    );
  }
  const auth = await requirePatientAccess(request, patientId, "viewSessions");
  if (auth instanceof Response) return auth;

  try {
    const result = await recordSessionContextView(
      patientId,
      body.sessionId,
      body.contextId,
      { id: auth.user.id, name: auth.user.name }
    );
    return Response.json(result);
  } catch (e) {
    return respostaDeErro(e, 400);
  }
}
