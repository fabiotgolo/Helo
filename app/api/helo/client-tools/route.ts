import { requirePatientAccess } from "@/lib/auth";
import {
  isHeloNavigationArea,
  isHeloSettingsSection,
  permissionForHeloTool,
  type HeloClientToolAction,
} from "@/lib/helo-client-tools";

const ACTIONS: readonly HeloClientToolAction[] = [
  "navigateHeloArea",
  "openPatientSettings",
  "openRoutineMode",
  "openEmergencyMode",
  "openActivitiesMode",
  "showGestureChoices",
];

/**
 * Autoriza apenas a ação local solicitada por uma Client Tool. Não altera
 * dados nem aceita rota/patientId fornecidos pelo Agent além do paciente
 * atualmente selecionado pelo cliente autenticado.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const patientId = typeof body?.patientId === "number" ? body.patientId : NaN;
  const action = body?.action;

  if (!Number.isInteger(patientId) || patientId <= 0) {
    return Response.json({ ok: false, error: "Paciente ativo não selecionado" }, { status: 400 });
  }
  if (typeof action !== "string" || !ACTIONS.includes(action as HeloClientToolAction)) {
    return Response.json({ ok: false, error: "Ação de interface não permitida" }, { status: 400 });
  }

  const area = body?.area;
  const section = body?.section;
  if (area !== undefined && !isHeloNavigationArea(area)) {
    return Response.json({ ok: false, error: "Área de navegação inválida" }, { status: 400 });
  }
  if (section !== undefined && !isHeloSettingsSection(section)) {
    return Response.json({ ok: false, error: "Seção de ajustes inválida" }, { status: 400 });
  }

  const typedAction = action as HeloClientToolAction;
  const auth = await requirePatientAccess(request, patientId, permissionForHeloTool(typedAction, { area, section }));
  if (auth instanceof Response) {
    const data = (await auth.json().catch(() => null)) as { error?: string } | null;
    return Response.json({ ok: false, error: data?.error ?? "Acesso negado" }, { status: auth.status });
  }

  return Response.json({ ok: true });
}
