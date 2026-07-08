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

export async function startSession(
  mode: string,
  operator?: string
): Promise<number | null> {
  try {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, operator }),
    });
    const data = (await res.json()) as { id: number };
    return data.id;
  } catch {
    return null;
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
