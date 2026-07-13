import { requirePatientAccess } from "@/lib/auth";
import { hasPermission } from "@/lib/access-types";
import type { AccessLink, AppUser } from "@/lib/access-types";
import { logAudit } from "@/lib/access";
import {
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
  type TemplateInput,
} from "@/lib/activity-store";
import type { ActivityCaps } from "@/lib/activity-types";

// Templates de Atividades (sessões personalizadas) de UM paciente.
// Toda operação exige patientId + vínculo ativo; cada verbo exige a
// permissão correspondente — a profissão sozinha não concede nada.

/** Capacidades derivadas do vínculo — a UI decide o que EXIBIR com isto;
 *  a autorização real continua sendo feita por rota. */
function capsFor(user: AppUser, link: AccessLink | null): ActivityCaps {
  if (user.role === "admin") {
    return { view: true, run: true, create: true, edit: true, delete: true, viewResults: true };
  }
  return {
    view: hasPermission(link, "viewActivities"),
    run: hasPermission(link, "runActivities"),
    create: hasPermission(link, "createActivities"),
    edit: hasPermission(link, "editActivities"),
    delete: hasPermission(link, "deleteActivities"),
    viewResults: hasPermission(link, "viewActivityResults"),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const auth = await requirePatientAccess(request, patientId, "viewActivities");
  if (auth instanceof Response) return auth;
  const caps = capsFor(auth.user, auth.link);
  // Inativas só aparecem para quem gerencia (modo de edição).
  const includeInactive =
    url.searchParams.get("all") === "1" && (caps.create || caps.edit);
  const templates = await listTemplates(patientId, includeInactive);
  return Response.json({ templates, caps });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    action?: "duplicate";
    templateId?: string;
    template?: TemplateInput;
  };
  const patientId = Number(body.patientId);
  const auth = await requirePatientAccess(request, patientId, "createActivities");
  if (auth instanceof Response) return auth;
  const author = { id: auth.user.id, name: auth.user.name };
  try {
    const template =
      body.action === "duplicate"
        ? await duplicateTemplate(patientId, String(body.templateId ?? ""), author)
        : await createTemplate(patientId, body.template ?? {}, author);
    void logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      patientId,
      action:
        body.action === "duplicate"
          ? "activity_template.duplicate"
          : "activity_template.create",
      entityType: "activityTemplate",
      entityId: template.id,
      metadata: { title: template.title, category: template.category },
    });
    return Response.json({ template });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    templateId?: string;
    template?: TemplateInput;
  };
  const patientId = Number(body.patientId);
  if (!body.templateId || !body.template) {
    return Response.json(
      { error: "patientId, templateId e template obrigatórios" },
      { status: 400 }
    );
  }
  const auth = await requirePatientAccess(request, patientId, "editActivities");
  if (auth instanceof Response) return auth;
  try {
    const template = await updateTemplate(
      patientId,
      body.templateId,
      body.template,
      { id: auth.user.id, name: auth.user.name }
    );
    void logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      patientId,
      action: "activity_template.update",
      entityType: "activityTemplate",
      entityId: template.id,
      metadata: { title: template.title, version: String(template.version) },
    });
    return Response.json({ template });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
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
  const auth = await requirePatientAccess(request, patientId, "deleteActivities");
  if (auth instanceof Response) return auth;
  const existing = await getTemplate(patientId, body.templateId);
  if (!existing) {
    return Response.json({ error: "atividade não encontrada" }, { status: 404 });
  }
  await deleteTemplate(patientId, body.templateId);
  void logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId,
    action: "activity_template.delete",
    entityType: "activityTemplate",
    entityId: body.templateId,
    metadata: { title: existing.title },
  });
  return Response.json({ ok: true });
}
