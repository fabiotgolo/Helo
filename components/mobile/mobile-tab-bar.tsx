"use client";

// ——— Menu inferior mobile (< sm) ———
// Equivalente aos controles da TopBar do desktop, fixo no rodapé e com
// safe-area do iPhone. Cada item carrega um ícone SVG num slot estável
// (TAB_ICONS): quando os SVGs definitivos chegarem, basta trocar o desenho —
// a estrutura do componente não muda.
//
// Segurança: este menu é só navegação. Admin aparece conforme o papel já
// resolvido por useAuthUser (mesmo critério do AdminLink) e a autorização
// real continua nas rotas do servidor. `locked` (tela de login) mantém o
// menu visível porém inerte — nenhum toque navega nem executa ação.

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAuthUser } from "@/lib/use-auth";

type TabId = "inicio" | "admin" | "suporte" | "ajustes" | "sair";

// Placeholders simples em stroke — substituir apenas o conteúdo de cada
// entrada pelos SVGs definitivos, mantendo viewBox 24 e currentColor.
const TAB_ICONS: Record<TabId, ReactNode> = {
  inicio: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-6">
      <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z" />
    </svg>
  ),
  admin: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-6">
      <circle cx="12" cy="7.5" r="3" />
      <path d="M5.5 19c1.1-2.9 3.5-4.4 6.5-4.4s5.4 1.5 6.5 4.4" />
      <path d="M15.5 4.5h4M17.5 2.5v4" />
    </svg>
  ),
  suporte: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-6">
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 4v-4h-1A2.5 2.5 0 0 1 4 13.5z" />
    </svg>
  ),
  ajustes: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-6">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" />
    </svg>
  ),
  sair: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-6">
      <path d="M14 4H7a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 7 20h7" />
      <path d="M17 8.5 20.5 12 17 15.5M20.5 12H10" />
    </svg>
  ),
};

const ITEM_BASE =
  "flex min-w-14 flex-1 flex-col items-center gap-1 rounded-2xl px-1 py-1.5 text-[11px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

export function MobileTabBar({
  className = "",
  locked = false,
}: {
  className?: string;
  /** Tela de login: menu visível como referência, sem nenhuma ação real. */
  locked?: boolean;
}) {
  const pathname = usePathname();
  const { user, loading, logout } = useAuthUser();

  // Sem sessão (e fora do modo locked) não há menu — a área autenticada é
  // inacessível de qualquer forma; o PatientProvider já leva ao login.
  if (!locked && (loading || !user)) return null;

  const items: Array<{
    id: TabId;
    label: string;
    href?: string;
    onTap?: () => void;
    show: boolean;
  }> = [
    { id: "inicio", label: "Conversar", href: "/", show: true },
    // Mesmo critério do AdminLink: exibição por papel; autorização no servidor.
    { id: "admin", label: "Admin", href: "/admin", show: locked || user?.role === "admin" },
    { id: "suporte", label: "Suporte", href: "/feedback", show: true },
    { id: "ajustes", label: "Ajustes", href: "/ajustes", show: true },
    { id: "sair", label: "Sair", onTap: () => void logout(), show: true },
  ];

  return (
    <nav
      aria-label="Menu principal"
      className={`no-print safe-area-pb fixed inset-x-0 bottom-0 z-40 border-t border-line bg-card/85 backdrop-blur-xl ${className}`}
    >
      <div className="mx-auto flex max-w-md items-stretch justify-between gap-1 px-3 pb-1.5 pt-2">
        {items
          .filter((item) => item.show)
          .map((item) => {
            const active = !locked && item.href === pathname;
            const tone = active ? "text-accent" : "text-ink-soft";
            const content = (
              <>
                <span className={tone}>{TAB_ICONS[item.id]}</span>
                <span className={tone}>{item.label}</span>
              </>
            );
            if (locked) {
              // Inerte de verdade: nem navega, nem executa — o toque só conta
              // como primeira interação da página (que revela o login).
              return (
                <span key={item.id} aria-hidden="true" className={ITEM_BASE}>
                  {content}
                </span>
              );
            }
            if (item.href) {
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                  className={ITEM_BASE}
                >
                  {content}
                </Link>
              );
            }
            return (
              <button
                key={item.id}
                type="button"
                onClick={item.onTap}
                aria-label={
                  item.id === "sair" && user
                    ? `Sair — encerrar a sessão de ${user.name}`
                    : item.label
                }
                className={ITEM_BASE}
              >
                {content}
              </button>
            );
          })}
      </div>
    </nav>
  );
}
