import { insertMessage } from "@/lib/store";
import type { HeloMessage } from "@/lib/types";

export async function POST(request: Request) {
  const m = (await request.json()) as HeloMessage;
  if (!m.text || !m.status) {
    return Response.json({ error: "text e status obrigatórios" }, { status: 400 });
  }
  const id = await insertMessage(m);
  return Response.json({ id });
}
