"use client";

import { useCallback, useEffect, useState } from "react";
import { TopBar, PillLink } from "@/components/ui";
import { GESTURES, type Gesture } from "@/lib/types";

type Stats = {
  period: string;
  geradoEm: string;
  totals: {
    mensagensConfirmadas: number;
    mensagensDescartadas: number;
    gestos: number;
    gestosIncertos: number;
    pausas: number;
    reformulacoes: number;
    sessoes: number;
    tempoMedioRespostaMs: number | null;
  };
  gestosPorTipo: { gesture: Gesture; n: number }[];
  porDia: { dia: string; gestos: number; mensagens: number }[];
  porCategoria: { category: string; n: number }[];
  porHora: { hora: string; n: number }[];
  relatosDor: { ts: string; text: string }[];
  mensagens: {
    id: number;
    ts: string;
    text: string;
    category: string | null;
    sensitive: number;
    status: string;
  }[];
};

const PERIODS = [
  { id: "hoje", label: "Hoje" },
  { id: "semana", label: "7 dias" },
  { id: "mes", label: "Mês" },
  { id: "ano", label: "Ano" },
  { id: "vitalicio", label: "Vitalício" },
] as const;

const SERIES = "#7f78ce"; // série única — validada contra a superfície clara

const GESTURE_COLORS: Record<Gesture, string> = {
  sim: "#2f9e6e",
  talvez: "#b9822f",
  nao: "#c25b4e",
};

function fmtDia(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

function fmtTs(ts: string): string {
  return ts.slice(0, 16).replace("T", " ");
}

export default function DashboardPage() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["id"]>("semana");
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/stats?period=${p}`);
      setStats((await res.json()) as Stats);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(period);
  }, [period, load]);

  const t = stats?.totals;
  const periodLabel = PERIODS.find((p) => p.id === period)?.label ?? "";

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        right={
          <>
            <PillLink href="/conversa">Conversa</PillLink>
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white hover:bg-black"
            >
              Gerar PDF
            </button>
          </>
        }
      />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-6">
        {/* Cabeçalho do relatório impresso */}
        <div className="hidden print:block">
          <h1 className="text-2xl font-semibold">Helo — Relatório observacional</h1>
          <p className="text-sm text-ink-soft">
            Período: {periodLabel} · Gerado em {new Date().toLocaleString("pt-BR")}
          </p>
          <p className="mt-1 text-xs text-ink-mute">
            Este relatório é observacional e não constitui diagnóstico médico.
          </p>
        </div>

        <div className="no-print flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-medium tracking-tight">Relatórios</h1>
            <p className="mt-1 text-ink-soft">
              Observações de uso para família e equipe de cuidado. Não é diagnóstico médico.
            </p>
          </div>
          <div role="tablist" aria-label="Período" className="flex gap-1 rounded-full border border-line bg-card p-1">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={period === p.id}
                type="button"
                onClick={() => setPeriod(p.id)}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  period === p.id ? "bg-ink text-white" : "text-ink-soft hover:text-ink"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {loading && !stats ? (
          <p className="py-20 text-center text-ink-soft">Carregando…</p>
        ) : t ? (
          <>
            <section aria-label="Resumo" className="print-block grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <Tile label="Mensagens confirmadas" value={t.mensagensConfirmadas} />
              <Tile label="Gestos registrados" value={t.gestos} />
              <Tile
                label="Tempo médio de resposta"
                value={
                  t.tempoMedioRespostaMs != null
                    ? `${(t.tempoMedioRespostaMs / 1000).toFixed(1)}s`
                    : "—"
                }
              />
              <Tile label="Gestos incertos" value={t.gestosIncertos} />
              <Tile label="Reformulações" value={t.reformulacoes} />
              <Tile label="Pausas" value={t.pausas} />
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card title="Atividade por dia" subtitle="gestos registrados">
                <DailyBars data={stats!.porDia} />
              </Card>

              <Card title="Respostas por gesto" subtitle="distribuição no período">
                <GestureBars data={stats!.gestosPorTipo} total={t.gestos} />
              </Card>

              <Card title="Mensagens por tema" subtitle="mensagens confirmadas">
                <CategoryBars data={stats!.porCategoria} />
              </Card>

              <Card title="Relatos de dor" subtitle="quando e o quê">
                {stats!.relatosDor.length === 0 ? (
                  <Empty />
                ) : (
                  <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto text-sm">
                    {stats!.relatosDor.map((r, i) => (
                      <li key={i} className="flex items-baseline justify-between gap-4 border-b border-line pb-2">
                        <span>{r.text}</span>
                        <span className="shrink-0 text-ink-soft">{fmtTs(r.ts)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <Card title="Histórico de mensagens" subtitle={`${stats!.mensagens.length} registros no período`}>
              {stats!.mensagens.length === 0 ? (
                <Empty />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-ink-soft">
                        <th className="py-2 pr-4 font-medium">Quando</th>
                        <th className="py-2 pr-4 font-medium">Mensagem</th>
                        <th className="py-2 pr-4 font-medium">Tema</th>
                        <th className="py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats!.mensagens.map((m) => (
                        <tr key={m.id} className="border-b border-line/60">
                          <td className="py-2.5 pr-4 whitespace-nowrap text-ink-soft">{fmtTs(m.ts)}</td>
                          <td className="py-2.5 pr-4">
                            {m.text}
                            {m.sensitive === 1 && (
                              <span className="ml-2 rounded-full bg-talvez-soft px-2 py-0.5 text-xs text-talvez">
                                sensível · 2 confirmações
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 pr-4 text-ink-soft">{m.category ?? "—"}</td>
                          <td className="py-2.5">
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                m.status === "confirmada"
                                  ? "bg-sim-soft text-sim"
                                  : "bg-nao-soft text-nao"
                              }`}
                            >
                              {m.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        ) : (
          <p className="py-20 text-center text-ink-soft">Não foi possível carregar os dados.</p>
        )}
      </main>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="print-block rounded-3xl border border-line bg-card p-5">
      <p className="text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
      <p className="mt-1 text-sm text-ink-soft">{label}</p>
    </div>
  );
}

function Card({
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

function Empty() {
  return <p className="py-8 text-center text-sm text-ink-mute">Sem registros no período.</p>;
}

/** Barras verticais por dia — série única, rótulo direto no maior valor, tooltip nativo. */
function DailyBars({ data }: { data: { dia: string; gestos: number }[] }) {
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
function GestureBars({ data, total }: { data: { gesture: Gesture; n: number }[]; total: number }) {
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
              {GESTURES[g].emoji} {GESTURES[g].label}
            </span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-cream">
              <div
                className="h-full rounded"
                style={{ width: `${(n / max) * 100}%`, background: GESTURE_COLORS[g] }}
                title={`${GESTURES[g].label}: ${n} (${pct}%)`}
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

/** Barras horizontais por tema — série única com rótulos visíveis. */
function CategoryBars({ data }: { data: { category: string; n: number }[] }) {
  if (data.length === 0) return <Empty />;
  const max = Math.max(...data.map((d) => d.n), 1);
  return (
    <ul className="flex flex-col gap-3">
      {data.slice(0, 8).map((c) => (
        <li key={c.category} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-sm capitalize">{c.category}</span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-cream">
            <div
              className="h-full rounded"
              style={{ width: `${(c.n / max) * 100}%`, background: SERIES }}
              title={`${c.category}: ${c.n}`}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-sm tabular-nums text-ink-soft">{c.n}</span>
        </li>
      ))}
    </ul>
  );
}
