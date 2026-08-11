import { requirePatientAccess } from "@/lib/auth";
import { jsonSemCache } from "@/lib/cache-policy";
import {
  isHeloNavigationArea,
  isHeloPermission,
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
  // getCurrentHeloActions é só leitura da tela e não passa por aqui;
  // a execução de uma ação do registry passa, com a permissão declarada.
  "interactWithHeloUI",
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
    return jsonSemCache({ ok: false, error: "Paciente ativo não selecionado" }, { status: 400 });
  }
  if (typeof action !== "string" || !ACTIONS.includes(action as HeloClientToolAction)) {
    return jsonSemCache({ ok: false, error: "Ação de interface não permitida" }, { status: 400 });
  }

  const area = body?.area;
  const section = body?.section;
  const permission = body?.permission;
  if (area !== undefined && !isHeloNavigationArea(area)) {
    return jsonSemCache({ ok: false, error: "Área de navegação inválida" }, { status: 400 });
  }
  if (section !== undefined && !isHeloSettingsSection(section)) {
    return jsonSemCache({ ok: false, error: "Seção de ajustes inválida" }, { status: 400 });
  }
  // A permissão declarada só APERTA a checagem (exige mais que o vínculo);
  // a autorização real de cada escrita continua nas próprias rotas de dados.
  if (permission !== undefined && !isHeloPermission(permission)) {
    return jsonSemCache({ ok: false, error: "Permissão desconhecida" }, { status: 400 });
  }

  const typedAction = action as HeloClientToolAction;
  const auth = await requirePatientAccess(request, patientId, permissionForHeloTool(typedAction, { area, section, permission }));
  if (auth instanceof Response) {
    const data = (await auth.json().catch(() => null)) as { error?: string } | null;
    return jsonSemCache({ ok: false, error: data?.error ?? "Acesso negado" }, { status: auth.status });
  }

  return jsonSemCache({ ok: true });
}
