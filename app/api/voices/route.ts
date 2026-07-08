// Lista as vozes disponíveis na conta ElevenLabs.
export async function GET() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "sem chave ElevenLabs" }, { status: 503 });
  }
  const res = await fetch("https://api.elevenlabs.io/v2/voices?page_size=50", {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    return Response.json({ error: "falha ao listar vozes" }, { status: 502 });
  }
  const data = (await res.json()) as {
    voices: { voice_id: string; name: string; labels?: Record<string, string> }[];
  };
  return Response.json({
    voices: data.voices.map((v) => ({
      id: v.voice_id,
      name: v.name,
      labels: v.labels ?? {},
    })),
  });
}
