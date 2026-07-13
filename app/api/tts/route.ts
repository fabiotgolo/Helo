import { getPatientSetting } from "@/lib/store";
import { patientCloneAllowed } from "@/lib/voice";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import { requirePatientAccess, requireUser } from "@/lib/auth";
import {
  getPlatformVoice,
  resolvePatientVoice,
  resolvePlatformVoiceForUser,
} from "@/lib/voice-catalog";
import type { ConfirmationStatus, SpeakerRole } from "@/lib/types";

// Síntese de voz via ElevenLabs — provedor obrigatório dos DOIS papéis:
//   speakerRole "helo"    → voz da plataforma resolvida pelo CATÁLOGO
//                           aprovado (preferência do usuário autorizado →
//                           voz padrão definida pelo Admin → fallback);
//   speakerRole "patient" → fonte configurada para AQUELE paciente (clone
//                           dele ou voz aprovada do catálogo), somente com
//                           a confirmação exigida pelo fluxo.
//
// A resolução do voiceId é EXCLUSIVA do servidor: o cliente declara autoria
// e confirmação, nunca envia voiceId técnico. As prévias dos Ajustes também
// só referenciam ids do catálogo interno ou o clone do próprio paciente
// (com vínculo verificado) — um voiceId arbitrário não passa por aqui.
// O header X-Voice-Source informa qual voz técnica realmente soou.
// Sem ELEVENLABS_API_KEY, responde 503 e o cliente aplica o fallback aprovado.

// Voz multilíngue calma — padrão histórico do projeto quando nada foi configurado.
const DEFAULT_VOICE = "onwK4e9ZLuTAKqWW03F9";

type VoiceSourceHeader =
  | "heloElevenLabs"
  | "patientElevenLabsClone"
  | "platformCatalogVoice"
  | "approvedFallback";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    text?: string;
    speakerRole?: SpeakerRole;
    confirmationStatus?: ConfirmationStatus;
    patientId?: number;
    /** Prévia explícita dos Ajustes: uma voz ATIVA do catálogo interno. */
    previewPlatformVoiceId?: string;
    /** Prévia da voz das falas de UM paciente (exige vínculo com ele). */
    previewPatientVoice?: {
      patientId?: number;
      source?: "clone" | "platform";
      platformVoiceId?: string;
    };
  };
  const { text, patientId } = body;
  if (!text || typeof text !== "string" || text.length > 1000) {
    return Response.json({ error: "texto inválido" }, { status: 400 });
  }

  // Síntese requer login; a voz de um paciente, vínculo com ele.
  const authUser = await requireUser(request);
  if (authUser instanceof Response) return authUser;
  if (body.speakerRole === "patient" && patientId) {
    const authPatient = await requirePatientAccess(request, Number(patientId));
    if (authPatient instanceof Response) return authPatient;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "sem chave ElevenLabs" }, { status: 503 });
  }

  const speakerRole: SpeakerRole = body.speakerRole === "patient" ? "patient" : "helo";
  const confirmationStatus: ConfirmationStatus =
    body.confirmationStatus ?? "notRequired";

  let voice: string;
  let voiceSource: VoiceSourceHeader;

  if (body.previewPlatformVoiceId) {
    // Prévia de uma voz da plataforma: somente catálogo interno ATIVO.
    // O Admin também ouve vozes desativadas (avaliação antes de reativar) —
    // ainda assim, apenas ids do catálogo, nunca um voiceId livre.
    const candidate = await getPlatformVoice(body.previewPlatformVoiceId.trim());
    const canPreview =
      candidate && (candidate.enabled || authUser.user.role === "admin");
    if (!candidate || !canPreview) {
      return Response.json(
        { error: "voz inexistente ou não aprovada" },
        { status: 422 }
      );
    }
    voice = candidate.elevenLabsVoiceId;
    voiceSource = "heloElevenLabs";
  } else if (body.previewPatientVoice) {
    // Prévia da voz das falas de um paciente: vínculo verificado, e as
    // opções são as mesmas do uso real — o clone DELE ou o catálogo.
    const previewPid = Number(body.previewPatientVoice.patientId);
    if (!previewPid) {
      return Response.json({ error: "patientId obrigatório" }, { status: 400 });
    }
    const authPatient = await requirePatientAccess(request, previewPid);
    if (authPatient instanceof Response) return authPatient;
    if (body.previewPatientVoice.source === "clone") {
      const clone = await getPatientSetting(
        previewPid,
        PATIENT_SETTING_KEYS.voiceId
      ).catch(() => undefined);
      if (!clone) {
        return Response.json(
          { error: "voz clonada não configurada para este paciente" },
          { status: 422 }
        );
      }
      voice = clone;
      voiceSource = "patientElevenLabsClone";
    } else {
      const candidate = await getPlatformVoice(
        body.previewPatientVoice.platformVoiceId?.trim() ?? ""
      );
      if (!candidate || !candidate.enabled) {
        return Response.json(
          { error: "voz inexistente ou não aprovada" },
          { status: 422 }
        );
      }
      voice = candidate.elevenLabsVoiceId;
      voiceSource = "platformCatalogVoice";
    }
  } else if (speakerRole === "patient") {
    // Bloqueio de domínio (não só de interface): a voz do paciente nunca
    // soa antes da confirmação exigida pelo fluxo.
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
    // Fonte configurada para ESTE paciente: clone dele, ou a voz aprovada
    // do catálogo escolhida para as falas dele. Nunca o clone de outro.
    const resolved = await resolvePatientVoice(Number(patientId));
    if (resolved.elevenLabsVoiceId) {
      voice = resolved.elevenLabsVoiceId;
      voiceSource = resolved.source;
    } else {
      // Fallback aprovado: voz neutra, identificada como tal no header —
      // a autoria segue do paciente; nada finge ser a voz dele.
      voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
      voiceSource = "approvedFallback";
    }
  } else {
    // Voz da plataforma Helo: preferência do usuário autorizado, senão a
    // voz padrão do catálogo aprovado. A escolha de um usuário nunca muda
    // a experiência dos demais.
    const resolved = await resolvePlatformVoiceForUser(authUser.user);
    if (resolved.elevenLabsVoiceId) {
      voice = resolved.elevenLabsVoiceId;
      voiceSource = "heloElevenLabs";
    } else {
      voice = process.env.ELEVENLABS_HELO_VOICE_ID || DEFAULT_VOICE;
      voiceSource = "heloElevenLabs";
    }
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
