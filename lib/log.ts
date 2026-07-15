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

export async function saveMessage(m: HeloMessage): Promise<void> {
  await fetch("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(m),
    keepalive: true,
  }).catch(() => {});
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
