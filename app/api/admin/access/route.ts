import {
  getLinkById,
  getUserById,
  grantAccess,
  listLinks,
  logAudit,
  revokeLink,
  updateLink,
} from "@/lib/access";
import { requireAdmin } from "@/lib/auth";
import type { Permission } from "@/lib/access-types";
import { PERMISSIONS, defaultPermissionsFor } from "@/lib/access-types";

// Vínculos usuário ↔ paciente — a matriz de acesso do Admin (seções 15–17).

function sanitizePermissions(perms: unknown): Permission[] | null {
  if (!Array.isArray(perms)) return null;
  const valid = perms.filter((p): p is Permission =>
    (PERMISSIONS as readonly string[]).includes(p as string)
  );
  return valid;
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const links = await listLinks();
  return Response.json({ links: links.filter((l) => l.status === "active") });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const body = (await request.json()) as {
    userId?: string;
    patientId?: number;
    accessRole?: string;
    permissions?: Permission[];
  };
  if (!body.userId || !body.patientId) {
    return Response.json(
      { error: "userId e patientId obrigatórios" },
      { status: 400 }
    );
  }
  const user = await getUserById(body.userId);
  if (!user) {
    return Response.json({ error: "usuário não encontrado" }, { status: 404 });
  }
  const permissions =
    sanitizePermissions(body.permissions) ?? defaultPermissionsFor(user.role);
  const link = await grantAccess({
    userId: body.userId,
    patientId: Number(body.patientId),
    accessRole: body.accessRole?.trim() || user.role,
    permissions,
    grantedByUserId: auth.user.id,
  });
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId: link.patientId,
    action: "access.grant",
    entityType: "userPatientAccess",
    entityId: link.id,
    metadata: { targetUser: user.name },
  });
  return Response.json({ link });
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const body = (await request.json()) as {
    id?: string;
    accessRole?: string;
    permissions?: Permission[];
  };
  if (!body.id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  const link = await getLinkById(body.id);
  if (!link) return Response.json({ error: "vínculo não encontrado" }, { status: 404 });
  const permissions = body.permissions
    ? sanitizePermissions(body.permissions) ?? undefined
    : undefined;
  await updateLink(body.id, { accessRole: body.accessRole, permissions });
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId: link.patientId,
    action: "access.updatePermissions",
    entityType: "userPatientAccess",
    entityId: link.id,
  });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const { id } = (await request.json()) as { id?: string };
  if (!id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  const link = await getLinkById(id);
  if (!link) return Response.json({ error: "vínculo não encontrado" }, { status: 404 });
  // Revogar acesso NÃO deleta o paciente nem afeta outros vínculos (seção 17).
  await revokeLink(id);
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId: link.patientId,
    action: "access.revoke",
    entityType: "userPatientAccess",
    entityId: id,
  });
  return Response.json({ ok: true });
}
