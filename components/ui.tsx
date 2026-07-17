"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Gesture } from "@/lib/types";
import { useGestures } from "@/lib/gestures";
import { useAuthUser } from "@/lib/use-auth";
import { usePatient } from "@/lib/patient";
import { ThemeDots } from "@/components/theme-dots";
import { MobileHeader } from "@/components/mobile/mobile-header";
import { MobileTabBar } from "@/components/mobile/mobile-tab-bar";
import { APP_VERSION, APP_COMMIT } from "@/lib/version";

// Carregado sob demanda: Three.js só entra no bundle quando há um orbe animado na tela
const Orb3D = dynamic(() => import("./orb-3d"), { ssr: false });

// ——— Orbe: forma orgânica circular em gradiente, marca visual do Helo ———

export type OrbPalette = "coral" | "lilas" | "oliva" | "rosa" | "ambar" | "ceu";

const PALETTES: Record<OrbPalette, string> = {
  coral:
    "radial-gradient(120% 120% at 30% 20%, #c3cdea 0%, rgba(195,205,234,0) 45%)," +
    "radial-gradient(130% 130% at 75% 15%, #f6c1cd 0%, rgba(246,193,205,0) 50%)," +
    "radial-gradient(140% 140% at 25% 80%, #ef4b52 0%, rgba(239,75,82,0) 60%)," +
    "radial-gradient(120% 120% at 80% 85%, #f89b4b 0%, rgba(248,155,75,0) 55%)," +
    "linear-gradient(160deg, #f2988a 0%, #ee6a5a 100%)",
  lilas:
    "radial-gradient(130% 130% at 50% 15%, #7f78ce 0%, rgba(127,120,206,0) 60%)," +
    "radial-gradient(140% 140% at 30% 90%, #f4b98a 0%, rgba(244,185,138,0) 55%)," +
    "radial-gradient(120% 120% at 80% 90%, #ecd4c0 0%, rgba(236,212,192,0) 50%)," +
    "linear-gradient(180deg, #8b84d6 0%, #b7aede 55%, #efb98d 100%)",
  oliva:
    "radial-gradient(120% 120% at 20% 30%, #a9c3e2 0%, rgba(169,195,226,0) 50%)," +
    "radial-gradient(130% 130% at 70% 35%, #6f7d3f 0%, rgba(111,125,63,0) 60%)," +
    "radial-gradient(140% 140% at 60% 95%, #e79a4e 0%, rgba(231,154,78,0) 55%)," +
    "linear-gradient(160deg, #b6c79a 0%, #8a9a5b 100%)",
  rosa:
    "radial-gradient(120% 120% at 30% 25%, #fbe3e0 0%, rgba(251,227,224,0) 55%)," +
    "radial-gradient(130% 130% at 75% 80%, #f6c9c2 0%, rgba(246,201,194,0) 55%)," +
    "linear-gradient(160deg, #f9ded9 0%, #f3c4bd 100%)",
  ambar:
    "radial-gradient(120% 120% at 30% 20%, #f7dcb4 0%, rgba(247,220,180,0) 55%)," +
    "radial-gradient(140% 140% at 70% 85%, #e0803f 0%, rgba(224,128,63,0) 60%)," +
    "linear-gradient(160deg, #f2c48d 0%, #e89a55 100%)",
  ceu:
    "radial-gradient(120% 120% at 30% 20%, #dbe7f5 0%, rgba(219,231,245,0) 55%)," +
    "radial-gradient(140% 140% at 70% 85%, #8fb2dd 0%, rgba(143,178,221,0) 60%)," +
    "linear-gradient(160deg, #c4d7ee 0%, #9dbde4 100%)",
};

