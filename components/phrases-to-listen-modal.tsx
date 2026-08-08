"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FavoritePhrase } from "@/lib/favorite-phrases";
import { setPhraseAudioPlaying } from "@/lib/phrase-audio";
import { ModalShell } from "@/components/modal-shell";
import { useRegisterHeloUIActions, type HeloUIAction } from "@/lib/helo-action-registry";

export function PhrasesToListenModal({
  patientId,
  phrases,
  onClose,
}: {
  patientId: number;
  phrases: FavoritePhrase[];
  onClose: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const phrase = phrases[index];
  const hasNavigation = phrases.length > 1;

  const cleanupAudio = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    startingRef.current = false;
    setIsPlaying(false);
    setPhraseAudioPlaying(false);
  };

  useEffect(() => cleanupAudio, []);

  async function playPhrase() {
    // Ignora completamente toques repetidos enquanto há síntese ou áudio.
    if (isPlaying || startingRef.current) return;
    startingRef.current = true;
    setError(null);
    cleanupAudio();
    startingRef.current = true;
    // Também reflete a guarda no React para desabilitar visualmente o botão
    // enquanto a TTS está sendo buscada.
    setIsPlaying(true);

    try {
      let source = phrase.audioUrl;
      if (!source) {
        // A frase é um recurso do paciente: o servidor a resolve por id e
        // devolve o texto junto com a autorização. Nada de texto livre aqui.
        const authorization = await fetch("/api/voice/grant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            patientId,
            source: { kind: "favoritePhrase", phraseId: phrase.id },
          }),
        });
        if (!authorization.ok) {
          throw new Error("Não foi possível preparar a voz do paciente.");
        }
        const granted = (await authorization.json()) as { grant: string; text: string };
        const response = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            patientId,
            text: granted.text,
            speakerRole: "patient",
            grant: granted.grant,
          }),
        });
        if (!response.ok) throw new Error("Não foi possível preparar a voz do paciente.");
        objectUrlRef.current = URL.createObjectURL(await response.blob());
        source = objectUrlRef.current;
      }

      const audio = new Audio(source);
      audioRef.current = audio;
      const finish = () => cleanupAudio();
      audio.onended = finish;
      audio.onerror = () => {
        setError("Não foi possível reproduzir esta frase.");
        finish();
      };
      await audio.play();
      setPhraseAudioPlaying(true);
    } catch (caught) {
      setError((caught as Error).message || "O navegador bloqueou a reprodução do áudio.");
      cleanupAudio();
    } finally {
      // A ref continua protegendo enquanto isPlaying estiver true; ao falhar,
      // cleanupAudio libera ambos os estados para uma nova tentativa.
      if (!audioRef.current) startingRef.current = false;
    }
  }

  function changePhrase(nextIndex: number) {
    cleanupAudio();
    setIndex(Math.max(0, Math.min(phrases.length - 1, nextIndex)));
  }

  function close() {
    cleanupAudio();
    onClose();
  }

  const dialogActions = useMemo<HeloUIAction[]>(
    () => {
      const actions: HeloUIAction[] = [{
        actionId: "atividades.frases.ouvir",
        actionClass: "patientResponse",
        label: "Ouvir frase",
        aliases: [
          "ouvir a frase",
          "reproduzir frase",
          "tocar frase",
          "clique em ouvir frase",
          `ouvir ${phrase.text}`,
        ],
        type: "activity",
        enabled: !isPlaying && !startingRef.current,
        run: () => void playPhrase(),
        toolSuccess: {
          result: "handled",
          audio: "phrase_playback_started",
          speechOwner: "patient",
          suppressAssistantNarration: true,
        },
      }];
      if (hasNavigation) {
        actions.push(
          {
            actionId: "atividades.frases.anterior",
            actionClass: "navigation",
            label: "Seta da esquerda — frase anterior",
            aliases: [
              "clique na seta da esquerda",
              "seta da esquerda",
              "frase anterior",
              "voltar frase",
            ],
            type: "navigation",
            enabled: index > 0,
            run: () => changePhrase(index - 1),
            toolSuccess: { result: "handled", phraseIndex: index, suppressAssistantNarration: true },
          },
          {
            actionId: "atividades.frases.proxima",
            actionClass: "navigation",
            label: "Seta da direita — próxima frase",
            aliases: [
              "clique na seta da direita",
              "seta da direita",
              "próxima frase",
              "proxima frase",
              "avançar frase",
            ],
            type: "navigation",
            enabled: index < phrases.length - 1,
            run: () => changePhrase(index + 1),
            toolSuccess: { result: "handled", phraseIndex: index + 2, suppressAssistantNarration: true },
          }
        );
      }
      return actions;
    },
    [hasNavigation, index, isPlaying, phrase, phrases.length]
  );
  useRegisterHeloUIActions(dialogActions);

  return (
    <ModalShell onClose={close} label="Frases para se ouvir" className="max-w-xl">
        <div className="flex justify-end">
          <button type="button" onClick={close} className="rounded-xl border border-line bg-card px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-cream">
            Fechar
          </button>
        </div>
        {error && <p role="alert" className="mt-3 rounded-xl bg-nao-soft px-3 py-2 text-sm text-nao">{error}</p>}
        <div className="mt-3 grid grid-cols-[auto_1fr_auto] items-center gap-3">
          {hasNavigation ? (
            <button type="button" onClick={() => changePhrase(index - 1)} disabled={index === 0} aria-label="Frase anterior" className="grid size-11 place-items-center rounded-full border border-line text-xl disabled:opacity-35">‹</button>
          ) : <span />}
          <article className="min-h-52 rounded-3xl border border-line/70 bg-cream/40 px-5 py-7 text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-ink-soft">Frase {index + 1} de {phrases.length}</p>
            <p className="mt-4 text-2xl font-medium leading-relaxed sm:text-3xl">“{phrase.text}”</p>
            {phrase.category && <p className="mt-3 text-sm text-ink-soft">{phrase.category}</p>}
            <button type="button" onClick={() => void playPhrase()} disabled={isPlaying || startingRef.current} className="mx-auto mt-5 flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-60">{isPlaying || startingRef.current ? "Ouvindo…" : "▶ Ouvir frase"}</button>
          </article>
          {hasNavigation ? (
            <button type="button" onClick={() => changePhrase(index + 1)} disabled={index === phrases.length - 1} aria-label="Próxima frase" className="grid size-11 place-items-center rounded-full border border-line text-xl disabled:opacity-35">›</button>
          ) : <span />}
        </div>
        {hasNavigation && <div className="mt-5 flex justify-center gap-2" aria-label="Selecionar frase">{phrases.map((item, itemIndex) => <button type="button" key={item.id} onClick={() => changePhrase(itemIndex)} aria-label={`Ir para frase ${itemIndex + 1}`} aria-current={itemIndex === index} className={`size-2.5 rounded-full ${itemIndex === index ? "bg-accent" : "bg-line"}`} />)}</div>}
    </ModalShell>
  );
}
