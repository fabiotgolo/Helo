import { requireUser } from "@/lib/auth";
import { setUserTheme } from "@/lib/access";
import { isThemeId, sanitizeFontScales } from "@/lib/access-types";

// Preferências VISUAIS (tema de cores + escala de fonte por tema) do PRÓPRIO
// usuário. Escopo: só a interface dele — nunca altera dados do paciente nem a
// experiência de outros usuários. Qualquer usuário autenticado pode escolher.
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const body = (await request.json().catch(() => ({}))) as {
    theme?: string | null;
    fontScales?: Record<string, number> | null;
  };

  const updates: {
    themePreference?: string | null;
    themeFontScales?: Record<string, number> | null;
  } = {};

  if ("theme" in body) {
    const chosen = body.theme?.trim() || null;
    // Só ids de tema conhecidos são aceitos — um valor manipulado no cliente
    // não chega ao armazenamento.
    if (chosen !== null && !isThemeId(chosen)) {
      return Response.json({ error: "tema inválido" }, { status: 422 });
    }
    updates.themePreference = chosen;
  }

  if ("fontScales" in body) {
    // O sanitizador descarta chaves/valores inválidos e devolve null quando
    // tudo está no padrão — nada manipulado chega ao armazenamento.
    updates.themeFontScales = sanitizeFontScales(body.fontScales);
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: "nada a atualizar" }, { status: 422 });
  }

  await setUserTheme(user.id, updates);
  return Response.json({ ok: true });
}
