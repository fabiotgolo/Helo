import { db } from "@/lib/db";
import type { HeloMessage } from "@/lib/types";

export async function POST(request: Request) {
  const m = (await request.json()) as HeloMessage;
  if (!m.text || !m.status) {
    return Response.json({ error: "text e status obrigatórios" }, { status: 400 });
  }
  const result = db
    .prepare(
      `INSERT INTO messages (session_id, text, category, sensitive, status, confirmations)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      m.sessionId ?? null,
      m.text,
      m.category ?? null,
      m.sensitive ? 1 : 0,
      m.status,
      m.confirmations ?? 1
    );
  return Response.json({ id: Number(result.lastInsertRowid) });
}
