import { getPatientSetting } from "@/lib/store";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import { requirePatientAccess, requireUser } from "@/lib/auth";
import {
  getPlatformVoice,
  resolvePatientVoice,
  resolvePlatformVoiceForUser,
} from "@/lib/voice-catalog";
import { verifySpeechGrant } from "@/lib/voice/speech-grant";
import type { SpeakerRole } from "@/lib/types";

// Síntese de voz via ElevenLabs — provedor obrigatório dos DOIS papéis:
//   speakerRole "helo"    → voz da plataforma resolvida pelo CATÁLOGO
//                           aprovado (preferência do usuário autorizado →
//                           voz padrão definida pelo Admin → fallback);
//   speakerRole "patient" → fonte configurada para AQUELE paciente (clone
//                           dele ou voz aprovada do catálogo), SOMENTE com um
//                           SpeechGrant emitido pelo servidor.
//
// ——— O que mudou na Fase 5.1A (R-01) ———
//
// Até aqui, a fala do paciente era autorizada por dois campos do CORPO da
// requisição: `speakerRole: "patient"` e `confirmationStatus: "confirmed"`.
// A verificação era feita no servidor, mas a afirmação vinha do cliente —
// qualquer usuário com vínculo podia mandar mil caracteres arbitrários e
// ouvi-los na voz clonada da pessoa.
//
// Agora a fala do paciente exige um `grant` (ver lib/voice/speech-grant.ts),
// emitido por /api/voice/grant a partir de uma ORIGEM que o servidor resolveu
// sozinho. `confirmationStatus` continua sendo aceito no corpo por
// compatibilidade com chamadas antigas, mas NÃO autoriza nada: se ele fosse
// suficiente, nada teria mudado.
//
// A resolução do voiceId segue EXCLUSIVA do servidor. O header X-Voice-Source
// informa qual voz técnica realmente soou.
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
    patientId?: number;
    /** Autorização server-side — obrigatória para a voz do paciente. */
    grant?: string;
    /** Prévia explícita dos Ajustes: uma voz ATIVA do catálogo interno. */
    previewPlatformVoiceId?: string;
    /**
     * Prévia da voz das falas de UM paciente. Continua escolhendo a FONTE
     * (clone dele ou voz do catálogo), mas o TEXTO vem do grant — a prévia
     * era, até aqui, um caminho aberto para texto livre na voz do clone.
     */
    previewPatientVoice?: {
      patientId?: number;
      source?: "clone" | "platform";
      platformVoiceId?: string;
    };
  };
  const { text } = body;
  if (!text || typeof text !== "string" || text.length > 1000) {
    return Response.json({ error: "texto inválido" }, { status: 400 });
  }

  // Síntese requer login. A voz de um paciente exige, além do vínculo, o grant.
  const authUser = await requireUser(request);
  if (authUser instanceof Response) return authUser;

  // A autorização é decidida ANTES de olhar para a chave da ElevenLabs. Duas
  // razões: uma fala não autorizada deve ser recusada mesmo com o provedor
  // fora do ar, e assim a suíte de autoria prova os 403 com a chave ausente —
  // sem gastar um único caractere pago para provar que algo é proibido.
  const speakerRole: SpeakerRole = body.speakerRole === "patient" ? "patient" : "helo";
  const preview = body.previewPatientVoice;
  // Os dois caminhos que fazem a voz DO PACIENTE soar. Ambos passam pelo
  // mesmo portão — a prévia não é uma porta lateral.
  const isPatientVoice = speakerRole === "patient" || Boolean(preview);
  const patientId = Number(preview?.patientId ?? body.patientId);

  let voice: string;
  let voiceSource: VoiceSourceHeader;

  if (isPatientVoice) {
    if (!Number.isInteger(patientId) || patientId <= 0) {
      return Response.json(
        { error: "fala do paciente exige patientId" },
        { status: 400 }
      );
    }
    // Vínculo ativo com ESTE paciente, verificado no servidor.
    const authPatient = await requirePatientAccess(request, patientId);
    if (authPatient instanceof Response) return authPatient;

    // O portão. Um grant ausente, adulterado, vencido, de outro paciente ou
    // de outro texto recusa a fala — e nenhum campo do corpo substitui isso.
    const verdict = verifySpeechGrant(body.grant, { patientId, text });
    if (!verdict.ok) {
      console.warn("[VOZ] fala do paciente recusada:", verdict.reason);
      // "misconfigured" é a única recusa que não é sobre QUEM pediu: o
      // servidor não tem chave para verificar coisa alguma. Sai como 503 para
      // não mandar quem opera procurar um problema de autorização que não
      // existe. Nos dois casos, nenhuma voz do paciente é sintetizada.
      const status = verdict.reason === "misconfigured" ? 503 : 403;
      return Response.json(
        { error: "fala do paciente sem autorização válida", reason: verdict.reason },
        { status }
      );
    }

    if (preview) {
      // Prévia: a FONTE é escolhida explicitamente, entre as mesmas opções do
      // uso real — o clone DELE ou uma voz aprovada do catálogo.
      if (preview.source === "clone") {
        const clone = await getPatientSetting(
          patientId,
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
        const candidate = await getPlatformVoice(preview.platformVoiceId?.trim() ?? "");
        if (!candidate || !candidate.enabled) {
          return Response.json(
            { error: "voz inexistente ou não aprovada" },
            { status: 422 }
          );
        }
        voice = candidate.elevenLabsVoiceId;
        voiceSource = "platformCatalogVoice";
      }
    } else {
      // Fonte configurada para ESTE paciente: clone dele, ou a voz aprovada
      // do catálogo escolhida para as falas dele. Nunca o clone de outro.
      const resolved = await resolvePatientVoice(patientId);
      if (resolved.elevenLabsVoiceId) {
        voice = resolved.elevenLabsVoiceId;
        voiceSource = resolved.source;
      } else {
        // Fallback aprovado: voz neutra, identificada como tal no header —
        // a autoria segue do paciente; nada finge ser a voz dele.
        voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
        voiceSource = "approvedFallback";
      }
    }
  } else if (body.previewPlatformVoiceId) {
    // Prévia de uma voz DA PLATAFORMA: somente catálogo interno ATIVO.
    // Não é voz de paciente — não há autoria a proteger, e por isso não exige
    // grant. O Admin também ouve vozes desativadas (avaliação antes de
    // reativar); ainda assim, apenas ids do catálogo, nunca um voiceId livre.
    const candidate = await getPlatformVoice(body.previewPlatformVoiceId.trim());
    const canPreview = candidate && (candidate.enabled || authUser.user.role === "admin");
    if (!candidate || !canPreview) {
      return Response.json(
        { error: "voz inexistente ou não aprovada" },
        { status: 422 }
      );
    }
    voice = candidate.elevenLabsVoiceId;
    voiceSource = "heloElevenLabs";
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

  // Autorizado e com a voz resolvida — só agora a configuração do provedor
  // importa. Sem chave, o cliente aplica o fallback aprovado.
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "sem chave ElevenLabs" }, { status: 503 });
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
