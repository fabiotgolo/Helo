import { insertMessage } from "@/lib/store";
import { requirePatientAccess } from "@/lib/auth";
import type { HeloMessage } from "@/lib/types";

// Registrar comunicação exige vínculo com createSession no paciente.
export async function POST(request: Request) {
  const m = (await request.json()) as HeloMessage;
  if (!m.text || !m.status) {
    return Response.json({ error: "text e status obrigatórios" }, { status: 400 });
  }
  const auth = await requirePatientAccess(
    request,
    Number(m.patientId),
    "createSession"
  );
  if (auth instanceof Response) return auth;
  const id = await insertMessage(m);
  return Response.json({ id });
}
