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

// Precisa se chamar exatamente "__session": atrás do Firebase Hosting, o CDN
// descarta TODOS os cookies das requisições ao backend, exceto este nome.
// Sem isso, a sessão não chega ao servidor em heloapp.web.app (401 no login).
export const SESSION_COOKIE = "__session";

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
/**
 * A fila offline diz de QUEM ela é; o servidor confere (R6 da auditoria,
 * gravidade **crítica**).
 *
 * O cookie de sessão é ambiente: `fetch` manda o que estiver valendo no
 * navegador AGORA, não o que valia quando o cuidador escreveu. Numa máquina
 * de plantão, com duas abas, isso é alcançável sem nada de exótico — o
 * cuidador A tem fila pendente, B entra na outra aba, e a fila de A passa a
 * sair com a credencial de B. Como o servidor grava `assistantId` do usuário
 * autenticado, a pergunta de A entraria no prontuário assinada por B. Uma
 * autoria trocada não tem como ser detectada depois: não existe nada no
 * registro que denuncie a troca.
 *
 * Por que aqui, e não no cliente: o cliente também confere (é o que evita
 * gastar a requisição), mas uma checagem que só existe no cliente é uma
 * checagem que uma aba velha, um bug de estado ou um script podem pular. Esta
 * fica no caminho por onde TODA rota de paciente passa.
 *
 * Sem `expectedUserId` nada muda — é o caso de todo cliente online, e das
 * operações enfileiradas antes desta fase.
 */
function identidadeConfere(user: AppUser, expectedUserId: unknown): boolean {
  if (typeof expectedUserId !== "string" || !expectedUserId) return true;
  return expectedUserId === user.id;
}

export async function requirePatientAccess(
  request: Request,
  patientId: number,
  permission?: Permission,
  expectedUserId?: unknown
): Promise<{ user: AppUser; link: AccessLink | null } | Response> {
  const user = await getSessionUser(request);
  if (!user) return unauthorized();
  if (!identidadeConfere(user, expectedUserId)) {
    // 403 e não 401: a sessão é válida: ela é de OUTRA pessoa. Mandar entrar
    // de novo não resolveria, e o cliente precisa distinguir os dois — um
    // pede reautenticação, o outro pede que o dono da fila volte.
    return Response.json(
      {
        error:
          "estes registros são de outro cuidador; entre com a conta de quem os criou para enviá-los",
        code: "IDENTITY_MISMATCH",
      },
      { status: 403 }
    );
  }
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
