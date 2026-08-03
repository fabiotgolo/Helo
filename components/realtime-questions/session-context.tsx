"use client";

// ——— Contexto da conversa (Fase 4.8) ———
//
// Uma etapa discreta ANTES da conversa: com quem, para quê, onde e sobre o quê.
// Tudo opcional, inclusive a etapa inteira.
//
// Duas regras dão forma a estas telas:
//
//   1. "Começar sem contexto" aparece no ALTO e no fim do formulário. Uma
//      conversa urgente não pode ficar atrás de um formulário — quem precisa
//      falar agora nunca deve ter que rolar a tela para escapar dele.
//   2. Nada aqui é fala do paciente. O texto é anotação do cuidador sobre a
//      circunstância, e a tela diz isso com todas as letras — para que ninguém,
//      lendo o histórico depois, confunda a intenção anotada com algo que o
//      paciente declarou.
//
// Editar durante a sessão não reescreve: cria uma versão nova e preserva a
// anterior. A tela avisa antes de gravar.

import { useState } from "react";
import { ModalShell } from "@/components/modal-shell";
import {
  EMPTY_INTERLOCUTOR,
  PersonPicker,
  type InterlocutorValue,
} from "@/components/realtime-questions/person-picker";
import {
  Control,
  EditButton,
  Primary,
} from "@/components/realtime-questions/ui";
import {
  contextSummary,
  ENVIRONMENT_SHORTCUTS,
  INTENTION_SHORTCUTS,
  MAX_CONTEXT_FIELD_LEN,
  MAX_CONTEXT_NOTES_LEN,
  type SessionContextVersion,
} from "@/lib/session-context-types";

export interface ContextDraft {
  interlocutor: InterlocutorValue;
  intention: string;
  environment: string;
  initialTopic: string;
  notes: string;
}

export const EMPTY_CONTEXT_DRAFT: ContextDraft = {
  interlocutor: EMPTY_INTERLOCUTOR,
  intention: "",
  environment: "",
  initialTopic: "",
  notes: "",
};

export function draftFromContext(context: SessionContextVersion): ContextDraft {
  return {
    interlocutor: {
      personId: context.interlocutorPersonId,
      name: context.interlocutorName ?? "",
      relation: context.interlocutorRelation ?? "",
    },
    intention: context.intention ?? "",
    environment: context.environment ?? "",
    initialTopic: context.initialTopic ?? "",
    notes: context.notes ?? "",
  };
}

/** Chips de sugestão: poupam digitação e nunca limitam o conteúdo (§3, §4). */
function Atalhos({
  legenda,
  opcoes,
  valor,
  onEscolher,
  disabled,
}: {
  legenda: string;
  opcoes: readonly string[];
  valor: string;
  onEscolher: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={legenda}>
      {opcoes.map((o) => {
        const ativo = valor.trim() === o;
        return (
          <button
            key={o}
            type="button"
            onClick={() => onEscolher(ativo ? "" : o)}
            disabled={disabled}
            aria-pressed={ativo}
            className={`min-h-11 rounded-full border px-4 py-2 text-sm transition-colors disabled:opacity-40 ${
              ativo
                ? "border-accent bg-accent/10 font-medium text-ink"
                : "border-line text-ink-soft hover:border-ink-mute"
            }`}
          >
            {ativo && <span aria-hidden="true">✓ </span>}
            {o}
          </button>
        );
      })}
    </div>
  );
}

function CamposDoContexto({
  patientId,
  draft,
  onChange,
  busy,
}: {
  patientId: number;
  draft: ContextDraft;
  onChange: (d: ContextDraft) => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      <PersonPicker
        patientId={patientId}
        value={draft.interlocutor}
        onChange={(interlocutor) => onChange({ ...draft, interlocutor })}
        disabled={busy}
      />

      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Intenção da conversa</span>
          <input
            type="text"
            value={draft.intention}
            maxLength={MAX_CONTEXT_FIELD_LEN}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, intention: e.target.value })}
            className="min-h-11 rounded-xl border border-line bg-bg px-3 text-ink"
          />
        </label>
        <Atalhos
          legenda="Sugestões de intenção"
          opcoes={INTENTION_SHORTCUTS}
          valor={draft.intention}
          onEscolher={(intention) => onChange({ ...draft, intention })}
          disabled={busy}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Ambiente</span>
          <input
            type="text"
            value={draft.environment}
            maxLength={MAX_CONTEXT_FIELD_LEN}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, environment: e.target.value })}
            className="min-h-11 rounded-xl border border-line bg-bg px-3 text-ink"
          />
        </label>
        <Atalhos
          legenda="Sugestões de ambiente"
          opcoes={ENVIRONMENT_SHORTCUTS}
          valor={draft.environment}
          onEscolher={(environment) => onChange({ ...draft, environment })}
          disabled={busy}
        />
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Assunto inicial</span>
        <input
          type="text"
          value={draft.initialTopic}
          maxLength={MAX_CONTEXT_FIELD_LEN}
          disabled={busy}
          onChange={(e) => onChange({ ...draft, initialTopic: e.target.value })}
          className="min-h-11 rounded-xl border border-line bg-bg px-3 text-ink"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Observação complementar</span>
        <textarea
          value={draft.notes}
          maxLength={MAX_CONTEXT_NOTES_LEN}
          rows={3}
          disabled={busy}
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
          className="rounded-xl border border-line bg-bg px-3 py-2 text-ink"
        />
      </label>
    </div>
  );
}

