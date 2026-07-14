"use client";

// ——— Ação contextual "Editar" ———
// Um único componente para todas as telas de USO: leva direto ao item exato
// no painel de gerenciamento correspondente (deep link de lib/edit-link),
// sem competir com a ação principal do conteúdo. Só deve ser renderizado
// quando a capacidade de edição veio do servidor — e mesmo assim a
// autorização real continua nas rotas de escrita.

import Link from "next/link";
import { buildEditLink, type EditTarget } from "@/lib/edit-link";

export function ContextualEdit({
  target,
  source,
  label,
  onNavigate,
  className = "",
}: {
  target: EditTarget;
  /** Caminho interno da tela de origem — vira o returnTo do destino. */
  source: string;
  /** Nome do conteúdo, para o aria-label ("Editar <label>"). */
  label: string;
  /** Confirmações antes de sair (ex.: encerrar sessão). Retornar false cancela. */
  onNavigate?: () => boolean;
  className?: string;
}) {
  const href = buildEditLink(target, source);
  return (
    <Link
      href={href}
      aria-label={`Editar ${label}`}
      title={`Editar ${label}`}
      onClick={(e) => {
        // O clique não pode vazar para a ação principal do conteúdo
        // (falar, iniciar sessão…) — edição nunca dispara uso.
        e.stopPropagation();
        if (onNavigate && !onNavigate()) e.preventDefault();
      }}
      className={`inline-flex min-h-9 items-center gap-1 rounded-full border border-line bg-card/90 px-3 py-1.5 text-sm font-medium text-ink-soft backdrop-blur-sm transition-colors hover:border-ink-mute hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${className}`}
    >
      <span aria-hidden="true">✎</span> Editar
    </Link>
  );
}
