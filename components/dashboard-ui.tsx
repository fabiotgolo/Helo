"use client";

// Peças compartilhadas dos dois níveis de Dashboard (Geral e Individual).
// Gráficos nunca dependem só de cor: todo dado tem rótulo, valor e emoji
// ou texto — e estados vazios explicam, em vez de sumir.

import { type Gesture } from "@/lib/types";
import { useGestures } from "@/lib/gestures";

export const SERIES = "#7f78ce"; // série única — validada contra a superfície clara

const GESTURE_COLORS: Record<Gesture, string> = {
  sim: "#2f9e6e",
  talvez: "#b9822f",
  nao: "#c25b4e",
};

export function fmtDia(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

export function fmtTs(ts: string): string {
  return ts.slice(0, 16).replace("T", " ");
}

/** Iniciais do paciente para o avatar (sem foto — nada sensível). */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function Avatar({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-ink font-semibold text-white ${
        size === "lg" ? "h-14 w-14 text-xl" : "h-11 w-11 text-base"
      }`}
    >
      {initials(name) || "?"}
    </span>
  );
}

export function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="print-block rounded-3xl border border-line bg-card p-5">
      <p className="text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
      <p className="mt-1 text-sm text-ink-soft">{label}</p>
    </div>
  );
}

export function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="print-block rounded-3xl border border-line bg-card p-6">
      <h2 className="font-semibold tracking-tight">{title}</h2>
      {subtitle && <p className="text-sm text-ink-soft">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children?: React.ReactNode }) {
  return (
    <p className="py-8 text-center text-sm text-ink-mute">
      {children ?? "Ainda não existem registros suficientes neste período."}
    </p>
  );
}

/** Barras verticais por dia — série única, rótulo direto no maior valor, tooltip nativo. */
export function DailyBars({ data }: { data: { dia: string; gestos: number }[] }) {
  if (data.length === 0) return <Empty />;
  const shown = data.slice(-31);
  const max = Math.max(...shown.map((d) => d.gestos), 1);
  const maxIdx = shown.findIndex((d) => d.gestos === max);
  return (
    <div className="flex h-44 items-end gap-1" role="img" aria-label="Gestos registrados por dia">
      {shown.map((d, i) => (
        <div key={d.dia} className="group flex min-w-0 flex-1 flex-col items-center gap-1.5">
          {i === maxIdx && (
            <span className="text-xs font-medium tabular-nums text-ink-soft">{d.gestos}</span>
          )}
          <div
            title={`${fmtDia(d.dia)}: ${d.gestos} gestos`}
            className="w-full max-w-8 rounded-t"
            style={{
              background: SERIES,
              height: `${Math.max((d.gestos / max) * 128, d.gestos > 0 ? 4 : 1)}px`,
            }}
          />
          <span className="truncate text-[10px] text-ink-mute">{fmtDia(d.dia)}</span>
        </div>
      ))}
    </div>
  );
}

/** Barras horizontais por gesto — cor semântica + emoji + rótulo + valor (nunca só cor). */
export function GestureBars({
  data,
  total,
}: {
  data: { gesture: Gesture; n: number }[];
  total: number;
}) {
  const gestures = useGestures();
  if (total === 0) return <Empty />;
  const order: Gesture[] = ["sim", "talvez", "nao"];
  const max = Math.max(...data.map((d) => d.n), 1);
  return (
    <ul className="flex flex-col gap-3">
      {order.map((g) => {
        const n = data.find((d) => d.gesture === g)?.n ?? 0;
        const pct = total > 0 ? Math.round((n / total) * 100) : 0;
        return (
          <li key={g} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-sm">
              {gestures[g].emoji} {gestures[g].label}
            </span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-cream">
              <div
                className="h-full rounded"
                style={{ width: `${(n / max) * 100}%`, background: GESTURE_COLORS[g] }}
                title={`${gestures[g].label}: ${n} (${pct}%)`}
              />
            </div>
            <span className="w-20 shrink-0 text-right text-sm tabular-nums text-ink-soft">
              {n} · {pct}%
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Barras horizontais rotuladas — série única (temas, itens de Rotina…). */
export function LabeledBars({
  data,
  max: maxItems = 8,
}: {
  data: { label: string; n: number }[];
  max?: number;
}) {
  if (data.length === 0) return <Empty />;
  const max = Math.max(...data.map((d) => d.n), 1);
  return (
    <ul className="flex flex-col gap-3">
      {data.slice(0, maxItems).map((c) => (
        <li key={c.label} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-sm capitalize" title={c.label}>
            {c.label}
          </span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-cream">
            <div
              className="h-full rounded"
              style={{ width: `${(c.n / max) * 100}%`, background: SERIES }}
              title={`${c.label}: ${c.n}`}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-sm tabular-nums text-ink-soft">{c.n}</span>
        </li>
      ))}
    </ul>
  );
}
