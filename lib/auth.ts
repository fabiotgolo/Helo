// ——— Guardas de autorização das rotas de API ———
// A regra do produto: NENHUMA rota confia no frontend. Toda leitura/escrita
// com escopo de paciente passa por requirePatientAccess — vínculo ativo
// (ou papel admin) verificado no servidor, contra o Firestore.

import {
  getLink,
  getSessionUserId,
  getUserById,
} from "@/lib/access";
import type { AccessLink, AppUser, Permission } from "@/lib/access-types";

export const SESSION_COOKIE = "helo_session";

export function sessionCookieHeader(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${secure}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readSessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

/** Usuário autenticado e ativo — null se sem sessão válida. */
export async function getSessionUser(request: Request): Promise<AppUser | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const userId = await getSessionUserId(token);
  if (!userId) return null;
  const user = await getUserById(userId);
  if (!user || user.status !== "active") return null;
  return user;
}

function unauthorized(): Response {
  return Response.json({ error: "não autenticado" }, { status: 401 });
}

function forbidden(msg = "acesso negado"): Response {
  return Response.json({ error: msg }, { status: 403 });
}

export async function requireUser(
  request: Request
): Promise<{ user: AppUser } | Response> {
  const user = await getSessionUser(request);
  return user ? { user } : unauthorized();
}

export async function requireAdmin(
  request: Request
): Promise<{ user: AppUser } | Response> {
  const user = await getSessionUser(request);
  if (!user) return unauthorized();
  if (user.role !== "admin") return forbidden("exclusivo do administrador");
  return { user };
}

/**
 * Autorização real por paciente: exige vínculo ativo com o patientId
 * (admin passa sem vínculo). Se `permission` for informada, o vínculo
 * precisa concedê-la. Retorna Response (401/403) quando negado.
 */
export async function requirePatientAccess(
  request: Request,
  patientId: number,
  permission?: Permission
): Promise<{ user: AppUser; link: AccessLink | null } | Response> {
  const user = await getSessionUser(request);
  if (!user) return unauthorized();
  if (!patientId || Number.isNaN(patientId)) {
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }
  if (user.role === "admin") return { user, link: null };
  const link = await getLink(user.id, patientId);
  if (!link) return forbidden("sem vínculo com este paciente");
  if (permission && !link.permissions.includes(permission)) {
    return forbidden(`permissão necessária: ${permission}`);
  }
  return { user, link };
}
