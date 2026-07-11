import { getPatientSetting } from "@/lib/store";

// Síntese de voz via ElevenLabs. Sem ELEVENLABS_API_KEY configurada,
// responde 503 e o cliente usa a voz local do navegador (pt-BR).
// A voz vem, em ordem: do corpo da requisição (prévia nos ajustes),
// da voz configurada para o paciente, da env, ou de um padrão multilíngue.
export async function POST(request: Request) {
  const { text, voiceId, patientId } = (await request.json()) as {
    text?: string;
    voiceId?: string;
    patientId?: number;
  };
  if (!text || typeof text !== "string" || text.length > 1000) {
    return Response.json({ error: "texto inválido" }, { status: 400 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "sem chave ElevenLabs" }, { status: 503 });
  }

  const saved = patientId
    ? await getPatientSetting(Number(patientId), "voice_id").catch(() => undefined)
    : undefined;

  const voice =
    voiceId || saved || process.env.ELEVENLABS_VOICE_ID || "onwK4e9ZLuTAKqWW03F9";

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.75,
          // Fala pausada e clara para o paciente acompanhar
          speed: 0.92,
        },
      }),
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    console.error("ElevenLabs TTS falhou:", res.status, detail);
    return Response.json({ error: "falha na síntese" }, { status: 502 });
  }

  return new Response(res.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
