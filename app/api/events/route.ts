import { db } from "@/lib/db";
import type { HeloEvent } from "@/lib/types";

export async function POST(request: Request) {
  const e = (await request.json()) as HeloEvent;
  if (!e.type) {
    return Response.json({ error: "type obrigatório" }, { status: 400 });
  }
  db.prepare(
    `INSERT INTO events (session_id, type, category, question, options, gesture, detail, response_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    e.sessionId ?? null,
    e.type,
    e.category ?? null,
    e.question ?? null,
    e.options ? JSON.stringify(e.options) : null,
    e.gesture ?? null,
    e.detail ?? null,
    e.responseMs ?? null
  );
  return Response.json({ ok: true });
}
