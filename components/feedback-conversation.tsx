"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ROLE_LABELS } from "@/lib/access-types";
import type {
  FeedbackConversationStatus,
  FeedbackMessage,
  FeedbackResolutionSource,
  FeedbackType,
} from "@/lib/feedback-types";

const input =
  "min-h-11 w-full rounded-2xl border border-line bg-card px-4 py-2.5 outline-none focus:border-ink-mute";
const action =
  "min-h-11 rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-on-accent hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40";
const secondary =
  "min-h-11 rounded-full border border-line bg-card px-5 py-2.5 text-sm font-medium hover:border-ink-mute disabled:opacity-40";

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? "Não foi possível concluir a ação. Tente novamente.";
}

function displayDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Agora" : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function FeedbackConversation({
  requestId,
  type,
  canReply,
  conversationStatus,
  resolvedAt,
  resolutionSource,
  canResolve = false,
  isAdmin = false,
  onRead,
  onMessageSent,
  onConversationResolved,
}: {
  requestId: string;
  type: FeedbackType;
  canReply: boolean;
  conversationStatus: FeedbackConversationStatus;
  resolvedAt: string | null;
  resolutionSource: FeedbackResolutionSource | null;
  canResolve?: boolean;
  isAdmin?: boolean;
  onRead?: () => void;
  onMessageSent?: () => void;
  onConversationResolved?: () => void;
}) {
  const [messages, setMessages] = useState<FeedbackMessage[] | null>(null);
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">(type === "bug" ? "private" : "public");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [showResolveConfirmation, setShowResolveConfirmation] = useState(false);
  const [locallyResolved, setLocallyResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const resolveButtonRef = useRef<HTMLButtonElement>(null);
  const cancelResolveButtonRef = useRef<HTMLButtonElement>(null);
  const onReadRef = useRef(onRead);

  useEffect(() => {
    onReadRef.current = onRead;
  }, [onRead]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/feedback/${requestId}/messages`);
      if (!response.ok) throw new Error(await responseError(response));
      const data = (await response.json()) as { messages: FeedbackMessage[] };
      setMessages(data.messages);
      onReadRef.current?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar a conversa.");
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!sending && messages) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, sending]);

  useEffect(() => {
    if (showResolveConfirmation) cancelResolveButtonRef.current?.focus();
  }, [showResolveConfirmation]);

  const conversationResolved = locallyResolved || conversationStatus !== "open";

  const closeResolveConfirmation = () => {
    if (resolving) return;
    setShowResolveConfirmation(false);
    window.requestAnimationFrame(() => resolveButtonRef.current?.focus());
  };

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/feedback/${requestId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, ...(isAdmin ? { visibility } : {}) }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const data = (await response.json()) as { message: FeedbackMessage };
      setMessages((current) => [...(current ?? []), data.message]);
      setText("");
      onMessageSent?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível enviar. Tente novamente.");
    } finally {
      setSending(false);
    }
  };

  const resolveConversation = async () => {
    if (resolving || conversationResolved) return;
    setResolving(true);
    setError(null);
    try {
      const response = await fetch(`/api/feedback/${requestId}/resolve`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response));
      const data = (await response.json()) as { systemMessage: FeedbackMessage };
      setMessages((current) => current ? [...current, data.systemMessage] : [data.systemMessage]);
      setLocallyResolved(true);
      setShowResolveConfirmation(false);
      onConversationResolved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível encerrar a conversa. Tente novamente.");
    } finally {
      setResolving(false);
    }
  };

  return (
    <section className="mt-5 border-t border-line pt-5" aria-label="Conversa da solicitação">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Conversa</h3>
        <div className="flex flex-wrap gap-2">
          {canResolve && !conversationResolved && (
            <button
              ref={resolveButtonRef}
              type="button"
              className={secondary}
              onClick={() => setShowResolveConfirmation(true)}
              disabled={loading || sending || resolving}
            >
              Encerrar conversa
            </button>
          )}
          <button type="button" className={secondary} onClick={() => void load()} disabled={loading || sending || resolving}>
            Atualizar
          </button>
        </div>
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        {isAdmin
          ? "Você está como administrador: pode ver e responder às mensagens privadas desta solicitação."
          : type === "bug"
            ? "Esta conversa é privada entre o autor e a administração."
            : "Mensagens privadas só são visíveis para o autor e a administração."}
      </p>
      {conversationResolved && (
        <div className="mt-4 rounded-2xl border border-sim bg-sim-soft px-4 py-3 text-sm text-sim" role="status">
          <p className="font-semibold">Questão resolvida — conversa encerrada</p>
          <p className="mt-1 text-ink-soft">
            {resolutionSource === "admin" ? "Encerrada pelo administrador" : "Encerrada pelo usuário"}
            {resolvedAt ? ` em ${displayDate(resolvedAt)}.` : "."} O histórico permanece disponível para consulta.
          </p>
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-2xl bg-nao-soft px-4 py-3 text-sm text-nao">{error}</p>}
      {loading ? (
        <p className="py-6 text-center text-sm text-ink-soft">Carregando conversa…</p>
      ) : messages?.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-soft">Ainda não há mensagens nesta solicitação.</p>
      ) : (
        <ol className="mt-4 flex max-h-[32rem] flex-col gap-3 overflow-y-auto pr-1" aria-live="polite">
          {messages?.map((message) => {
            const admin = message.senderRole === "admin";
            const system = message.senderRole === "system";
            return (
              <li key={message.id} className={`rounded-2xl border p-4 ${admin ? "border-accent bg-accent text-on-accent" : system ? "border-sim bg-sim-soft" : "border-line bg-card"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold">{system ? "Sistema Helo" : admin ? "Admin Helo" : message.senderName}</span>
                  <span className={admin ? "text-on-accent/75" : "text-ink-mute"}>{displayDate(message.createdAt)}</span>
                </div>
                {system ? (
                  <p className="mt-0.5 text-xs text-ink-mute">Atualização automática da conversa</p>
                ) : (
                  <p className={`mt-0.5 text-xs ${admin ? "text-on-accent/75" : "text-ink-mute"}`}>
                    {admin ? "Resposta oficial" : (message.senderAppRole ? ROLE_LABELS[message.senderAppRole] : "Usuário")} · {message.visibility === "public" ? "Mensagem pública" : "Mensagem privada"}
                  </p>
                )}
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{message.message}</p>
              </li>
            );
          })}
          <div ref={endRef} />
        </ol>
      )}
      {canReply && !conversationResolved && (
        <form className="mt-4 flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {isAdmin && type === "feature" && (
            <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`feedback-visibility-${requestId}`}>
              Visibilidade da resposta
              <select id={`feedback-visibility-${requestId}`} className={input} value={visibility} onChange={(event) => setVisibility(event.target.value as "public" | "private")} disabled={sending}>
                <option value="public">Pública — visível a usuários autorizados</option>
                <option value="private">Privada — apenas autor e administração</option>
              </select>
            </label>
          )}
          <label className="flex flex-col gap-2 text-sm font-medium" htmlFor={`feedback-message-${requestId}`}>
            Escreva uma mensagem...
            <textarea id={`feedback-message-${requestId}`} className={`${input} min-h-28 resize-y`} value={text} onChange={(event) => setText(event.target.value)} maxLength={5000} disabled={sending} required />
          </label>
          <div className="flex flex-wrap gap-3">
            <button type="submit" className={action} disabled={sending || !text.trim()}>{sending ? "Enviando…" : "Enviar"}</button>
            <button type="button" className={secondary} disabled={sending || !text} onClick={() => setText("")}>Cancelar</button>
          </div>
        </form>
      )}
      {showResolveConfirmation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`resolve-title-${requestId}`}
            aria-describedby={`resolve-description-${requestId}`}
            className="w-full max-w-md rounded-2xl border border-line bg-card p-5 shadow-xl"
          >
            <h4 id={`resolve-title-${requestId}`} className="text-lg font-semibold">Encerrar esta conversa?</h4>
            <p id={`resolve-description-${requestId}`} className="mt-2 text-sm leading-6 text-ink-soft">
              Você está indicando que considera esta questão resolvida. Após o encerramento, não será possível enviar novas mensagens nesta conversa.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-3">
              <button ref={cancelResolveButtonRef} type="button" className={secondary} disabled={resolving} onClick={closeResolveConfirmation}>
                Manter conversa aberta
              </button>
              <button type="button" className={action} disabled={resolving} onClick={() => void resolveConversation()}>
                {resolving ? "Encerrando…" : "Resolver e encerrar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
