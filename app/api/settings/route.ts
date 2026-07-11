import { getPatientSettings, setPatientSettings } from "@/lib/store";
import { requirePatientAccess } from "@/lib/auth";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import type { Permission } from "@/lib/access-types";

// Configurações do paciente (nome, voz, gestos, estilo de fala…).
// Sempre com escopo de patientId — não existe mais configuração global.
// Escrita exige a permissão da área correspondente:
//   gestos → editGestures · voz → manageVoice · demais → editProfile.

function permissionForKey(key: string): Permission {
  if (
    key === PATIENT_SETTING_KEYS.gestureSim ||
    key === PATIENT_SETTING_KEYS.gestureTalvez ||
    key === PATIENT_SETTING_KEYS.gestureNao
  ) {
    return "editGestures";
  }
  if (key === PATIENT_SETTING_KEYS.voiceId) return "manageVoice";
  return "editProfile";
}

export async function GET(request: Request) {
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!patientId) {
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }
  // Leitura exige vínculo ativo — mínimo para operar a Helo.
  const auth = await requirePatientAccess(request, patientId);
  if (auth instanceof Response) return auth;
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
  const needed = new Set(
    Object.keys(updates).map((k) => permissionForKey(k))
  );
  for (const permission of needed) {
    const auth = await requirePatientAccess(
      request,
      Number(patientId),
      permission
    );
    if (auth instanceof Response) return auth;
  }
  await setPatientSettings(Number(patientId), updates as Record<string, string>);
  return Response.json({ ok: true });
}
