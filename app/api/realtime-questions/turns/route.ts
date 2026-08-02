import { requirePatientAccess } from "@/lib/auth";
import {
  createTurn,
  listTurns,
  runTurnAction,
} from "@/lib/realtime-question-store";
import {
  isTurnActionKind,
  type TurnAction,
} from "@/lib/realtime-question-machine";
import {
  isSemanticResponse,
  isSensitiveCategory,
} from "@/lib/realtime-question-types";

// Interações (perguntas) de uma sessão de Perguntas em tempo real.
//
// O cliente descreve a AÇÃO do assistente ("conferi a seleção"), nunca o
// próximo estado: a máquina de estados é quem decide para onde a interação
// vai. É assim que a reconfirmação de pergunta sensível não pode ser pulada
// por uma requisição forjada.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const auth = await requirePatientAccess(request, patientId, "viewSessions");
  if (auth instanceof Response) return auth;
  if (!sessionId) {
    return Response.json({ error: "sessionId obrigatório" }, { status: 400 });
  }
  const turns = await listTurns(patientId, sessionId);
  if (!turns) {
    return Response.json({ error: "sessão não encontrada" }, { status: 404 });
  }
  return Response.json({ turns });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    sessionId?: string;
    text?: unknown;
    questionSource?: unknown;
    isSensitive?: unknown;
    sensitiveCategory?: unknown;
    /** "Reutilizar como novo" a partir do histórico (§24). */
    reusedFromTurnId?: unknown;
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
  try {
    const turn = await createTurn(
      patientId,
      body.sessionId,
      {
        text: body.text,
        questionSource: body.questionSource,
        isSensitive: body.isSensitive,
        sensitiveCategory: body.sensitiveCategory,
        reusedFromTurnId: body.reusedFromTurnId,
      },
      { id: auth.user.id, name: auth.user.name }
    );
    return Response.json({ turn });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Monta a ação a partir do corpo, aceitando só o que cada tipo exige. */
function parseAction(raw: unknown): TurnAction | null {
  const v = (raw ?? {}) as Record<string, unknown>;
  const kind = v.kind;
  if (!isTurnActionKind(kind)) return null;
  switch (kind) {
    case "REVIEW": {
      if (typeof v.reviewedText !== "string") return null;
      // Sensibilidade é marcação MANUAL do assistente na revisão. Omitida,
      // não altera o que já estava gravado; a validação real é do domínio.
      const action: TurnAction = {
        kind,
        reviewedText: v.reviewedText.slice(0, 500),
      };
      if (v.isSensitive !== undefined) action.isSensitive = v.isSensitive === true;
      if (v.sensitiveCategory !== undefined) {
        action.sensitiveCategory = isSensitiveCategory(v.sensitiveCategory)
          ? v.sensitiveCategory
          : null;
      }
      return action;
    }
    case "SELECT_RESPONSE":
    case "CHANGE_RESPONSE":
      return isSemanticResponse(v.response)
        ? { kind, response: v.response }
        : null;
    case "RECORD_NO_RESPONSE":
    case "CANCEL":
      return {
        kind,
        reason:
          typeof v.reason === "string" ? v.reason.slice(0, 200) : undefined,
      };
    default:
      return { kind };
  }
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    sessionId?: string;
    turnId?: string;
    action?: unknown;
  };
  const patientId = Number(body.patientId);
  if (!body.sessionId || !body.turnId) {
    return Response.json(
      { error: "patientId, sessionId e turnId obrigatórios" },
      { status: 400 }
    );
  }
  const action = parseAction(body.action);
  if (!action) {
    return Response.json({ error: "ação inválida" }, { status: 400 });
  }
  const auth = await requirePatientAccess(request, patientId, "createSession");
  if (auth instanceof Response) return auth;
  try {
    const turn = await runTurnAction(
      patientId,
      body.sessionId,
      body.turnId,
      action,
      { id: auth.user.id, name: auth.user.name }
    );
    return Response.json({ turn });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
