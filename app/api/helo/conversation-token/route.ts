import { requireUser } from "@/lib/auth";

// O SDK React usa WebRTC para conversas por voz. A credencial retornada aqui
// expira e não dá acesso à API da ElevenLabs nem aos demais recursos da conta.
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;

  const agentId = process.env.ELEVENLABS_HELO_AGENT_ID?.trim();
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!agentId) {
    return Response.json({ error: "Agent Helo não configurado" }, { status: 503 });
  }
  if (!apiKey) {
    return Response.json({ error: "Serviço de voz não configurado" }, { status: 503 });
  }

  try {
    const params = new URLSearchParams({ agent_id: agentId });
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?${params}`,
      { headers: { "xi-api-key": apiKey }, cache: "no-store" }
    );
    if (!response.ok) {
      console.error("Falha ao obter token temporário do Agent Helo:", response.status);
      return Response.json({ error: "Não foi possível conectar com a Helo" }, { status: 502 });
    }
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== "string" || !body.token) {
      return Response.json({ error: "Resposta inválida do serviço de voz" }, { status: 502 });
    }
    return Response.json({ conversationToken: body.token });
  } catch (error) {
    console.error("Erro ao obter token temporário do Agent Helo:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Serviço de voz indisponível" }, { status: 502 });
  }
}