export function Orb({
  palette,
  className = "",
  breathe = false,
  getAmplitude,
  children,
}: {
  palette: OrbPalette;
  className?: string;
  breathe?: boolean;
  /** Fonte de amplitude 0–1 para o orbe reagir à voz em curso (só com breathe). */
  getAmplitude?: () => number;
  children?: React.ReactNode;
}) {
  return (
    <div
      aria-hidden="true"
      className={`orb ${breathe ? "orb-breathe" : ""} flex items-center justify-center ${className}`}
      style={{ background: PALETTES[palette] }}
    >
      {/* Orbes "vivos" ganham a versão 3D; o gradiente CSS fica por baixo como fallback */}
      {breathe && <Orb3D palette={palette} getAmplitude={getAmplitude} />}
      {children && <span className="relative z-[1]">{children}</span>}
    </div>
  );
}

// ——— Botões de gesto ———

const GESTURE_ORDER: Gesture[] = ["sim", "talvez", "nao"];

const GESTURE_STYLES: Record<Gesture, { ring: string; bg: string; text: string }> = {
  sim: { ring: "border-sim/40", bg: "bg-sim-soft", text: "text-sim" },
  talvez: { ring: "border-talvez/40", bg: "bg-talvez-soft", text: "text-talvez" },
  nao: { ring: "border-nao/40", bg: "bg-nao-soft", text: "text-nao" },
};

/**
 * Os três gestos, lado a lado. `size="grande"` para perguntas diretas,
 * `size="compacto"` para linhas de opção (como na referência visual).
 */
