import {
  createPatient,
  getPatient,
  hardDeletePatient,
  listPatients,
  updatePatient,
} from "@/lib/store";
import {
  grantAccess,
  listLinksForPatient,
  listPatientIdsForUser,
  logAudit,
  revokeLink,
} from "@/lib/access";
import { requireAdmin, requirePatientAccess, requireUser } from "@/lib/auth";
import { PERMISSIONS, ROLES_THAT_CREATE_PATIENTS } from "@/lib/access-types";

// Pacientes. Autorização real no servidor:
// - GET: admin vê todos; demais usuários, SOMENTE os vinculados.
// - POST: admin, profissional, cuidador e familiar criam; o criador
//   não-admin é vinculado automaticamente ao novo paciente (seção 11).
// - PATCH: renomear exige vínculo com editProfile; ativar/desativar é do Admin.
// - DELETE: exclusivo do Admin (desativação segura ou exclusão definitiva).

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const all = await listPatients();
  if (auth.user.role === "admin") return Response.json({ patients: all });
  const allowed = new Set(await listPatientIdsForUser(auth.user.id));
  return Response.json({ patients: all.filter((p) => allowed.has(p.id)) });
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  if (!ROLES_THAT_CREATE_PATIENTS.includes(auth.user.role)) {
    return Response.json(
      { error: "seu papel não permite criar pacientes" },
      { status: 403 }
    );
  }
  const { name } = (await request.json()) as { name?: string };
  if (!name?.trim()) {
    return Response.json({ error: "nome obrigatório" }, { status: 400 });
  }
  const patient = await createPatient(name);
  // Vínculo automático do criador — e de mais ninguém (seção 11).
  if (auth.user.role !== "admin") {
    await grantAccess({
      userId: auth.user.id,
      patientId: patient.id,
      accessRole: auth.user.role,
      permissions: [...PERMISSIONS],
      grantedByUserId: auth.user.id,
    });
  }
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId: patient.id,
    action: "patient.create",
    entityType: "patient",
    entityId: String(patient.id),
  });
  return Response.json({ patient });
}

export async function PATCH(request: Request) {
  const { id, name, active } = (await request.json()) as {
    id?: number;
    name?: string;
    active?: boolean;
  };
  if (!id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  // Ativar/desativar paciente é gestão global → Admin.
  const auth =
    active !== undefined
      ? await requireAdmin(request)
      : await requirePatientAccess(request, id, "editProfile");
  if (auth instanceof Response) return auth;
  await updatePatient(id, { name, active });
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId: id,
    action:
      active !== undefined
        ? `patient.${active ? "reactivate" : "deactivate"}`
        : "patient.update",
    entityType: "patient",
    entityId: String(id),
  });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const { id, hard } = (await request.json()) as { id?: number; hard?: boolean };
  if (!id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  const patient = await getPatient(id);
  if (!patient) {
    return Response.json({ error: "paciente não encontrado" }, { status: 404 });
  }
  const links = await listLinksForPatient(id);
  if (hard) {
    // Exclusão definitiva: perfil + vínculos. Histórico global preservado
    // (carimbado com patientId) para eventual auditoria.
    for (const l of links) await revokeLink(l.id);
    await hardDeletePatient(id);
  } else {
    // Padrão: desativação segura (soft delete) — recuperável.
    await updatePatient(id, { active: false });
  }
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId: id,
    action: hard ? "patient.hardDelete" : "patient.deactivate",
    entityType: "patient",
    entityId: String(id),
    metadata: { name: patient.name, linkedUsers: String(links.length) },
  });
  return Response.json({ ok: true, deleted: Boolean(hard) });
}