/** Etapa anterior à conversa. Pular é uma saída de primeira classe. */
export function SessionContextScreen({
  patientId,
  busy,
  onSave,
  onSkip,
}: {
  patientId: number;
  busy: boolean;
  onSave: (draft: ContextDraft) => void;
  onSkip: () => void;
}) {
  const [draft, setDraft] = useState<ContextDraft>(EMPTY_CONTEXT_DRAFT);

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-medium text-ink">
          Contexto da conversa (opcional)
        </h2>
        <p className="text-sm text-ink-soft">
          Anotação do cuidador sobre a circunstância. Não é fala do paciente e
          nunca é apresentada a ele.
        </p>
      </header>

      {/* A saída rápida vem ANTES do formulário: quem precisa falar agora não
          deve ter que atravessar campo nenhum. */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-card/60 px-4 py-3">
        <Control onClick={onSkip} disabled={busy}>
          Começar sem contexto
        </Control>
        <span className="text-sm text-ink-soft">
          A conversa começa na hora; o contexto pode ser preenchido depois.
        </span>
      </div>

      <CamposDoContexto
        patientId={patientId}
        draft={draft}
        onChange={setDraft}
        busy={busy}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Primary onClick={() => onSave(draft)} disabled={busy}>
          Salvar e começar
        </Primary>
        <Control onClick={onSkip} disabled={busy}>
          Começar sem contexto
        </Control>
      </div>
    </section>
  );
}

/** Resumo de uma linha durante a sessão — só nas telas do cuidador. */
export function SessionContextBar({
  context,
  busy,
  onEdit,
  onView,
}: {
  context: SessionContextVersion;
  busy: boolean;
  onEdit: () => void;
  onView: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-card/40 px-4 py-2">
      <span className="text-xs font-semibold uppercase tracking-widest text-ink-soft">
        Contexto
      </span>
      <button
        type="button"
        onClick={onView}
        disabled={busy}
        className="min-h-9 flex-1 truncate text-left text-sm text-ink underline-offset-4 hover:underline disabled:opacity-40"
      >
        {contextSummary(context)}
      </button>
      {context.version > 1 && (
        <span className="text-xs text-ink-soft">versão {context.version}</span>
      )}
      <EditButton label="o contexto da conversa" onClick={onEdit} disabled={busy} />
    </div>
  );
}

/** Edição durante a sessão — sempre cria versão nova, e a tela avisa. */
export function SessionContextDialog({
  patientId,
  context,
  busy,
  onSave,
  onClose,
}: {
  patientId: number;
  context: SessionContextVersion;
  busy: boolean;
  onSave: (draft: ContextDraft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ContextDraft>(() =>
    context.skipped ? EMPTY_CONTEXT_DRAFT : draftFromContext(context)
  );

  return (
    <ModalShell
      onClose={onClose}
      label="Editar o contexto da conversa"
      disableDismiss={busy}
    >
      <div className="flex flex-col gap-5">
        <h2 className="text-xl font-medium text-ink">
          Editar o contexto da conversa
        </h2>
        <p className="text-sm text-ink-soft">
          A versão atual é preservada: esta edição cria a versão{" "}
          {context.version + 1}, e o histórico continua mostrando o que valia
          antes.
        </p>
        <CamposDoContexto
          patientId={patientId}
          draft={draft}
          onChange={setDraft}
          busy={busy}
        />
        <div className="flex flex-wrap gap-3">
          <Primary onClick={() => onSave(draft)} disabled={busy}>
            Salvar nova versão
          </Primary>
          <Control onClick={onClose} disabled={busy}>
            Cancelar
          </Control>
        </div>
      </div>
    </ModalShell>
  );
}

/** Versões em leitura — o que valia em cada momento da conversa. */
export function ContextVersionsList({
  versions,
  onClose,
}: {
  versions: SessionContextVersion[];
  onClose: () => void;
}) {
  return (
    <ModalShell onClose={onClose} label="Contexto da conversa">
      <h2 className="text-xl font-medium text-ink">Contexto da conversa</h2>
      <ol className="mt-4 flex flex-col gap-3">
        {versions.map((v) => (
          <li
            key={v.id}
            className="flex flex-col gap-1 rounded-2xl border border-line bg-bg/40 px-4 py-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink">
                Versão {v.version}
              </span>
              {v.status === "ACTIVE" ? (
                <span className="text-xs text-ink-soft">vigente</span>
              ) : (
                <span className="text-xs text-ink-soft">substituída</span>
              )}
            </div>
            <p className="text-sm text-ink">{contextSummary(v)}</p>
            {v.notes && <p className="text-sm text-ink-soft">{v.notes}</p>}
          </li>
        ))}
      </ol>
    </ModalShell>
  );
}
