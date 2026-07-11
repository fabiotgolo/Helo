import {
  createAuthSession,
  getUserByEmail,
  logAudit,
  verifyPassword,
} from "@/lib/access";
import { sessionCookieHeader } from "@/lib/auth";

export async function POST(request: Request) {
  const { email, password } = (await request.json()) as {
    email?: string;
    password?: string;
  };
  if (!email?.trim() || !password) {
    return Response.json({ error: "email e senha obrigatórios" }, { status: 400 });
  }
  const user = await getUserByEmail(email);
  // Mesma resposta para email inexistente e senha errada.
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return Response.json({ error: "credenciais inválidas" }, { status: 401 });
  }
  if (user.status !== "active") {
    return Response.json({ error: "conta desativada" }, { status: 403 });
  }
  const token = await createAuthSession(user.id);
  await logAudit({ userId: user.id, userName: user.name, action: "auth.login" });
  const { passwordHash: _hash, ...safe } = user;
  void _hash;
  return Response.json(
    { user: safe },
    { headers: { "Set-Cookie": sessionCookieHeader(token) } }
  );
}
