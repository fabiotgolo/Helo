import { requirePatientAccess } from "@/lib/auth";
import {
  createNode,
  getPathDetail,
  replaceNode,
  reuseNode,
  reviewNode,
  runNodeAction,
} from "@/lib/option-conversation-store";
import {
  isNodeActionKind,
  type NodeAction,
} from "@/lib/option-conversation-machine";
import { statusForCreationError } from "@/lib/realtime-question-store";

// Níveis de um caminho da conversa por opções.
//
// Nenhuma rota aqui aceita "status": o cliente descreve o que o assistente fez
// ("conferi a opção observada") e a máquina de estados decide o resto. É assim
// que não existe requisição capaz de avançar um nível sem conferência, nem de
// reescrever um texto que o paciente já viu.

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
  return Response.json({ nodes: detail.nodes });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    sessionId?: string;
    pathId?: string;
    promptText?: unknown;
    options?: unknown;
    parentNodeId?: unknown;
    isSensitive?: unknown;
    sensitiveCategory?: unknown;
    clientRequestId?: unknown;
    /** "Reutilizar como novo" a partir do histórico (§24). */
    reuseFromNodeId?: unknown;
    /** "Criar versão corrigida" de um nível já apresentado (§28, §29). */
    replaceNodeId?: unknown;
    /** Id proposto pelo cliente (Fase 4.9.3, revisão do §3.3). */
    nodeId?: unknown;
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
    if (typeof body.reuseFromNodeId === "string" && body.reuseFromNodeId) {
      const result = await reuseNode(
        patientId,
        body.sessionId,
        body.reuseFromNodeId,
        { targetPathId: body.pathId, clientRequestId: body.clientRequestId },
        assistant
      );
      return Response.json(result);
    }

    if (!body.pathId) {
      return Response.json({ error: "pathId obrigatório" }, { status: 400 });
    }

    if (typeof body.replaceNodeId === "string" && body.replaceNodeId) {
      const result = await replaceNode(
        patientId,
        body.sessionId,
        body.pathId,
        body.replaceNodeId,
        body.clientRequestId,
        assistant
      );
      return Response.json(result);
    }

    const node = await createNode(
      patientId,
      body.sessionId,
      body.pathId,
      {
        promptText: body.promptText,
        options: body.options,
        parentNodeId: body.parentNodeId,
        isSensitive: body.isSensitive,
        sensitiveCategory: body.sensitiveCategory,
        clientRequestId: body.clientRequestId,
        nodeId: body.nodeId,
      },
      assistant
    );
    return Response.json({ node });
  } catch (e) {
    return Response.json(
      { error: (e as Error).message },
      { status: statusForCreationError(e) }
    );
  }
}

/**
 * Monta a ação a partir do corpo, aceitando só o que cada tipo exige.
 *
 * REVIEW é o único caminho de edição direta, e o domínio já o recusa a partir
 * de PRESENTED — não há como reescrever pela rota o que o paciente já viu.
 */
function parseNodeAction(raw: unknown): NodeAction | null {
  const v = (raw ?? {}) as Record<string, unknown>;
  const kind = v.kind;
  if (!isNodeActionKind(kind)) return null;
  switch (kind) {
    // REVIEW é tratado fora daqui, por reviewNode: as opções precisam passar
    // pela mesma normalização da criação (limite de três, sem lacunas).
    case "REVIEW":
      return null;
    case "SELECT_OPTION":
    case "CHANGE_OPTION":
      return typeof v.optionId === "string" && v.optionId
        ? { kind, optionId: v.optionId }
        : null;
    case "MARK_REPLACED":
      // Só o domínio marca substituição, dentro de replaceNode.
      return null;
    case "DEACTIVATE":
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
    nodeId?: string;
    action?: unknown;
    clientRequestId?: unknown;
  };
  const patientId = Number(body.patientId);
  if (!body.sessionId || !body.pathId || !body.nodeId) {
    return Response.json(
      { error: "patientId, sessionId, pathId e nodeId obrigatórios" },
      { status: 400 }
    );
  }
  const raw = (body.action ?? {}) as Record<string, unknown>;
  const auth = await requirePatientAccess(request, patientId, "createSession");
  if (auth instanceof Response) return auth;
  const assistant = { id: auth.user.id, name: auth.user.name };

  // Edição do rascunho: mesmo registro, com as opções normalizadas como na
  // criação (§27).
  if (raw.kind === "REVIEW") {
    try {
      const node = await reviewNode(
        patientId,
        body.sessionId,
        body.pathId,
        body.nodeId,
        {
          promptText: raw.promptText,
          options: raw.options,
          isSensitive: raw.isSensitive,
          sensitiveCategory: raw.sensitiveCategory,
          clientRequestId: body.clientRequestId,
        },
        assistant
      );
      return Response.json({ node });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  const action = parseNodeAction(body.action);
  if (!action) {
    return Response.json({ error: "ação inválida" }, { status: 400 });
  }
  try {
    const result = await runNodeAction(
      patientId,
      body.sessionId,
      body.pathId,
      body.nodeId,
      action,
      assistant,
      body.clientRequestId
    );
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
