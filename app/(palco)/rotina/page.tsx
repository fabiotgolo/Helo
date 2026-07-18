"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePatient } from "@/lib/patient";
import { modeSpeakerRole } from "@/lib/defaults";
import {
  ROUTINE_QUESTIONS,
  ROUTINE_QUESTIONS_BY_KEY,
  ROUTINE_ANSWER_ORDER,
  ROUTINE_ANSWER_TO_GESTURE,
  type RoutineAnswer,
  type RoutineQuestion,
} from "@/lib/routine";
import { logEvent, saveMessage, startSession, endSession } from "@/lib/log";
import { useHelo } from "@/lib/helo-state";
import { useGestures } from "@/lib/gestures";
import type { SpeakResult } from "@/lib/useSpeech";
import {
  beginPatientVoiceOverride,
  endPatientVoiceOverride,
  isPlatformMuted,
} from "@/lib/audio-coordinator";
import { OverlayVeil } from "@/components/overlay-panel";
import { useRegisterHeloUIActions, type HeloUIAction } from "@/lib/helo-action-registry";
import { useHeloScreenContext } from "@/lib/helo-screen-context";

// Modo rotina — perguntas, não frases soltas. Cada card é uma PERGUNTA
// dirigida ao paciente; ao abrir, três respostas (SIM / TALVEZ / NÃO)
// transformam a pergunta na fala DO PACIENTE. Essa resposta é dita pela voz
// dele (clone ou voz configurada em Ajustes — resolução técnica é do servidor
// /api/tts), com prioridade sobre o Agente e a plataforma; nada narra "SIM
// selecionado". O catálogo de perguntas é fixo (lib/routine.ts) e estável — os
// actionIds do Action Registry vêm da `key`, nunca do texto visual.
//
// Emergência não é tocada por esta tela: a arquitetura de voz, o Audio Manager
// global, o mute, o Action Registry e as tools são compartilhados por composição.

// Feedback visível do estado da voz da resposta — nenhum caminho é silencioso
// para o assistente (mas sem NARRAÇÃO por voz).
type VoiceFeedback = { status: "falando" | "erro" | "silenciada"; detail?: string } | null;

