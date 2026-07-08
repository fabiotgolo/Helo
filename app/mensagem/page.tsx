"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { MENSAGEM_POOL, type Frase } from "@/lib/frases";
import { type Gesture } from "@/lib/types";
import { useGestures } from "@/lib/gestures";
import { logEvent, saveMessage, startSession, endSession } from "@/lib/log";
import { useSpeech } from "@/lib/useSpeech";
import { Orb, GestureTriplet, TopBar } from "@/components/ui";

const LOTE = 3;
const MAX_FRASES_PARAGRAFO = 3;

// Construção progressiva: frase → parágrafo (máx. 3 frases) → mensagem final.
// Cada frase é confirmada por gesto; a mensagem inteira é relida e
// confirmada antes de ser falada e registrada.

type Phase = "intro" | "escolha" | "confirma_frase" | "continuar" | "final" | "done";

export default function MensagemPage() {
  const { speak, engine } = useSpeech();
  const gestures = useGestures();

  const [phase, setPhase] = useState<Phase>("intro");
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [batch, setBatch] = useState(0);
  const [marks, setMarks] = useState<Record<number, Gesture>>({});
  const [pending, setPending] = useState<Frase | null>(null);
  const [aiOptions, setAiOptions] = useState<Frase[] | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const rejected = useRef<string[]>([]);
  const shownAt = useRef(Date.now());

  const batchOptions: Frase[] = useMemo(() => {
    if (aiOptions) return aiOptions;
    const start = (batch * LOTE) % MENSAGEM_POOL.length;
    return MENSAGEM_POOL.slice(start, start + LOTE);
  }, [batch, aiOptions]);

  useEffect(() => {
    const handler = () => endSession(sessionId);
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [sessionId]);

  const begin = useCallback(async () => {
    const id = await startSession("mensagem");
    setSessionId(id);
    setDraft([]);
    setBatch(0);
    setMarks({});
    setAiOptions(null);
    rejected.current = [];
    setPhase("escolha");
    shownAt.current = Date.now();
    logEvent({
      sessionId: id,
      type: "pergunta_apresentada",
      category: "mensagem",
      question: "O que você quer dizer nesta mensagem?",
    });
    void speak("Vamos montar a mensagem, uma frase de cada vez. O que você quer dizer?");
  }, [speak]);

  const trySuggestions = useCallback(async () => {
    setAiLoading(true);
    try {
      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "Qual frase acrescentar à mensagem?",
          category: "mensagem",
          rejected: rejected.current.slice(-9),
          path: [],
          draft,
        }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as {
        options: { label: string; phrase: string }[];
      };
      if (!data.options?.length) return false;
      setAiOptions(data.options.slice(0, LOTE));
      setMarks({});
      shownAt.current = Date.now();
      void speak("Tenho outras sugestões.");
      return true;
    } catch {
      return false;
    } finally {
      setAiLoading(false);
    }
  }, [draft, speak]);

  const advanceBatch = useCallback(async () => {
    if (aiOptions) {
      const again = await trySuggestions();
      if (!again) {
        setAiOptions(null);
        setBatch((b) => b + 1);
        setMarks({});
      }
      return;
    }
    const nextBatch = batch + 1;
    if (nextBatch * LOTE >= MENSAGEM_POOL.length) {
      const gotAI = await trySuggestions();
      if (gotAI) return;
    }
    setBatch(nextBatch);
    setMarks({});
    shownAt.current = Date.now();
    void speak("Vou mostrar outras opções.");
  }, [batch, aiOptions, trySuggestions, speak]);

  const onOptionGesture = useCallback(
    (idx: number, g: Gesture) => {
      const option = batchOptions[idx];
      if (!option || marks[idx]) return;
      logEvent({
        sessionId,
        type: "gesto",
        category: "mensagem",
        question: option.label,
        gesture: g,
        detail: aiOptions ? "escolha de frase (sugestão IA)" : "escolha de frase",
        responseMs: Date.now() - shownAt.current,
      });
      if (g === "sim") {
        setPending(option);
        setPhase("confirma_frase");
        shownAt.current = Date.now();
        void speak(`Acrescento à mensagem: ${option.phrase} — Confirma?`);
        return;
      }
      rejected.current.push(option.label);
      const newMarks = { ...marks, [idx]: g };
      setMarks(newMarks);
      if (batchOptions.every((_, i) => newMarks[i])) void advanceBatch();
    },
    [batchOptions, marks, aiOptions, sessionId, speak, advanceBatch]
  );

  const onConfirmFrase = useCallback(
    (g: Gesture) => {
      if (!pending) return;
      logEvent({
        sessionId,
        type: "gesto",
        category: "mensagem",
        question: `Confirma frase: ${pending.phrase}`,
        gesture: g,
        responseMs: Date.now() - shownAt.current,
      });
      if (g === "sim") {
        setDraft((d) => [...d, pending.phrase]);
        logEvent({ sessionId, type: "confirmacao", category: "mensagem", detail: pending.phrase });
        setPending(null);
        setPhase("continuar");
        shownAt.current = Date.now();
        void speak("Frase acrescentada. Quer acrescentar mais uma frase?");
      } else {
        logEvent({
          sessionId,
          type: g === "talvez" ? "reformulacao" : "descarte",
          category: "mensagem",
          detail: pending.phrase,
        });
        setPending(null);
        setPhase("escolha");
        shownAt.current = Date.now();
        void speak("Tudo bem, vamos escolher outra frase.");
      }
    },
    [pending, sessionId, speak]
  );

  const fullMessage = draft.join(" ");

  const onContinuar = useCallback(
    (g: Gesture) => {
      logEvent({
        sessionId,
        type: "gesto",
        category: "mensagem",
        question: "Quer acrescentar mais uma frase?",
        gesture: g,
        responseMs: Date.now() - shownAt.current,
      });
      if (g === "sim") {
        setMarks({});
        setAiOptions(null);
        setPhase("escolha");
        shownAt.current = Date.now();
        void speak("O que mais você quer dizer?");
      } else if (g === "talvez") {
        void speak(`Vou reler a mensagem: ${fullMessage} — Quer acrescentar mais uma frase?`);
        shownAt.current = Date.now();
      } else {
        setPhase("final");
        shownAt.current = Date.now();
        void speak(`A mensagem ficou assim: ${fullMessage} — Confirma esta mensagem?`);
      }
    },
    [sessionId, fullMessage, speak]
  );

  const onFinal = useCallback(
    (g: Gesture) => {
      logEvent({
        sessionId,
        type: "gesto",
        category: "mensagem",
        question: `Confirma mensagem final`,
        gesture: g,
        responseMs: Date.now() - shownAt.current,
      });
      if (g === "sim") {
        logEvent({ sessionId, type: "confirmacao", category: "mensagem", detail: fullMessage });
        void saveMessage({
          sessionId,
          text: fullMessage,
          category: "mensagem",
          status: "confirmada",
        });
        setPhase("done");
        void speak(fullMessage);
      } else if (g === "talvez") {
        // Reformular: remove a última frase e volta a perguntar
        const removed = draft[draft.length - 1];
        logEvent({ sessionId, type: "reformulacao", category: "mensagem", detail: removed });
        setDraft((d) => d.slice(0, -1));
        setPhase(draft.length <= 1 ? "escolha" : "continuar");
        shownAt.current = Date.now();
        void speak("Removi a última frase. Quer acrescentar outra?");
      } else {
        logEvent({ sessionId, type: "descarte", category: "mensagem", detail: fullMessage });
        void saveMessage({
          sessionId,
          text: fullMessage,
          category: "mensagem",
          status: "descartada",
        });
        setDraft([]);
        setPhase("intro");
        void speak("Mensagem descartada.");
      }
    },
    [sessionId, fullMessage, draft, speak]
  );

  // Parágrafos de no máximo 3 frases, como no descritivo
  const paragraphs: string[][] = [];
  for (let i = 0; i < draft.length; i += MAX_FRASES_PARAGRAFO) {
    paragraphs.push(draft.slice(i, i + MAX_FRASES_PARAGRAFO));
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        right={
          <span className="rounded-full border border-line bg-card px-4 py-1.5 text-xs text-ink-soft">
            voz: {engine === "elevenlabs" ? "ElevenLabs" : "navegador"}
          </span>
        }
      />

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-8 px-6 py-8">
        {phase === "intro" && (
          <section className="flex flex-col items-center gap-8 text-center">
            <Orb palette="lilas" breathe className="h-32 w-32" />
            <div>
              <h1 className="text-4xl font-medium tracking-tight">Montar mensagem</h1>
              <p className="mx-auto mt-3 max-w-lg text-lg text-ink-soft">
                Uma frase de cada vez, no ritmo do paciente. Cada frase é confirmada
                por gesto, e a mensagem inteira é relida antes de ser comunicada.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void begin()}
              className="rounded-full bg-ink px-10 py-4 text-lg font-medium text-white hover:bg-black"
            >
              Começar
            </button>
          </section>
        )}

        {phase !== "intro" && phase !== "done" && draft.length > 0 && (
          <section aria-label="Mensagem em construção" className="w-full rounded-3xl border border-line bg-card p-6">
            <p className="text-xs font-semibold uppercase tracking-widest text-ink-soft">
              Mensagem até agora
            </p>
            <div className="mt-2 flex flex-col gap-3">
              {paragraphs.map((p, i) => (
                <p key={i} className="text-lg leading-relaxed">
                  {p.join(" ")}
                </p>
              ))}
            </div>
          </section>
        )}

        {phase === "escolha" && (
          <section aria-live="polite" className="flex w-full flex-col items-center gap-6">
            <h1 className="text-center text-3xl font-medium tracking-tight text-ink-soft">
              {draft.length === 0 ? "O que você quer dizer?" : "O que mais você quer dizer?"}
            </h1>
            {aiLoading && <p className="text-ink-mute animate-pulse">Formulando sugestões…</p>}
            <div className="flex w-full flex-col gap-5">
              {batchOptions.map((option, idx) => {
                const marked = marks[idx];
                return (
                  <div
                    key={`${batch}-${aiOptions ? "ai" : "c"}-${idx}`}
                    className={`flex flex-col items-center gap-3 rounded-3xl px-6 py-4 ${marked ? "opacity-35" : ""}`}
                  >
                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <h2 className="text-center text-3xl font-medium tracking-tight">
                        “{option.phrase}”
                      </h2>
                      <button
                        type="button"
                        onClick={() => void speak(option.phrase)}
                        aria-label={`Ler em voz alta: ${option.phrase}`}
                        className="rounded-full border border-line bg-card px-3 py-1.5 text-sm text-ink-soft hover:border-ink-mute"
                      >
                        🔊
                      </button>
                      {aiOptions && (
                        <span className="rounded-full bg-talvez-soft px-3 py-1 text-xs font-medium text-talvez">
                          ✦ sugerida por IA
                        </span>
                      )}
                    </div>
                    {marked ? (
                      <span className="text-lg">
                        {gestures[marked].emoji} {gestures[marked].label}
                      </span>
                    ) : (
                      <GestureTriplet
                        size="compacto"
                        idPrefix={`m-${idx}-`}
                        onGesture={(g) => onOptionGesture(idx, g)}
                        disabled={aiLoading}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {phase === "confirma_frase" && pending && (
          <section aria-live="polite" className="flex flex-col items-center gap-8">
            <p className="text-sm font-semibold uppercase tracking-widest text-ink-soft">
              Acrescentar esta frase?
            </p>
            <blockquote className="text-center text-4xl font-medium leading-snug tracking-tight">
              “{pending.phrase}”
            </blockquote>
            <GestureTriplet onGesture={onConfirmFrase} />
            <p className="text-sm text-ink-mute">👍 acrescentar · ✋ outra frase · ✊ não</p>
          </section>
        )}

        {phase === "continuar" && (
          <section aria-live="polite" className="flex flex-col items-center gap-8">
            <h1 className="text-center text-4xl font-medium tracking-tight sm:text-5xl">
              Quer acrescentar mais uma frase?
            </h1>
            <GestureTriplet onGesture={onContinuar} />
            <p className="text-sm text-ink-mute">👍 sim · ✋ reler a mensagem · ✊ concluir</p>
          </section>
        )}

        {phase === "final" && (
          <section aria-live="polite" className="flex flex-col items-center gap-8">
            <p className="text-sm font-semibold uppercase tracking-widest text-ink-soft">
              Confirmar mensagem final
            </p>
            <blockquote className="max-w-2xl text-center text-3xl font-medium leading-snug tracking-tight">
              “{fullMessage}”
            </blockquote>
            <GestureTriplet onGesture={onFinal} />
            <p className="text-sm text-ink-mute">
              👍 comunicar e registrar · ✋ remover última frase · ✊ descartar tudo
            </p>
          </section>
        )}

        {phase === "done" && (
          <section aria-live="polite" className="flex flex-col items-center gap-8">
            <Orb palette="coral" breathe className="h-28 w-28" />
            <blockquote className="max-w-2xl text-center text-3xl font-medium leading-snug tracking-tight">
              “{fullMessage}”
            </blockquote>
            <p className="text-lg text-ink-soft">Mensagem comunicada e registrada.</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => void speak(fullMessage)}
                className="rounded-full border border-line bg-card px-6 py-3 font-medium hover:border-ink-mute"
              >
                🔊 Repetir
              </button>
              <button
                type="button"
                onClick={() => void begin()}
                className="rounded-full bg-ink px-6 py-3 font-medium text-white hover:bg-black"
              >
                Nova mensagem
              </button>
              <Link
                href="/"
                onClick={() => endSession(sessionId)}
                className="rounded-full border border-line bg-card px-6 py-3 font-medium hover:border-ink-mute"
              >
                Encerrar
              </Link>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
