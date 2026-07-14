"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_TYPE_LABELS,
  type AdminFeedbackRequest,
  type FeedbackStatus,
  type FeedbackType,
} from "@/lib/feedback-types";
import { ROLE_LABELS } from "@/lib/access-types";
import { FeedbackConversation } from "@/components/feedback-conversation";

const input =
  "min-h-10 rounded-2xl border border-line bg-card px-3 py-2 text-sm outline-none focus:border-ink-mute";
const secondary =
  "min-h-10 rounded-full border border-line bg-card px-4 py-2 text-sm font-medium hover:border-ink-mute disabled:opacity-40";

async function api(
  method: "PATCH" | "DELETE",
  body: unknown
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch("/api/admin/feedback", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "não foi possível concluir a ação" };
  } catch {
    return { ok: false, error: "falha de conexão" };
  }
}

export default function AdminFeedbackTab() {
  const [requests, setRequests] = useState<AdminFeedbackRequest[] | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | FeedbackType>("all");
  const [status, setStatus] = useState<"all" | FeedbackStatus>("all");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/admin/feedback");
      if (!response.ok) throw new Error("Não foi possível carregar o feedback.");
      const data = (await response.json()) as { requests: AdminFeedbackRequest[] };
      setRequests(data.requests);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o feedback.");
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

  const update = async (id: string, body: Record<string, unknown>, success: string) => {
    setBusyId(id);
    setError(null);
    const result = await api("PATCH", { id, ...body });
    setBusyId(null);
    if (!result.ok) {
      setError(result.error ?? "Não foi possível atualizar.");
      return;
    }
    setNotice(success);
    await load();
  };

  const remove = async (id: string) => {
    setBusyId(id);
    const result = await api("DELETE", { id });
    setBusyId(null);
    setConfirmDelete(null);
    if (!result.ok) {
      setError(result.error ?? "Não foi possível excluir.");
      return;
    }
    setNotice("Solicitação excluída.");
    await load();
  };

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("pt-BR");
    return (requests ?? []).filter(
      (request) =>
        (type === "all" || request.type === type) &&
        (status === "all" || request.status === status) &&
        (!q ||
          request.title.toLocaleLowerCase("pt-BR").includes(q) ||
          request.description.toLocaleLowerCase("pt-BR").includes(q) ||
          request.createdByName.toLocaleLowerCase("pt-BR").includes(q))
    );
  }, [query, requests, status, type]);

  return (
    <section className="flex flex-col gap-5" aria-label="Feedback e suporte">
      <div>
        <h2 className="text-xl font-semibold">Feedback e suporte</h2>
        <p className="mt-1 text-sm text-ink-soft">Solicitações públicas, bugs privados e sua moderação.</p>
        {!!requests?.filter((request) => request.hasUnreadMessages).length && (
          <p className="mt-2 text-sm font-medium text-sim">
            {requests.filter((request) => request.hasUnreadMessages).length} solicitação(ões) com nova mensagem.
          </p>
        )}
      </div>

      {notice && <p role="status" className="rounded-2xl bg-sim-soft px-4 py-3 text-sm text-sim">{notice}</p>}
      {error && <p role="alert" className="rounded-2xl bg-nao-soft px-4 py-3 text-sm text-nao">{error}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <input className={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar título ou autor" aria-label="Buscar feedback" />
        <select className={input} value={type} onChange={(event) => setType(event.target.value as "all" | FeedbackType)} aria-label="Filtrar por tipo">
          <option value="all">Todos os tipos</option>
          <option value="feature">Recursos</option>
          <option value="bug">Bugs</option>
        </select>
        <select className={input} value={status} onChange={(event) => setStatus(event.target.value as "all" | FeedbackStatus)} aria-label="Filtrar por status">
          <option value="all">Todos os status</option>
          {FEEDBACK_STATUSES.map((item) => <option key={item} value={item}>{FEEDBACK_STATUS_LABELS[item]}</option>)}
        </select>
      </div>

      {requests === null ? (
        <p className="py-12 text-center text-ink-soft">Carregando feedback…</p>
      ) : shown.length === 0 ? (
        <p className="border-y border-line py-12 text-center text-ink-soft">Nenhuma solicitação encontrada.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {shown.map((request) => (
            <article key={request.id} className="rounded-2xl border border-line bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap gap-2 text-xs font-medium">
                    <span className="rounded-full border border-line px-2.5 py-1">{FEEDBACK_TYPE_LABELS[request.type]}</span>
                    <span className="rounded-full bg-ink-soft/10 px-2.5 py-1 text-ink-soft">{request.visibility === "public" ? "Público" : "Privado"}</span>
                    {request.archived && <span className="rounded-full bg-nao-soft px-2.5 py-1 text-nao">Arquivada</span>}
                    {request.hasUnreadMessages && <span className="rounded-full bg-sim-soft px-2.5 py-1 text-sim">Nova mensagem</span>}
                  </div>
                  <h3 className="mt-3 text-lg font-semibold">{request.title}</h3>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{request.description}</p>
                  <p className="mt-3 text-xs text-ink-mute">
                    {request.createdByName} · {ROLE_LABELS[request.createdByRole]} · {new Date(request.createdAt).toLocaleString("pt-BR")} · {request.votesCount} voto(s)
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <select
                    className={input}
                    value={request.status}
                    disabled={busyId === request.id}
                    aria-label={`Status de ${request.title}`}
                    onChange={(event) => void update(request.id, { status: event.target.value }, "Status atualizado.")}
                  >
                    {FEEDBACK_STATUSES.map((item) => <option key={item} value={item}>{FEEDBACK_STATUS_LABELS[item]}</option>)}
                  </select>
                  {request.type === "feature" && <select
                    className={input}
                    value={request.visibility}
                    disabled={busyId === request.id}
                    aria-label={`Visibilidade de ${request.title}`}
                    onChange={(event) => void update(request.id, { visibility: event.target.value }, "Visibilidade atualizada.")}
                  >
                    <option value="public">Público</option>
                    <option value="private">Privado</option>
                  </select>}
                </div>
              </div>

              <details className="mt-4 rounded-2xl border border-line px-4 py-3 text-sm">
                <summary className="cursor-pointer font-medium">Contexto técnico e vínculo</summary>
                <dl className="mt-3 grid grid-cols-1 gap-2 text-ink-soft sm:grid-cols-2">
                  <div><dt className="text-xs text-ink-mute">Usuário</dt><dd className="break-all">{request.createdByUserId}</dd></div>
                  <div><dt className="text-xs text-ink-mute">Paciente</dt><dd>{request.patientId ?? "Não vinculado"}</dd></div>
                  <div><dt className="text-xs text-ink-mute">Versão</dt><dd>{request.appVersion || "Não informada"}</dd></div>
                  <div><dt className="text-xs text-ink-mute">Rota</dt><dd className="break-all">{request.route || "Não informada"}</dd></div>
                  {request.metadata && <div className="sm:col-span-2"><dt className="text-xs text-ink-mute">Bug</dt><dd>{[request.metadata.browser, request.metadata.operatingSystem, request.metadata.viewport].filter(Boolean).join(" · ") || "Sem metadados adicionais"}</dd></div>}
                </dl>
              </details>

              {confirmDelete === request.id ? (
                <div role="alertdialog" aria-label="Confirmar exclusão da solicitação" className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl bg-nao-soft p-4 text-sm">
                  <span className="mr-auto">Excluir esta solicitação e seus votos?</span>
                  <button type="button" className="min-h-10 rounded-full bg-nao px-4 py-2 font-medium text-white disabled:opacity-40" disabled={busyId === request.id} onClick={() => void remove(request.id)}>Excluir</button>
                  <button type="button" className={secondary} disabled={busyId === request.id} onClick={() => setConfirmDelete(null)}>Cancelar</button>
                </div>
              ) : (
                <div className="mt-4 flex flex-wrap gap-2">
                  <div className="relative inline-flex">
                    <button type="button" className={secondary} disabled={busyId === request.id} onClick={() => setConversationId((current) => current === request.id ? null : request.id)}>{conversationId === request.id ? "Fechar conversa" : "Abrir conversa"}</button>
                    {request.hasUnreadMessages && <span className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-nao text-xs font-bold text-white shadow-sm" aria-label={`${request.unreadMessagesCount} mensagens não lidas`}>{request.unreadMessagesCount > 99 ? "99+" : request.unreadMessagesCount}</span>}
                  </div>
                  <button type="button" className={secondary} disabled={busyId === request.id} onClick={() => void update(request.id, { archived: !request.archived }, request.archived ? "Solicitação desarquivada." : "Solicitação arquivada.")}>{request.archived ? "Desarquivar" : "Arquivar"}</button>
                  <button type="button" className="min-h-10 rounded-full px-4 py-2 text-sm font-medium text-nao hover:bg-nao-soft" disabled={busyId === request.id} onClick={() => setConfirmDelete(request.id)}>Excluir</button>
                </div>
              )}
              {conversationId === request.id && (
                <FeedbackConversation
                  requestId={request.id}
                  type={request.type}
                  canReply
                  isAdmin
                  onRead={() => markConversationRead(request.id)}
                  onMessageSent={load}
                />
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
