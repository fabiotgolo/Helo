import { getPatientSettings, setPatientSettings } from "@/lib/store";

// Configurações do paciente (nome, voz, gestos, estilo de fala…).
// Sempre com escopo de patientId — não existe mais configuração global.
export async function GET(request: Request) {
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!patientId) {
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }
  const settings = await getPatientSettings(patientId);
  return Response.json(settings);
}

export async function POST(request: Request) {
  const { patientId, ...updates } = (await request.json()) as {
    patientId?: number;
  } & Record<string, string>;
  if (!patientId) {
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }
  await setPatientSettings(Number(patientId), updates as Record<string, string>);
  return Response.json({ ok: true });
}
