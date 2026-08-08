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

/**
 * Referência a um recurso do servidor — a forma como a tela diz DE ONDE vem a
 * fala, em vez de afirmar que ela está autorizada.
 *
 * Espelha `SpeechSource` em lib/voice/speech-sources.ts; repetida aqui porque
 * aquele módulo importa Firestore e não pode atravessar para o cliente.
 */
export type SpeechSourceRef =
  | { kind: "routineAnswer"; questionKey: string; answer: "yes" | "maybe" | "no" }
  | { kind: "emergencyItem"; itemId?: string; defaultKey?: string }
  | { kind: "activityResponse"; runId: string; itemId: string; optionId: string; gesture: "sim" | "talvez" | "nao" }
  | { kind: "favoritePhrase"; phraseId: string }
  | { kind: "confirmedMessage"; messageId: string }
  | { kind: "patientVoicePreview" };

/** Opções de uma fala. Sem opções, a fala pertence à plataforma. */
export interface SpeakOptions {
  speakerRole?: SpeakerRole;
  /**
   * Estatuto da confirmação no FLUXO da tela. Continua governando o gate local
   * (a interface não tenta falar o que o fluxo ainda não liberou), mas deixou
   * de ser autorização: o servidor não o aceita mais como prova. Ver
   * `source`/`grant`.
   */
  confirmationStatus?: ConfirmationStatus;
  /** Paciente autor da fala — obrigatório quando speakerRole = "patient". */
  patientId?: number | null;
  /** Recurso do servidor que autoriza esta fala do paciente. */
  source?: SpeechSourceRef;
  /** Grant já emitido pelo servidor (ex.: devolvido por /api/messages). */
  grant?: string;
  mode?: HeloItemMode;
  /**
   * Prioridade da fala perante o Audio Manager.
   * - "patientEmergency": a frase de emergência DO PACIENTE tem prioridade
   *   MÁXIMA — interrompe/suprime a voz do Agente Helo e da plataforma e as
   *   bloqueia até terminar (nunca espera brecha).
   * - "patientResponse": a resposta DO PACIENTE na Rotina (SIM/TALVEZ/NÃO)
   *   também é fala dele e prevalece sobre o Agente — atravessa o gate de
   *   "Agente ativo" e assume o áudio como saída principal.
   * Ambas respeitam a hierarquia (paciente > Agente > plataforma) e o MUTE
   * SEMPRE bloqueia, inclusive estas. Sem o marcador, a fala segue a regra
   * padrão (bloqueada enquanto o Agente estiver ativo).
   */
  priority?: "patientEmergency" | "patientResponse";
}

/**
 * Gate LOCAL do fluxo: a interface não tenta falar o que o fluxo da tela ainda
 * não liberou — por gesto confirmado, ou por definição do produto de que o
 * fluxo dispensa confirmação (Emergência: o toque é a confirmação).
 *
 * Isto NÃO é a autorização. Desde a Fase 5.1A quem autoriza a voz do paciente
 * é o SpeechGrant emitido pelo servidor (lib/voice/speech-grant.ts): esta
 * função roda só no cliente, e um cliente não pode se autorizar. Ela continua
 * existindo porque evita um round-trip inútil para uma fala que o próprio
 * fluxo já sabe que não deve acontecer.
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
 * Autoria por modo — as frases dos três modos representam o PACIENTE falando:
 *   Rotina     → paciente ("Estou cansado", "Estou com dor"…): usa a voz dele
 *                (clone/catálogo configurado em Ajustes), com fallback aprovado
 *                quando não houver voz configurada;
 *   Emergência → paciente ("Preciso de ajuda"…);
 *   Conversa   → paciente (as frases confirmadas; a condução é da plataforma).
 * A CONDUÇÃO/instrução da plataforma ("Você quer dizer… — Confirma?") é falada
 * à parte, por speak() sem opções → voz "helo". A resolução técnica do voiceId
 * (clone → catálogo → fallback) é EXCLUSIVA do servidor (/api/tts).
 * Ponto único de resolução: quando um item individual ganhar autoria
 * explícita editável (o campo ModeItem.speakerRole já existe), a exceção
 * por item entra aqui — nunca hardcoded nas telas.
 */
const MODE_SPEAKER_ROLE: Record<HeloItemMode, SpeakerRole> = {
  rotina: "patient",
  emergencia: "patient",
  conversa: "patient",
};
export function modeSpeakerRole(mode: HeloItemMode): SpeakerRole {
  return MODE_SPEAKER_ROLE[mode];
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
