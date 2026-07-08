import { insertEvent } from "@/lib/store";
import type { HeloEvent } from "@/lib/types";

export async function POST(request: Request) {
  const e = (await request.json()) as HeloEvent;
  if (!e.type) {
    return Response.json({ error: "type obrigatório" }, { status: 400 });
  }
  await insertEvent(e);
  return Response.json({ ok: true });
}
