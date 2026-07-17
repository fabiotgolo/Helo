"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PillLink, TopBar } from "@/components/ui";
import { FeedbackConversation } from "@/components/feedback-conversation";
import { usePatient } from "@/lib/patient";
import { redirectToLogin, useAuthUser } from "@/lib/use-auth";
import {
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_TYPE_LABELS,
  type FeedbackRequest,
  type FeedbackType,
} from "@/lib/feedback-types";

type Tab = "requests" | "closed" | "new";
type Filter = "all" | FeedbackType;
type Sort = "recent" | "votes";

const input =
  "min-h-11 w-full rounded-2xl border border-line bg-card px-4 py-2.5 outline-none focus:border-ink-mute";
const action =
  "min-h-11 rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-on-accent hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40";
const secondary =
  "min-h-11 rounded-full border border-line bg-card px-5 py-2.5 text-sm font-medium hover:border-ink-mute disabled:opacity-40";

function relativeDate(iso: string): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
  if (days === 0) return "hoje";
  if (days === 1) return "ontem";
  return `há ${days} dias`;
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? "Não foi possível concluir a ação. Tente novamente.";
}

export default function FeedbackPage() {
  const { patient, patientId } = usePatient();
  const { user } = useAuthUser();
  const isAdmin = user?.role === "admin";
  const [tab, setTab] = useState<Tab>("requests");
  const [requests, setRequests] = useState<FeedbackRequest[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<FeedbackType>("feature");
  const [includePatient, setIncludePatient] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [votingId, setVotingId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/feedback");
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      if (!response.ok) throw new Error(await responseError(response));
      const data = (await response.json()) as { requests: FeedbackRequest[] };
      setRequests(data.requests);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar as solicitações.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const markConversationRead = useCallback((id: string) => {
    setRequests((current) =>
      current?.map((request) =>
        request.id === id ? { ...request, hasUnreadMessages: false, unreadMessagesCount: 0 } : request
      ) ?? null
    );
  }, []);

  const shown = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    return (requests ?? [])
      .filter((request) =>
        tab === "closed" ? request.conversationStatus === "resolved" :
          tab === "requests" ? request.conversationStatus === "open" : true
      )
      .filter((request) => filter === "all" || request.type === filter)
      .filter(
        (request) =>
          !normalized ||
          request.title.toLocaleLowerCase("pt-BR").includes(normalized) ||
          request.description.toLocaleLowerCase("pt-BR").includes(normalized)
      )
      .sort((a, b) =>
        sort === "votes"
          ? b.votesCount - a.votesCount || b.createdAt.localeCompare(a.createdAt)
          : b.createdAt.localeCompare(a.createdAt)
      );
  }, [filter, query, requests, sort, tab]);

  const submit = async () => {
    if (!title.trim() || !description.trim()) {
      setError("Preencha o título e a descrição antes de enviar.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const response = await fetch(editingId ? `/api/feedback/${editingId}` : "/api/feedback", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          ...(editingId
            ? {}
            : {
                type,
                patientId: includePatient ? patientId : null,
                route: window.location.pathname + window.location.search,
                viewport: { width: window.innerWidth, height: window.innerHeight },
              }),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setTitle("");
      setDescription("");
      setIncludePatient(false);
      setEditingId(null);
      setNotice(editingId ? "Solicitação atualizada com sucesso." : "Solicitação enviada com sucesso.");
      setTab("requests");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível enviar. Tente novamente.");
    } finally {
      setSending(false);
    }
  };

  const startNew = () => {
    setEditingId(null);
    setTitle("");
    setDescription("");
    setType("feature");
    setIncludePatient(false);
    setError(null);
    setTab("new");
  };

  const startEdit = (request: FeedbackRequest) => {
    setEditingId(request.id);
    setTitle(request.title);
    setDescription(request.description);
    setType(request.type);
    setIncludePatient(false);
    setError(null);
    setTab("new");
  };

  const remove = async (id: string) => {
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/feedback/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response));
      setConfirmingDeleteId(null);
      setNotice("Solicitação excluída.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível excluir a solicitação.");
    } finally {
      setSending(false);
    }
  };

  const vote = async (id: string) => {
    if (votingId) return;
    setVotingId(id);
    setError(null);
    try {
      const response = await fetch(`/api/feedback/${id}/vote`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response));
      const vote = (await response.json()) as { hasVoted: boolean; votesCount: number };
      setRequests((current) =>
        current?.map((request) =>
          request.id === id ? { ...request, ...vote } : request
        ) ?? null
      );
      setNotice(vote.hasVoted ? "Seu voto foi registrado." : "Seu voto foi removido.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível registrar o voto.");
    } finally {
      setVotingId(null);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col pb-24 sm:pb-0">
      <TopBar
        showFeedback={false}
        right={
          <>
            <PillLink href="/dashboard">Pacientes</PillLink>
            <PillLink href="/">Conversar</PillLink>
          </>
        }
      />

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 pl-14 sm:px-6 sm:pl-20 xl:pl-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-medium tracking-tight">Feedback e suporte</h1>
            <p className="mt-1 text-ink-soft">
              Sugira melhorias, reporte problemas e acompanhe o que foi enviado.
            </p>
          </div>
          <button type="button" className={action} onClick={startNew}>
            Nova solicitação
          </button>
        </div>

        <div role="tablist" aria-label="Feedback e suporte" className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-full border border-line bg-card p-1">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "closed"}
            className={`min-h-10 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium ${tab === "closed" ? "bg-accent text-on-accent" : "text-ink-soft hover:text-ink"}`}
            onClick={() => setTab("closed")}
          >
            Solicitações encerradas
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "requests"}
            className={`min-h-10 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium ${tab === "requests" ? "bg-accent text-on-accent" : "text-ink-soft hover:text-ink"}`}
            onClick={() => setTab("requests")}
          >
            Solicitações
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "new"}
            className={`min-h-10 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium ${tab === "new" ? "bg-accent text-on-accent" : "text-ink-soft hover:text-ink"}`}
            onClick={startNew}
          >
            Nova solicitação
          </button>
        </div>

        {notice && <p role="status" className="rounded-2xl bg-sim-soft px-4 py-3 text-sm text-sim">{notice}</p>}
        {error && <p role="alert" className="rounded-2xl bg-nao-soft px-4 py-3 text-sm text-nao">{error}</p>}

        {tab === "new" ? (
          <form
            className="flex flex-col gap-5 rounded-2xl border border-line bg-card p-5 sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset className="flex flex-col gap-2" disabled={editingId !== null}>
              <legend className="text-sm font-medium">Tipo</legend>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Tipo de solicitação">
                {(["feature", "bug"] as FeedbackType[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="radio"
                    aria-checked={type === item}
                    onClick={() => setType(item)}
                    className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium ${type === item ? "border-accent bg-accent text-on-accent" : "border-line text-ink hover:border-ink-mute"}`}
                  >
                    {item === "feature" ? "Solicitar recurso" : "Reportar bug"}
                  </button>
                ))}
              </div>
              {editingId && <p className="text-sm text-ink-soft">O tipo não muda após o envio para preservar a privacidade e os votos.</p>}
            </fieldset>

            <label className="flex flex-col gap-2 text-sm font-medium">
              Título
              <input
                className={input}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={140}
                required
                autoFocus
                placeholder="Resumo curto da solicitação"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-medium">
              Descrição
              <textarea
                className={`${input} min-h-36 resize-y`}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={5000}
                required
                placeholder={type === "bug" ? "O que aconteceu e o que você esperava que acontecesse?" : "O que você gostaria que a Helo tivesse ou melhorasse?"}
              />
            </label>

            {!editingId && patient && patientId != null && (
              <label className="flex items-start gap-3 rounded-2xl border border-line px-4 py-3 text-sm">
                <input
                  type="checkbox"
                  checked={includePatient}
                  onChange={(event) => setIncludePatient(event.target.checked)}
                  className="mt-1 h-4 w-4 accent-ink"
                />
                <span>
                  Vincular ao paciente ativo: <strong>{patient.name}</strong>
                  <span className="mt-0.5 block text-ink-soft">Opcional; use somente quando o contexto ajudar a investigar a solicitação.</span>
                </span>
              </label>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" className={action} disabled={sending}>
                {sending ? "Salvando…" : editingId ? "Salvar alterações" : "Enviar"}
              </button>
              <button type="button" className={secondary} disabled={sending} onClick={() => {
                setEditingId(null);
                setTab("requests");
              }}>
                Cancelar
              </button>
            </div>
          </form>
        ) : (
          <section className="flex flex-col gap-4" aria-label={tab === "closed" ? "Solicitações encerradas" : "Solicitações enviadas e públicas"}>
            {tab === "closed" && (
              <p className="text-sm text-ink-soft">Conversas resolvidas permanecem disponíveis para consulta e podem ser excluídas pelo autor ou pela administração.</p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              <label className="sr-only" htmlFor="feedback-search">Buscar solicitações</label>
              <input id="feedback-search" className={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar solicitações" />
              <label className="sr-only" htmlFor="feedback-filter">Filtrar por tipo</label>
              <select id="feedback-filter" className={input} value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
                <option value="all">Todos os tipos</option>
                <option value="feature">Recursos</option>
                <option value="bug">Bugs enviados por mim</option>
              </select>
              <label className="sr-only" htmlFor="feedback-sort">Ordenar solicitações</label>
              <select id="feedback-sort" className={input} value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
                <option value="recent">Mais recentes</option>
                <option value="votes">Mais votados</option>
              </select>
            </div>

            {loading ? (
              <p className="py-16 text-center text-ink-soft">Carregando solicitações…</p>
            ) : shown.length === 0 ? (
              <div className="border-y border-line py-16 text-center">
                <p className="font-medium">Nenhuma solicitação encontrada.</p>
                <p className="mt-1 text-sm text-ink-soft">{tab === "closed" ? "Nenhuma conversa foi encerrada ainda." : "Seja o primeiro a sugerir uma melhoria."}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {shown.map((request) => (
                  <article key={request.id} className="rounded-2xl border border-line bg-card p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
                          <span className="rounded-full border border-line px-2.5 py-1">{FEEDBACK_TYPE_LABELS[request.type]}</span>
                          <span className="rounded-full bg-ink-soft/10 px-2.5 py-1 text-ink-soft">{FEEDBACK_STATUS_LABELS[request.status]}</span>
                          {request.conversationStatus === "resolved" && <span className="rounded-full bg-sim-soft px-2.5 py-1 text-sim">Conversa resolvida</span>}
                          {request.type === "bug" && <span className="rounded-full bg-talvez-soft px-2.5 py-1 text-talvez">Privado</span>}
                          {request.hasUnreadMessages && <span className="rounded-full bg-sim-soft px-2.5 py-1 text-sim">Nova resposta</span>}
                          {request.archived && <span className="rounded-full bg-nao-soft px-2.5 py-1 text-nao">Arquivada</span>}
                        </div>
                        <h2 className="mt-3 text-lg font-semibold">{request.title}</h2>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{request.description}</p>
                        <p className="mt-3 text-xs text-ink-mute">{relativeDate(request.createdAt)}</p>
                      </div>
                      {request.type === "feature" && request.visibility === "public" && !request.archived && (
                        <button
                          type="button"
                          title={request.hasVoted ? "Remover voto" : "Votar nesta solicitação"}
                          aria-label={request.hasVoted ? `Remover voto de ${request.title}` : `Votar em ${request.title}`}
                          onClick={() => void vote(request.id)}
                          disabled={votingId === request.id}
                          className={`min-h-11 shrink-0 rounded-full border px-3 py-2 text-sm font-semibold disabled:opacity-40 ${request.hasVoted ? "border-accent bg-accent text-on-accent" : "border-line hover:border-ink-mute"}`}
                        >
                          ▲ {request.votesCount}
                        </button>
                      )}
                    </div>
                    {(request.isOwner || isAdmin) && (
                      (request.isOwner || isAdmin) && confirmingDeleteId === request.id ? (
                        <div role="alertdialog" aria-label={`Excluir ${request.title}`} className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl bg-nao-soft p-4 text-sm">
                          <span className="mr-auto">Excluir esta solicitação? Esta ação não pode ser desfeita.</span>
                          <button type="button" className="min-h-10 rounded-full bg-nao px-4 py-2 font-medium text-white disabled:opacity-40" disabled={sending} onClick={() => void remove(request.id)}>Excluir</button>
                          <button type="button" className={secondary} disabled={sending} onClick={() => setConfirmingDeleteId(null)}>Cancelar</button>
                        </div>
                      ) : (
                        <div className="mt-4 flex flex-wrap gap-2">
                          <div className="relative inline-flex">
                            <button type="button" className={secondary} onClick={() => setConversationId((current) => current === request.id ? null : request.id)}>{conversationId === request.id ? "Ocultar conversa" : "Abrir conversa"}</button>
                            {request.hasUnreadMessages && <span className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-nao text-xs font-bold text-white shadow-sm" aria-label={`${request.unreadMessagesCount} mensagens não lidas`}>{request.unreadMessagesCount > 99 ? "99+" : request.unreadMessagesCount}</span>}
                          </div>
                          {request.isOwner && <>
                            <button type="button" className={secondary} onClick={() => startEdit(request)}>Editar</button>
                          </>}
                          {(request.isOwner || isAdmin) && <>
                            <button type="button" className="min-h-10 rounded-full px-4 py-2 text-sm font-medium text-nao hover:bg-nao-soft" onClick={() => setConfirmingDeleteId(request.id)}>Excluir</button>
                          </>}
                        </div>
                      )
                    )}
                    {!request.isOwner && !isAdmin && request.type === "feature" && request.visibility === "public" && (
                      <div className="mt-4">
                        <div className="relative inline-flex">
                          <button type="button" className={secondary} onClick={() => setConversationId((current) => current === request.id ? null : request.id)}>{conversationId === request.id ? "Ocultar conversa" : "Ver respostas"}</button>
                          {request.hasUnreadMessages && <span className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-nao text-xs font-bold text-white shadow-sm" aria-label={`${request.unreadMessagesCount} mensagens não lidas`}>{request.unreadMessagesCount > 99 ? "99+" : request.unreadMessagesCount}</span>}
                        </div>
                      </div>
                    )}
                    {conversationId === request.id && (
                      <FeedbackConversation
                        requestId={request.id}
                        type={request.type}
                        canReply={request.isOwner || isAdmin}
                        conversationStatus={request.conversationStatus}
                        resolvedAt={request.resolvedAt}
                        resolutionSource={request.resolutionSource}
                        canResolve={request.isOwner || isAdmin}
                        isAdmin={isAdmin}
                        onRead={() => markConversationRead(request.id)}
                        onMessageSent={load}
                        onConversationResolved={() => void load()}
                      />
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