export default function RotinaPage() {
  const { speak, stop } = useHelo();
  const { patientId } = usePatient();
  const gestures = useGestures();

  // openKey null → menu de perguntas; caso contrário, a pergunta aberta.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<RoutineAnswer | null>(null);
  const [feedback, setFeedback] = useState<VoiceFeedback>(null);

  const sessionRef = useRef<number | null>(null);
  const sessionPending = useRef<Promise<number | null> | null>(null);

  const openQuestion: RoutineQuestion | null = openKey
    ? ROUTINE_QUESTIONS_BY_KEY[openKey] ?? null
    : null;

  const ensureSession = useCallback(() => {
    if (sessionRef.current != null) return Promise.resolve(sessionRef.current);
    if (!sessionPending.current) {
      sessionPending.current = startSession("rotina", patientId).then(({ id }) => {
        sessionRef.current = id;
        if (id == null) sessionPending.current = null;
        return id;
      });
    }
    return sessionPending.current;
  }, [patientId]);

  useEffect(() => {
    const handler = () => endSession(sessionRef.current);
    window.addEventListener("beforeunload", handler);
    return () => {
      handler();
      window.removeEventListener("beforeunload", handler);
    };
  }, []);

  // Abrir a pergunta de um card. NÃO fala nada: a pergunta é exibida em
  // silêncio — só a resposta do paciente é vocalizada. Interrompe qualquer voz
  // da plataforma em curso e zera a seleção anterior.
  const openQuestionByKey = useCallback(
    (key: string) => {
      const question = ROUTINE_QUESTIONS_BY_KEY[key];
      if (!question) return;
      console.log("[HELO ROUTINE] question opened", question.key);
      stop();
      setOpenKey(key);
      setSelected(null);
      setFeedback(null);
      void ensureSession().then((sid) => {
        logEvent({
          sessionId: sid,
          patientId,
          type: "pergunta_apresentada",
          category: "rotina",
          question: question.question,
        });
      });
    },
    [ensureSession, patientId, stop]
  );

  // Selecionar uma resposta (SIM/TALVEZ/NÃO). A pergunta vira a frase-resposta,
  // que é fala DO PACIENTE: sai na voz dele (clone/voz de Ajustes; fallback
  // aprovado no servidor), com prioridade sobre o Agente — beginPatientVoiceOverride
  // suprime o Agente e priority "patientResponse" atravessa o gate. O registro é
  // SILENCIOSO: nenhuma voz da plataforma nem do Agente confirma a seleção.
  const answer = useCallback(
    (key: string, ans: RoutineAnswer) => {
      const question = ROUTINE_QUESTIONS_BY_KEY[key];
      if (!question) return;
      const responseText = question.responses[ans];
      // Garante que a pergunta certa esteja aberta (o Agent pode responder
      // sem um "abrir" explícito antes).
      if (openKey !== key) {
        setOpenKey(key);
      }
      console.log("[HELO ROUTINE] answer selected", question.key, ans);
      console.log("[HELO ROUTINE] selected answer text", responseText);
      console.log("[HELO VOICE] routine response voiceRole patient");
      console.log("[HELO AGENT] suppress narration for routine answer");
      setSelected(ans);
      setFeedback({ status: "falando" });

      const speakResponse = async (): Promise<SpeakResult> => {
        // Voz do paciente com prioridade sobre o Agente: assume o áudio na hora,
        // interrompendo a plataforma e suprimindo o Agente até terminar. O mute
        // continua bloqueando tudo.
        beginPatientVoiceOverride();
        try {
          return await speak(responseText, {
            speakerRole: modeSpeakerRole("rotina"), // "patient"
            confirmationStatus: "confirmed", // a seleção da resposta é a confirmação
            patientId,
            mode: "rotina",
            priority: "patientResponse",
          });
        } finally {
          endPatientVoiceOverride();
        }
      };

      speakResponse()
        .then((result) => {
          if (result === "concluida") console.log("[HELO AUDIO] patient routine response played");
          if (result === "silenciada" && isPlatformMuted()) {
            setFeedback({ status: "silenciada", detail: "a voz da plataforma está mutada" });
            window.setTimeout(
              () => setFeedback((f) => (f?.status === "silenciada" ? null : f)),
              6000
            );
          } else if (result === "erro" || result === "bloqueada") {
            setFeedback({
              status: "erro",
              detail: result === "bloqueada" ? "o navegador bloqueou o áudio" : "a reprodução falhou",
            });
            window.setTimeout(
              () => setFeedback((f) => (f?.status === "erro" ? null : f)),
              8000
            );
          } else {
            // concluída ou interrompida por outra resposta: limpa só o "falando".
            setFeedback((f) => (f?.status === "falando" ? null : f));
          }
        })
        .catch((err: unknown) => {
          console.error("[HELO ROUTINE] erro na fala da resposta:", (err as Error)?.message ?? err);
          setFeedback({ status: "erro", detail: "erro inesperado na voz" });
        });

      // Registro SILENCIOSO em segundo plano: as três respostas são falas do
      // paciente (inclusive o "NÃO, …") — todas registradas como confirmadas.
      void ensureSession().then((sid) => {
        logEvent({
          sessionId: sid,
          patientId,
          type: "gesto",
          category: "rotina",
          question: question.question,
          gesture: ROUTINE_ANSWER_TO_GESTURE[ans],
        });
        void saveMessage({
          sessionId: sid,
          patientId,
          text: responseText,
          category: "rotina",
          status: "confirmada",
          speakerRole: modeSpeakerRole("rotina"),
          confirmationStatus: "confirmed",
        });
      });
    },
    [ensureSession, openKey, patientId, speak]
  );

  // Responder de novo a MESMA pergunta: volta a exibir a pergunta, sem seleção.
  const answerAgain = useCallback(() => {
    stop();
    setSelected(null);
    setFeedback(null);
  }, [stop]);

  // Voltar ao menu de perguntas — sem responder. Interrompe a fala em curso,
  // preserva paciente ativo e sessão, e NUNCA navega para Home/Dashboard.
  // Mesmo handler do botão "Voltar" e da ação routine.backToMenu do Agente.
  const backToMenu = useCallback(() => {
    console.log("[HELO ROUTINE] back to menu");
    stop();
    setOpenKey(null);
    setSelected(null);
    setFeedback(null);
  }, [stop]);

  // Contexto de tela para getCurrentHeloActions: o Agent distingue o menu da
  // pergunta aberta e recebe a pergunta atual.
  const screenContext = useMemo(
    () =>
      openQuestion
        ? { screen: "routine_question", extra: { currentQuestion: openQuestion.question } }
        : { screen: "routine_menu" },
    [openQuestion]
  );
  useHeloScreenContext(screenContext);

  // Action Registry: espelha o que está clicável agora — os cards (menu) ou,
  // dentro de uma pergunta, as três respostas + voltar. Os handlers são os
  // MESMOS do toque manual. As respostas devolvem um retorno técnico e não
  // narrável: quem fala é o paciente, o Agente fica em silêncio.
  const registryActions = useMemo<HeloUIAction[]>(() => {
    if (openQuestion) {
      const q = openQuestion;
      const answerActions = ROUTINE_ANSWER_ORDER.map((ans) => ({
        actionId: `routine.answer.${q.key}.${ans}`,
        label: ans === "yes" ? "SIM" : ans === "maybe" ? "TALVEZ" : "NÃO",
        type: "routineAnswer" as const,
        enabled: true,
        run: () => answer(q.key, ans),
        // Retorno técnico e não-narrável: acionar por tool executa o MESMO
        // handler do clique (resposta do paciente com prioridade). O Agente não
        // deve ler nada em voz alta nem confirmar a seleção.
        toolSuccess: {
          result: "handled",
          audibleResponse: "patient_voice_only",
          speechOwner: "patient",
          suppressAgentSpeech: true,
          suppressAssistantNarration: true,
        },
      }));
      return [
        ...answerActions,
        {
          actionId: "routine.backToMenu",
          label: "Voltar para menu de rotinas",
          type: "navigation",
          enabled: true,
          run: () => backToMenu(),
          toolSuccess: { result: "handled", screen: "routine_menu" },
        },
      ];
    }
    return ROUTINE_QUESTIONS.map((q) => ({
      actionId: `routine.open.${q.key}`,
      label: q.question,
      type: "routineQuestion" as const,
      enabled: true,
      run: () => openQuestionByKey(q.key),
      // Abrir o card NÃO fala nada — a voz do paciente só soa ao selecionar
      // SIM/TALVEZ/NÃO. Retorno técnico e não-narrável.
      toolSuccess: {
        result: "opened",
        screen: "routine_question",
        suppressAssistantNarration: true,
      },
    }));
  }, [answer, backToMenu, openQuestion, openQuestionByKey]);
  useRegisterHeloUIActions(registryActions);

  // Log temporário: espelha no console quantas ações da Rotina estão
  // registradas agora (menu de perguntas ou respostas do card aberto).
  useEffect(() => {
    console.log(
      "[HELO ROUTINE] actions registered",
      registryActions.length,
      openQuestion ? `(card: ${openQuestion.key})` : "(menu)"
    );
  }, [registryActions, openQuestion]);

  // Texto exibido no destaque: a pergunta, ou a resposta escolhida.
  const displayText =
    openQuestion && selected ? openQuestion.responses[selected] : openQuestion?.question ?? "";

  return (
    <div className="relative flex flex-1 flex-col">
      <OverlayVeil />
      <main className="relative flex w-full flex-1 flex-col items-center justify-center px-4 pb-6 pl-14 sm:px-6 sm:pl-20 xl:pl-6">
        {openQuestion ? (
          <section
            key="pergunta"
            aria-live="polite"
            aria-label="Pergunta da rotina"
            className="fade-rise pointer-events-auto mx-auto flex w-full max-w-3xl flex-col items-center gap-8 py-8"
          >
            {/* Voltar ao menu de perguntas — âncora clara, alinhada à esquerda. */}
            <div className="flex w-full">
              <button
                type="button"
                onClick={backToMenu}
                className="flex items-center gap-2 rounded-full border border-line bg-card/70 px-4 py-2 text-sm font-medium text-ink-soft shadow-soft backdrop-blur-md transition-colors hover:border-ink-mute hover:text-ink"
              >
                <span aria-hidden="true">←</span>
                Voltar para as rotinas
              </button>
            </div>

            <p className="text-sm font-semibold uppercase tracking-widest text-ink-soft">
              {selected ? "Resposta" : "Pergunta"}
            </p>

            {/* A pergunta vira a resposta ao selecionar — mesmo bloco de destaque. */}
            <blockquote className="text-center text-4xl font-medium leading-snug tracking-tight sm:text-5xl">
              {selected ? displayText : `“${displayText}”`}
            </blockquote>

            {/* Estado da voz da resposta — perceptível, sem NARRAÇÃO por voz. */}
            <div aria-live="polite" className="min-h-6 text-center">
              {feedback?.status === "silenciada" && (
                <span className="text-sm text-ink-mute">Voz não reproduzida ({feedback.detail}).</span>
              )}
              {feedback?.status === "erro" && (
                <span className="text-sm font-medium text-nao">A voz não saiu ({feedback.detail}).</span>
              )}
            </div>

            {/* Três respostas — SIM, TALVEZ, NÃO, sempre nessa ordem, com o emoji
                de gesto configurado para o paciente. */}
            <div className="flex items-stretch justify-center gap-4 sm:gap-6">
              {ROUTINE_ANSWER_ORDER.map((ans) => {
                const g = ROUTINE_ANSWER_TO_GESTURE[ans];
                const info = gestures[g];
                const label = ans === "yes" ? "SIM" : ans === "maybe" ? "TALVEZ" : "NÃO";
                const isChosen = selected === ans;
                const dim = selected != null && !isChosen;
                return (
                  <button
                    key={ans}
                    type="button"
                    aria-label={`Responder ${label.toLowerCase()}`}
                    aria-pressed={isChosen}
                    onClick={() => answer(openQuestion.key, ans)}
                    className={`flex h-36 w-28 flex-col items-center justify-center gap-2 rounded-3xl border bg-card/70 shadow-soft backdrop-blur-md transition-transform hover:scale-[1.04] active:scale-[0.97] sm:h-40 sm:w-32 ${
                      isChosen ? "border-accent ring-4 ring-accent/40" : "border-line/70"
                    } ${dim ? "opacity-50" : ""}`}
                  >
                    <span className="text-5xl sm:text-6xl" aria-hidden="true">
                      {info.emoji}
                    </span>
                    <span className="text-sm font-semibold uppercase tracking-wide text-ink-soft">
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Após responder: responder de novo ou voltar ao menu. */}
            {selected && (
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={answerAgain}
                  className="rounded-full border border-line bg-card/70 px-5 py-2 text-sm font-medium text-ink-soft shadow-soft backdrop-blur-md transition-colors hover:border-ink-mute hover:text-ink"
                >
                  Responder de novo
                </button>
                <button
                  type="button"
                  onClick={backToMenu}
                  className="rounded-full border border-line bg-card/70 px-5 py-2 text-sm font-medium text-ink-soft shadow-soft backdrop-blur-md transition-colors hover:border-ink-mute hover:text-ink"
                >
                  Voltar para as rotinas
                </button>
              </div>
            )}
          </section>
        ) : (
          <section
            key="menu"
            aria-label="Rotina"
            className="fade-rise pointer-events-auto mx-auto flex w-full max-w-4xl flex-col gap-8 py-8"
          >
            <div className="text-center">
              <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">Rotina</h1>
              <p className="mt-2 text-lg text-ink-soft">
                Toque na pergunta. O paciente responde SIM, TALVEZ ou NÃO — e a resposta fala na voz dele.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {ROUTINE_QUESTIONS.map((q) => (
                <button
                  key={q.key}
                  type="button"
                  onClick={() => openQuestionByKey(q.key)}
                  className="w-full rounded-3xl border border-line/70 bg-card/70 px-5 py-7 text-center text-xl font-medium leading-snug tracking-tight shadow-soft backdrop-blur-md transition-transform hover:scale-[1.03] active:scale-[0.98]"
                >
                  {q.question}
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
