"use client";

// ——— Reprodução avulsa de um áudio recebido do servidor ———
//
// Três telas — Ajustes, Admin e o gerenciador de frases — tocam um áudio único
// fora do orquestrador de voz: a prévia de uma voz, a prévia de uma frase. Não
// passam por `useSpeech` porque não são fala do produto; são conferência.
//
// As três escreviam a mesma sequência, e as três erravam o mesmo ponto:
//
//     const url = URL.createObjectURL(await res.blob());
//     const audio = new Audio(url);
//     audioRef.current = audio;
//     await audio.play();
//
// O `pause()` do áudio anterior estava lá. O `revokeObjectURL` não. Cada clique
// em "ouvir" deixava um Blob preso na memória da aba, e sair da tela no meio da
// reprodução deixava o áudio tocando.
//
// Este hook é o dono. Um ObjectURL por vez, revogado quando outro o substitui,
// quando a reprodução termina, quando dá erro, quando alguém para, e na
// desmontagem. Se a tela precisa saber quando começou e quando acabou (o
// gerenciador de frases suspende a fala da plataforma enquanto a prévia toca),
// os avisos vêm por callback.

import { useCallback, useEffect, useRef } from "react";

export interface PreviewAudioCallbacks {
  /** A reprodução terminou sozinha. */
  onEnded?: () => void;
  /** O elemento de áudio falhou. */
  onError?: () => void;
}

export interface PreviewAudio {
  /** Toca o blob. Substituir uma prévia em curso libera a anterior. */
  play: (blob: Blob, callbacks?: PreviewAudioCallbacks) => Promise<void>;
  /** Para e libera. Idempotente. */
  stop: () => void;
}

export function usePreviewAudio(): PreviewAudio {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      // Os handlers saem ANTES do pause: sem isso, `pause()` dispara o
      // `onended`/`onerror` da prévia que está sendo descartada, e a tela
      // receberia o aviso de "terminou" referente ao áudio errado.
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  // Sair da tela no meio de uma prévia para o áudio e libera o Blob.
  useEffect(() => stop, [stop]);

  const play = useCallback(
    async (blob: Blob, callbacks?: PreviewAudioCallbacks) => {
      stop();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        stop();
        callbacks?.onEnded?.();
      };
      audio.onerror = () => {
        stop();
        callbacks?.onError?.();
      };
      try {
        await audio.play();
      } catch (erro) {
        // Autoplay negado ou fonte inválida: nada fica pendurado.
        stop();
        throw erro;
      }
    },
    [stop]
  );

  return { play, stop };
}
