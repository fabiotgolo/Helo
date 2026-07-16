import { requirePatientAccess } from "@/lib/auth";
import { hasPermission } from "@/lib/access-types";

// Capacidades de edicao da tela Ajustes para o paciente ativo. Isto so orienta
// a interface; cada rota de escrita continua validando permissao no servidor.
export async function GET(request: Request) {
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!patientId) {
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }

  const auth = await requirePatientAccess(request, patientId);
  if (auth instanceof Response) return auth;

  const admin = auth.link === null;
  return Response.json({
    profile: admin || hasPermission(auth.link, "editProfile"),
    conversation: admin || hasPermission(auth.link, "editConversation"),
    gestures: admin || hasPermission(auth.link, "editGestures"),
    // Saudação e voz pertencem ao Agent Helo, não à fala do paciente. Um
    // vínculo ativo já é a autorização mínima, ainda conferida no POST.
    heloGreeting: true,
  });
}