export function GestureTriplet({
  onGesture,
  size = "grande",
  disabled = false,
  idPrefix = "",
  highlighted = false,
}: {
  onGesture: (g: Gesture) => void;
  size?: "grande" | "compacto";
  disabled?: boolean;
  idPrefix?: string;
  /** Chama atenção para as opções; nunca dispara uma resposta por si só. */
  highlighted?: boolean;
}) {
  const grande = size === "grande";
  const gestures = useGestures();
  return (
    <div
      role="group"
      aria-label="Gestos: sim, talvez, não"
      className={`flex items-center justify-center rounded-3xl ${grande ? "gap-6" : "gap-3"} ${
        highlighted ? "ring-2 ring-accent ring-offset-4 ring-offset-transparent motion-safe:animate-pulse" : ""
      }`}
    >
      {GESTURE_ORDER.map((g) => {
        const info = gestures[g];
        const s = GESTURE_STYLES[g];
        return (
          <button
            key={idPrefix + g}
            type="button"
            disabled={disabled}
            onClick={() => onGesture(g)}
            aria-label={`${info.label} (${info.hint})`}
            className={`group flex flex-col items-center justify-center rounded-3xl border ${s.ring} ${s.bg}
              transition-transform duration-150 hover:scale-[1.04] active:scale-[0.97]
              disabled:opacity-40 disabled:hover:scale-100
              ${grande ? "h-40 w-40 sm:h-44 sm:w-44" : "h-16 w-16"}`}
          >
            <span className={grande ? "text-6xl sm:text-7xl" : "text-2xl"} aria-hidden="true">
              {info.emoji}
            </span>
            {grande && (
              <span className={`mt-2 text-sm font-semibold uppercase tracking-wide ${s.text}`}>
                {info.label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ——— Navegação superior ———

/**
 * Ação global de encerrar sessão — única fonte do "Sair" da plataforma.
 * Renderiza-se sozinha: aparece para QUALQUER usuário autenticado (todos os
 * papéis, admin incluído) e some quando não há sessão. O comportamento do
 * logout (voz, sessões de modo, espelhos locais, cookie) vive em useAuthUser.
 */
export function LogoutButton() {
  const { user, loading, logout } = useAuthUser();
  if (loading || !user) return null;
  return (
    <button
      type="button"
      onClick={() => void logout()}
      title={`${user.name} — encerrar sessão`}
      aria-label={`Sair — encerrar a sessão de ${user.name}`}
      className="rounded-full border border-line bg-card px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:border-ink-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink sm:px-5"
    >
      Sair
    </button>
  );
}

/** Acesso global ao suporte, sem interferir nos fluxos do paciente. */
export function FeedbackLink() {
  const { user, loading } = useAuthUser();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!user) {
      setUnreadCount(0);
      return;
    }
    const controller = new AbortController();
    const endpoint = user.role === "admin" ? "/api/admin/feedback" : "/api/feedback";
    void fetch(endpoint, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("não foi possível carregar o feedback");
        const data = (await response.json()) as { requests?: Array<{ unreadMessagesCount?: number }> };
        setUnreadCount(data.requests?.reduce((total, request) => total + (request.unreadMessagesCount ?? 0), 0) ?? 0);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setUnreadCount(0);
      });
    return () => controller.abort();
  }, [user?.id, user?.role]);

  if (loading || !user) return null;
  const unreadLabel = unreadCount === 1 ? "1 mensagem não lida" : `${unreadCount} mensagens não lidas`;
  return (
    <Link
      href="/feedback"
      aria-label={unreadCount ? `Feedback e suporte — ${unreadLabel}` : "Feedback e suporte"}
      className="relative rounded-full border border-line bg-card px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-ink-mute"
    >
      Feedback e suporte
      {unreadCount > 0 && (
        <span aria-hidden="true" className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-nao text-xs font-bold text-white shadow-sm">
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      )}
    </Link>
  );
}

/** Entrada persistente do Admin no menu principal; segurança real fica no servidor. */
export function AdminLink() {
  const { user, loading } = useAuthUser();
  if (loading || user?.role !== "admin") return null;
  return <PillLink href="/admin">Admin</PillLink>;
}

/**
 * Seletor persistente do paciente ativo. A lista já chega filtrada por
 * /api/patients; selectPatient também só aceita ids presentes nessa lista.
 * Assim, o menu troca a experiência, mas não é uma camada de autorização.
 */
export function PatientSwitcher() {
  const { user, loading: authLoading } = useAuthUser();
  const { patients, patient, loading: patientsLoading, selectPatient } = usePatient();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeWhenOutside = (event: MouseEvent | TouchEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeWhenOutside);
    document.addEventListener("touchstart", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeWhenOutside);
      document.removeEventListener("touchstart", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  // A tela de login também usa a TopBar. Não exibimos contexto de paciente
  // antes de saber que existe uma sessão autenticada.
  if (authLoading || !user || patientsLoading) return null;

  if (patients.length === 0) {
    return (
      <span className="rounded-full border border-line bg-card px-4 py-2.5 text-sm text-ink-soft">
        Nenhum paciente selecionado
      </span>
    );
  }

  if (patients.length === 1) {
    return (
      <span
        className="max-w-52 truncate px-2 py-2.5 text-sm font-semibold text-ink"
        title={`Paciente ativo: ${patient?.name ?? patients[0].name}`}
      >
        Paciente: {patient?.name ?? patients[0].name}
      </span>
    );
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-label="Selecionar paciente"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex max-w-60 items-center gap-2 rounded-full border border-line bg-card px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:border-ink-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <span className="shrink-0">Pacientes</span>
        <span className="truncate text-ink-soft">{patient?.name ?? "Selecionar"}</span>
        <span aria-hidden="true" className="text-xs">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Pacientes autorizados"
          className="absolute right-0 z-50 mt-2 min-w-64 overflow-hidden rounded-2xl border border-line bg-card p-1.5 shadow-lg"
        >
          <p className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-mute">
            Paciente ativo
          </p>
          {patients.map((candidate) => {
            const selected = candidate.id === patient?.id;
            return (
              <button
                key={candidate.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  selectPatient(candidate.id);
                  setOpen(false);
                  // O dashboard individual é a única tela cuja identidade
                  // também está na rota. Mantemos URL e paciente ativo em
                  // sincronia sem alterar a navegação das demais áreas.
                  if (/^\/dashboard\/\d+$/.test(pathname)) {
                    router.replace(`/dashboard/${candidate.id}`);
                  }
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-bg ${
                  selected ? "font-semibold text-ink" : "text-ink-soft"
                }`}
              >
                <span aria-hidden="true" className="w-4 text-center">{selected ? "✓" : ""}</span>
                <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TopBar({
  right,
  showLogout = true,
  showFeedback = true,
  showThemeDots = true,
  showAdmin = true,
  mobile = "full",
}: {
  right?: React.ReactNode;
  /** Só a tela de login desliga — toda área autenticada mantém o Sair. */
  showLogout?: boolean;
  /** A própria página de feedback evita repetir o atalho. */
  showFeedback?: boolean;
  /** Atalho rápido de temas — indicador + troca. Ligado em todo o app. */
  showThemeDots?: boolean;
  /** Entrada persistente para o Dashboard Administrativo quando o papel é admin. */
  showAdmin?: boolean;
  /**
   * Padrão mobile global (< sm): cabeçalho + menu inferior da Home em TODAS
   * as telas que usam a TopBar. "locked" = tela de login (menu visível porém
   * inerte); "none" desliga o padrão quando uma tela tiver exceção funcional.
   * O desktop ignora — o header original segue exclusivo de sm+.
   */
  mobile?: "full" | "locked" | "none";
}) {
  return (
    <>
      {mobile !== "none" && (
        <>
          <MobileHeader className="sm:hidden" />
          <MobileTabBar className="sm:hidden" locked={mobile === "locked"} />
        </>
      )}
      {/* relative z-30: mesma razão do cabeçalho mobile — o palco (irmão
          posterior) não pode cobrir a coluna de temas nem a navegação. */}
      <header className="no-print relative z-30 hidden items-center justify-between gap-3 px-6 py-4 sm:flex sm:px-10">
      {/* A marca ancora a coluna de temas logo abaixo dela. `relative` só
          para posicionar; a coluna é absoluta e não ocupa altura no header. */}
      <div className="relative">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Helo — página inicial">
          <Orb palette="coral" className="h-6 w-6" />
          <span className="text-xl font-semibold tracking-tight">Helo</span>
          <span
            className="self-center rounded-full border border-line px-1.5 py-0.5 text-[10px] font-medium leading-none tracking-wide text-ink-mute tabular-nums"
            title={APP_COMMIT ? `build ${APP_COMMIT}` : undefined}
          >
            v{APP_VERSION}
          </span>
        </Link>
        {/* Coluna de temas na margem esquerda, sob a marca: sobrepõe o vão
            lateral sem empurrar o conteúdo da página. */}
        {showThemeDots && (
          <ThemeDots orientation="vertical" className="absolute left-0 top-full mt-1" />
        )}
      </div>
      {/* flex-wrap: em telas estreitas os controles quebram de linha — o
          Sair nunca some por falta de espaço. */}
      <nav className="flex flex-wrap items-center justify-end gap-2">
        <PatientSwitcher />
        {right}
        {showAdmin && <AdminLink />}
        {showFeedback && <FeedbackLink />}
        {showLogout && <LogoutButton />}
      </nav>
    </header>
    </>
  );
}

export function PillLink({
  href,
  children,
  dark = false,
}: {
  href: string;
  children: React.ReactNode;
  dark?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full px-5 py-2.5 text-sm font-medium transition-colors ${
        dark
          ? "bg-accent text-on-accent hover:bg-accent-strong"
          : "bg-card text-ink border border-line hover:border-ink-mute"
      }`}
    >
      {children}
    </Link>
  );
}

export function GestureLegend() {
  const gestures = useGestures();
  return (
    <div className="flex items-center justify-center gap-5 text-sm text-ink-soft">
      {GESTURE_ORDER.map((g) => (
        <span key={g} className="flex items-center gap-1.5">
          <span aria-hidden="true">{gestures[g].emoji}</span>
          {gestures[g].label}
        </span>
      ))}
    </div>
  );
}
