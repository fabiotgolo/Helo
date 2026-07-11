import { getPatientSummaries } from "@/lib/store";
import { listPatientIdsForUser } from "@/lib/access";
import { requireUser } from "@/lib/auth";

// Resumo de atividade por paciente para o Dashboard Geral.
// Só status e contagens — nenhum conteúdo de mensagem ou ID de voz.
// Filtrado NO SERVIDOR pelos vínculos do usuário autenticado (admin vê todos).
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const allowed =
    auth.user.role === "admin"
      ? null
      : await listPatientIdsForUser(auth.user.id);
  const summaries = await getPatientSummaries(allowed);
  return Response.json({ summaries });
}
