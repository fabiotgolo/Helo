import { requirePatientAccess } from "@/lib/auth";
import { logAudit } from "@/lib/access";
import {
  endRun,
  getRunDetail,
  listRunsWithStats,
  listTemplates,
  startRun,
} from "@/lib/activity-store";
import { ACTIVITY_CATEGORIES, type ActivityCategory } from "@/lib/activity-types";
import type { Period } from "@/lib/store";

// Execuções (runs) de Atividades. Iniciar/encerrar exige runActivities;
// consultar histórico e agregados exige viewActivityResults. A identidade
// do operador vem SEMPRE da sessão autenticada — nunca do corpo.

const PERIODS: Period[] = ["hoje", "semana", "mes", "ano", "vitalicio"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const auth = await requirePatientAccess(
    request,
    patientId,
    "viewActivityResults"
  );
  if (auth instanceof Response) return auth;

  // Histórico detalhado de UMA execução (conteúdo exibido + respostas).
  const runId = url.searchParams.get("runId");
  if (runId) {
    const detail = await getRunDetail(patientId, runId);
    if (!detail) {
      return Response.json({ error: "execução não encontrada" }, { status: 404 });
    }
    return Response.json(detail);
  }

  const periodParam = url.searchParams.get("period") as Period | null;
  const period = PERIODS.includes(periodParam as Period)
    ? (periodParam as Period)
    : "semana";
  const categoryParam = url.searchParams.get("category");
  const category = ACTIVITY_CATEGORIES.includes(categoryParam as ActivityCategory)
    ? (categoryParam as ActivityCategory)
    : null;
  const [result, templates] = await Promise.all([
    listRunsWithStats(patientId, {
      period,
      templateId: url.searchParams.get("templateId"),
      category,
      operatorId: url.searchParams.get("operatorId"),
    }),
    // "Sessões disponíveis" no Dashboard — só a contagem/títulos ativos.
    listTemplates(patientId, false),
  ]);
  return Response.json({
    ...result,
    period,
    availableTemplates: templates.map((t) => ({
      id: t.id,
      title: t.title,
      category: t.category,
    })),
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    templateId?: string;
  };
  const patientId = Number(body.patientId);
  if (!body.templateId) {
    return Response.json(
      { error: "patientId e templateId obrigatórios" },
      { status: 400 }
    );
  }
  const auth = await requirePatientAccess(request, patientId, "runActivities");
  if (auth instanceof Response) return auth;
  try {
    const run = await startRun(patientId, body.templateId, {
      id: auth.user.id,
      name: auth.user.name,
    });
    void logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      patientId,
      action: "activity_run.start",
      entityType: "activityRun",
      entityId: run.id,
      metadata: { templateId: run.templateId, title: run.templateTitle },
    });
    return Response.json({ run });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    runId?: string;
    status?: string;
  };
  const patientId = Number(body.patientId);
  const status =
    body.status === "abandonada" ? "abandonada" : ("concluida" as const);
  if (!body.runId) {
    return Response.json(
      { error: "patientId e runId obrigatórios" },
      { status: 400 }
    );
  }
  const auth = await requirePatientAccess(request, patientId, "runActivities");
  if (auth instanceof Response) return auth;
  try {
    await endRun(patientId, body.runId, status);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
