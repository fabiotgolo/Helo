import { requirePatientAccess } from "@/lib/auth";
import { comOrigem, lerOrigem } from "@/lib/origem-da-operacao";
import {
  createPath,
  getPathDetail,
  listPathDetails,
  listPaths,
  recordHistoryOpen,
  restartPath,
  returnToNode,
  reusePath,
  runPathAction,
} from "@/lib/option-conversation-store";
import {
  isPathActionKind,
  type PathAction,
} from "@/lib/option-conversation-machine";
import {
  respostaDeErro,
  statusForCreationError,
} from "@/lib/realtime-question-store";

// Caminhos da conversa por opções, dentro de uma sessão de Perguntas em tempo
// real. Criar/operar exige createSession; consultar exige viewSessions.
//
// O cliente descreve a AÇÃO do assistente ("reiniciei a conversa"), nunca o
// próximo estado: quem decide para onde o caminho vai é a máquina de estados.
// O paciente vem da sessão e o assistente vem da autenticação — nenhum dos
// dois é aceito do corpo da requisição.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const auth = await requirePatientAccess(request, patientId, "viewSessions");
  if (auth instanceof Response) return auth;
  if (!sessionId) {
    return Response.json({ error: "sessionId obrigatório" }, { status: 400 });
  }

  const pathId = url.searchParams.get("pathId");
  if (pathId) {
    const detail = await getPathDetail(patientId, sessionId, pathId);
    if (!detail) {
      return Response.json({ error: "conversa não encontrada" }, { status: 404 });
    }
    return Response.json(detail);
  }

  // `detail=1` traz caminhos + níveis + frases numa leitura só: é o que o
  // histórico e a restauração após atualizar a página precisam (§22, §32).
  if (url.searchParams.get("detail") === "1") {
    const details = await listPathDetails(patientId, sessionId);
    if (!details) {
      return Response.json({ error: "sessão não encontrada" }, { status: 404 });
    }
    return Response.json({ details });
  }

  const paths = await listPaths(patientId, sessionId);
  if (!paths) {
    return Response.json({ error: "sessão não encontrada" }, { status: 404 });
  }
  return Response.json({ paths });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    /** Dono da fila offline (R6). Conferido em requirePatientAccess. */
    expectedUserId?: unknown;
    sessionId?: string;
    clientRequestId?: unknown;
    /** "REUSE" copia um caminho concluído para um caminho NOVO (§25). */
    reuseFromPathId?: unknown;
    /** Id proposto pelo cliente (Fase 4.9.3, revisão do §3.3). */
    pathId?: unknown;
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
  const assistant = { id: auth.user.id, name: auth.user.name };

  try {
    return await comOrigem(lerOrigem(body), async () => {
      if (typeof body.reuseFromPathId === "string" && body.reuseFromPathId) {
        const result = await reusePath(
          patientId,
          body.sessionId!,
          body.reuseFromPathId,
          body.clientRequestId,
          assistant
        );
        return Response.json(result);
      }
      const path = await createPath(
        patientId,
        body.sessionId!,
        { clientRequestId: body.clientRequestId, pathId: body.pathId },
        assistant
      );
      return Response.json({ path });
    });
  } catch (e) {
    return respostaDeErro(e, statusForCreationError(e));
  }
}

/** Só o que cada ação exige — nada mais é aceito do corpo. */
function parsePathAction(raw: unknown): PathAction | null {
  const v = (raw ?? {}) as Record<string, unknown>;
  const kind = v.kind;
  if (!isPathActionKind(kind)) return null;
  switch (kind) {
    case "COMPLETE":
      return {
        kind,
        finalStatementId:
          typeof v.finalStatementId === "string" ? v.finalStatementId : null,
      };
    case "INTERRUPT":
    case "RESTART":
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
    /** Dono da fila offline (R6). Conferido em requirePatientAccess. */
    expectedUserId?: unknown;
    sessionId?: string;
    pathId?: string;
    action?: unknown;
    /** Retorno pelo breadcrumb: o nível ao qual voltar (§14). */
    returnToNodeId?: unknown;
    clientRequestId?: unknown;
  };
  const patientId = Number(body.patientId);
  if (!body.sessionId || !body.pathId) {
    return Response.json(
      { error: "patientId, sessionId e pathId obrigatórios" },
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
  const assistant = { id: auth.user.id, name: auth.user.name };

  try {
    return await comOrigem(lerOrigem(body), async () => {
      // Voltar pelo breadcrumb desativa a ramificação posterior e abre uma nova,
      // na mesma transação — separar as duas deixaria o caminho sem nível ativo.
      if (typeof body.returnToNodeId === "string" && body.returnToNodeId) {
        const detail = await returnToNode(
          patientId,
          body.sessionId!,
          body.pathId!,
          body.returnToNodeId,
          body.clientRequestId,
          assistant
        );
        return Response.json(detail);
      }

      const action = parsePathAction(body.action);
      if (!action) {
        return Response.json({ error: "ação inválida" }, { status: 400 });
      }

      // Reiniciar encerra o caminho atual E cria o seguinte: é uma operação só.
      if (action.kind === "RESTART") {
        const result = await restartPath(
          patientId,
          body.sessionId!,
          body.pathId!,
          body.clientRequestId,
          assistant
        );
        return Response.json(result);
      }

      const path = await runPathAction(
        patientId,
        body.sessionId!,
        body.pathId!,
        action,
        assistant,
        body.clientRequestId
      );
      return Response.json({ path });
    });
  } catch (e) {
    return respostaDeErro(e, 400);
  }
}

/**
 * Abrir um item do histórico (§22). É um PUT porque registra a CONSULTA — e
 * apenas ela: nenhum campo do item é tocado, porque abrir nunca pode alterar
 * o que aconteceu.
 */
export async function PUT(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    /** Dono da fila offline (R6). Conferido em requirePatientAccess. */
    expectedUserId?: unknown;
    sessionId?: string;
    itemType?: string;
    itemId?: string;
    pathId?: string | null;
  };
  const patientId = Number(body.patientId);
  const types = ["TURN", "PATH", "NODE", "STATEMENT"] as const;
  if (
    !body.sessionId ||
    !body.itemId ||
    !types.includes(body.itemType as (typeof types)[number])
  ) {
    return Response.json(
      { error: "patientId, sessionId, itemType e itemId obrigatórios" },
      { status: 400 }
    );
  }
  const auth = await requirePatientAccess(request, patientId, "viewSessions");
  if (auth instanceof Response) return auth;
  try {
    await comOrigem(lerOrigem(body), () =>
      recordHistoryOpen(
        patientId,
        body.sessionId!,
        {
          itemType: body.itemType as (typeof types)[number],
          itemId: body.itemId!,
          pathId: body.pathId ?? null,
        },
        { id: auth.user.id, name: auth.user.name }
      )
    );
    return Response.json({ ok: true });
  } catch (e) {
    return respostaDeErro(e, 400);
  }
}
