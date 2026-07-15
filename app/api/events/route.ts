import { insertEvent } from "@/lib/store";
import { requirePatientAccess } from "@/lib/auth";
import type { HeloEvent } from "@/lib/types";

// Registrar eventos exige vínculo com createSession no paciente.
export async function POST(request: Request) {
  const e = (await request.json()) as HeloEvent;
  if (!e.type) {
    return Response.json({ error: "type obrigatório" }, { status: 400 });
  }
  const auth = await requirePatientAccess(
    request,
    Number(e.patientId),
    "createSession"
  );
  if (auth instanceof Response) return auth;
  await insertEvent(e);
  return Response.json({ ok: true });
}
