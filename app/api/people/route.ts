import { listPeople, addPerson, deactivatePerson } from "@/lib/store";
import { requirePatientAccess } from "@/lib/auth";

// Rede de pessoas do paciente — sempre com escopo de patientId.
// Leitura exige vínculo; escrita exige editProfile.
export async function GET(request: Request) {
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!patientId) {
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }
  const auth = await requirePatientAccess(request, patientId);
  if (auth instanceof Response) return auth;
  const people = await listPeople(patientId);
  return Response.json({ people });
}

export async function POST(request: Request) {
  const { patientId, name, relation } = (await request.json()) as {
    patientId?: number;
    name?: string;
    relation?: string;
  };
  if (!patientId || !name?.trim()) {
    return Response.json(
      { error: "patientId e nome obrigatórios" },
      { status: 400 }
    );
  }
  const auth = await requirePatientAccess(request, patientId, "editProfile");
  if (auth instanceof Response) return auth;
  const id = await addPerson(patientId, name.trim(), relation);
  return Response.json({ id });
}

export async function DELETE(request: Request) {
  const { patientId, id } = (await request.json()) as {
    patientId?: number;
    id?: number;
  };
  if (!patientId || !id) {
    return Response.json(
      { error: "patientId e id obrigatórios" },
      { status: 400 }
    );
  }
  const auth = await requirePatientAccess(request, patientId, "editProfile");
  if (auth instanceof Response) return auth;
  await deactivatePerson(patientId, id);
  return Response.json({ ok: true });
}
