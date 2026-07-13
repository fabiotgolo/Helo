"use client";

// ——— Seção "Atividades e sessões personalizadas" do Dashboard Individual ———
// Mesmo contrato da página: patientId vem de fora, todo fetch o carrega, e
// respostas atrasadas de um paciente anterior são descartadas. A permissão
// é própria (viewActivityResults) — 403 aqui não derruba o resto da página.
//
// Linguagem observacional por regra do produto: desempenho, respostas,
// tempo — nunca "nível de cognição", nunca diagnóstico.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Gesture } from "@/lib/types";
import { Card, Empty, GestureBars, Tile, fmtDia, fmtTs, SERIES } from "@/components/dashboard-ui";
import {
  ACTIVITY_CATEGORY_LABELS,
  CORRECTNESS_LABELS,
  RUN_STATUS_LABELS,
  type ActivityCategory,
  type ActivityRunStatus,
  type Correctness,
} from "@/lib/activity-types";

type RunSummary = {
  id: string;
  templateId: string;
  templateTitle: string;
  templateVersion: number;
  category: ActivityCategory;
  operatorId: string | null;
  operatorName: string | null;
  startedAt: string;
  durationMin: number | null;
  status: ActivityRunStatus;
  respostas: number;
  corretas: number;
  incorretas: number;
  incertas: number;
  naoRespondidas: number;
  gestos: Record<Gesture, number>;
  tempoMedioMs: number | null;
};

type Payload = {
  runs: RunSummary[];
  stats: {
    totals: {
      sessoes: number;
      concluidas: number;
      abandonadas: number;
      emAndamento: number;
      respostas: number;
      comCriterio: number;
      corretas: number;
      incorretas: number;
      incertas: number;
      naoRespondidas: number;
      tempoMedioMs: number | null;
      duracaoMediaMin: number | null;
      gestos: Record<Gesture, number>;
    };
    porDia: { dia: string; respostas: number; corretas: number; comCriterio: number; sessoes: number }[];
    porHora: { hora: string; respostas: number; corretas: number; comCriterio: number; tempoTotalMs: number; tempoN: number }[];
    porCategoria: { category: ActivityCategory; sessoes: number }[];
    porTemplate: { templateId: string; titulo: string; sessoes: number }[];
    porOperador: { operatorId: string; nome: string; sessoes: number }[];
  };
  availableTemplates: { id: string; title: string; category: ActivityCategory }[];
};

type RunDetail = {
  run: {
    id: string;
    templateTitle: string;
    templateVersion: number;
    operatorName: string | null;
    startedAtLocal: string;
    status: ActivityRunStatus;
  };
  items: {
    itemId: string;
    title: string;
    question: string;
    options: { id: string; label: string }[];
    correctOptionId: string | null;
    hasMedia: boolean;
    response: {
      optionGestures: { optionId: string; gesture: Gesture }[];
      selectedOptionId: string | null;
      selectedOptionLabel: string | null;
      correctness: Correctness | null;
      responseTimeMs: number | null;
      ts: string;
      revision: number;
    } | null;
  }[];
};

const GESTURE_EMOJI: Record<Gesture, string> = { sim: "👍", talvez: "✋", nao: "✊" };

function fmtMs(ms: number | null): string {
  return ms != null ? `${(ms / 1000).toFixed(1)}s` : "—";
}

