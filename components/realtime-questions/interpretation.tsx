"use client";

// ——— Interpretação digitada pelo cuidador (Fase 4.2) ———
//
// O paciente vocalizou algo; o cuidador escreve o que ENTENDEU e submete àquele
// que falou. Todo este arquivo existe para sustentar uma única distinção:
//
//   antes do SIM do paciente, isto é interpretação — não é fala dele.
//
// Por isso nenhuma tela daqui usa "o paciente disse" ou qualquer formulação que
// sugira declaração. O cabeçalho diz de quem é o texto, e a etiqueta de espera
// repete que a confirmação ainda não veio. Depois do SIM, quem escreve a frase
// de autoria é `rotuloDeAutoria` — que nunca omite quem formulou.
//
// Não há IA em lugar nenhum deste arquivo: o texto é do cuidador, digitado.

import { useState } from "react";
import {
  Control,
  EditButton,
  Primary,
  Selo,
} from "@/components/realtime-questions/ui";
import { MAX_STATEMENT_LEN } from "@/lib/option-conversation-types";
import {
  SENSITIVE_CATEGORIES,
  SENSITIVE_CATEGORY_LABELS,
  type SensitiveCategory,
} from "@/lib/realtime-question-types";

export interface InterpretationDraft {
  text: string;
  isSensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;
}

export const EMPTY_INTERPRETATION: InterpretationDraft = {
  text: "",
  isSensitive: false,
  sensitiveCategory: null,
};

/** Escrita da interpretação — antes de qualquer coisa aparecer ao paciente. */
export function InterpretationEditor({
  draft,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: InterpretationDraft;
  busy: boolean;
  onChange: (d: InterpretationDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-medium text-ink">
          O que você entendeu que o paciente disse?
        </h2>
        <p className="text-sm text-ink-soft">
          Escreva com as suas palavras. O paciente vai ler e confirmar — até lá,
          isto é a sua interpretação, não a fala dele.
        </p>
      </header>

      <label className="flex flex-col gap-1">
        <span className="sr-only">Interpretação do cuidador</span>
        <textarea
          aria-label="Interpretação do cuidador"
          value={draft.text}
          maxLength={MAX_STATEMENT_LEN}
          rows={4}
          disabled={busy}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
          className="rounded-2xl border border-line bg-bg px-4 py-3 text-lg text-ink"
        />
        <span className="self-end text-xs text-ink-soft">
          {draft.text.length}/{MAX_STATEMENT_LEN}
        </span>
      </label>

      <div className="flex flex-wrap gap-3">
        <Primary onClick={onSubmit} disabled={busy || !draft.text.trim()}>
          Registrar interpretação
        </Primary>
        <Control onClick={onCancel} disabled={busy}>
          Cancelar
        </Control>
      </div>
    </section>
  );
}

/**
 * Revisão antes de apresentar. É aqui que o cuidador relê o que escreveu e
 * classifica o assunto como sensível — a classificação é MANUAL, porque o Helo
 * não interpreta o conteúdo.
 */
export function InterpretationReview({
  text,
  isSensitive,
  sensitiveCategory,
  busy,
  onChangeSensitive,
  onEdit,
  onPresent,
  onCancel,
}: {
  text: string;
  isSensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;
  busy: boolean;
  onChangeSensitive: (
    isSensitive: boolean,
    category: SensitiveCategory | null
  ) => void;
  onEdit: () => void;
  onPresent: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-medium text-ink">
          Interpretação registrada pelo cuidador
        </h2>
        <EditButton label="a interpretação" onClick={onEdit} disabled={busy} />
      </div>

      <blockquote className="rounded-2xl border border-line bg-card/60 px-5 py-4 text-xl font-medium text-ink">
        {text}
      </blockquote>

      {/* Dito antes do botão de apresentar, não depois: é a informação que
          decide se o cuidador deve seguir em frente. */}
      <p className="text-sm text-ink-soft">Ainda não é fala do paciente.</p>

      <div className="flex flex-col gap-2 rounded-2xl border border-line px-4 py-3">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isSensitive}
            disabled={busy}
            onChange={(e) =>
              onChangeSensitive(
                e.target.checked,
                e.target.checked ? sensitiveCategory : null
              )
            }
          />
          <span className="text-ink">Assunto sensível</span>
        </label>
        {isSensitive && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-soft">Categoria</span>
            <select
              value={sensitiveCategory ?? ""}
              disabled={busy}
              onChange={(e) =>
                onChangeSensitive(
                  true,
                  (e.target.value || null) as SensitiveCategory | null
                )
              }
              className="min-h-11 rounded-xl border border-line bg-bg px-3 text-ink"
            >
              <option value="">Selecione</option>
              {SENSITIVE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {SENSITIVE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
        )}
        {isSensitive && (
          <p className="text-xs text-ink-soft">
            Assunto sensível exige uma segunda confirmação do paciente antes de
            virar comunicação confirmada.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <Primary onClick={onPresent} disabled={busy}>
          Apresentar ao paciente
        </Primary>
        <Control onClick={onCancel} disabled={busy}>
          Cancelar
        </Control>
      </div>
    </section>
  );
}

/** Etiqueta discreta enquanto a confirmação não vem. */
export function InterpretationBadge({ sensitive }: { sensitive?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p aria-live="polite" className="text-sm text-ink-soft">
        Interpretação aguardando confirmação do paciente.
      </p>
      {sensitive && <Selo>Sensível</Selo>}
    </div>
  );
}

/** Estado local do rascunho, para o fluxo não recriar isto em dois lugares. */
export function useInterpretationDraft() {
  return useState<InterpretationDraft>(EMPTY_INTERPRETATION);
}
