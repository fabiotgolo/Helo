import { countUsers } from "@/lib/access";
import { getSessionUser } from "@/lib/auth";

// Estado de autenticação do cliente. `needsBootstrap` indica instalação
// nova (nenhum usuário): a tela de login oferece criar o primeiro Admin.
export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (user) return Response.json({ user, needsBootstrap: false });
  const needsBootstrap = (await countUsers()) === 0;
  return Response.json({ user: null, needsBootstrap });
}
