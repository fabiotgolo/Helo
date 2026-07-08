import Link from "next/link";
import type { Gesture } from "@/lib/types";
import { GESTURES } from "@/lib/types";
import { APP_VERSION, APP_COMMIT } from "@/lib/version";

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
  children,
}: {
  palette: OrbPalette;
  className?: string;
  breathe?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      aria-hidden="true"
      className={`orb ${breathe ? "orb-breathe" : ""} flex items-center justify-center ${className}`}
      style={{ background: PALETTES[palette] }}
    >
      {children}
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
}: {
  onGesture: (g: Gesture) => void;
  size?: "grande" | "compacto";
  disabled?: boolean;
  idPrefix?: string;
}) {
  const grande = size === "grande";
  return (
    <div
      role="group"
      aria-label="Gestos: sim, talvez, não"
      className={`flex items-center justify-center ${grande ? "gap-6" : "gap-3"}`}
    >
      {GESTURE_ORDER.map((g) => {
        const info = GESTURES[g];
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

export function TopBar({ right }: { right?: React.ReactNode }) {
  return (
    <header className="no-print flex items-center justify-between px-6 py-4 sm:px-10">
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
      <nav className="flex items-center gap-2">{right}</nav>
    </header>
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
          ? "bg-ink text-white hover:bg-black"
          : "bg-card text-ink border border-line hover:border-ink-mute"
      }`}
    >
      {children}
    </Link>
  );
}

export function GestureLegend() {
  return (
    <div className="flex items-center justify-center gap-5 text-sm text-ink-soft">
      {GESTURE_ORDER.map((g) => (
        <span key={g} className="flex items-center gap-1.5">
          <span aria-hidden="true">{GESTURES[g].emoji}</span>
          {GESTURES[g].label}
        </span>
      ))}
    </div>
  );
}
