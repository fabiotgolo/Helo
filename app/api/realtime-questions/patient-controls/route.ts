import { requirePatientAccess } from "@/lib/auth";
import {
  getOpenPatientControl,
  listPatientControls,
  openPatientControl,
  runPatientControlAction,
} from "@/lib/patient-control-store";
import {
  isPatientControlActionKind,
  type PatientControlAction,
} from "@/lib/patient-control-machine";
import { isPatientCommand } from "@/lib/patient-control-types";
import { respostaDeErro } from "@/lib/realtime-question-store";
import { isSemanticResponse } from "@/lib/realtime-question-types";

// Controles diretos do paciente (Fase 4.7), dentro de uma sessão de Perguntas
// em tempo real. Operar exige createSession; consultar exige viewSessions.
//
// O cliente descreve a AÇÃO do assistente ("o paciente marcou o comando 2",
// "conferi o comando observado"), nunca o próximo estado nem o efeito. Quem
// decide o que cada comando faz — e se ele pode acontecer agora — é a máquina
// de estados, e a execução delega aos verbos que já governam sessão, turno,
// nível e caminho.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const auth = await requirePatientAccess(request, patientId, "viewSessions");
  if (auth instanceof Response) return auth;
  if (!sessionId) {
    return Response.json({ error: "sessionId obrigatório" }, { status: 400 });
  }

  if (url.searchParams.get("all") === "1") {
    const requests = await listPatientControls(patientId, sessionId);
    return Response.json({ requests });
  }

  const openRequest = await getOpenPatientControl(patientId, sessionId);
  return Response.json({ request: openRequest });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    /** Dono da fila offline (R6). Conferido em requirePatientAccess. */
    expectedUserId?: unknown;
    sessionId?: string;
    clientRequestId?: unknown;
    targetType?: unknown;
    targetId?: unknown;
    targetPathId?: unknown;
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
    const result = await openPatientControl(
      patientId,
      body.sessionId,
      {
        clientRequestId: body.clientRequestId,
        targetType: body.targetType,
        targetId: body.targetId,
        targetPathId: body.targetPathId,
      },
      { id: auth.user.id, name: auth.user.name }
    );
    return Response.json({ request: result });
  } catch (e) {
    return respostaDeErro(e, 400);
  }
}

/**
 * Só o que a máquina entende passa daqui: o corpo é reescrito campo a campo,
 * nunca repassado. Um cliente não tem como injetar estado, horário ou efeito.
 */
function parseControlAction(raw: unknown): PatientControlAction | null {
  if (!raw || typeof raw !== "object") return null;
  const action = raw as Record<string, unknown>;
  const kind = action.kind;
  if (!isPatientControlActionKind(kind)) return null;

  if (kind === "SELECT_COMMAND" || kind === "CHANGE_COMMAND") {
    return isPatientCommand(action.command)
      ? { kind, command: action.command }
      : null;
  }
  if (kind === "RESPOND_END") {
    return isSemanticResponse(action.response)
      ? { kind, response: action.response }
      : null;
  }
  if (kind === "CANCEL") {
    return {
      kind,
      reason: typeof action.reason === "string" ? action.reason : undefined,
    };
  }
  return { kind } as PatientControlAction;
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    /** Dono da fila offline (R6). Conferido em requirePatientAccess. */
    expectedUserId?: unknown;
    sessionId?: string;
    requestId?: string;
    action?: unknown;
    clientRequestId?: unknown;
  };
  const patientId = Number(body.patientId);
  const action = parseControlAction(body.action);
  if (!body.sessionId || !body.requestId || !action) {
    return Response.json(
      { error: "patientId, sessionId, requestId e action válidos são obrigatórios" },
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
    const result = await runPatientControlAction(
      patientId,
      body.sessionId,
      body.requestId,
      action,
      { id: auth.user.id, name: auth.user.name },
      body.clientRequestId
    );
    return Response.json(result);
  } catch (e) {
    return respostaDeErro(e, 400);
  }
}
