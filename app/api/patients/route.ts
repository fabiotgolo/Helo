import { listPatients, createPatient, updatePatient } from "@/lib/store";

// Pacientes da Helo. O GET dispara a migração automática: se ainda não há
// nenhum paciente, o primeiro é criado a partir dos dados globais legados.
export async function GET() {
  const patients = await listPatients();
  return Response.json({ patients });
}

export async function POST(request: Request) {
  const { name } = (await request.json()) as { name?: string };
  if (!name?.trim()) {
    return Response.json({ error: "nome obrigatório" }, { status: 400 });
  }
  const patient = await createPatient(name);
  return Response.json({ patient });
}

export async function PATCH(request: Request) {
  const { id, name, active } = (await request.json()) as {
    id?: number;
    name?: string;
    active?: boolean;
  };
  if (!id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  await updatePatient(id, { name, active });
  return Response.json({ ok: true });
}
