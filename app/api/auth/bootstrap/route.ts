import {
  countUsers,
  createAuthSession,
  createUser,
  logAudit,
} from "@/lib/access";
import { sessionCookieHeader } from "@/lib/auth";

// Cria o PRIMEIRO administrador — só funciona com a base de usuários vazia.
// Depois disso, contas são criadas exclusivamente pelo Admin.
export async function POST(request: Request) {
  if ((await countUsers()) > 0) {
    return Response.json(
      { error: "instalação já inicializada" },
      { status: 403 }
    );
  }
  const { name, email, password } = (await request.json()) as {
    name?: string;
    email?: string;
    password?: string;
  };
  if (!name?.trim() || !email?.trim() || !password || password.length < 8) {
    return Response.json(
      { error: "nome, email e senha (mínimo 8 caracteres) obrigatórios" },
      { status: 400 }
    );
  }
  const user = await createUser({ name, email, password, role: "admin" });
  const token = await createAuthSession(user.id);
  await logAudit({
    userId: user.id,
    userName: user.name,
    action: "auth.bootstrap",
    entityType: "user",
    entityId: user.id,
  });
  return Response.json(
    { user },
    { headers: { "Set-Cookie": sessionCookieHeader(token) } }
  );
}
