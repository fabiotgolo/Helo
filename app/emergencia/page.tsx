"use client";

import { useCallback, useEffect, useRef } from "react";
import { EMERGENCIA } from "@/lib/flow";
import { logEvent, saveMessage, startSession, endSession } from "@/lib/log";
import { useSpeech } from "@/lib/useSpeech";
import { TopBar, PillLink } from "@/components/ui";

// Modo emergência: frases críticas fixas, sem IA e sem etapas.
// O toque do assistente é a confirmação — a voz sai na hora.
export default function EmergenciaPage() {
  const { speak } = useSpeech();
  const sessionRef = useRef<number | null>(null);

  useEffect(() => {
    const handler = () => endSession(sessionRef.current);
    window.addEventListener("beforeunload", handler);
    return () => {
      handler();
      window.removeEventListener("beforeunload", handler);
    };
  }, []);

  const trigger = useCallback(
    async (item: { label: string; phrase: string }) => {
      if (sessionRef.current == null) {
        sessionRef.current = await startSession("emergencia");
      }
      const sid = sessionRef.current;
      void speak(item.phrase);
      logEvent({ sessionId: sid, type: "emergencia", category: "emergencia", detail: item.phrase });
      void saveMessage({
        sessionId: sid,
        text: item.phrase,
        category: "emergencia",
        status: "confirmada",
      });
    },
    [speak]
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar right={<PillLink href="/conversa">Conversa guiada</PillLink>} />

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-8">
        <div className="text-center">
          <h1 className="text-4xl font-medium tracking-tight">Emergência</h1>
          <p className="mt-2 text-lg text-ink-soft">
            Um toque fala na hora, em voz alta. Sempre disponível, sem depender de IA.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          {EMERGENCIA.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => void trigger(item)}
              className="rounded-3xl border-2 border-nao/30 bg-nao-soft px-6 py-8 text-left transition-transform hover:scale-[1.02] active:scale-[0.98]"
            >
              <span className="block text-2xl font-semibold tracking-tight text-nao">
                {item.label}
              </span>
              <span className="mt-1 block text-lg text-ink-soft">“{item.phrase}”</span>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
