export const PHRASE_AUDIO_EVENT = "helo:phrase-audio";

/** Pausa a captura do Agent enquanto uma frase gravada é reproduzida. */
export function setPhraseAudioPlaying(playing: boolean): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PHRASE_AUDIO_EVENT, { detail: { playing } }));
  }
}
