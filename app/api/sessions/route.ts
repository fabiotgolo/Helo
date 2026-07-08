import { db } from "@/lib/db";

export async function POST(request: Request) {
  const { operator, mode } = (await request.json()) as {
    operator?: string;
    mode?: string;
  };
  const result = db
    .prepare("INSERT INTO sessions (operator, mode) VALUES (?, ?)")
    .run(operator ?? null, mode ?? "conversa");
  return Response.json({ id: Number(result.lastInsertRowid) });
}

export async function PATCH(request: Request) {
  const { id } = (await request.json()) as { id?: number };
  if (!id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  db.prepare(
    "UPDATE sessions SET ended_at = datetime('now','localtime') WHERE id = ?"
  ).run(id);
  return Response.json({ ok: true });
}
