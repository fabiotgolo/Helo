"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Gesture, ModeItem } from "@/lib/types";
import { useGestures } from "@/lib/gestures";
import { usePatient, usePatientItems } from "@/lib/patient";
import { DEFAULT_ITEMS, modeSpeakerRole } from "@/lib/defaults";
import { logEvent, saveMessage, startSession, endSession } from "@/lib/log";
import { useHelo } from "@/lib/helo-state";
import { GestureTriplet } from "@/components/ui";
import { OverlayVeil } from "@/components/overlay-panel";

// Modo rotina: as frases rápidas são DO PACIENTE (personalizáveis em
// Ajustes), com espelho local — o modo continua funcionando sem IA e sem
// rede. Se ainda não há nada carregado (primeiro uso offline), o conteúdo
// padrão da Helo entra como rede de segurança.

type Pending = {
  itemId: string | null;
  label: string;
  phrase: string;
  category: string;
};

export default function RotinaPage() {
  const { speak } = useHelo();
  const gestures = useGestures();
  const { patientId } = usePatient();
  const { enabledItems, loading } = usePatientItems("rotina");
  const [pending, setPending] = useState<Pending | null>(null);
  const sessionRef = useRef<number | null>(null);
  // Marcado em propose(); o valor inicial nunca é lido (onGesture exige pending)
  const shownAt = useRef(0);
  // Trava contra duplo toque: o gesto vale uma única vez por confirmação.
  const answeredRef = useRef(false);

  // Rede de segurança: sem itens do paciente (primeiro uso sem rede),
  // a Rotina apresenta o conteúdo padrão — nunca uma tela vazia.
  const items: Pending[] = useMemo(() => {
    if (enabledItems.length > 0) {
      return enabledItems.map((i: ModeItem) => ({
        itemId: i.id,
        label: i.label,
        phrase: i.spokenText,
        category: i.category,
      }));
    }
    if (loading) return [];
    return DEFAULT_ITEMS.rotina.map((d) => ({
      itemId: null,
      label: d.label,
      phrase: d.spokenText,
      category: d.category,
    }));
  }, [enabledItems, loading]);

  const ensureSession = useCallback(async () => {
    if (sessionRef.current == null) {
      sessionRef.current = await startSession("rotina", undefined, patientId);
    }
    return sessionRef.current;
  }, [patientId]);

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
      answeredRef.current = false;
      shownAt.current = Date.now();
      logEvent({
        sessionId: sid,
        patientId,
        itemId: item.itemId ?? undefined,
        type: "pergunta_apresentada",
        category: item.category,
        question: `Confirma: ${item.phrase}`,
      });
      void speak(`Você quer dizer: ${item.phrase} — Confirma?`);
    },
    [ensureSession, speak, patientId]
  );

  const onGesture = useCallback(
    (g: Gesture) => {
      if (!pending || answeredRef.current) return;
      answeredRef.current = true;
      const sid = sessionRef.current;
      logEvent({
        sessionId: sid,
        patientId,
        itemId: pending.itemId ?? undefined,
        type: "gesto",
        category: pending.category,
        question: `Confirma: ${pending.phrase}`,
        gesture: g,
        responseMs: Date.now() - shownAt.current,
      });
      if (g === "sim") {
        logEvent({ sessionId: sid, patientId, type: "confirmacao", category: pending.category, detail: pending.phrase });
        void saveMessage({
          sessionId: sid,
          patientId,
          text: pending.phrase,
          category: pending.category,
          status: "confirmada",
          speakerRole: modeSpeakerRole("rotina"),
          confirmationStatus: "confirmed",
        });
        // Definição atual do produto: a Rotina é dita pela voz da PLATAFORMA
        // Helo, mesmo sendo necessidade do paciente. A autoria vem de
        // modeSpeakerRole — quando um item ganhar autoria própria, a exceção
        // entra lá, não aqui.
        void speak(pending.phrase, {
          speakerRole: modeSpeakerRole("rotina"),
          confirmationStatus: "confirmed",
          patientId,
          mode: "rotina",
        });
      } else if (g === "nao") {
        logEvent({ sessionId: sid, patientId, type: "descarte", category: pending.category, detail: pending.phrase });
        void saveMessage({
          sessionId: sid,
          patientId,
          text: pending.phrase,
          category: pending.category,
          status: "descartada",
          speakerRole: modeSpeakerRole("rotina"),
          confirmationStatus: "rejected",
        });
      } else {
        logEvent({ sessionId: sid, patientId, type: "reformulacao", category: pending.category, detail: pending.phrase });
      }
      setPending(null);
    },
    [pending, speak, patientId]
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

            {items.length === 0 && loading && (
              <p className="text-center text-ink-mute">Carregando as frases do paciente…</p>
            )}

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {items.map((item) => (
                <button
                  key={item.itemId ?? item.label}
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
