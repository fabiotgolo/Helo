// ——— Fila → requisição HTTP real (Fase B) ———
//
// Módulo PURO: recebe uma `OfflineOperation`, devolve a descrição de UMA
// requisição — método, caminho, corpo. Nenhum `fetch` aqui. É o que faz esta
// tradução testável em milissegundos, sem servidor, no mesmo espírito de
// `lib/offline/queue.ts`.
//
// A REGRA que este módulo nunca quebra: `clientRequestId` no corpo é SEMPRE
// `op.idempotencyKey` — nunca um valor lido de dentro de `op.payload` (que
// pode conter, por razões históricas da 4.9.2, um `clientRequestId` que era
// só a chave de dedup do CLIQUE, não da OPERAÇÃO da fila). Reenviar com uma
// chave diferente a cada tentativa desfaria toda a proteção da Fase A.
//
// Os ids que o payload já carrega (turnId, pathId, nodeId, statementId) são a
// identidade DEFINITIVA do registro desde que nasceram no cliente (Fase B,
// revisão do §3.3) — vão para o corpo exatamente como estão, sem tradução.
// Uma referência entre operações da mesma fila (um nó cujo `pathId` foi
// criado por uma operação anterior) já é válida por construção.

import type { OfflineOperation } from "@/lib/offline/types";

export interface SyncRequest {
  method: "POST" | "PATCH";
  /** Relativo a `/api/realtime-questions`. */
  path: string;
  body: Record<string, unknown>;
}

export class UnsupportedOperationError extends Error {
  constructor(operationType: string) {
    super(`tipo de operação sem mapeamento de sincronização: ${operationType}`);
    this.name = "UnsupportedOperationError";
  }
}

/** O que o payload de cada tipo de operação garante ter — ver lib/realtime-question-client.ts. */
type Payload = Record<string, unknown>;

function payloadOf(op: OfflineOperation): Payload {
  return (op.payload ?? {}) as Payload;
}

/**
 * Monta a requisição real para uma operação ENVIÁVEL.
 *
 * Não valida se a operação PODE ser enviada agora (ordem, dependências,
 * backoff) — isso é `nextSendable`, em `queue.ts`. Esta função só traduz.
 */
