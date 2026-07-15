// ——— Domínio da orquestração de voz da Helo ———
// Dois papéis vocais, ambos ElevenLabs:
//   - "helo"    → a voz oficial da PLATAFORMA (apresentação, perguntas,
//                 instruções, avisos, Rotina por definição atual do produto);
//   - "patient" → a voz do PACIENTE (clonada/personalizada), usada somente
//                 quando a frase é efetivamente uma fala dele.
//
// speakerRole responde "quem é o autor da fala"; voiceSource responde "qual
// voz técnica sintetiza o áudio". Os dois conceitos nunca se misturam: a
// resolução de voiceSource acontece aqui e no servidor (/api/tts) — nunca
// espalhada por componentes visuais.

import type { ConfirmationStatus, HeloItemMode, SpeakerRole } from "@/lib/types";

/** Voz técnica que sintetiza o áudio de uma fala. */
export type VoiceSource =
  | "heloElevenLabs" // voz da plataforma (catálogo aprovado, ElevenLabs)
  | "patientElevenLabsClone" // voz clonada/personalizada do paciente (ElevenLabs)
  | "platformCatalogVoice" // fala DO PACIENTE vocalizada por uma voz aprovada
  //                          do catálogo (escolha explícita) — a autoria
  //                          (speakerRole) continua sendo "patient"
  | "approvedFallback" // fallback aprovado pelo produto, claramente identificado
  | "none";

/** Quem está falando agora — consumido pelo Orb e pela interface. */
export type ActiveSpeaker = "platform" | "patient" | "none";

export type VoiceState = "idle" | "loading" | "speaking" | "interrupted" | "error";

/** Opções de uma fala. Sem opções, a fala pertence à plataforma. */
export interface SpeakOptions {
  speakerRole?: SpeakerRole;
  /** Exigido para a voz clonada: "confirmed" (gesto) ou "notRequired" (fluxo sem confirmação, ex.: Emergência). */
  confirmationStatus?: ConfirmationStatus;
  /** Paciente autor da fala — obrigatório quando speakerRole = "patient". */
  patientId?: number | null;
  mode?: HeloItemMode;
}

/**
 * Regra obrigatória de confirmação (bloqueada no domínio, não só na UI):
 * a voz clonada do paciente só pode soar quando a fala é dele E o fluxo já
 * a liberou — por gesto confirmado ou por definição do produto de que o
 * fluxo dispensa confirmação (Emergência: o toque é a confirmação).
 */
export function patientCloneAllowed(
  speakerRole: SpeakerRole,
  confirmationStatus: ConfirmationStatus
): boolean {
  return (
    speakerRole === "patient" &&
    (confirmationStatus === "confirmed" || confirmationStatus === "notRequired")
  );
}

/**
 * Autoria por modo — definição ATUAL do produto:
 *   Rotina     → plataforma (mesmo que o texto seja necessidade do paciente);
 *   Emergência → paciente;
 *   Conversa   → paciente (as frases confirmadas; a condução é da plataforma).
 * Ponto único de resolução: quando um item individual ganhar autoria
 * explícita editável (o campo ModeItem.speakerRole já existe), a exceção
 * por item entra aqui — nunca hardcoded nas telas.
 */
export function modeSpeakerRole(mode: HeloItemMode): SpeakerRole {
  return mode === "rotina" ? "helo" : "patient";
}

/**
 * Chave de cache de áudio. Inclui papel E paciente: áudio da plataforma é
 * compartilhável; áudio do paciente nunca contamina outro paciente nem
 * responde por uma fala da plataforma com o mesmo texto.
 */
export function audioCacheKey(
  speakerRole: SpeakerRole,
  patientId: number | null,
  text: string
): string {
  return speakerRole === "helo"
    ? `helo||${text}`
    : `patient|${patientId ?? "?"}|${text}`;
}
