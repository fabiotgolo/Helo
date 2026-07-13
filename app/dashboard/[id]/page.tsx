"use client";

// ——— Dashboard Individual: os dados de UM paciente, e de mais nenhum ———
// O patientId vem da ROTA — todo fetch desta página o carrega explicitamente,
// e respostas que chegarem depois de uma troca de paciente são descartadas
// (o efeito compara o id vigente antes de aplicar). Nada aqui lê estado
// global de conteúdo: trocar de rota troca o contexto inteiro.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { TopBar, PillLink } from "@/components/ui";
import {
  Avatar,
  Card,
  DailyBars,
  Empty,
  GestureBars,
  LabeledBars,
  Tile,
  fmtTs,
} from "@/components/dashboard-ui";
import { ActivitySection } from "@/components/activity-dashboard";
import { usePatient } from "@/lib/patient";
import { redirectToLogin } from "@/lib/use-auth";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import { GESTURES, type Gesture, type ModeItem, type Patient } from "@/lib/types";
import type { SessionSummary } from "@/lib/store";

type Stats = {
  period: string;
  patientId: number;
  geradoEm: string;
  totals: {
    mensagensConfirmadas: number;
    mensagensDescartadas: number;
    gestos: number;
    gestosIncertos: number;
    pausas: number;
    reformulacoes: number;
    emergencias: number;
    sessoes: number;
    tempoMedioRespostaMs: number | null;
  };
  gestosPorTipo: { gesture: Gesture; n: number }[];
  porDia: { dia: string; gestos: number; mensagens: number }[];
  porCategoria: { category: string; n: number }[];
  porHora: { hora: string; n: number }[];
  relatosDor: { ts: string; text: string }[];
  rotinaMaisUsadas: { text: string; n: number }[];
  emergenciasRecentes: { ts: string; text: string }[];
  mensagens: {
    id: string;
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
  { id: "mes", label: "30 dias" },
  { id: "ano", label: "Ano" },
  { id: "vitalicio", label: "Vitalício" },
] as const;

const MODE_LABEL: Record<string, string> = {
  conversa: "Conversa",
  rotina: "Rotina",
  emergencia: "Emergência",
};

export default function DashboardIndividualPage() {
  const params = useParams<{ id: string }>();
  const patientId = Number(params.id);
  const router = useRouter();
  const { patients, loading: patientsLoading, selectPatient, reloadPatients } = usePatient();

  const [period, setPeriod] = useState<(typeof PERIODS)[number]["id"]>("semana");
  const [stats, setStats] = useState<Stats | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [itemsRotina, setItemsRotina] = useState<ModeItem[] | null>(null);
  const [itemsEmergencia, setItemsEmergencia] = useState<ModeItem[] | null>(null);
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [platformVoiceOk, setPlatformVoiceOk] = useState<boolean | null>(null);
  // Estado da voz do paciente vindo de /api/voices (status apenas — o
  // voiceId técnico nunca chega ao cliente).
  const [patientVoice, setPatientVoice] = useState<{
    hasClone: boolean;
    source: "clone" | "platform";
  } | null>(null);
  const [error, setError] = useState(false);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);

  const patient: Patient | undefined = patients.find((p) => p.id === patientId);
  const invalidId = !patientId || Number.isNaN(patientId);

  // A lista do provider pode estar defasada em relação ao card clicado
  // (ex.: o Admin acabou de criar o paciente/vínculo em outra janela).
  // Antes de concluir "não encontrado", recarrega a lista UMA vez; o
  // veredito só vale depois dessa busca fresca.
  const [patientsRefetched, setPatientsRefetched] = useState(false);
  useEffect(() => {
    setPatientsRefetched(false);
  }, [patientId]);
  useEffect(() => {
    if (invalidId || patientsLoading || patient || patientsRefetched) return;
    void reloadPatients().finally(() => setPatientsRefetched(true));
  }, [invalidId, patientsLoading, patient, patientsRefetched, reloadPatients]);

  // Carga isolada por paciente: tudo parametrizado pelo id da rota. Se o id
  // mudar (troca rápida), o cleanup marca as respostas antigas como
  // descartáveis — dados do paciente anterior nunca "vazam" para o novo.
  const load = useCallback(
    async (isStale: () => boolean) => {
      setLoading(true);
      setError(false);
      try {
        const [statsR, sessR, rotR, emgR, setR, voicesR] = await Promise.all([
          fetch(`/api/stats?period=${period}&patientId=${patientId}`),
          fetch(`/api/sessions?patientId=${patientId}&limit=20`),
          fetch(`/api/items?patientId=${patientId}&mode=rotina`),
          fetch(`/api/items?patientId=${patientId}&mode=emergencia`),
          fetch(`/api/settings?patientId=${patientId}`),
          fetch(`/api/voices?patientId=${patientId}`),
        ]);
        if (isStale()) return;
        if (statsR.status === 401) {
          redirectToLogin();
          return;
        }
        if (statsR.status === 403) {
          // Sem vínculo/permissão: negação REAL vinda do servidor — nenhum
          // dado deste paciente chegou ao cliente.
          setDenied(true);
          return;
        }
        if (!statsR.ok) throw new Error("stats");
        setStats((await statsR.json()) as Stats);
        setSessions(sessR.ok ? ((await sessR.json()) as { sessions: SessionSummary[] }).sessions : []);
        setItemsRotina(rotR.ok ? ((await rotR.json()) as { items: ModeItem[] }).items : []);
        setItemsEmergencia(emgR.ok ? ((await emgR.json()) as { items: ModeItem[] }).items : []);
        setSettings(setR.ok ? ((await setR.json()) as Record<string, string>) : {});
        if (voicesR.ok) {
          const v = (await voicesR.json()) as {
            platformVoiceReady: boolean;
            patient?: { hasClone: boolean; source: "clone" | "platform" };
          };
          setPlatformVoiceOk(v.platformVoiceReady);
          setPatientVoice(v.patient ?? null);
        } else {
          setPlatformVoiceOk(false);
          setPatientVoice(null);
        }
        if (isStale()) return;
      } catch {
        if (!isStale()) setError(true);
      } finally {
        if (!isStale()) setLoading(false);
      }
    },
    [patientId, period]
  );

  useEffect(() => {
    if (invalidId) return;
    let stale = false;
    // Limpa o conteúdo do paciente anterior ANTES de buscar o novo — nunca
    // exibir dados residuais de outro paciente durante o carregamento.
    setStats(null);
    setSessions(null);
    setItemsRotina(null);
    setItemsEmergencia(null);
    setSettings(null);
    setPatientVoice(null);
    setDenied(false);
    void load(() => stale);
    return () => {
      stale = true;
    };
  }, [invalidId, load]);

  const openSettings = useCallback(() => {
    // Ajustes opera sobre o paciente ATIVO: alinhar o ativo ao paciente
    // deste dashboard antes de navegar.
    selectPatient(patientId);
    router.push("/ajustes");
  }, [selectPatient, patientId, router]);

  const useHeloWith = useCallback(() => {
    selectPatient(patientId);
    router.push("/");
  }, [selectPatient, patientId, router]);

  const t = stats?.totals;
  const voiceConfigured = Boolean(patientVoice?.hasClone);
  const gestureEmojis = useMemo(
    () => ({
      sim: settings?.[PATIENT_SETTING_KEYS.gestureSim]?.trim() || GESTURES.sim.emoji,
      talvez: settings?.[PATIENT_SETTING_KEYS.gestureTalvez]?.trim() || GESTURES.talvez.emoji,
      nao: settings?.[PATIENT_SETTING_KEYS.gestureNao]?.trim() || GESTURES.nao.emoji,
    }),
    [settings]
  );
  const gesturesCustomized = Boolean(
    settings?.[PATIENT_SETTING_KEYS.gestureSim]?.trim() ||
      settings?.[PATIENT_SETTING_KEYS.gestureTalvez]?.trim() ||
      settings?.[PATIENT_SETTING_KEYS.gestureNao]?.trim()
  );
  const periodLabel = PERIODS.find((p) => p.id === period)?.label ?? "";

  // ——— Acesso negado (sem vínculo ou sem permissão) ———
  if (denied) {
    return (
      <div className="flex min-h-dvh flex-col">
        <TopBar right={<PillLink href="/dashboard">← Pacientes</PillLink>} />
        <main role="alert" className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-2xl font-medium">Acesso negado.</p>
          <p className="text-ink-soft">
            Você não possui vínculo ativo com este paciente ou não tem a
            permissão necessária. Fale com o administrador.
          </p>
          <Link
            href="/dashboard"
            className="rounded-full bg-ink px-6 py-3 font-medium text-white hover:bg-black"
          >
            Voltar aos meus pacientes
          </Link>
        </main>
      </div>
    );
  }

  // ——— Estados de rota inválida / paciente inexistente ———
  // "Não encontrado" só depois de uma busca FRESCA da lista confirmar.
  if (invalidId || (!patientsLoading && !patient && patientsRefetched)) {
    return (
      <div className="flex min-h-dvh flex-col">
        <TopBar right={<PillLink href="/dashboard">← Pacientes</PillLink>} />
        <main role="alert" className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-2xl font-medium">Paciente não encontrado.</p>
          <p className="text-ink-soft">
            {invalidId
              ? "O endereço aberto não corresponde a um paciente válido."
              : "Este paciente não existe ou não está mais ativo."}
          </p>
          <Link
            href="/dashboard"
            className="rounded-full bg-ink px-6 py-3 font-medium text-white hover:bg-black"
          >
            Voltar aos pacientes
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        right={
          <>
            <PillLink href="/dashboard">← Pacientes</PillLink>
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

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-6 sm:px-6">
        {/* Cabeçalho do relatório impresso */}
        <div className="hidden print:block">
          <h1 className="text-2xl font-semibold">
            Helo — Relatório observacional · {patient?.name ?? `Paciente ${patientId}`}
          </h1>
          <p className="text-sm text-ink-soft">
            Período: {periodLabel} · Gerado em {new Date().toLocaleString("pt-BR")}
          </p>
          <p className="mt-1 text-xs text-ink-mute">
            Este relatório é observacional e não constitui diagnóstico médico.
          </p>
        </div>

        {/* ——— Cabeçalho ——— */}
        <div className="no-print flex flex-wrap items-center gap-4">
          <Avatar name={patient?.name ?? "?"} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-3xl font-medium tracking-tight">
              {patient?.name ?? "Carregando…"}
            </h1>
            <p className="text-ink-soft">
              Acompanhamento individual · observacional, não é diagnóstico médico.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={useHeloWith}
              className="min-h-11 rounded-full border border-line bg-card px-5 py-2.5 text-sm font-medium hover:border-ink-mute"
            >
              Usar a Helo com {patient?.name?.split(" ")[0] ?? "este paciente"}
            </button>
            <button
              type="button"
              onClick={openSettings}
              className="min-h-11 rounded-full border border-line bg-card px-5 py-2.5 text-sm font-medium hover:border-ink-mute"
            >
              ⚙ Ajustes do paciente
            </button>
          </div>
        </div>

        {/* ——— Período ——— */}
        <div
          role="tablist"
          aria-label="Período"
          className="no-print flex w-fit max-w-full gap-1 overflow-x-auto rounded-full border border-line bg-card p-1"
        >
          {PERIODS.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={period === p.id}
              type="button"
              onClick={() => setPeriod(p.id)}
              className={`min-h-10 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                period === p.id ? "bg-ink text-white" : "text-ink-soft hover:text-ink"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {error ? (
          <div role="alert" className="rounded-3xl border border-line bg-card p-10 text-center">
            <p className="text-lg">Não foi possível carregar os dados deste paciente.</p>
            <button
              type="button"
              onClick={() => {
                let stale = false;
                void load(() => stale);
              }}
              className="mt-4 rounded-full bg-ink px-6 py-3 font-medium text-white hover:bg-black"
            >
              Tentar de novo
            </button>
          </div>
        ) : loading && !stats ? (
          <p className="py-20 text-center text-ink-soft">
            Carregando os dados de {patient?.name ?? "…"}…
          </p>
        ) : t ? (
          <>
            {/* ——— Resumo de comunicação ——— */}
            <section
              aria-label="Resumo de comunicação"
              className="print-block grid grid-cols-2 gap-4 sm:grid-cols-4"
            >
              <Tile label="Frases aprovadas" value={t.mensagensConfirmadas} />
              <Tile label="Frases descartadas" value={t.mensagensDescartadas} />
              <Tile label="Reformulações" value={t.reformulacoes} />
              <Tile label="Pausas" value={t.pausas} />
              <Tile label="Gestos registrados" value={t.gestos} />
              <Tile
                label="Tempo médio de resposta"
                value={
                  t.tempoMedioRespostaMs != null
                    ? `${(t.tempoMedioRespostaMs / 1000).toFixed(1)}s`
                    : "—"
                }
              />
              <Tile label="Sessões" value={t.sessoes} />
              <Tile label="Emergências acionadas" value={t.emergencias} />
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card title="Atividade por dia" subtitle="gestos registrados">
                <DailyBars data={stats!.porDia} />
              </Card>

              <Card title="Respostas por gesto" subtitle="distribuição no período">
                <GestureBars data={stats!.gestosPorTipo} total={t.gestos} />
              </Card>

              <Card title="Mensagens por tema" subtitle="mensagens confirmadas">
                <LabeledBars
                  data={stats!.porCategoria.map((c) => ({ label: c.category, n: c.n }))}
                />
              </Card>

              <Card title="Relatos de dor" subtitle="quando e o quê">
                {stats!.relatosDor.length === 0 ? (
                  <Empty />
                ) : (
                  <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto text-sm">
                    {stats!.relatosDor.map((r, i) => (
                      <li
                        key={i}
                        className="flex items-baseline justify-between gap-4 border-b border-line pb-2"
                      >
                        <span>{r.text}</span>
                        <span className="shrink-0 text-ink-soft">{fmtTs(r.ts)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {/* ——— Resumo de Rotina ——— */}
              <Card
                title="Rotina"
                subtitle={
                  itemsRotina
                    ? `${itemsRotina.filter((i) => i.enabled).length} frases ativas · ${
                        itemsRotina.filter((i) => !i.isDefault).length
                      } personalizadas`
                    : undefined
                }
              >
                {itemsRotina && itemsRotina.filter((i) => !i.isDefault).length === 0 && (
                  <p className="mb-3 rounded-2xl bg-cream px-4 py-2.5 text-sm text-ink-soft">
                    Rotina ainda sem personalização — este paciente usa as frases padrão da Helo.
                  </p>
                )}
                <p className="mb-2 text-sm font-medium text-ink-soft">Mais usadas no período</p>
                <LabeledBars
                  data={stats!.rotinaMaisUsadas.map((r) => ({ label: r.text, n: r.n }))}
                  max={5}
                />
              </Card>

              {/* ——— Resumo de Emergência ——— */}
              <Card
                title="Emergência"
                subtitle={
                  itemsEmergencia
                    ? `${itemsEmergencia.filter((i) => i.enabled).length} ações configuradas · ${
                        itemsEmergencia.filter((i) => !i.isDefault).length
                      } personalizadas`
                    : undefined
                }
              >
                {itemsEmergencia && itemsEmergencia.filter((i) => !i.isDefault).length === 0 && (
                  <p className="mb-3 rounded-2xl bg-cream px-4 py-2.5 text-sm text-ink-soft">
                    Emergência sem personalização — valem as ações padrão da Helo.
                  </p>
                )}
                {stats!.emergenciasRecentes.length === 0 ? (
                  <Empty>Nenhuma emergência acionada no período.</Empty>
                ) : (
                  <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto text-sm">
                    {stats!.emergenciasRecentes.map((r, i) => (
                      <li
                        key={i}
                        className="flex items-baseline justify-between gap-4 border-b border-line pb-2"
                      >
                        <span>{r.text}</span>
                        <span className="shrink-0 text-ink-soft">{fmtTs(r.ts)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {/* ——— Resumo de gestos ——— */}
              <Card
                title="Gestos"
                subtitle={gesturesCustomized ? "gestos personalizados" : "gestos padrão da Helo"}
              >
                <ul className="flex flex-wrap gap-3 text-sm">
                  <li className="rounded-2xl bg-cream px-4 py-2.5">
                    {gestureEmojis.sim} confirmar
                  </li>
                  <li className="rounded-2xl bg-cream px-4 py-2.5">
                    {gestureEmojis.talvez} reformular
                  </li>
                  <li className="rounded-2xl bg-cream px-4 py-2.5">
                    {gestureEmojis.nao} rejeitar
                  </li>
                </ul>
                <p className="mt-3 text-sm text-ink-soft">
                  {t.gestos > 0
                    ? `${t.gestos} gestos registrados no período, ${t.gestosIncertos} incertos.`
                    : "Nenhum gesto registrado no período."}
                </p>
              </Card>

              {/* ——— Resumo de voz ——— */}
              <Card title="Voz" subtitle="status — nenhum identificador é exibido">
                <ul className="flex flex-col gap-2 text-sm">
                  <li className="flex items-center justify-between gap-4 rounded-2xl bg-cream px-4 py-3">
                    <span>Voz da plataforma Helo (ElevenLabs)</span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        platformVoiceOk
                          ? "bg-sim-soft text-sim"
                          : "bg-talvez-soft text-talvez"
                      }`}
                    >
                      {platformVoiceOk == null
                        ? "verificando…"
                        : platformVoiceOk
                          ? "ativa"
                          : "indisponível — fallback aprovado em uso"}
                    </span>
                  </li>
                  <li className="flex items-center justify-between gap-4 rounded-2xl bg-cream px-4 py-3">
                    <span>Voz do paciente (clonada/personalizada)</span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        voiceConfigured ? "bg-sim-soft text-sim" : "bg-cream text-ink-soft"
                      }`}
                    >
                      {voiceConfigured ? "configurada" : "não configurada"}
                    </span>
                  </li>
                </ul>
                {!voiceConfigured && (
                  <p className="mt-3 text-sm text-ink-soft">
                    Sem voz clonada, as falas do paciente usam uma voz aprovada
                    do catálogo da plataforma, claramente identificada. A
                    atribuição do clone é feita pelo administrador.
                  </p>
                )}
              </Card>
            </div>

            {/* ——— Sessões recentes ——— */}
            <Card
              title="Sessões recentes"
              subtitle={sessions ? `${sessions.length} sessões (últimos 90 dias)` : undefined}
            >
              {!sessions || sessions.length === 0 ? (
                <Empty>Nenhuma sessão registrada ainda para este paciente.</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-ink-soft">
                        <th className="py-2 pr-4 font-medium">Início</th>
                        <th className="py-2 pr-4 font-medium">Duração</th>
                        <th className="py-2 pr-4 font-medium">Modo</th>
                        <th className="py-2 pr-4 font-medium">Operador</th>
                        <th className="py-2 pr-4 font-medium">Apresentadas</th>
                        <th className="py-2 pr-4 font-medium">Confirmadas</th>
                        <th className="py-2 pr-4 font-medium">Reformulações</th>
                        <th className="py-2 font-medium">Emergências</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((s) => (
                        <tr key={s.id} className="border-b border-line/60">
                          <td className="whitespace-nowrap py-2.5 pr-4 text-ink-soft">
                            {fmtTs(s.startedAt)}
                          </td>
                          <td className="py-2.5 pr-4 tabular-nums">
                            {s.durationMin != null ? `${s.durationMin} min` : "—"}
                          </td>
                          <td className="py-2.5 pr-4">{MODE_LABEL[s.mode] ?? s.mode}</td>
                          <td className="py-2.5 pr-4 text-ink-soft">{s.operator ?? "—"}</td>
                          <td className="py-2.5 pr-4 tabular-nums">{s.phrasesShown}</td>
                          <td className="py-2.5 pr-4 tabular-nums">{s.confirmed}</td>
                          <td className="py-2.5 pr-4 tabular-nums">{s.reformulations}</td>
                          <td className="py-2.5 tabular-nums">{s.emergencies}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* ——— Histórico de mensagens ——— */}
            <Card
              title="Histórico de mensagens"
              subtitle={`${stats!.mensagens.length} registros no período`}
            >
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
                          <td className="whitespace-nowrap py-2.5 pr-4 text-ink-soft">
                            {fmtTs(m.ts)}
                          </td>
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

            {/* ——— Atividades e sessões personalizadas ——— */}
            <ActivitySection patientId={patientId} period={period} />

            <p className="text-center text-xs text-ink-mute">
              Estas informações são observacionais e não constituem diagnóstico médico.
            </p>
          </>
        ) : (
          <p className="py-20 text-center text-ink-soft">Não foi possível carregar os dados.</p>
        )}
      </main>
    </div>
  );
}
