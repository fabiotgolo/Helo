"use client";

// ——— Dashboard Geral multi-paciente ———
// Organiza e resume os pacientes; nenhum conteúdo de comunicação aparece
// aqui — só atividade e status. Um paciente = um perfil = dados isolados:
// o card leva ao Dashboard Individual (/dashboard/[id]), que carrega
// exclusivamente os dados daquele patientId.
//
// Linguagem observacional por regra: contagens e datas, nunca leitura
// clínica ("piorando", "risco") — isso não existe nesta camada.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TopBar, PillLink } from "@/components/ui";
import { Avatar } from "@/components/dashboard-ui";
import { usePatient } from "@/lib/patient";
import { redirectToLogin, useAuthUser } from "@/lib/use-auth";
import { ROLES_THAT_CREATE_PATIENTS, ROLE_LABELS } from "@/lib/access-types";
import type { PatientSummary } from "@/lib/store";

type Filter = "todos" | "ativos" | "inativos" | "semVoz" | "incompletos";
type Sort = "atividade" | "nome" | "criacao";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "todos", label: "Todos" },
  { id: "ativos", label: "Ativos (7 dias)" },
  { id: "inativos", label: "Sem sessões (7 dias)" },
  { id: "semVoz", label: "Sem voz configurada" },
  { id: "incompletos", label: "Configuração incompleta" },
];

function relTime(iso: string | null): string {
  if (!iso) return "nenhuma atividade nos últimos 30 dias";
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "agora mesmo";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "ontem" : `há ${d} dias`;
}

