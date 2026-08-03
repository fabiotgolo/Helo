"use client";

// ——— Histórico da sessão: modelo comum e detalhes (§22, §23, §25) ———
//
// Perguntas fechadas e conversas por opções acontecem na MESMA sessão, então
// aparecem numa lista só, na ordem em que ocorreram. O que muda é o que cada
// item oferece ao ser aberto.
//
// Duas regras governam tudo aqui:
//   1. abrir um item NUNCA altera seus dados — só registra a consulta;
//   2. um item encerrado não volta a ser ativo: reutilizar cria registro NOVO.

import { ModalShell } from "@/components/modal-shell";
import { tryToConfirmedPatientStatement } from "@/lib/confirmed-patient-statement";
import {
  Control,
  Primary,
  Selo,
} from "@/components/realtime-questions/ui";
import {
  activeTrail,
  confirmedLabel,
  isTerminalPathStatus,
  trailLabels,
  type OptionConversationFinalStatement,
  type OptionConversationNode,
  type PathDetail,
} from "@/lib/option-conversation-types";
import {
  isTerminalTurnStatus,
  SEMANTIC_RESPONSE_LABELS,
  SENSITIVE_CATEGORY_LABELS,
  type ConversationQuestionTurn,
} from "@/lib/realtime-question-types";

// ---------- Modelo comum ----------

export type HistoryEntry =
  | { kind: "TURN"; id: string; at: string; turn: ConversationQuestionTurn }
  | { kind: "PATH"; id: string; at: string; detail: PathDetail };

/** Rótulo + ícone por resultado: a diferença nunca depende só de cor (§35). */
export interface EntrySummary {
  icon: string;
  label: string;
  title: string;
  emAndamento: boolean;
}

export function summarize(entry: HistoryEntry): EntrySummary {
  if (entry.kind === "TURN") {
    const t = entry.turn;
    const emAndamento = !isTerminalTurnStatus(t.status);
    const resposta =
      t.status === "CONFIRMED" && t.confirmedResponse
        ? `Confirmada: ${SEMANTIC_RESPONSE_LABELS[t.confirmedResponse]}`
        : t.status === "NO_RESPONSE"
          ? "Sem resposta"
          : t.status === "CANCELED"
            ? "Cancelada"
            : t.status === "UNCERTAIN_GESTURE"
              ? "Gesto incerto"
              : "Em andamento";
    return {
      icon:
        t.status === "CONFIRMED"
          ? "✓"
          : t.status === "NO_RESPONSE"
            ? "—"
            : t.status === "CANCELED"
              ? "×"
              : emAndamento
                ? "◔"
                : "?",
      label: resposta,
      title: t.presentedText || t.reviewedText,
      emAndamento,
    };
  }

  const { path, nodes, statements } = entry.detail;
  const emAndamento = !isTerminalPathStatus(path.status);
  const raiz =
    nodes.find((n) => n.id === path.rootNodeId) ??
    nodes.find((n) => n.parentNodeId === null) ??
    null;
  const frase = ultimaFrase(statements);
  const label =
    path.status === "COMPLETED"
      ? tryToConfirmedPatientStatement(frase)
        ? "Mensagem confirmada"
        : "Concluída"
      : path.status === "RESTARTED"
        ? "Reiniciada"
        : path.status === "INTERRUPTED"
          ? "Encerrada sem confirmar"
          : path.status === "PAUSED"
            ? "Pausada"
            : "Em andamento";
  return {
    icon:
      path.status === "COMPLETED"
        ? "✓"
        : path.status === "RESTARTED"
          ? "↺"
          : path.status === "INTERRUPTED"
            ? "×"
            : "◔",
    label,
    title: raiz?.promptText ?? "Conversa por opções",
    emAndamento,
  };
}

/** A frase que representa o caminho — a última que não foi descartada. */
export function ultimaFrase(
  statements: OptionConversationFinalStatement[]
): OptionConversationFinalStatement | null {
  const vivas = statements.filter(
    (s) => s.status !== "CANCELED" && s.status !== "REPLACED"
  );
  return vivas.at(-1) ?? statements.at(-1) ?? null;
}

