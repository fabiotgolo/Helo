import { db } from "@/lib/db";

export async function GET() {
  const people = db
    .prepare("SELECT id, name, relation FROM people WHERE active = 1 ORDER BY id")
    .all();
  return Response.json({ people });
}

export async function POST(request: Request) {
  const { name, relation } = (await request.json()) as {
    name?: string;
    relation?: string;
  };
  if (!name?.trim()) {
    return Response.json({ error: "nome obrigatório" }, { status: 400 });
  }
  const result = db
    .prepare("INSERT INTO people (name, relation) VALUES (?, ?)")
    .run(name.trim(), relation?.trim() || null);
  return Response.json({ id: Number(result.lastInsertRowid) });
}

export async function DELETE(request: Request) {
  const { id } = (await request.json()) as { id?: number };
  if (!id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  db.prepare("UPDATE people SET active = 0 WHERE id = ?").run(id);
  return Response.json({ ok: true });
}
