"use client";

// ——— Histórico da sessão, para o ASSISTENTE ———
// Recolhido por padrão: nunca disputa a área principal com o que o paciente
// está vendo. Mostra o resultado observacional de cada item, jamais os eventos
// técnicos — a trilha detalhada permanece em background (§23).
//
// Os itens são CLICÁVEIS (§22):
//   - em andamento → recupera a tela daquele item, com o estado que ele tinha;
//   - encerrado    → oferece visualizar detalhes ou reutilizar como novo.
//
// Abrir um item NUNCA altera seus dados: a única gravação é o registro da
// consulta, feito pelo servidor.

import {
  buildHistory,
  summarize,
  type HistoryEntry,
} from "@/components/realtime-questions/option-conversation/history";
import type { PathDetail } from "@/lib/option-conversation-types";
import {
  SENSITIVE_CATEGORY_LABELS,
  type ConversationQuestionTurn,
} from "@/lib/realtime-question-types";

function hora(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
}

export function SessionHistory({
  turns,
  paths = [],
  busy = false,
  onOpen,
}: {
  turns: ConversationQuestionTurn[];
  paths?: PathDetail[];
  busy?: boolean;
  /** Ausente = histórico apenas de leitura (sessão encerrada, por exemplo). */
  onOpen?: (entry: HistoryEntry) => void;
}) {
  const entries = buildHistory(turns, paths);
  if (entries.length === 0) return null;

  // Sem nenhuma conversa por opções, o rótulo continua sendo o de sempre —
  // "perguntas". Só quando os dois tipos convivem é que "itens" descreve
  // melhor o que está na lista.
  const soPerguntas = paths.length === 0;
  const unidade = soPerguntas
    ? entries.length === 1
      ? "pergunta"
      : "perguntas"
    : entries.length === 1
      ? "item"
      : "itens";

  return (
    <details className="no-print pointer-events-auto mx-auto w-full max-w-3xl rounded-2xl border border-line bg-card/70 backdrop-blur-sm">
      <summary className="cursor-pointer list-none px-5 py-3 text-sm font-medium text-ink-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        Histórico da sessão ({entries.length} {unidade})
      </summary>
      <ol className="flex flex-col gap-2 border-t border-line px-5 py-4">
        {entries.map((entry, index) => (
          <HistoryRow
            key={`${entry.kind}:${entry.id}`}
            entry={entry}
            index={index + 1}
            busy={busy}
            onOpen={onOpen}
          />
        ))}
      </ol>
    </details>
  );
}

function HistoryRow({
  entry,
  index,
  busy,
  onOpen,
}: {
  entry: HistoryEntry;
  index: number;
  busy: boolean;
  onOpen?: (entry: HistoryEntry) => void;
}) {
  const resumo = summarize(entry);
  const modo =
    entry.kind === "TURN" ? "Pergunta fechada" : "Conversa por opções";
  const quando =
    entry.kind === "TURN"
      ? hora(entry.turn.presentedAt)
      : hora(entry.detail.path.startedAt);

  const conteudo = (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-semibold tabular-nums text-ink-mute">{index}.</span>
        <span className="min-w-0 flex-1 text-ink">{resumo.title}</span>
        {quando && (
          <span className="tabular-nums text-xs text-ink-mute">{quando}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-ink-soft">
          <span aria-hidden="true">{resumo.icon}</span> {resumo.label}
        </span>
        <Selo>{modo}</Selo>
        {entry.kind === "TURN" && entry.turn.isSensitive && (
          <Selo>
            Sensível
            {entry.turn.sensitiveCategory
              ? ` · ${SENSITIVE_CATEGORY_LABELS[entry.turn.sensitiveCategory]}`
              : ""}
          </Selo>
        )}
        {entry.kind === "TURN" && entry.turn.correctionCount > 0 && (
          <Selo>
            {entry.turn.correctionCount}{" "}
            {entry.turn.correctionCount === 1 ? "correção" : "correções"}
          </Selo>
        )}
        {entry.kind === "TURN" && entry.turn.representCount > 0 && (
          <Selo>
            {entry.turn.representCount}{" "}
            {entry.turn.representCount === 1
              ? "reapresentação"
              : "reapresentações"}
          </Selo>
        )}
        {entry.kind === "PATH" && (
          <Selo>
            {entry.detail.nodes.length}{" "}
            {entry.detail.nodes.length === 1 ? "nível" : "níveis"}
          </Selo>
        )}
      </div>
    </>
  );

  if (!onOpen) {
    return (
      <li className="flex flex-col gap-1 rounded-xl px-3 py-2 text-sm odd:bg-bg/40">
        {conteudo}
      </li>
    );
  }

  return (
    <li className="odd:bg-bg/40">
      {/* A clicabilidade é anunciada pelo papel de botão e pelo rótulo — não
          depende só de cor nem de hover (§35). */}
      <button
        type="button"
        disabled={busy}
        onClick={() => onOpen(entry)}
        aria-label={`${
          resumo.emAndamento ? "Retomar" : "Abrir"
        } ${modo.toLowerCase()}: ${resumo.title}. ${resumo.label}.`}
        className="flex w-full flex-col gap-1 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40"
      >
        {conteudo}
        <span className="text-xs text-ink-mute underline underline-offset-2">
          {resumo.emAndamento ? "Retomar este item" : "Ver detalhes ou reutilizar"}
        </span>
      </button>
    </li>
  );
}

function Selo({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-line px-2 py-0.5 text-ink-mute">
      {children}
    </span>
  );
}
