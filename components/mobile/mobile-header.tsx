"use client";

// ——— Header mobile da Home (< sm) ———
// Composição da referência visual: marca + versão à esquerda com o atalho de
// temas logo abaixo; área do paciente à direita. É só APRESENTAÇÃO — paciente
// ativo, temas e sessão continuam vindo dos providers já validados
// (usePatient, useTheme via ThemeDots, useAuthUser). Desktop não usa este
// componente: lá permanece a TopBar.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Orb } from "@/components/ui";
import { ThemeDots } from "@/components/theme-dots";
import { PlatformMuteToggle } from "@/components/platform-mute-toggle";
import { useAuthUser } from "@/lib/use-auth";
import { usePatient } from "@/lib/patient";
import { APP_VERSION, APP_COMMIT } from "@/lib/version";

/**
 * Área do paciente no topo direito:
 *   0 pacientes → nada (área vazia);
 *   1 paciente  → só o nome, sem combo;
 *   2+          → combo para trocar (mesmo selectPatient validado — a lista
 *                 já chega filtrada por vínculo em /api/patients).
 */
function MobilePatientArea() {
  const { user, loading: authLoading } = useAuthUser();
  const { patients, patient, loading, selectPatient } = usePatient();
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

  if (authLoading || !user || loading || patients.length === 0) return null;

  const label = (
    <span className="flex min-w-0 items-center gap-2.5">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-5 shrink-0 text-ink-soft"
      >
        <circle cx="12" cy="8" r="3.4" />
        <path d="M5.5 19.2c1.2-3 3.6-4.5 6.5-4.5s5.3 1.5 6.5 4.5" />
      </svg>
      <span className="flex min-w-0 flex-col items-start leading-tight">
        <span className="text-[11px] text-ink-soft">Paciente</span>
        {/* Sem largura fixa: self-stretch + a cadeia de min-w-0 fazem o
            truncate responder ao espaço que o header realmente dá — o nome
            cresce até onde cabe e nunca estoura a borda da tela. */}
        <span className="self-stretch truncate text-left text-sm font-semibold text-ink">
          {patient?.name ?? patients[0].name}
        </span>
      </span>
    </span>
  );

  if (patients.length === 1) {
    return (
      <span
        className="flex min-w-0 items-center rounded-full border border-line bg-card px-3.5 py-2"
        title={`Paciente ativo: ${patient?.name ?? patients[0].name}`}
      >
        {label}
      </span>
    );
  }

  return (
    <div ref={menuRef} className="relative min-w-0">
      <button
        type="button"
        aria-label="Selecionar paciente"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 max-w-full items-center gap-2 rounded-full border border-line bg-card px-3.5 py-2 transition-colors hover:border-ink-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        {label}
        <span aria-hidden="true" className="text-xs text-ink-soft">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Pacientes autorizados"
          className="absolute right-0 z-50 mt-2 min-w-56 overflow-hidden rounded-2xl border border-line bg-card p-1.5 shadow-lg"
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
                  // Mesmo comportamento do PatientSwitcher desktop: o
                  // dashboard individual é a única tela com a identidade
                  // também na rota — URL e paciente ativo andam juntos.
                  if (/^\/dashboard\/\d+$/.test(pathname)) {
                    router.replace(`/dashboard/${candidate.id}`);
                  }
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-bg ${
                  selected ? "font-semibold text-ink" : "text-ink-soft"
                }`}
              >
                <span aria-hidden="true" className="w-4 text-center">
                  {selected ? "✓" : ""}
                </span>
                <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function MobileHeader({ className = "" }: { className?: string }) {
  return (
    <header
      // relative z-30: o palco é irmão POSTERIOR no DOM e pintaria por cima
      // da coluna de temas (que desce sob a marca). O cabeçalho e seus
      // controles ficam sempre acima do orbe.
      className={`no-print relative z-30 flex items-start justify-between gap-3 px-5 pb-1 pt-4 ${className}`}
    >
      {/* Mesma âncora do desktop: a coluna de temas é absoluta sob a marca —
          não rouba altura do palco nem empurra o conteúdo da tela. */}
      <div className="relative shrink-0">
        <Link href="/" className="flex items-center gap-2" aria-label="Helo — página inicial">
          <Orb palette="coral" className="h-6 w-6" />
          <span className="text-xl font-semibold tracking-tight">Helo</span>
          <span
            className="self-center rounded-full border border-line px-1.5 py-0.5 text-[10px] font-medium leading-none tracking-wide text-ink-mute tabular-nums"
            title={APP_COMMIT ? `build ${APP_COMMIT}` : undefined}
          >
            v{APP_VERSION}
          </span>
        </Link>
        {/* Coluna de temas sob a marca e, logo abaixo, o mute da voz da
            plataforma — mesmo alvo de toque das bolinhas. */}
        <div className="absolute left-0 top-full mt-1 flex flex-col items-center gap-1">
          <ThemeDots size="compact" orientation="vertical" />
          <PlatformMuteToggle size="compact" />
        </div>
      </div>
      <MobilePatientArea />
    </header>
  );
}
