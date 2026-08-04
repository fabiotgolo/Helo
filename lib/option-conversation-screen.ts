// ——— Qual tela um caminho mostra agora (conversa por opções e interpretação) ———
//
// Módulo neutro (sem JSX, sem imports de servidor): fica em lib/, e não dentro
// de flow.tsx, para que a UI (flow.tsx) e o portão que decide o que o paciente
// pode ver (session.tsx, via `pacienteEstaOlhando`) leiam a MESMA função. Duas
// cópias desta regra divergiriam, e a que divergisse mostraria ao paciente algo
// que só o cuidador deveria ver — ou esconderia do cuidador algo que só ele
// deveria decidir. Ficar em lib/ também é o que permite testar a regra inteira,
// exaustivamente, sem navegador (scripts/test-option-conversation-screen.mjs).

import {
  isTerminalPathStatus,
  isTerminalStatementStatus,
  type PathDetail,
} from "@/lib/option-conversation-types";

/** O que a tela está pedindo do assistente agora. */
export type Screen =
  | { kind: "EDIT_NODE"; nodeId: string | null; parentNodeId: string | null }
  | { kind: "REVIEW_NODE"; nodeId: string }
  | { kind: "STAGE" }
  | { kind: "EDIT_STATEMENT"; statementId: string | null }
  | { kind: "CONFIRM_STATEMENT"; statementId: string }
  | { kind: "DONE" };

/** A frase viva do caminho — a última que ainda não foi descartada. */
export function liveStatement(detail: PathDetail) {
  const live = detail.statements.filter(
    (s) => s.status !== "CANCELED" && s.status !== "REPLACED"
  );
  return live.at(-1) ?? null;
}

/**
 * A tela é DERIVADA do estado persistido — não guardada. É isso que faz pausa,
 * retomada e atualização da página restaurarem tudo sozinhas (§32): o servidor
 * devolve o caminho, e a tela certa reaparece.
 */
export function telaDerivada(detail: PathDetail): Screen {
  const { path, nodes } = detail;
  if (isTerminalPathStatus(path.status)) return { kind: "DONE" };

  const statement = liveStatement(detail);
  if (statement && !isTerminalStatementStatus(statement.status)) {
    return statement.status === "DRAFT" || statement.status === "REVIEWED"
      ? { kind: "EDIT_STATEMENT", statementId: statement.id }
      : { kind: "CONFIRM_STATEMENT", statementId: statement.id };
  }
  if (statement && isTerminalStatementStatus(statement.status)) {
    return { kind: "DONE" };
  }

  const activeNode = nodes.find((n) => n.id === path.activeNodeId) ?? null;
  if (!activeNode) {
    return { kind: "EDIT_NODE", nodeId: null, parentNodeId: null };
  }

  switch (activeNode.status) {
    case "DRAFT":
      return {
        kind: "EDIT_NODE",
        nodeId: activeNode.id,
        parentNodeId: activeNode.parentNodeId,
      };
    case "REVIEWED":
      return { kind: "REVIEW_NODE", nodeId: activeNode.id };
    case "CONFIRMED": {
      const chosen = activeNode.options.find(
        (o) => o.id === activeNode.confirmedOptionId
      );
      // Opção terminal → compositor. Opção comum → próximo nível.
      return chosen?.isTerminal
        ? { kind: "EDIT_STATEMENT", statementId: null }
        : { kind: "EDIT_NODE", nodeId: null, parentNodeId: activeNode.id };
    }
    default:
      return { kind: "STAGE" };
  }
}

/**
 * O paciente está com os olhos na tela agora?
 *
 * São os dois únicos momentos em que o caminho pertence a ele: as opções
 * apresentadas — incluindo a seleção provisória, ainda por conferir — e a
 * frase aguardando o gesto, do primeiro SIM/TALVEZ/NÃO até uma decisão
 * terminal (inclui TALVEZ em ajuste e a reconfirmação de assunto sensível: a
 * frase continua em negociação com o paciente até esse ponto). Em todo o
 * resto — compor, revisar, navegar pelo breadcrumb, ver o registro pronto —
 * a tela é do cuidador.
 */
export function pacienteEstaOlhando(detail: PathDetail): boolean {
  const kind = telaDerivada(detail).kind;
  return kind === "STAGE" || kind === "CONFIRM_STATEMENT";
}
