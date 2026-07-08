import { db } from "@/lib/db";

export async function GET() {
  const rows = db.prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  return Response.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

export async function POST(request: Request) {
  const updates = (await request.json()) as Record<string, string>;
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  for (const [key, value] of Object.entries(updates)) {
    stmt.run(key, value);
  }
  return Response.json({ ok: true });
}
