"use client";

// ——— Ação contextual "Editar" ———
// Um único componente para todas as telas de USO: leva direto ao item exato
// no painel de gerenciamento correspondente (deep link de lib/edit-link),
// sem competir com a ação principal do conteúdo. Só deve ser renderizado
// quando a capacidade de edição veio do servidor — e mesmo assim a
// autorização real continua nas rotas de escrita.

import { useRouter } from "next/navigation";
import Link from "next/link";
import { buildEditLink, type EditTarget } from "@/lib/edit-link";
import { useHeloDialog } from "@/components/helo-dialog";
import type { HeloConfirmOptions } from "@/components/helo-dialog";

export function ContextualEdit({
  target,
  source,
  label,
  confirm,
  className = "",
}: {
  target: EditTarget;
  /** Caminho interno da tela de origem — vira o returnTo do destino. */
  source: string;
  /** Nome do conteúdo, para o aria-label ("Editar <label>"). */
  label: string;
  /**
   * Confirmação (modal Helo) antes de navegar — ex.: editar durante uma sessão
   * encerra a sessão atual. Cancelar mantém a tela como está. Ausente = navega
   * direto. Substitui o antigo window.confirm nativo.
   */
  confirm?: HeloConfirmOptions;
  className?: string;
}) {
  const href = buildEditLink(target, source);
  const router = useRouter();
  const dialog = useHeloDialog();
  return (
    <Link
      href={href}
      aria-label={`Editar ${label}`}
      title={`Editar ${label}`}
      onClick={(e) => {
        // O clique não pode vazar para a ação principal do conteúdo
        // (falar, iniciar sessão…) — edição nunca dispara uso.
        e.stopPropagation();
        // Com confirmação, a navegação é assíncrona: segura o clique, abre o
        // modal Helo e só navega no "Continuar".
        if (confirm) {
          e.preventDefault();
          void dialog.confirm(confirm).then((ok) => {
            if (ok) router.push(href);
          });
        }
      }}
      className={`inline-flex min-h-9 items-center gap-1 rounded-full border border-line bg-card/90 px-3 py-1.5 text-sm font-medium text-ink-soft backdrop-blur-sm transition-colors hover:border-ink-mute hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${className}`}
    >
      <span aria-hidden="true">✎</span> Editar
    </Link>
  );
}
