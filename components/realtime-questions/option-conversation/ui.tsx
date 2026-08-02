"use client";

// ——— Peças visuais da conversa por opções ———
// Mesmo vocabulário da tela Conversar: os botões são os de session.tsx, os
// tokens de tema são os do projeto e nada aqui redesenha a tela.

import type { ReactNode } from "react";
import {
  INTERACTION_MODE_HINTS,
  INTERACTION_MODE_LABELS,
  type InteractionMode,
} from "@/lib/realtime-question-types";

export function Primary({
  children,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full bg-accent px-7 py-3.5 text-base font-medium text-on-accent transition-colors hover:bg-accent-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function Control({
  children,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-line bg-card px-5 py-3 text-sm font-medium text-ink-soft transition-colors hover:border-ink-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * Lápis discreto (§26). O ícone NUNCA vai sozinho: o rótulo acessível diz o
 * que será editado, para quem usa leitor de tela saber antes de acionar.
 *
 * Diferente de components/contextual-edit.tsx, que é um deep link para uma tela
 * de gerenciamento — este edita o conteúdo aqui mesmo.
 */
export function EditButton({
  label,
  onClick,
  disabled = false,
}: {
  /** O que está sendo editado: vira "Editar <label>". */
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`Editar ${label}`}
      title={`Editar ${label}`}
      className="inline-flex min-h-9 min-w-9 items-center gap-1 rounded-full border border-line bg-card/90 px-3 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:border-ink-mute hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span aria-hidden="true">✎</span>
      <span className="sr-only sm:not-sr-only">Editar</span>
    </button>
  );
}

/**
 * Indica o modo ATIVO (§3). Fica sempre visível enquanto há conteúdo na tela:
 * o assistente precisa saber, sem inferir, o que os três sinais significam
 * agora — e a mudança de significado nunca pode ser silenciosa.
 */
export function InteractionModeBadge({ mode }: { mode: InteractionMode }) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-line bg-card/70 px-4 py-2"
      // O texto explicativo acompanha o rótulo para leitores de tela.
      aria-live="polite"
    >
      <span className="text-xs font-semibold uppercase tracking-widest text-ink-soft">
        {INTERACTION_MODE_LABELS[mode]}
      </span>
      <span className="text-sm text-ink-mute">
        {INTERACTION_MODE_HINTS[mode]}
      </span>
    </div>
  );
}

export function Selo({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-mute">
      {children}
    </span>
  );
}
