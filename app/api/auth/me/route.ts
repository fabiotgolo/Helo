import { countUsers } from "@/lib/access";
import { getSessionUser } from "@/lib/auth";
import { jsonSemCache } from "@/lib/cache-policy";

// Estado de autenticação do cliente. `needsBootstrap` indica instalação
// nova (nenhum usuário): a tela de login oferece criar o primeiro Admin.
//
// ——— A-10b ———
//
// É um GET que devolve o usuário autenticado inteiro — nome, papel,
// preferências —, e a 5.4C mediu esta rota EM PRODUÇÃO: ela chega ao
// navegador com `Cache-Control: no-cache`, que não é da rota (ela não define
// nenhum) e sim da camada de Hosting. `no-cache` permite GUARDAR a resposta
// desde que se revalide; para a identidade de quem está logado, guardar é o
// que não se quer. `no-store` diz a coisa certa, e diz na origem.
export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (user) return jsonSemCache({ user, needsBootstrap: false });
  const needsBootstrap = (await countUsers()) === 0;
  return jsonSemCache({ user: null, needsBootstrap });
}