export default function DashboardGeralPage() {
  const router = useRouter();
  const { addPatient } = usePatient();
  const { user } = useAuthUser();
  const canCreate = !user || ROLES_THAT_CREATE_PATIENTS.includes(user.role);
  const [summaries, setSummaries] = useState<PatientSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("todos");
  const [sort, setSort] = useState<Sort>("atividade");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const r = await fetch("/api/patients/summary");
      if (r.status === 401) {
        redirectToLogin();
        return;
      }
      if (!r.ok) throw new Error();
      const d = (await r.json()) as { summaries: PatientSummary[] };
      setSummaries(d.summaries);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    // Aba antiga não pode mostrar pacientes já excluídos: ao voltar o foco
    // para a janela (ou a aba ficar visível), a lista é recarregada.
    // Dedupe de 5s: trocas rápidas de foco não viram rajada de requisições.
    let lastLoad = Date.now();
    const reload = () => {
      if (Date.now() - lastLoad < 5000) return;
      lastLoad = Date.now();
      void load();
    };
    const onFocus = reload;
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const shown = useMemo(() => {
    if (!summaries) return [];
    const q = query.trim().toLowerCase();
    return summaries
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .filter((s) => {
        switch (filter) {
          case "ativos":
            return s.sessions7d > 0;
          case "inativos":
            return s.sessions7d === 0;
          case "semVoz":
            return !s.voiceConfigured;
          case "incompletos":
            return s.profileCompletion < 1;
          default:
            return true;
        }
      })
      .sort((a, b) => {
        switch (sort) {
          case "nome":
            return a.name.localeCompare(b.name, "pt-BR");
          case "criacao":
            return b.createdAt.localeCompare(a.createdAt);
          default:
            return (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "");
        }
      });
  }, [summaries, query, filter, sort]);

  const create = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(false);
    // addPatient (contexto de pacientes) já cria o perfil completo no
    // servidor: id único, settings e conteúdo padrão de Rotina, Emergência
    // e Conversa — o Dashboard Individual nasce automaticamente daí.
    const created = await addPatient(name);
    setCreating(false);
    if (created) {
      setNewName("");
      router.push(`/dashboard/${created.id}`);
    } else {
      setCreateError(true);
    }
  }, [newName, addPatient, router]);

  return (
    <div className="flex min-h-dvh flex-col pb-24 sm:pb-0">
      <TopBar
        right={
          <>
            <PillLink href="/ajustes">Ajustes</PillLink>
            <PillLink href="/">Início</PillLink>
          </>
        }
      />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 pl-14 sm:px-6 sm:pl-20 xl:pl-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-medium tracking-tight">Pacientes</h1>
            <p className="mt-1 text-ink-soft">
              {user
                ? `${user.name} · ${ROLE_LABELS[user.role]} — você vê os pacientes vinculados a você.`
                : "Cada paciente tem sua própria Helo. Toque em um card para abrir o acompanhamento individual."}
            </p>
          </div>
        </div>

        {/* ——— Novo paciente (admin, profissional, cuidador, familiar) ——— */}
        {canCreate && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          className="flex flex-col gap-2 sm:flex-row"
          aria-label="Cadastrar novo paciente"
        >
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Nome do novo paciente"
            className="min-h-12 flex-1 rounded-2xl border border-line bg-card px-5 py-3 outline-none focus:border-ink-mute"
          />
          <button
            type="submit"
            disabled={creating || !newName.trim()}
            className="min-h-12 rounded-full bg-accent px-6 py-3 font-medium text-on-accent hover:bg-accent-strong disabled:opacity-40"
          >
            {creating ? "Criando…" : "+ Novo paciente"}
          </button>
        </form>
        )}
        {createError && (
          <p role="alert" className="rounded-2xl bg-nao-soft px-4 py-3 text-sm text-nao">
            Não foi possível criar o paciente. Verifique a conexão e tente de novo.
          </p>
        )}

        {/* ——— Busca, filtros e ordenação ——— */}
        <div className="flex flex-col gap-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar paciente por nome…"
            aria-label="Buscar paciente por nome"
            className="min-h-12 w-full rounded-2xl border border-line bg-card px-5 py-3 outline-none focus:border-ink-mute"
          />
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Filtrar pacientes" className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                  className={`min-h-10 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                    filter === f.id
                      ? "bg-accent text-on-accent"
                      : "border border-line bg-card text-ink-soft hover:border-ink-mute"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <label className="ml-auto flex items-center gap-2 text-sm text-ink-soft">
              Ordenar por
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                className="min-h-10 rounded-full border border-line bg-card px-3 py-2 text-sm outline-none focus:border-ink-mute"
              >
                <option value="atividade">Última atividade</option>
                <option value="nome">Nome</option>
                <option value="criacao">Data de criação</option>
              </select>
            </label>
          </div>
        </div>

        {/* ——— Lista ——— */}
        {error ? (
          <div role="alert" className="rounded-3xl border border-line bg-card p-10 text-center">
            <p className="text-lg">Não foi possível carregar os pacientes.</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-4 rounded-full bg-accent px-6 py-3 font-medium text-on-accent hover:bg-accent-strong"
            >
              Tentar de novo
            </button>
          </div>
        ) : summaries === null ? (
          <p className="py-16 text-center text-ink-soft">Carregando pacientes…</p>
        ) : summaries.length === 0 ? (
          <div className="rounded-3xl border border-line bg-card p-10 text-center">
            <p className="text-lg">
              {user && user.role !== "admin"
                ? "Você ainda não possui pacientes vinculados."
                : "Nenhum paciente cadastrado ainda."}
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              {canCreate
                ? "Cadastre um paciente acima — a Helo cria o perfil, as frases padrão e o acompanhamento individual automaticamente."
                : "Peça ao administrador para vincular você a um paciente."}
            </p>
          </div>
        ) : shown.length === 0 ? (
          <div className="rounded-3xl border border-line bg-card p-10 text-center">
            <p className="text-lg">Nenhum paciente corresponde à busca ou ao filtro.</p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setFilter("todos");
              }}
              className="mt-4 rounded-full border border-line bg-cream px-6 py-3 font-medium hover:border-ink-mute"
            >
              Limpar busca e filtros
            </button>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {shown.map((s) => (
              <li key={s.patientId}>
                <Link
                  href={`/dashboard/${s.patientId}`}
                  className="flex h-full flex-col gap-4 rounded-3xl border border-line bg-card p-5 transition-transform hover:scale-[1.01] hover:border-ink-mute focus-visible:border-accent"
                >
                  <div className="flex items-center gap-3">
                    <Avatar name={s.name} />
                    <div className="min-w-0">
                      <p className="truncate text-lg font-semibold tracking-tight">{s.name}</p>
                      <p className="text-sm text-ink-soft">{relTime(s.lastActivityAt)}</p>
                    </div>
                  </div>

                  <dl className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-2xl bg-cream px-2 py-2.5">
                      <dt className="text-xs text-ink-soft">Sessões · 7d</dt>
                      <dd className="text-lg font-semibold tabular-nums">{s.sessions7d}</dd>
                    </div>
                    <div className="rounded-2xl bg-cream px-2 py-2.5">
                      <dt className="text-xs text-ink-soft">Frases · 7d</dt>
                      <dd className="text-lg font-semibold tabular-nums">{s.approvedPhrases7d}</dd>
                    </div>
                    <div className="rounded-2xl bg-cream px-2 py-2.5">
                      <dt className="text-xs text-ink-soft">Emergências · 7d</dt>
                      <dd className="text-lg font-semibold tabular-nums">{s.emergencies7d}</dd>
                    </div>
                  </dl>

                  <div className="mt-auto flex flex-wrap gap-1.5 text-xs">
                    <span
                      className={`rounded-full px-2.5 py-1 font-medium ${
                        s.voiceConfigured ? "bg-sim-soft text-sim" : "bg-cream text-ink-soft"
                      }`}
                    >
                      {s.voiceConfigured ? "✓ voz do paciente configurada" : "voz do paciente não configurada"}
                    </span>
                    {s.profileCompletion < 1 && (
                      <span className="rounded-full bg-talvez-soft px-2.5 py-1 font-medium text-talvez">
                        perfil {Math.round(s.profileCompletion * 100)}% preenchido
                      </span>
                    )}
                    {s.reformulations7d > 0 && (
                      <span className="rounded-full bg-cream px-2.5 py-1 text-ink-soft">
                        {s.reformulations7d} reformulações · 7d
                      </span>
                    )}
                    {s.pauses7d > 0 && (
                      <span className="rounded-full bg-cream px-2.5 py-1 text-ink-soft">
                        {s.pauses7d} pausas · 7d
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <p className="text-center text-xs text-ink-mute">
          Estas informações são observacionais e não constituem diagnóstico médico.
        </p>
      </main>
    </div>
  );
}
