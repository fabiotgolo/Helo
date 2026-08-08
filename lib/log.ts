"use client";

import type { HeloEvent, HeloMessage } from "@/lib/types";

// Registro em segundo plano — nunca bloqueia a conversa.
export function logEvent(e: HeloEvent): void {
  void fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(e),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Registra a comunicação. Quando a mensagem é uma fala CONFIRMADA do paciente,
 * a resposta traz o SpeechGrant que autoriza vocalizá-la — o registro passa a
 * existir antes da voz, e é ele que sustenta a fala.
 *
 * Devolve null quando o registro falhou (rede, permissão): sem registro não há
 * grant, e sem grant a voz do paciente não soa. Falha FECHADA, de propósito.
 */
export async function saveMessage(
  m: HeloMessage
): Promise<{ id: string; grant?: string } | null> {
  try {
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(m),
      keepalive: true,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: string; grant?: string };
    return data.id ? { id: data.id, grant: data.grant } : null;
  } catch {
    return null;
  }
}

// O operador NÃO é enviado pelo cliente: o servidor deriva operatorId,
// nome e papel da sessão autenticada (cookie) em /api/sessions.
export async function startSession(
  mode: string,
  patientId?: number | null
): Promise<{ id: number | null; error: string | null }> {
  try {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, patientId }),
    });
    const data = (await res.json()) as { id?: number; error?: string };
    if (!res.ok || !data.id) {
      return { id: null, error: data.error ?? "falha ao criar a sessão" };
    }
    return { id: data.id, error: null };
  } catch {
    return { id: null, error: "sem conexão com o servidor" };
  }
}

export function endSession(id: number | null): void {
  if (!id) return;
  void fetch("/api/sessions", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
    keepalive: true,
  }).catch(() => {});
}
