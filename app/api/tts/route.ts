import { getPatientSetting } from "@/lib/store";
import { patientCloneAllowed } from "@/lib/voice";
import type { ConfirmationStatus, SpeakerRole } from "@/lib/types";

// Síntese de voz via ElevenLabs — provedor obrigatório dos DOIS papéis:
//   speakerRole "helo"    → voz oficial da plataforma (ELEVENLABS_HELO_VOICE_ID);
//   speakerRole "patient" → voz clonada do paciente (setting voice_id), somente
//                           com a confirmação exigida pelo fluxo; sem clone,
//                           voz neutra claramente identificada (fallback
//                           aprovado), nunca fingindo ser a voz do paciente.
//
// A resolução do voiceId é EXCLUSIVA do servidor: o cliente declara autoria e
// confirmação, nunca escolhe voz (exceto a prévia dos Ajustes, explícita).
// O header X-Voice-Source informa qual voz técnica realmente soou.
// Sem ELEVENLABS_API_KEY, responde 503 e o cliente aplica o fallback aprovado.

// Voz multilíngue calma — padrão histórico do projeto quando nada foi configurado.
const DEFAULT_VOICE = "onwK4e9ZLuTAKqWW03F9";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    text?: string;
    speakerRole?: SpeakerRole;
    confirmationStatus?: ConfirmationStatus;
    patientId?: number;
    /** Prévia explícita dos Ajustes — único caminho em que o cliente indica voz. */
    previewVoiceId?: string;
  };
  const { text, patientId, previewVoiceId } = body;
  if (!text || typeof text !== "string" || text.length > 1000) {
    return Response.json({ error: "texto inválido" }, { status: 400 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "sem chave ElevenLabs" }, { status: 503 });
  }

  const speakerRole: SpeakerRole = body.speakerRole === "patient" ? "patient" : "helo";
  const confirmationStatus: ConfirmationStatus =
    body.confirmationStatus ?? "notRequired";

  let voice: string;
  let voiceSource: "heloElevenLabs" | "patientElevenLabsClone" | "approvedFallback";

  if (previewVoiceId) {
    // Prévia dos Ajustes: a família ouve uma voz candidata antes de salvar.
    voice = previewVoiceId;
    voiceSource = "approvedFallback";
  } else if (speakerRole === "patient") {
    // Bloqueio de domínio (não só de interface): a voz clonada nunca soa
    // antes da confirmação exigida pelo fluxo.
    if (!patientCloneAllowed(speakerRole, confirmationStatus)) {
      return Response.json(
        { error: "fala do paciente sem confirmação exigida pelo fluxo" },
        { status: 403 }
      );
    }
    if (!patientId) {
      return Response.json(
        { error: "fala do paciente exige patientId" },
        { status: 400 }
      );
    }
    const clone = await getPatientSetting(Number(patientId), "voice_id").catch(
      () => undefined
    );
    if (clone) {
      voice = clone;
      voiceSource = "patientElevenLabsClone";
    } else {
      // Fallback aprovado: voz neutra, identificada como tal no header —
      // a autoria segue do paciente; nada finge ser a voz dele.
      voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
      voiceSource = "approvedFallback";
    }
  } else {
    // Voz oficial da plataforma Helo — identidade sonora única e persistente.
    // Nunca usa a voz configurada do paciente.
    voice = process.env.ELEVENLABS_HELO_VOICE_ID || DEFAULT_VOICE;
    voiceSource = "heloElevenLabs";
  }

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
      "X-Voice-Source": voiceSource,
    },
  });
}
