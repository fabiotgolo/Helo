import {
  createUser,
  deleteUser,
  getUserById,
  listLinksForUser,
  listUsers,
  logAudit,
  updateUser,
} from "@/lib/access";
import { requireAdmin } from "@/lib/auth";
import type { ProfessionalType, UserRole } from "@/lib/access-types";
import { ROLE_LABELS } from "@/lib/access-types";

// Gestão global de contas — EXCLUSIVA do Admin (seções 13/14/18/20).

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const users = await listUsers();
  // Vínculos por usuário, para a matriz de acesso e o aviso pré-exclusão.
  const withLinks = await Promise.all(
    users.map(async (u) => ({
      ...u,
      links: await listLinksForUser(u.id),
    }))
  );
  return Response.json({ users: withLinks });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const body = (await request.json()) as {
    name?: string;
    email?: string;
    password?: string;
    role?: UserRole;
    professionalType?: ProfessionalType | null;
  };
  if (!body.name?.trim() || !body.email?.trim() || !body.password || !body.role) {
    return Response.json(
      { error: "nome, email, senha e papel obrigatórios" },
      { status: 400 }
    );
  }
  if (!(body.role in ROLE_LABELS)) {
    return Response.json({ error: "papel inválido" }, { status: 400 });
  }
  if (body.password.length < 8) {
    return Response.json({ error: "senha: mínimo 8 caracteres" }, { status: 400 });
  }
  try {
    const user = await createUser({
      name: body.name,
      email: body.email,
      password: body.password,
      role: body.role,
      professionalType: body.professionalType ?? null,
    });
    await logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      action: "user.create",
      entityType: "user",
      entityId: user.id,
      metadata: { role: user.role },
    });
    return Response.json({ user });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const body = (await request.json()) as {
    id?: string;
    name?: string;
    email?: string;
    role?: UserRole;
    professionalType?: ProfessionalType | null;
    status?: "active" | "inactive";
    password?: string;
    /** Concessão do Admin: usuário pode escolher a própria voz da plataforma. */
    canSelectPlatformVoice?: boolean;
  };
  if (!body.id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  const target = await getUserById(body.id);
  if (!target) return Response.json({ error: "usuário não encontrado" }, { status: 404 });
  // O Admin não rebaixa nem desativa a própria conta — evita perder o acesso.
  if (
    body.id === auth.user.id &&
    ((body.role && body.role !== "admin") || body.status === "inactive")
  ) {
    return Response.json(
      { error: "não é possível rebaixar ou desativar a própria conta" },
      { status: 400 }
    );
  }
  await updateUser(body.id, body);
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    action: body.status
      ? `user.${body.status === "inactive" ? "deactivate" : "reactivate"}`
      : body.canSelectPlatformVoice !== undefined
        ? `user.voicePermission.${body.canSelectPlatformVoice ? "grant" : "revoke"}`
        : "user.update",
    entityType: "user",
    entityId: body.id,
  });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const { id } = (await request.json()) as { id?: string };
  if (!id) return Response.json({ error: "id obrigatório" }, { status: 400 });
  if (id === auth.user.id) {
    return Response.json(
      { error: "não é possível excluir a própria conta" },
      { status: 400 }
    );
  }
  const target = await getUserById(id);
  if (!target) return Response.json({ error: "usuário não encontrado" }, { status: 404 });
  // Exclui conta, sessões e vínculos. PACIENTES NÃO SÃO TOCADOS (seção 18).
  const links = await listLinksForUser(id);
  await deleteUser(id);
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    action: "user.delete",
    entityType: "user",
    entityId: id,
    metadata: { name: target.name, removedLinks: String(links.length) },
  });
  return Response.json({ ok: true });
}