/** Ordena perguntas fechadas e caminhos numa linha do tempo só. */
export function buildHistory(
  turns: ConversationQuestionTurn[],
  paths: PathDetail[]
): HistoryEntry[] {
  const entries: HistoryEntry[] = [
    ...turns.map((turn) => ({
      kind: "TURN" as const,
      id: turn.id,
      at: turn.createdAt,
      turn,
    })),
    ...paths.map((detail) => ({
      kind: "PATH" as const,
      id: detail.path.id,
      at: detail.path.createdAt,
      detail,
    })),
  ];
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

function hora(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
}

function dataHora(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
}

// ---------- Ações de um item encerrado ----------

export function HistoryActionsDialog({
  entry,
  busy,
  onDetails,
  onReuse,
  onClose,
}: {
  entry: HistoryEntry;
  busy: boolean;
  onDetails: () => void;
  onReuse: () => void;
  onClose: () => void;
}) {
  const resumo = summarize(entry);
  return (
    <ModalShell onClose={onClose} label="O que deseja fazer com este item?" disableDismiss={busy}>
      <h2 className="text-xl font-medium">O que deseja fazer com este item?</h2>
      <p className="mt-2 text-sm text-ink-soft">{resumo.title}</p>
      <p className="mt-1 text-sm text-ink-mute">
        Reutilizar cria um registro novo em rascunho. O original permanece
        intacto, e nenhuma resposta anterior é copiada.
      </p>
      <div className="mt-6 flex flex-col gap-2">
        <Primary onClick={onDetails} disabled={busy}>
          Visualizar detalhes
        </Primary>
        <Control onClick={onReuse} disabled={busy}>
          Reutilizar como novo
        </Control>
        <Control onClick={onClose} disabled={busy}>
          Cancelar
        </Control>
      </div>
    </ModalShell>
  );
}

// ---------- Visualização de detalhes (§23) ----------

export function HistoryDetail({
  entry,
  assistantName,
  busy,
  onReusePath,
  onReuseNode,
  onReuseStatement,
  onReuseTurn,
  onClose,
}: {
  entry: HistoryEntry;
  assistantName: string | null;
  busy: boolean;
  onReusePath: (pathId: string) => void;
  onReuseNode: (nodeId: string) => void;
  onReuseStatement: (statementId: string) => void;
  onReuseTurn: (turnId: string) => void;
  onClose: () => void;
}) {
  return (
    <ModalShell
      onClose={onClose}
      label="Detalhes do item"
      className="max-w-2xl"
      disableDismiss={busy}
    >
      <h2 className="text-xl font-medium">Detalhes</h2>
      {/* Nada de log técnico bruto aqui: o cuidador vê o que aconteceu, não a
          trilha de eventos (§23). */}
      {entry.kind === "TURN" ? (
        <TurnDetail
          turn={entry.turn}
          assistantName={assistantName}
          busy={busy}
          onReuse={() => onReuseTurn(entry.turn.id)}
        />
      ) : (
        <PathDetailView
          detail={entry.detail}
          assistantName={assistantName}
          busy={busy}
          onReusePath={onReusePath}
          onReuseNode={onReuseNode}
          onReuseStatement={onReuseStatement}
        />
      )}
      <div className="mt-6">
        <Control onClick={onClose} disabled={busy}>
          Fechar
        </Control>
      </div>
    </ModalShell>
  );
}

function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-semibold uppercase tracking-widest text-ink-soft">
        {rotulo}
      </span>
      <span className="text-ink">{children}</span>
    </div>
  );
}

function TurnDetail({
  turn,
  assistantName,
  busy,
  onReuse,
}: {
  turn: ConversationQuestionTurn;
  assistantName: string | null;
  busy: boolean;
  onReuse: () => void;
}) {
  const resultado =
    turn.status === "CONFIRMED" && turn.confirmedResponse
      ? `Resposta confirmada: ${SEMANTIC_RESPONSE_LABELS[turn.confirmedResponse]}`
      : turn.status === "NO_RESPONSE"
        ? "Sem resposta"
        : turn.status === "CANCELED"
          ? "Pergunta cancelada"
          : turn.status === "UNCERTAIN_GESTURE"
            ? "Gesto incerto — nenhuma resposta atribuída"
            : "Em andamento";
  return (
    <div className="mt-4 flex flex-col gap-4">
      <Campo rotulo="Pergunta apresentada">
        {turn.presentedText || turn.reviewedText}
      </Campo>
      <Campo rotulo="Modo de interação">Pergunta fechada — SIM, TALVEZ e NÃO</Campo>
      <Campo rotulo="Resultado">{resultado}</Campo>
      <Campo rotulo="Apresentada em">{dataHora(turn.presentedAt)}</Campo>
      <Campo rotulo="Responsável">{assistantName ?? "—"}</Campo>
      <div className="flex flex-wrap gap-2">
        {turn.isSensitive && (
          <Selo>
            Sensível
            {turn.sensitiveCategory
              ? ` · ${SENSITIVE_CATEGORY_LABELS[turn.sensitiveCategory]}`
              : ""}
          </Selo>
        )}
        {turn.correctionCount > 0 && (
          <Selo>
            {turn.correctionCount}{" "}
            {turn.correctionCount === 1 ? "correção" : "correções"}
          </Selo>
        )}
        {turn.representCount > 0 && (
          <Selo>
            {turn.representCount}{" "}
            {turn.representCount === 1 ? "reapresentação" : "reapresentações"}
          </Selo>
        )}
        {turn.reusedFromTurnId && <Selo>Reutilizada de outra pergunta</Selo>}
      </div>
      {isTerminalTurnStatus(turn.status) && (
        <div>
          <Control onClick={onReuse} disabled={busy}>
            Reutilizar esta pergunta
          </Control>
        </div>
      )}
    </div>
  );
}

