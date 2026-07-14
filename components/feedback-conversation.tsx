"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ROLE_LABELS } from "@/lib/access-types";
import type { FeedbackMessage, FeedbackType } from "@/lib/feedback-types";

const input =
  "min-h-11 w-full rounded-2xl border border-line bg-card px-4 py-2.5 outline-none focus:border-ink-mute";
const action =
  "min-h-11 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-40";
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
  isAdmin = false,
  onRead,
  onMessageSent,
}: {
  requestId: string;
  type: FeedbackType;
  canReply: boolean;
  isAdmin?: boolean;
  onRead?: () => void;
  onMessageSent?: () => void;
}) {
  const [messages, setMessages] = useState<FeedbackMessage[] | null>(null);
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">(type === "bug" ? "private" : "public");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
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

  return (
    <section className="mt-5 border-t border-line pt-5" aria-label="Conversa da solicitação">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Conversa</h3>
        <button type="button" className={secondary} onClick={() => void load()} disabled={loading || sending}>
          Atualizar
        </button>
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        {isAdmin
          ? "Você está como administrador: pode ver e responder às mensagens privadas desta solicitação."
          : type === "bug"
            ? "Esta conversa é privada entre o autor e a administração."
            : "Mensagens privadas só são visíveis para o autor e a administração."}
      </p>
      {error && <p role="alert" className="mt-3 rounded-2xl bg-nao-soft px-4 py-3 text-sm text-nao">{error}</p>}
      {loading ? (
        <p className="py-6 text-center text-sm text-ink-soft">Carregando conversa…</p>
      ) : messages?.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-soft">Ainda não há mensagens nesta solicitação.</p>
      ) : (
        <ol className="mt-4 flex max-h-[32rem] flex-col gap-3 overflow-y-auto pr-1" aria-live="polite">
          {messages?.map((message) => {
            const admin = message.senderRole === "admin";
            return (
              <li key={message.id} className={`rounded-2xl border p-4 ${admin ? "border-ink bg-ink text-white" : "border-line bg-card"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold">{admin ? "Admin Helo" : message.senderName}</span>
                  <span className={admin ? "text-white/75" : "text-ink-mute"}>{displayDate(message.createdAt)}</span>
                </div>
                <p className={`mt-0.5 text-xs ${admin ? "text-white/75" : "text-ink-mute"}`}>
                  {admin ? "Resposta oficial" : ROLE_LABELS[message.senderAppRole] ?? "Usuário"} · {message.visibility === "public" ? "Mensagem pública" : "Mensagem privada"}
                </p>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{message.message}</p>
              </li>
            );
          })}
          <div ref={endRef} />
        </ol>
      )}
      {canReply && (
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
    </section>
  );
}
