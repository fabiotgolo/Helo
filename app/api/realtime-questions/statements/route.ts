import { requirePatientAccess } from "@/lib/auth";
import {
  createStatement,
  getPathDetail,
  replaceStatement,
  reuseStatement,
  runStatementAction,
} from "@/lib/option-conversation-store";
import {
  isStatementActionKind,
  type StatementAction,
} from "@/lib/option-conversation-machine";
import {
  isSemanticResponse,
  isSensitiveCategory,
} from "@/lib/realtime-question-types";

// Mensagem em construção e frase final de um caminho.
//
// A regra que esta rota NÃO pode contornar: só SIM confirma. TALVEZ e NÃO
// chegam aqui como resposta OBSERVADA e param em PROVISIONAL_RESPONSE — não
// existe corpo de requisição capaz de transformá-los em confirmação, porque
// quem decide é applyStatementAction, e `confirmedResponse` é tipado `"YES" |
// null`.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const pathId = url.searchParams.get("pathId") ?? "";
  const auth = await requirePatientAccess(request, patientId, "viewSessions");
  if (auth instanceof Response) return auth;
  if (!sessionId || !pathId) {
    return Response.json(
      { error: "sessionId e pathId obrigatórios" },
      { status: 400 }
    );
  }
  const detail = await getPathDetail(patientId, sessionId, pathId);
  if (!detail) {
    return Response.json({ error: "conversa não encontrada" }, { status: 404 });
  }
  return Response.json({ statements: detail.statements });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    sessionId?: string;
    pathId?: string;
    text?: unknown;
    originNodeId?: unknown;
    isSensitive?: unknown;
    sensitiveCategory?: unknown;
    clientRequestId?: unknown;
    /** "Reutilizar como novo" a partir do histórico (§24). */
    reuseFromStatementId?: unknown;
    /** "Criar versão corrigida" de uma frase já apresentada (§30). */
    replaceStatementId?: unknown;
  };
  const patientId = Number(body.patientId);
  if (!body.sessionId) {
    return Response.json(
      { error: "patientId e sessionId obrigatórios" },
      { status: 400 }
    );
  }
  const auth = await requirePatientAccess(request, patientId, "createSession");
  if (auth instanceof Response) return auth;
  const assistant = { id: auth.user.id, name: auth.user.name };

  try {
    if (
      typeof body.reuseFromStatementId === "string" &&
      body.reuseFromStatementId
    ) {
      const result = await reuseStatement(
        patientId,
        body.sessionId,
        body.reuseFromStatementId,
        { targetPathId: body.pathId, clientRequestId: body.clientRequestId },
        assistant
      );
      return Response.json(result);
    }

    if (!body.pathId) {
      return Response.json({ error: "pathId obrigatório" }, { status: 400 });
    }

    if (
      typeof body.replaceStatementId === "string" &&
      body.replaceStatementId
    ) {
      const result = await replaceStatement(
        patientId,
        body.sessionId,
        body.pathId,
        body.replaceStatementId,
        body.clientRequestId,
        assistant
      );
      return Response.json(result);
    }

    const statement = await createStatement(
      patientId,
      body.sessionId,
      body.pathId,
      {
        text: body.text,
        originNodeId: body.originNodeId,
        isSensitive: body.isSensitive,
        sensitiveCategory: body.sensitiveCategory,
        clientRequestId: body.clientRequestId,
      },
      assistant
    );
    return Response.json({ statement });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Só o que cada ação exige — nada mais é aceito do corpo. */
function parseStatementAction(
  raw: unknown
): StatementAction | { kind: "REJECT" } | null {
  const v = (raw ?? {}) as Record<string, unknown>;
  const kind = v.kind;
  // REJECT não está em STATEMENT_ACTION_KINDS: ele tem função própria no
  // domínio (applyStatementRejection), com a mesma cerimônia da confirmação.
  if (kind === "REJECT") return { kind: "REJECT" };
  if (!isStatementActionKind(kind)) return null;
  switch (kind) {
    case "EDIT": {
      if (typeof v.text !== "string") return null;
      const action: StatementAction = { kind, text: v.text.slice(0, 500) };
      if (v.isSensitive !== undefined) action.isSensitive = v.isSensitive === true;
      if (v.sensitiveCategory !== undefined) {
        action.sensitiveCategory = isSensitiveCategory(v.sensitiveCategory)
          ? v.sensitiveCategory
          : null;
      }
      return action;
    }
    case "RESPOND":
    case "CHANGE_RESPONSE":
      return isSemanticResponse(v.response)
        ? { kind, response: v.response }
        : null;
    case "MARK_REPLACED":
      // Só o domínio marca substituição, dentro de replaceStatement.
      return null;
    case "CANCEL":
      return {
        kind,
        reason: typeof v.reason === "string" ? v.reason.slice(0, 200) : undefined,
      };
    default:
      return { kind };
  }
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    sessionId?: string;
    pathId?: string;
    statementId?: string;
    action?: unknown;
  };
  const patientId = Number(body.patientId);
  if (!body.sessionId || !body.pathId || !body.statementId) {
    return Response.json(
      { error: "patientId, sessionId, pathId e statementId obrigatórios" },
      { status: 400 }
    );
  }
  const action = parseStatementAction(body.action);
  if (!action) {
    return Response.json({ error: "ação inválida" }, { status: 400 });
  }
  const auth = await requirePatientAccess(request, patientId, "createSession");
  if (auth instanceof Response) return auth;
  try {
    const result = await runStatementAction(
      patientId,
      body.sessionId,
      body.pathId,
      body.statementId,
      action,
      { id: auth.user.id, name: auth.user.name }
    );
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
