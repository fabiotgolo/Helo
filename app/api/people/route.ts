import { listPeople, addPerson, deactivatePerson } from "@/lib/store";

export async function GET() {
  const people = await listPeople();
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
  const id = await addPerson(name.trim(), relation);
  return Response.json({ id });
}

export async function DELETE(request: Request) {
  const { id } = (await request.json()) as { id?: number };
  if (!id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  await deactivatePerson(id);
  return Response.json({ ok: true });
}
