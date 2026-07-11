import { getStats, type Period } from "@/lib/store";

// Métricas observacionais de UM paciente — patientId é obrigatório:
// nenhuma agregação global mistura pacientes (a visão geral usa
// /api/patients/summary, que só devolve contagens de atividade).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const period = (url.searchParams.get("period") ?? "semana") as Period;
  const patientId = Number(url.searchParams.get("patientId"));
  if (!patientId || Number.isNaN(patientId)) {
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }
  const stats = await getStats(period, patientId);
  return Response.json(stats);
}
