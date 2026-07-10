"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ROTINA } from "@/lib/flow";
import type { Gesture } from "@/lib/types";
import { useGestures } from "@/lib/gestures";
import { logEvent, saveMessage, startSession, endSession } from "@/lib/log";
import { useHelo } from "@/lib/helo-state";
import { GestureTriplet } from "@/components/ui";
import { OverlayVeil } from "@/components/overlay-panel";

type Pending = { label: string; phrase: string; category: string };

export default function RotinaPage() {
  const { speak } = useHelo();
  const gestures = useGestures();
  const [pending, setPending] = useState<Pending | null>(null);
  const sessionRef = useRef<number | null>(null);
  // Marcado em propose(); o valor inicial nunca é lido (onGesture exige pending)
  const shownAt = useRef(0);

  const ensureSession = useCallback(async () => {
    if (sessionRef.current == null) {
      sessionRef.current = await startSession("rotina");
    }
    return sessionRef.current;
  }, []);

  useEffect(() => {
    const handler = () => endSession(sessionRef.current);
    window.addEventListener("beforeunload", handler);
    return () => {
      handler();
      window.removeEventListener("beforeunload", handler);
    };
  }, []);

  const propose = useCallback(
    async (item: Pending) => {
      const sid = await ensureSession();
      setPending(item);
      shownAt.current = Date.now();
      logEvent({
        sessionId: sid,
        type: "pergunta_apresentada",
        category: item.category,
        question: `Confirma: ${item.phrase}`,
      });
      void speak(`Você quer dizer: ${item.phrase} — Confirma?`);
    },
    [ensureSession, speak]
  );

  const onGesture = useCallback(
    (g: Gesture) => {
      if (!pending) return;
      const sid = sessionRef.current;
      logEvent({
        sessionId: sid,
        type: "gesto",
        category: pending.category,
        question: `Confirma: ${pending.phrase}`,
        gesture: g,
        responseMs: Date.now() - shownAt.current,
      });
      if (g === "sim") {
        logEvent({ sessionId: sid, type: "confirmacao", category: pending.category, detail: pending.phrase });
        void saveMessage({
          sessionId: sid,
          text: pending.phrase,
          category: pending.category,
          status: "confirmada",
        });
        void speak(pending.phrase);
      } else if (g === "nao") {
        logEvent({ sessionId: sid, type: "descarte", category: pending.category, detail: pending.phrase });
        void saveMessage({
          sessionId: sid,
          text: pending.phrase,
          category: pending.category,
          status: "descartada",
        });
      } else {
        logEvent({ sessionId: sid, type: "reformulacao", category: pending.category, detail: pending.phrase });
      }
      setPending(null);
    },
    [pending, speak]
  );

  return (
    <div className="relative flex flex-1 flex-col">
      {/* Fase 7 — Rotina imersiva: o orbe Rotina assume o centro do palco e
          um véu leve cobre a cena; as frases flutuam DIRETO sobre ele, que
          segue visível e animado através da camada. Só o conteúdo troca
          (com fade) entre grade e confirmação — o palco nunca desmonta. */}
      <OverlayVeil />
      <main className="relative flex w-full flex-1 flex-col items-center justify-center px-4 pb-6 sm:px-6">
        {pending ? (
          <section
            key="confirmar"
            aria-live="polite"
            aria-label="Confirmar frase"
            className="fade-rise pointer-events-auto mx-auto flex w-full max-w-3xl flex-col items-center gap-10 py-8"
          >
            <p className="text-sm font-semibold uppercase tracking-widest text-ink-soft">
              Confirmar mensagem
            </p>
            <blockquote className="text-center text-4xl font-medium leading-snug tracking-tight sm:text-5xl">
              “{pending.phrase}”
            </blockquote>
            <GestureTriplet onGesture={onGesture} />
            <p className="text-sm text-ink-mute">
              {gestures.sim.emoji} falar e registrar · {gestures.talvez.emoji} não é bem isso · {gestures.nao.emoji} descartar
            </p>
          </section>
        ) : (
          <section
            key="frases"
            aria-label="Rotina"
            className="fade-rise pointer-events-auto mx-auto flex w-full max-w-4xl flex-col gap-8 py-8"
          >
            <div className="text-center">
              <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">Rotina</h1>
              <p className="mt-2 text-lg text-ink-soft">
                Toque na frase que o paciente indicou. Ele confirma com um gesto antes de o Helo falar.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {ROTINA.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => void propose(item)}
                  className="rounded-3xl border border-line/70 bg-card/70 px-5 py-8 text-xl font-medium tracking-tight shadow-[var(--shadow-soft)] backdrop-blur-md transition-transform hover:scale-[1.03] active:scale-[0.98]"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
