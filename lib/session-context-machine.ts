// ——— Contexto da sessão: transições (Fase 4.8) ———
// Módulo puro, no mesmo contrato das outras máquinas do projeto: recebe o
// estado atual, devolve `{status, patch, event}` e não escreve nada. Nenhum
// store atribui `status` por conta própria.
//
// O contexto tem um ciclo curto — ACTIVE, e depois REPLACED quando uma versão
// nova toma o lugar. Não existe transição de volta: uma versão substituída
// continua legível, mas nunca volta a valer (§6).

import {
  RtqDomainError,
  type SessionContextStatus,
  type SessionContextVersion,
} from "@/lib/session-context-types";
import type { InteractionEventType } from "@/lib/audit-events";
import type { RtqSessionStatus } from "@/lib/realtime-question-types";

export const ALLOWED_CONTEXT_TRANSITIONS: Record<
  SessionContextStatus,
  readonly SessionContextStatus[]
> = {
  ACTIVE: ["REPLACED"],
  REPLACED: [],
};

export interface ContextStateChange {
  status: SessionContextStatus;
  patch: Record<string, unknown>;
  event: {
    eventType: InteractionEventType;
    previousValue: unknown;
    newValue: unknown;
    metadata?: Record<string, unknown> | null;
  };
}

/**
 * Marca a versão vigente como substituída pela nova. A substituição NÃO apaga
 * nem reescreve: o texto anterior continua exatamente como estava, e é isso
 * que permite auditar o que valia em cada momento da conversa.
 */
export function applyContextReplacement(
  current: SessionContextVersion,
  replacedByContextId: string,
  now: string
): ContextStateChange {
  if (!ALLOWED_CONTEXT_TRANSITIONS[current.status].includes("REPLACED")) {
    throw new RtqDomainError(
      "só a versão vigente do contexto pode ser substituída"
    );
  }
  if (replacedByContextId === current.id) {
    throw new RtqDomainError("um contexto não pode substituir a si mesmo");
  }
  return {
    status: "REPLACED",
    patch: {
      status: "REPLACED",
      replacedByContextId,
      replacedAt: now,
      updatedAt: now,
    },
    event: {
      eventType: "SESSION_CONTEXT_REPLACED",
      previousValue: { status: current.status, version: current.version },
      newValue: { status: "REPLACED", replacedByContextId },
      metadata: { version: current.version },
    },
  };
}

/**
 * Sessão encerrada não recebe mais contexto (§34): o registro precisa refletir
 * a circunstância de uma conversa que aconteceu, não uma anotação posterior.
 * A LEITURA continua livre — o histórico é somente leitura por natureza.
 */
export function assertSessionAcceptsContextWrite(
  status: RtqSessionStatus
): void {
  if (status === "COMPLETED" || status === "ABANDONED") {
    throw new RtqDomainError(
      "esta sessão já foi encerrada: o contexto não pode mais ser alterado"
    );
  }
}
