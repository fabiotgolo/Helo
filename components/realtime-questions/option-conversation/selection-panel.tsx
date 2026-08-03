"use client";

// ——— Conferência da opção observada (§10, §12) ———
//
// A seleção NÃO avança sozinha. O assistente vê qual opção marcou e confirma
// que ela corresponde ao gesto que observou — confirmar não significa
// concordar, interpretar ou decidir pelo paciente.

import {
  Control,
  Primary,
} from "@/components/realtime-questions/ui";

export function SelectionPanel({
  optionLabel,
  position,
  sensitive,
  correcting,
  busy,
  onConfirm,
  onCorrect,
  onCancelSelection,
}: {
  optionLabel: string;
  position: number;
  /** O nível ou a opção foi marcada como assunto sensível. */
  sensitive: boolean;
  /** "Corrigir" reabriu as opções: a próxima escolha é uma correção. */
  correcting: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCorrect: () => void;
  onCancelSelection: () => void;
}) {
  return (
    <section
      aria-live="polite"
      className="flex flex-col items-center gap-4 rounded-3xl border border-line bg-card/80 px-6 py-6"
    >
      <p className="text-center text-2xl font-medium">
        Opção observada: {optionLabel}
        <span className="sr-only"> (posição {position})</span>
      </p>
      <p className="max-w-xl text-center text-sm text-ink-soft">
        {correcting
          ? "Toque na opção que corresponde ao gesto observado. A seleção anterior fica registrada no histórico."
          : "Confirmar que esta opção corresponde ao gesto observado? A confirmação significa apenas que você conferiu essa correspondência."}
        {sensitive && !correcting
          ? " Este assunto é sensível: a frase final exigirá reconfirmação reforçada."
          : ""}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Primary onClick={onConfirm} disabled={busy || correcting}>
          Confirmar
        </Primary>
        <Control onClick={onCorrect} disabled={busy || correcting}>
          Corrigir
        </Control>
        <Control onClick={onCancelSelection} disabled={busy}>
          Cancelar seleção
        </Control>
      </div>
    </section>
  );
}