function PathDetailView({
  detail,
  assistantName,
  busy,
  onReusePath,
  onReuseNode,
  onReuseStatement,
}: {
  detail: PathDetail;
  assistantName: string | null;
  busy: boolean;
  onReusePath: (pathId: string) => void;
  onReuseNode: (nodeId: string) => void;
  onReuseStatement: (statementId: string) => void;
}) {
  const { path, nodes, statements } = detail;
  const trilha = trailLabels(activeTrail(nodes, path.activeNodeId));
  const frase = ultimaFrase(statements);
  // O histórico só chama uma frase de "confirmada pelo paciente" quando o
  // portão da autoria atesta a confirmação — status sozinho não basta.
  const falaDoPaciente = tryToConfirmedPatientStatement(frase);
  const encerrado = isTerminalPathStatus(path.status);

  return (
    <div className="mt-4 flex flex-col gap-4">
      <Campo rotulo="Modo de interação">
        Escolha entre opções — os sinais significam opção 1, 2 e 3
      </Campo>
      <Campo rotulo="Caminho completo">
        {trilha.length > 0 ? trilha.join(" › ") : "Nenhuma escolha confirmada"}
      </Campo>
      <Campo rotulo="Iniciada em">{dataHora(path.startedAt)}</Campo>
      <Campo rotulo="Responsável">{assistantName ?? "—"}</Campo>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest text-ink-soft">
          Níveis apresentados
        </span>
        <ol className="flex flex-col gap-2">
          {nodes.map((node) => (
            <NodeRow
              key={node.id}
              node={node}
              busy={busy}
              reusable={encerrado}
              onReuse={() => onReuseNode(node.id)}
            />
          ))}
        </ol>
      </div>

      {frase && (
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-bg/40 px-4 py-3">
          <Campo rotulo="Frase final">
            {falaDoPaciente?.text || frase.presentedText || frase.currentText}
          </Campo>
          <Campo rotulo="Resultado">
            {falaDoPaciente
              ? "Confirmada pelo paciente"
              : frase.status === "REJECTED"
                ? "Rejeitada — nunca tratada como comunicação confirmada"
                : frase.status === "CANCELED"
                  ? "Cancelada antes da confirmação"
                  : "Em construção"}
          </Campo>
          <div className="flex flex-wrap gap-2">
            {frase.isSensitive && (
              <Selo>
                Sensível
                {frase.sensitiveCategory
                  ? ` · ${SENSITIVE_CATEGORY_LABELS[frase.sensitiveCategory]}`
                  : ""}
              </Selo>
            )}
            {frase.editCount > 0 && (
              <Selo>
                {frase.editCount} {frase.editCount === 1 ? "edição" : "edições"}
              </Selo>
            )}
            {frase.replacesStatementId && <Selo>Versão corrigida</Selo>}
            {frase.reusedFromStatementId && <Selo>Reutilizada</Selo>}
          </div>
          {encerrado && (
            <div>
              <Control onClick={() => onReuseStatement(frase.id)} disabled={busy}>
                Reutilizar esta frase
              </Control>
            </div>
          )}
        </div>
      )}

      {encerrado && (
        <div className="flex flex-wrap gap-2">
          <Control onClick={() => onReusePath(path.id)} disabled={busy}>
            Iniciar uma conversa baseada nesta
          </Control>
        </div>
      )}
    </div>
  );
}

function NodeRow({
  node,
  busy,
  reusable,
  onReuse,
}: {
  node: OptionConversationNode;
  busy: boolean;
  reusable: boolean;
  onReuse: () => void;
}) {
  const escolhida = confirmedLabel(node);
  return (
    <li className="flex flex-col gap-1 rounded-xl border border-line px-3 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="min-w-0 flex-1 font-medium text-ink">
          {node.promptText}
        </span>
        <span className="tabular-nums text-xs text-ink-mute">
          {hora(node.presentedAt)}
        </span>
      </div>
      <p className="text-ink-soft">
        Opções apresentadas:{" "}
        {node.options
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((o) => `${o.position}. ${o.label}`)
          .join(" · ")}
      </p>
      <p className="text-ink-soft">
        {escolhida ? (
          <>
            Opção confirmada: <strong className="text-ink">{escolhida}</strong>
          </>
        ) : (
          "Nenhuma opção foi confirmada neste nível."
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {node.status === "INACTIVE" && <Selo>Ramificação anterior</Selo>}
        {node.status === "REPLACED" && <Selo>Substituído por versão corrigida</Selo>}
        {node.replacesNodeId && <Selo>Versão corrigida</Selo>}
        {node.reusedFromNodeId && <Selo>Reutilizado</Selo>}
        {node.isSensitive && (
          <Selo>
            Sensível
            {node.sensitiveCategory
              ? ` · ${SENSITIVE_CATEGORY_LABELS[node.sensitiveCategory]}`
              : ""}
          </Selo>
        )}
        {node.correctionCount > 0 && (
          <Selo>
            {node.correctionCount}{" "}
            {node.correctionCount === 1 ? "correção" : "correções"}
          </Selo>
        )}
        {reusable && (
          <button
            type="button"
            onClick={onReuse}
            disabled={busy}
            className="rounded-full border border-line px-3 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-ink-mute hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reutilizar este nível
          </button>
        )}
      </div>
    </li>
  );
}