export function buildSyncRequest(op: OfflineOperation): SyncRequest {
  const patientId = Number(op.patientId);
  const p = payloadOf(op);
  const clientRequestId = op.idempotencyKey;

  switch (op.operationType) {
    case "createTurn":
      return {
        method: "POST",
        path: "/turns",
        body: {
          patientId,
          sessionId: p.sessionId,
          text: p.text,
          questionSource: p.questionSource,
          isSensitive: p.isSensitive,
          sensitiveCategory: p.sensitiveCategory,
          reusedFromTurnId: p.reusedFromTurnId,
          turnId: p.turnId,
          clientRequestId,
        },
      };

    case "turnAction":
      return {
        method: "PATCH",
        path: "/turns",
        body: {
          patientId,
          sessionId: p.sessionId,
          turnId: p.turnId,
          action: p.action,
          clientRequestId,
        },
      };

    case "createPath":
      return {
        method: "POST",
        path: "/paths",
        body: {
          patientId,
          sessionId: p.sessionId,
          pathId: p.pathId,
          clientRequestId,
        },
      };

    case "pathAction":
      return {
        method: "PATCH",
        path: "/paths",
        body: {
          patientId,
          sessionId: p.sessionId,
          pathId: p.pathId,
          action: p.action,
          clientRequestId,
        },
      };

    case "createNode":
      return {
        method: "POST",
        path: "/nodes",
        body: {
          patientId,
          sessionId: p.sessionId,
          pathId: p.pathId,
          nodeId: p.nodeId,
          promptText: p.promptText,
          options: p.options,
          parentNodeId: p.parentNodeId,
          isSensitive: p.isSensitive,
          sensitiveCategory: p.sensitiveCategory,
          clientRequestId,
        },
      };

    case "nodeAction":
      return {
        method: "PATCH",
        path: "/nodes",
        body: {
          patientId,
          sessionId: p.sessionId,
          pathId: p.pathId,
          nodeId: p.nodeId,
          action: p.action,
          clientRequestId,
        },
      };

    case "reviewNode": {
      const input = (p.input ?? {}) as Payload;
      return {
        method: "PATCH",
        path: "/nodes",
        body: {
          patientId,
          sessionId: p.sessionId,
          pathId: p.pathId,
          nodeId: p.nodeId,
          action: {
            kind: "REVIEW",
            promptText: input.promptText,
            options: input.options,
            isSensitive: input.isSensitive,
            sensitiveCategory: input.sensitiveCategory,
          },
          clientRequestId,
        },
      };
    }

    case "createStatement":
      return {
        method: "POST",
        path: "/statements",
        body: {
          patientId,
          sessionId: p.sessionId,
          pathId: p.pathId,
          statementId: p.statementId,
          text: p.text,
          originNodeId: p.originNodeId,
          isSensitive: p.isSensitive,
          sensitiveCategory: p.sensitiveCategory,
          reusedFromStatementId: p.reusedFromStatementId,
          clientRequestId,
        },
      };

    case "statementAction":
      return {
        method: "PATCH",
        path: "/statements",
        body: {
          patientId,
          sessionId: p.sessionId,
          pathId: p.pathId,
          statementId: p.statementId,
          action: p.action,
          clientRequestId,
        },
      };

    case "createCaregiverInterpretation":
      return {
        method: "POST",
        path: "/statements",
        body: {
          patientId,
          sessionId: p.sessionId,
          origin: "CAREGIVER_INTERPRETATION",
          text: p.text,
          isSensitive: p.isSensitive,
          sensitiveCategory: p.sensitiveCategory,
          reusedFromStatementId: p.reusedFromStatementId,
          // NÃO `pathId`: a rota decide qual ramo roda pela AUSÊNCIA desse
          // campo (ver app/api/realtime-questions/statements/route.ts).
          interpretationPathId: p.pathId,
          statementId: p.statementId,
          clientRequestId,
        },
      };

    case "saveSessionContext":
      return {
        method: "POST",
        path: "/session-context",
        body: {
          patientId,
          sessionId: p.sessionId,
          skipped: p.skipped,
          interlocutorPersonId: p.interlocutorPersonId,
          interlocutorName: p.interlocutorName,
          interlocutorRelation: p.interlocutorRelation,
          intention: p.intention,
          environment: p.environment,
          initialTopic: p.initialTopic,
          notes: p.notes,
          clientRequestId,
        },
      };

    case "openPatientControl":
      return {
        method: "POST",
        path: "/patient-controls",
        body: {
          patientId,
          sessionId: p.sessionId,
          targetType: p.targetType,
          targetId: p.targetId,
          targetPathId: p.targetPathId,
          clientRequestId,
        },
      };

    case "patientControlAction":
      return {
        method: "PATCH",
        path: "/patient-controls",
        body: {
          patientId,
          sessionId: p.sessionId,
          requestId: p.requestId,
          action: p.action,
          clientRequestId,
        },
      };

    case "sessionAction":
      return {
        method: "PATCH",
        path: "/sessions",
        body: {
          patientId,
          sessionId: p.sessionId,
          action: p.action,
          clientRequestId,
        },
      };

    default: {
      const _exhaustivo: never = op.operationType;
      throw new UnsupportedOperationError(_exhaustivo);
    }
  }
}

/**
 * O que extrair da resposta de SUCESSO para registrar a confirmação —
 * id e horário que o SERVIDOR devolveu, não um palpite local.
 *
 * `campo` é o nome do objeto na resposta (`turn`, `path`, `node`, `statement`,
 * `session`, `context`, `request`) — cada rota devolve a entidade sob um nome
 * próprio, nunca genérico.
 */
export function extractConfirmation(
  op: OfflineOperation,
  json: unknown
): { remoteEntityId: string | null; remoteConfirmedAt: string | null } {
  const corpo = (json ?? {}) as Record<string, unknown>;
  const campo = CAMPO_DA_RESPOSTA[op.operationType];
  const entidade = (corpo[campo] ?? null) as Record<string, unknown> | null;
  if (!entidade) return { remoteEntityId: null, remoteConfirmedAt: null };
  const id = typeof entidade.id === "string" ? entidade.id : null;
  const horario =
    (typeof entidade.updatedAt === "string" && entidade.updatedAt) ||
    (typeof entidade.createdAt === "string" && entidade.createdAt) ||
    null;
  return { remoteEntityId: id, remoteConfirmedAt: horario };
}

const CAMPO_DA_RESPOSTA: Record<OfflineOperation["operationType"], string> = {
  createTurn: "turn",
  turnAction: "turn",
  createPath: "path",
  pathAction: "path",
  createNode: "node",
  nodeAction: "node",
  reviewNode: "node",
  createStatement: "statement",
  statementAction: "statement",
  createCaregiverInterpretation: "statement",
  saveSessionContext: "context",
  openPatientControl: "request",
  patientControlAction: "request",
  sessionAction: "session",
};