export function ActivitySection({
  patientId,
  period,
}: {
  patientId: number;
  period: string;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [state, setState] = useState<"ok" | "carregando" | "negado" | "erro">("carregando");
  const [templateFilter, setTemplateFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [operatorFilter, setOperatorFilter] = useState("");
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailError, setDetailError] = useState(false);

  // Filtros zeram na troca de paciente — nada atravessa de um para outro.
  useEffect(() => {
    setTemplateFilter("");
    setCategoryFilter("");
    setOperatorFilter("");
    setOpenRun(null);
    setDetail(null);
  }, [patientId]);

  useEffect(() => {
    let stale = false;
    setState("carregando");
    const q = new URLSearchParams({ patientId: String(patientId), period });
    if (templateFilter) q.set("templateId", templateFilter);
    if (categoryFilter) q.set("category", categoryFilter);
    if (operatorFilter) q.set("operatorId", operatorFilter);
    void fetch(`/api/activities/runs?${q}`)
      .then(async (r) => {
        if (stale) return;
        if (r.status === 401 || r.status === 403) {
          setState("negado");
          return;
        }
        if (!r.ok) throw new Error();
        const d = (await r.json()) as Payload;
        if (stale) return;
        setData(d);
        setState("ok");
      })
      .catch(() => {
        if (!stale) setState("erro");
      });
    return () => {
      stale = true;
    };
  }, [patientId, period, templateFilter, categoryFilter, operatorFilter]);

  const toggleRun = useCallback(
    async (runId: string) => {
      if (openRun === runId) {
        setOpenRun(null);
        return;
      }
      setOpenRun(runId);
      setDetail(null);
      setDetailError(false);
      try {
        const r = await fetch(
          `/api/activities/runs?patientId=${patientId}&runId=${runId}`
        );
        if (!r.ok) throw new Error();
        setDetail((await r.json()) as RunDetail);
      } catch {
        setDetailError(true);
      }
    },
    [openRun, patientId]
  );

  if (state === "negado") {
    return (
      <Card title="Atividades e sessões personalizadas">
        <Empty>Sem permissão para ver os resultados das Atividades.</Empty>
      </Card>
    );
  }
  if (state === "erro") {
    return (
      <Card title="Atividades e sessões personalizadas">
        <Empty>Não foi possível carregar os resultados das Atividades.</Empty>
      </Card>
    );
  }
  if (state === "carregando" || !data) {
    return (
      <Card title="Atividades e sessões personalizadas">
        <p className="py-6 text-center text-sm text-ink-mute">Carregando…</p>
      </Card>
    );
  }

  const t = data.stats.totals;
  const noRuns = t.sessoes === 0;
  const hasCriterio = t.comCriterio > 0;
  const filtered = Boolean(templateFilter || categoryFilter || operatorFilter);

  return (
    <section aria-label="Atividades e sessões personalizadas" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Atividades e sessões personalizadas
          </h2>
          <p className="text-sm text-ink-soft">
            {data.availableTemplates.length}{" "}
            {data.availableTemplates.length === 1
              ? "sessão disponível"
              : "sessões disponíveis"}{" "}
            · {t.sessoes} {t.sessoes === 1 ? "realizada" : "realizadas"} no período
          </p>
        </div>
        <Link
          href="/atividades"
          className="no-print rounded-full border border-line bg-card px-4 py-2 text-sm font-medium hover:border-ink-mute"
        >
          Abrir Atividades →
        </Link>
      </div>

      {/* ——— Filtros ——— */}
      <div className="no-print flex flex-wrap gap-2 text-sm">
        <select
          aria-label="Filtrar por template"
          value={templateFilter}
          onChange={(e) => setTemplateFilter(e.target.value)}
          className="rounded-full border border-line bg-card px-4 py-2"
        >
          <option value="">Todos os templates</option>
          {data.availableTemplates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.title}
            </option>
          ))}
        </select>
        <select
          aria-label="Filtrar por categoria"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-full border border-line bg-card px-4 py-2"
        >
          <option value="">Todas as categorias</option>
          {Object.entries(ACTIVITY_CATEGORY_LABELS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filtrar por profissional"
          value={operatorFilter}
          onChange={(e) => setOperatorFilter(e.target.value)}
          className="rounded-full border border-line bg-card px-4 py-2"
        >
          <option value="">Todos os operadores</option>
          {data.stats.porOperador.map((op) => (
            <option key={op.operatorId} value={op.operatorId}>
              {op.nome}
            </option>
          ))}
        </select>
      </div>

      {noRuns ? (
        <Card title="Sessões">
          <Empty>
            {filtered
              ? "Nenhuma sessão encontrada com estes filtros."
              : "Ainda não existem sessões registradas."}
          </Empty>
        </Card>
      ) : (
        <>
          {/* ——— Totais — nada é inventado: só o que tem dado aparece ——— */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Tile label="Sessões realizadas" value={t.concluidas} />
            <Tile label="Sessões abandonadas" value={t.abandonadas} />
            <Tile label="Respostas registradas" value={t.respostas} />
            <Tile label="Tempo médio de resposta" value={fmtMs(t.tempoMedioMs)} />
            {hasCriterio && (
              <>
                <Tile label="Respostas corretas" value={t.corretas} />
                <Tile label="Respostas incorretas" value={t.incorretas} />
                <Tile label="Respostas incertas" value={t.incertas} />
                <Tile label="Não respondidas" value={t.naoRespondidas} />
              </>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {hasCriterio && (
              <Card
                title="Desempenho por dia"
                subtitle={`% de respostas corretas · ${t.comCriterio} respostas com critério no período`}
              >
                <PercentBars
                  data={data.stats.porDia
                    .filter((d) => d.comCriterio > 0)
                    .map((d) => ({
                      label: fmtDia(d.dia),
                      pct: Math.round((d.corretas / d.comCriterio) * 100),
                      n: d.comCriterio,
                    }))}
                  ariaLabel="Percentual de respostas corretas por dia"
                />
              </Card>
            )}

            <Card title="Respostas por horário" subtitle="quando as sessões acontecem">
              {data.stats.porHora.length === 0 ? (
                <Empty />
              ) : (
                <PercentBars
                  data={data.stats.porHora.map((h) => ({
                    label: `${h.hora}h`,
                    pct:
                      hasCriterio && h.comCriterio > 0
                        ? Math.round((h.corretas / h.comCriterio) * 100)
                        : null,
                    n: h.respostas,
                  }))}
                  ariaLabel="Respostas por horário"
                  mode="count"
                />
              )}
              {hasCriterio && bestWindow(data.stats.porHora) && (
                <p className="mt-3 text-sm text-ink-soft">
                  Nas sessões registradas, houve maior proporção de respostas
                  corretas por volta de {bestWindow(data.stats.porHora)} —
                  observação do período, não um diagnóstico.
                </p>
              )}
            </Card>

            <Card title="Distribuição de gestos" subtitle="nas Atividades do período">
              <GestureBars
                data={Object.entries(t.gestos).map(([gesture, n]) => ({
                  gesture: gesture as Gesture,
                  n,
                }))}
                total={t.gestos.sim + t.gestos.talvez + t.gestos.nao}
              />
            </Card>

            <Card title="Histórico por tipo de atividade" subtitle="sessões no período">
              <ul className="flex flex-col gap-3">
                {data.stats.porCategoria.map((c) => (
                  <li key={c.category} className="flex items-center gap-3 text-sm">
                    <span className="w-44 shrink-0 truncate">
                      {ACTIVITY_CATEGORY_LABELS[c.category]}
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-cream">
                      <div
                        className="h-full rounded"
                        style={{
                          width: `${(c.sessoes / Math.max(...data.stats.porCategoria.map((x) => x.sessoes), 1)) * 100}%`,
                          background: SERIES,
                        }}
                      />
                    </div>
                    <span className="w-8 shrink-0 text-right tabular-nums text-ink-soft">
                      {c.sessoes}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          {/* ——— Sessões (histórico detalhado sob demanda) ——— */}
          <Card
            title="Sessões de Atividades"
            subtitle={`${data.runs.length} no período · toque para abrir o detalhe`}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-ink-soft">
                    <th className="py-2 pr-4 font-medium">Início</th>
                    <th className="py-2 pr-4 font-medium">Atividade</th>
                    <th className="py-2 pr-4 font-medium">Operador</th>
                    <th className="py-2 pr-4 font-medium">Duração</th>
                    <th className="py-2 pr-4 font-medium">Respostas</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((r) => (
                    <RunRow
                      key={r.id}
                      run={r}
                      open={openRun === r.id}
                      detail={openRun === r.id ? detail : null}
                      detailError={openRun === r.id && detailError}
                      onToggle={() => void toggleRun(r.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <p className="text-center text-xs text-ink-mute">
        Estas informações são observacionais e não constituem diagnóstico médico.
      </p>
    </section>
  );
}

/** Janela de melhor proporção de corretas (só com amostra mínima). */
function bestWindow(
  porHora: { hora: string; corretas: number; comCriterio: number }[]
): string | null {
  const candidates = porHora.filter((h) => h.comCriterio >= 3);
  if (candidates.length < 2) return null;
  const best = [...candidates].sort(
    (a, b) => b.corretas / b.comCriterio - a.corretas / a.comCriterio
  )[0];
  return best ? `${best.hora}h` : null;
}

function RunRow({
  run,
  open,
  detail,
  detailError,
  onToggle,
}: {
  run: RunSummary;
  open: boolean;
  detail: RunDetail | null;
  detailError: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-line/60">
        <td className="whitespace-nowrap py-2.5 pr-4 text-ink-soft">{fmtTs(run.startedAt)}</td>
        <td className="py-2.5 pr-4">
          {run.templateTitle}{" "}
          <span className="text-xs text-ink-mute">v{run.templateVersion}</span>
        </td>
        <td className="py-2.5 pr-4 text-ink-soft">{run.operatorName ?? "—"}</td>
        <td className="py-2.5 pr-4 tabular-nums">
          {run.durationMin != null ? `${run.durationMin} min` : "—"}
        </td>
        <td className="py-2.5 pr-4 tabular-nums">
          {run.respostas}
          {run.corretas + run.incorretas + run.incertas > 0 && (
            <span className="text-xs text-ink-mute"> · {run.corretas} corretas</span>
          )}
        </td>
        <td className="py-2.5 pr-4">
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              run.status === "concluida"
                ? "bg-sim-soft text-sim"
                : run.status === "abandonada"
                  ? "bg-nao-soft text-nao"
                  : "bg-talvez-soft text-talvez"
            }`}
          >
            {RUN_STATUS_LABELS[run.status]}
          </span>
        </td>
        <td className="py-2.5 text-right">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="no-print rounded-full border border-line bg-card px-3 py-1 text-xs font-medium hover:border-ink-mute"
          >
            {open ? "Fechar" : "Detalhes"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line/60 bg-cream/50">
          <td colSpan={7} className="p-4">
            {detailError ? (
              <p className="text-sm text-nao">Não foi possível carregar o detalhe.</p>
            ) : !detail ? (
              <p className="text-sm text-ink-mute">Carregando o detalhe…</p>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-xs text-ink-mute">
                  Conteúdo exibido na época (versão {detail.run.templateVersion}) —
                  edições posteriores do template não alteram este histórico.
                </p>
                <ul className="flex flex-col gap-2">
                  {detail.items.map((it, i) => (
                    <li key={it.itemId} className="rounded-2xl bg-white p-3 text-sm">
                      <p className="font-medium">
                        {i + 1}. {it.question || it.title || "(conteúdo)"}
                        {it.hasMedia && <span className="ml-1 text-ink-mute">· com mídia</span>}
                      </p>
                      {it.options.length > 0 &&
                        (() => {
                          // Gesto registrado por alternativa (mapa para busca).
                          const byOption = new Map(
                            (it.response?.optionGestures ?? []).map((g) => [
                              g.optionId,
                              g.gesture,
                            ])
                          );
                          return (
                            <ul className="mt-1.5 flex flex-col gap-1">
                              {it.options.map((o) => {
                                const g = byOption.get(o.id);
                                return (
                                  <li
                                    key={o.id}
                                    className="flex items-center justify-between gap-3 text-ink-soft"
                                  >
                                    <span>
                                      {o.label}
                                      {o.id === it.correctOptionId && (
                                        <span className="ml-1 text-xs text-ink-mute">(correta)</span>
                                      )}
                                    </span>
                                    <span className="shrink-0 tabular-nums">
                                      {g ? `${GESTURE_EMOJI[g]} ${g}` : "—"}
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          );
                        })()}
                      {it.response ? (
                        <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-ink-soft">
                          {it.response.correctness && (
                            <span>Resultado: {CORRECTNESS_LABELS[it.response.correctness]}</span>
                          )}
                          <span>Tempo: {fmtMs(it.response.responseTimeMs)}</span>
                        </p>
                      ) : (
                        it.question && (
                          <p className="mt-1 text-ink-mute">Sem resposta registrada.</p>
                        )
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/** Barras verticais compactas — percentual (com n) ou contagem simples. */
function PercentBars({
  data,
  ariaLabel,
  mode = "percent",
}: {
  data: { label: string; pct: number | null; n: number }[];
  ariaLabel: string;
  mode?: "percent" | "count";
}) {
  if (data.length === 0) return <Empty />;
  const shown = data.slice(-24);
  const maxN = Math.max(...shown.map((d) => d.n), 1);
  return (
    <div className="flex h-44 items-end gap-1" role="img" aria-label={ariaLabel}>
      {shown.map((d) => {
        const value = mode === "percent" ? (d.pct ?? 0) : d.n;
        const height =
          mode === "percent"
            ? (value / 100) * 128
            : (value / maxN) * 128;
        const title =
          mode === "percent"
            ? `${d.label}: ${d.pct}% corretas (${d.n} respostas)`
            : `${d.label}: ${d.n} respostas${d.pct != null ? ` · ${d.pct}% corretas` : ""}`;
        return (
          <div key={d.label} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <span className="text-[10px] tabular-nums text-ink-soft">
              {mode === "percent" ? `${value}%` : value}
            </span>
            <div
              title={title}
              className="w-full max-w-8 rounded-t"
              style={{ background: SERIES, height: `${Math.max(height, 3)}px` }}
            />
            <span className="truncate text-[10px] text-ink-mute">{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}
