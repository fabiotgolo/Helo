import { getPatientSummaries } from "@/lib/store";

// Resumo de atividade por paciente para o Dashboard Geral.
// Só status e contagens — nenhum conteúdo de mensagem ou ID de voz.
export async function GET() {
  const summaries = await getPatientSummaries();
  return Response.json({ summaries });
}
