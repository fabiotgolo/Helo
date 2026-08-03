"use client";

// ——— Perguntas em tempo real: orquestrador da sessão ———
//
// Esta casca NÃO decide nada sobre a conversa. Ela:
//   1. mostra o estado que veio do servidor;
//   2. despacha a AÇÃO do assistente para a máquina de estados das Fases 1/2;
//   3. substitui o estado local pelo que o servidor devolveu.
//
// Consequências diretas, e é por isso que o desenho é este:
//   - nenhuma seleção aparece como confirmada antes da resposta do servidor;
//   - uma resposta provisória interrompida por pausa volta como provisória;
//   - a interface não tem como pular a reconfirmação de um assunto sensível,
//     porque quem escolhe o próximo estado é o domínio.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHeloDialog } from "@/components/helo-dialog";
import { SessionHistory } from "@/components/realtime-questions/session-history";
import {
  QuestionStage,
  useAnswerChoices,
} from "@/components/realtime-questions/question-stage";
import {
  AwaitingControls,
  ComposeScreen,
  ErrorBanner,
  ExitModal,
  FinishedScreen,
  IdleScreen,
  PausedScreen,
  ProvisionalPanel,
  ReconfirmPanel,
  ReviewScreen,
  UncertainScreen,
} from "@/components/realtime-questions/session-screens";
import { Control } from "@/components/realtime-questions/ui";
import { OptionConversationFlow } from "@/components/realtime-questions/option-conversation/flow";
import {
  HistoryActionsDialog,
  HistoryDetail,
  type HistoryEntry,
} from "@/components/realtime-questions/option-conversation/history";
import { OverlayVeil } from "@/components/overlay-panel";
import {
  newRequestId,
  pauseOnUnload,
  useRtqPersistence,
  type SessionContextInput,
  type SessionDetail,
} from "@/lib/realtime-question-client";
import {
  SessionContextBar,
  SessionContextDialog,
  SessionContextScreen,
  ContextVersionsList,
  type ContextDraft,
} from "@/components/realtime-questions/session-context";
import type { SessionContextVersion } from "@/lib/session-context-types";
import type { TurnAction } from "@/lib/realtime-question-machine";
import {
  isTerminalPathStatus,
  type PathDetail,
} from "@/lib/option-conversation-types";
import {
  isTerminalSessionStatus,
  isTerminalTurnStatus,
  type ConversationQuestionTurn,
  type PatientResponseProfile,
  type SemanticResponse,
  type SensitiveCategory,
} from "@/lib/realtime-question-types";

export function RealtimeQuestionSession({
  patientId,
  initial,
  onLeave,
}: {
  patientId: number;
  initial: SessionDetail;
  /** Sai do modo depois que a sessão já foi encerrada como o assistente quis. */
  onLeave: () => void;
}) {
  const persist = useRtqPersistence();
  const dialog = useHeloDialog();

  const [detail, setDetail] = useState<SessionDetail>(initial);
  const [profile, setProfile] = useState<PatientResponseProfile | null>(null);
  const [composing, setComposing] = useState(initial.turns.length === 0);
  const [draft, setDraft] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [category, setCategory] = useState<SensitiveCategory | null>(null);
  const [exitOpen, setExitOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // "Corrigir" reabre as três opções SEM apagar a seleção: a próxima escolha
  // vira RESPONSE_CHANGED, preservando a anterior no evento. Quem quer apagar
  // usa "Cancelar seleção", que é RESPONSE_REMOVED.
  // Guardamos QUAL turno está em correção — assim o modo nunca sobra ligado
  // para a pergunta seguinte.
  const [correctingTurnId, setCorrectingTurnId] = useState<string | null>(null);
  // Caminhos da conversa por opções desta sessão. O estado vive no servidor:
  // isto é só o espelho local do que ele devolveu.
  const [pathDetails, setPathDetails] = useState<PathDetail[]>([]);
  // Caminho aberto na tela. `null` = a sessão está no fluxo de perguntas.
  const [openPathId, setOpenPathId] = useState<string | null>(null);
  // Item do histórico em consulta. Abrir NUNCA altera dados (§22).
  const [historyEntry, setHistoryEntry] = useState<HistoryEntry | null>(null);
  const [historyDetail, setHistoryDetail] = useState<HistoryEntry | null>(null);
  // Contexto da conversa (Fase 4.8). Edição e consulta durante a sessão.
  const [contextEditing, setContextEditing] = useState(false);
  const [contextVersions, setContextVersions] = useState<
    SessionContextVersion[] | null
  >(null);
  // A ação que falhou fica guardada para "Tentar novamente" repetir
  // exatamente ela — nada é reconstruído por adivinhação.
  const failed = useRef<
    | { kind: "turn"; turnId: string; action: TurnAction }
    | { kind: "session"; action: "PAUSE" | "RESUME" | "COMPLETE" | "ABANDON" }
    | { kind: "create"; text: string }
    | null
  >(null);
  const [retryable, setRetryable] = useState(false);

  const { session, turns, context } = detail;
  const choices = useAnswerChoices(profile);

  // O turno em curso é o último ainda não terminal — derivado, nunca guardado.
  const currentTurn = useMemo(
    () =>
      [...turns]
        .sort((a, b) => a.sequence - b.sequence)
        .reverse()
        .find((t) => !isTerminalTurnStatus(t.status)) ?? null,
    [turns]
  );
  const lastTurn = useMemo(
    () => [...turns].sort((a, b) => a.sequence - b.sequence).at(-1) ?? null,
    [turns]
  );

  const sessionOver = isTerminalSessionStatus(session.status);
  const paused = session.status === "PAUSED";
  const busy = persist.saving;
  const correcting =
    currentTurn != null &&
    currentTurn.id === correctingTurnId &&
    currentTurn.status === "PROVISIONAL_RESPONSE";

  // Mapeamento sinal → resposta do paciente (emoji e rótulo das três opções).
  useEffect(() => {
    let cancelled = false;
    void persist
      .responseProfile(patientId)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch(() => {
        // Sem o perfil a tela ainda funciona: o padrão do modo é aplicado.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  // Caminhos da conversa por opções, carregados junto da sessão. Ao voltar de
  // uma pausa ou atualizar a página, é daqui que o caminho ativo, o nível
  // atual, o breadcrumb e a mensagem em construção reaparecem (§32).
  const loadPaths = useCallback(async () => {
    const details = await persist.pathDetails(patientId, session.id);
    setPathDetails(details);
    return details;
  }, [persist, patientId, session.id]);

  useEffect(() => {
    let cancelled = false;
    void persist
      .pathDetails(patientId, session.id)
      .then((details) => {
        if (cancelled) return;
        setPathDetails(details);
        // Um caminho ainda vivo reabre sozinho: interromper a conversa no meio
        // por causa de um refresh seria perder o contexto do paciente.
        const alive = details.find((d) => !isTerminalPathStatus(d.path.status));
        if (alive) setOpenPathId(alive.path.id);
      })
      .catch(() => {
        // Sem os caminhos a tela de perguntas continua funcionando.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, session.id]);

  const openPath = useMemo(
    () => pathDetails.find((d) => d.path.id === openPathId) ?? null,
    [pathDetails, openPathId]
  );

  const applyPathDetail = useCallback((detail: PathDetail) => {
    setPathDetails((all) =>
      all.some((d) => d.path.id === detail.path.id)
        ? all.map((d) => (d.path.id === detail.path.id ? detail : d))
        : [...all, detail]
    );
  }, []);

  /**
   * PONTO ÚNICO de entrada no motor de opções.
   *
   * Hoje só responde ao gatilho MANUAL — a entrada discreta que o assistente
   * aciona, usada como fallback, validação e teste. É aqui que a ativação
   * automática pela IA será ligada quando existir: quando ela identificar que
   * a pergunta ou a frase exige continuidade, chamará este mesmo caminho, sem
   * que nada mais na tela precise mudar.
   */
  const shouldOpenOptionFlow = useCallback(
    (trigger: "MANUAL"): boolean => trigger === "MANUAL",
    []
  );

  const startOptionConversation = useCallback(async () => {
    if (!shouldOpenOptionFlow("MANUAL")) return;
    persist.clearError();
    try {
      const path = await persist.createPath(
        patientId,
        session.id,
        newRequestId("path")
      );
      const details = await loadPaths();
      setOpenPathId(
        details.find((d) => d.path.id === path.id)?.path.id ?? path.id
      );
      setComposing(false);
    } catch {
      // A faixa de erro já explica.
    }
  }, [
    shouldOpenOptionFlow,
    persist,
    patientId,
    session.id,
    loadPaths,
  ]);

  /**
   * Sai do caminho e volta ao fluxo de perguntas, sem encerrar a sessão nem o
   * caminho: ele continua ativo e reaparece ao recarregar a página. Sair NÃO
   * reabre nada — senão o botão não teria como funcionar.
   */
  const leaveOptionConversation = useCallback(() => {
    setOpenPathId(null);
    void loadPaths().catch(() => {});
  }, [loadPaths]);

  /** Reiniciar encerra um caminho e abre outro: a tela acompanha o novo. */
  const switchToPath = useCallback(
    (pathId: string) => {
      void loadPaths()
        .then(() => setOpenPathId(pathId))
        .catch(() => {});
    },
    [loadPaths]
  );

  // ——— Histórico clicável (§22, §24, §25) ———

  /**
   * Abrir um item registra a CONSULTA e nada mais. Em andamento, a tela
   * daquele item é recuperada com o estado que ele tem no servidor; encerrado,
   * abre-se o menu de detalhes e reutilização.
   */
  const openHistoryEntry = useCallback(
    (entry: HistoryEntry) => {
      const tipo = entry.kind === "TURN" ? "TURN" : "PATH";
      void persist
        .openHistoryItem(patientId, session.id, tipo, entry.id)
        .catch(() => {});

      const emAndamento =
        entry.kind === "TURN"
          ? !isTerminalTurnStatus(entry.turn.status)
          : !isTerminalPathStatus(entry.detail.path.status);

      if (!emAndamento) {
        setHistoryEntry(entry);
        return;
      }
      // Recuperar a tela do item: o estado vem do servidor, então basta
      // apontar a tela para ele.
      if (entry.kind === "PATH") {
        setComposing(false);
        setOpenPathId(entry.detail.path.id);
      } else {
        setOpenPathId(null);
        setComposing(false);
      }
    },
    [persist, patientId, session.id]
  );

  /** Toda reutilização cria um registro NOVO em rascunho (§24). */
  const reuse = useCallback(
    async (op: () => Promise<unknown>, target: "PATH" | "TURN") => {
      persist.clearError();
      try {
        await op();
        setHistoryEntry(null);
        setHistoryDetail(null);
        if (target === "PATH") {
          const details = await loadPaths();
          const novo = details.find((d) => !isTerminalPathStatus(d.path.status));
          if (novo) {
            setComposing(false);
            setOpenPathId(novo.path.id);
          }
        } else {
          const fresh = await persist.sessionDetail(patientId, session.id);
          setDetail(fresh);
          setOpenPathId(null);
          setComposing(false);
        }
      } catch {
        // A faixa de erro já explica; o original continua intacto.
      }
    },
    [persist, patientId, session.id, loadPaths]
  );

  const applyTurn = useCallback((turn: ConversationQuestionTurn) => {
    setDetail((d) => {
      const known = d.turns.some((t) => t.id === turn.id);
      return {
        ...d,
        turns: known
          ? d.turns.map((t) => (t.id === turn.id ? turn : t))
          : [...d.turns, turn],
      };
    });
  }, []);

  const reload = useCallback(async () => {
    const fresh = await persist.sessionDetail(patientId, session.id);
    setDetail(fresh);
    return fresh;
  }, [persist, patientId, session.id]);

  /** Despacha uma ação do assistente e adota o turno devolvido pelo servidor. */
  const act = useCallback(
    async (turnId: string, action: TurnAction) => {
      persist.clearError();
      try {
        const turn = await persist.turnAction(
          patientId,
          session.id,
          turnId,
          action
        );
        applyTurn(turn);
        failed.current = null;
        setRetryable(false);
        return turn;
      } catch (e) {
        failed.current = { kind: "turn", turnId, action };
        setRetryable(true);
        throw e;
      }
    },
    [persist, patientId, session.id, applyTurn]
  );

  const sessionAct = useCallback(
    async (action: "PAUSE" | "RESUME" | "COMPLETE" | "ABANDON") => {
      persist.clearError();
      try {
        const updated = await persist.sessionAction(
          patientId,
          session.id,
          action
        );
        // Concluir pode ter fechado turnos abertos como "sem resposta":
        // o detalhe completo é a única fonte confiável.
        if (action === "COMPLETE") {
          const fresh = await persist.sessionDetail(patientId, session.id);
          setDetail(fresh);
        } else {
          setDetail((d) => ({ ...d, session: updated }));
        }
        failed.current = null;
        setRetryable(false);
        return updated;
      } catch (e) {
        failed.current = { kind: "session", action };
        setRetryable(true);
        throw e;
      }
    },
    [persist, patientId, session.id]
  );

  // ——— Contexto da conversa (Fase 4.8) ———
  // Gravar contexto NÃO é ação voltada ao paciente: não apresenta, não
  // confirma e não toca em turno nenhum. Só registra a circunstância.
  const salvarContexto = useCallback(
    async (input: Omit<SessionContextInput, "clientRequestId">) => {
      persist.clearError();
      const salvo = await persist.saveSessionContext(patientId, session.id, {
        ...input,
        clientRequestId: newRequestId("ctx"),
      });
      setDetail((d) => ({ ...d, context: salvo }));
      setContextEditing(false);
      return salvo;
    },
    [persist, patientId, session.id]
  );

  const verContexto = useCallback(async () => {
    if (!context) return;
    // A consulta é auditada, mas nunca bloqueia a leitura se o registro falhar.
    void persist.openSessionContext(patientId, session.id, context.id).catch(() => {});
    const versions = await persist.sessionContextVersions(patientId, session.id);
    setContextVersions(versions);
  }, [persist, patientId, session.id, context]);

  // ——— Ações do fluxo ———

  const startQuestion = useCallback(() => {
    setDraft("");
    setSensitive(false);
    setCategory(null);
    setComposing(true);
  }, []);

  const continueToReview = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    if (currentTurn) {
      // Voltou da revisão para editar: o turno já existe em DRAFT e o texto
      // definitivo só é persistido ao apresentar.
      setComposing(false);
      return;
    }
    try {
      const turn = await persist.createTurn(patientId, session.id, { text });
      applyTurn(turn);
      setComposing(false);
      failed.current = null;
      setRetryable(false);
    } catch {
      // O texto digitado permanece no campo — nada se perde.
      failed.current = { kind: "create", text };
      setRetryable(true);
    }
  }, [draft, currentTurn, persist, patientId, session.id, applyTurn]);

  /** Repete a última ação que falhou, exatamente como ela era. */
  const retryFailed = useCallback(() => {
    const last = failed.current;
    if (!last) return;
    failed.current = null;
    setRetryable(false);
    if (last.kind === "turn") {
      void act(last.turnId, last.action).catch(() => {});
    } else if (last.kind === "session") {
      void sessionAct(last.action).catch(() => {});
    } else {
      void persist
        .createTurn(patientId, session.id, { text: last.text })
        .then((turn) => {
          applyTurn(turn);
          setComposing(false);
        })
        .catch(() => {
          failed.current = last;
          setRetryable(true);
        });
    }
  }, [act, sessionAct, persist, patientId, session.id, applyTurn]);

  const present = useCallback(
    async (turn: ConversationQuestionTurn) => {
      const text = draft.trim() || turn.reviewedText;
      if (!text) return;
      try {
        await act(turn.id, {
          kind: "REVIEW",
          reviewedText: text,
          isSensitive: sensitive,
          sensitiveCategory: sensitive ? category : null,
        });
        await act(turn.id, { kind: "PRESENT" });
        await act(turn.id, { kind: "AWAIT_RESPONSE" });
      } catch {
        // A faixa de erro já explica; o turno continua editável.
      }
    },
    [act, draft, sensitive, category]
  );

  const represent = useCallback(
    async (turn: ConversationQuestionTurn) => {
      try {
        await act(turn.id, { kind: "REPRESENT" });
        await act(turn.id, { kind: "AWAIT_RESPONSE" });
      } catch {
        /* faixa de erro */
      }
    },
    [act]
  );

  const registerNoResponse = useCallback(
    async (turn: ConversationQuestionTurn) => {
      const ok = await dialog.confirm({
        title: "Registrar ausência de resposta?",
        message:
          "O paciente não apresentou uma resposta identificável. Deseja registrar ausência de resposta?",
        confirmLabel: "Registrar ausência",
        cancelLabel: "Voltar",
        tone: "warning",
      });
      if (!ok) return;
      try {
        await act(turn.id, { kind: "RECORD_NO_RESPONSE" });
      } catch {
        /* faixa de erro */
      }
    },
    [act, dialog]
  );

  const cancelQuestion = useCallback(
    async (turn: ConversationQuestionTurn) => {
      const ok = await dialog.confirm({
        title: "Cancelar esta pergunta?",
        message:
          "A pergunta sai do fluxo e fica registrada como cancelada. Nada do que já foi observado é apagado.",
        confirmLabel: "Cancelar pergunta",
        cancelLabel: "Voltar",
        tone: "warning",
      });
      if (!ok) return;
      try {
        await act(turn.id, { kind: "CANCEL" });
        setComposing(false);
      } catch {
        /* faixa de erro */
      }
    },
    [act, dialog]
  );

  // ——— Saída da tela ———

  const finishAndLeave = useCallback(
    async (action: "COMPLETE" | "ABANDON") => {
      if (action === "ABANDON") {
        const ok = await dialog.confirm({
          title: "Abandonar a sessão?",
          message:
            "A sessão fica registrada como abandonada, nunca como concluída. As perguntas e respostas já registradas são preservadas — nenhuma pergunta sem resposta vira um NÃO.",
          confirmLabel: "Abandonar sessão",
          cancelLabel: "Voltar",
          tone: "danger",
        });
        if (!ok) return;
      }
      setLeaving(true);
      try {
        await sessionAct(action);
        setExitOpen(false);
        // NÃO sai da tela: a sessão encerrada mostra seu resumo, e é o
        // assistente quem decide quando voltar. Concluir uma sessão sem ver
        // o que ficou registrado seria encerrar às cegas.
      } finally {
        setLeaving(false);
      }
    },
    [dialog, sessionAct]
  );

  const pauseAndLeave = useCallback(async () => {
    setLeaving(true);
    try {
      await sessionAct("PAUSE");
      setExitOpen(false);
      onLeave();
    } catch {
      setLeaving(false);
    }
  }, [sessionAct, onLeave]);

  const requestExit = useCallback(() => {
    // Sessão sem nenhuma pergunta: sai direto e descarta, sem modal.
    if (turns.length === 0) {
      setLeaving(true);
      void sessionAct("ABANDON").finally(onLeave);
      return;
    }
    setExitOpen(true);
  }, [turns.length, sessionAct, onLeave]);

  // Fechamento abrupto do navegador → PAUSA (recuperável), nunca abandono
  // silencioso: encerrar sem conclusão é um juízo do assistente.
  useEffect(() => {
    if (sessionOver) return;
    const handler = () => pauseOnUnload(patientId, session.id);
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [patientId, session.id, sessionOver]);

  // Atalhos do assistente: 1 = SIM, 2 = TALVEZ, 3 = NÃO — o mesmo padrão da
  // tela Conversar. Ativos só quando a pergunta aguarda resposta.
  // Enquanto um caminho está aberto, 1/2/3 significam OPÇÃO 1/2/3 e quem
  // escuta é o flow — os dois significados nunca ficam ativos ao mesmo tempo.
  useEffect(() => {
    if (openPath) return;
    if (!currentTurn || currentTurn.status !== "AWAITING_RESPONSE" || paused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement) {
        const tag = e.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
      }
      const map: Record<string, SemanticResponse> = {
        "1": "YES",
        "2": "MAYBE",
        "3": "NO",
      };
      const response = map[e.key];
      if (!response) return;
      void act(currentTurn.id, { kind: "SELECT_RESPONSE", response });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentTurn, paused, act, openPath]);

  // ——— Render ———

  const status = currentTurn?.status ?? null;
  // Enquanto um caminho está aberto, ele ocupa a área principal: os dois modos
  // nunca dividem a tela, para que o significado dos sinais seja um só.
  const showStage =
    !paused &&
    !sessionOver &&
    !composing &&
    openPath == null &&
    currentTurn != null &&
    (status === "PRESENTED" ||
      status === "AWAITING_RESPONSE" ||
      status === "PROVISIONAL_RESPONSE" ||
      status === "RECONFIRMATION_PENDING");

  return (
    <div className="relative flex flex-1 flex-col">
      <OverlayVeil />
      <main className="relative flex w-full flex-1 flex-col items-center justify-center gap-6 px-4 pb-6 sm:px-6">
        <div className="pointer-events-auto mx-auto flex w-full max-w-3xl flex-col gap-6 py-6">
          {persist.error && (
            <ErrorBanner
              message={persist.error.message}
              canReload={
                persist.error.kind === "conflict" ||
                persist.error.kind === "notFound"
              }
              onRetry={retryable ? retryFailed : null}
              onReload={() => void reload().catch(() => {})}
              onDismiss={persist.clearError}
            />
          )}

          {/* Barra do contexto: só nas telas do CUIDADOR. Nunca aparece sobre
              o palco do paciente — o contexto não é para ele ver. */}
          {context && !sessionOver && !showStage && !openPath && (
            <SessionContextBar
              context={context}
              busy={busy}
              onEdit={() => setContextEditing(true)}
              onView={() => void verContexto().catch(() => {})}
            />
          )}

          {sessionOver ? (
            <FinishedScreen status={session.status} turns={turns} onLeave={onLeave} />
          ) : context == null ? (
            /* Antes de tudo: preencher ou pular. Enquanto o cuidador não
               decidir, a sessão não avança — e pular é um clique só. */
            <SessionContextScreen
              patientId={patientId}
              busy={busy}
              onSave={(draft: ContextDraft) =>
                void salvarContexto({
                  interlocutorPersonId: draft.interlocutor.personId,
                  interlocutorName: draft.interlocutor.name || null,
                  interlocutorRelation: draft.interlocutor.relation || null,
                  intention: draft.intention || null,
                  environment: draft.environment || null,
                  initialTopic: draft.initialTopic || null,
                  notes: draft.notes || null,
                }).catch(() => {})
              }
              onSkip={() => void salvarContexto({ skipped: true }).catch(() => {})}
            />
          ) : paused ? (
            <PausedScreen
              busy={busy}
              onResume={() => void sessionAct("RESUME").catch(() => {})}
              onExit={requestExit}
            />
          ) : openPath ? (
            <OptionConversationFlow
              key={openPath.path.id}
              patientId={patientId}
              sessionId={session.id}
              detail={openPath}
              profile={profile}
              persist={persist}
              onDetail={applyPathDetail}
              onLeave={leaveOptionConversation}
              onSwitchPath={switchToPath}
            />
          ) : composing ? (
            <ComposeScreen
              draft={draft}
              busy={busy}
              editing={currentTurn != null}
              onChange={setDraft}
              onContinue={() => void continueToReview()}
              onCancel={() => {
                if (currentTurn) void cancelQuestion(currentTurn);
                else setComposing(false);
              }}
              cancelable={currentTurn != null || turns.length > 0}
              onOptionConversation={
                currentTurn == null
                  ? () => void startOptionConversation()
                  : null
              }
            />
          ) : currentTurn?.status === "DRAFT" ? (
            <ReviewScreen
              text={draft.trim() || currentTurn.reviewedText}
              sensitive={sensitive}
              category={category}
              busy={busy}
              onEdit={() => {
                setDraft(draft.trim() || currentTurn.reviewedText);
                setComposing(true);
              }}
              onSensitiveChange={(value) => {
                setSensitive(value);
                if (!value) setCategory(null);
              }}
              onCategoryChange={setCategory}
              onPresent={() => void present(currentTurn)}
              onCancel={() => void cancelQuestion(currentTurn)}
            />
          ) : currentTurn?.status === "UNCERTAIN_GESTURE" ? (
            <UncertainScreen
              busy={busy}
              onAwait={() =>
                void act(currentTurn.id, { kind: "AWAIT_RESPONSE" }).catch(() => {})
              }
              onRepresent={() => void represent(currentTurn)}
              onPause={() => void sessionAct("PAUSE").catch(() => {})}
              onNoResponse={() => void registerNoResponse(currentTurn)}
              onCancel={() => void cancelQuestion(currentTurn)}
            />
          ) : currentTurn == null ? (
            <IdleScreen
              lastTurn={lastTurn}
              busy={busy}
              onNewQuestion={startQuestion}
              onOptionConversation={() => void startOptionConversation()}
              onFinish={requestExit}
            />
          ) : null}

          {showStage && currentTurn && (
            <>
              <QuestionStage
                question={currentTurn.presentedText || currentTurn.reviewedText}
                choices={choices}
                selected={currentTurn.provisionalResponse}
                awaiting={currentTurn.status !== "PRESENTED"}
                disabled={
                  busy ||
                  !(
                    currentTurn.status === "AWAITING_RESPONSE" ||
                    (currentTurn.status === "PROVISIONAL_RESPONSE" && correcting)
                  )
                }
                onSelect={(response) => {
                  const changing = currentTurn.status === "PROVISIONAL_RESPONSE";
                  setCorrectingTurnId(null);
                  // Reescolher a MESMA resposta não é correção: só fecha o
                  // modo de correção, sem gerar evento nem contar como uma.
                  if (changing && response === currentTurn.provisionalResponse) {
                    return;
                  }
                  void act(currentTurn.id, {
                    kind: changing ? "CHANGE_RESPONSE" : "SELECT_RESPONSE",
                    response,
                  }).catch(() => {});
                }}
              />

              {currentTurn.status === "AWAITING_RESPONSE" && (
                <AwaitingControls
                  busy={busy}
                  onUncertain={() =>
                    void act(currentTurn.id, {
                      kind: "RECORD_UNCERTAIN_GESTURE",
                    }).catch(() => {})
                  }
                  onRepresent={() => void represent(currentTurn)}
                  onNoResponse={() => void registerNoResponse(currentTurn)}
                />
              )}

              {currentTurn.status === "PROVISIONAL_RESPONSE" &&
                currentTurn.provisionalResponse && (
                  <ProvisionalPanel
                    response={currentTurn.provisionalResponse}
                    sensitive={currentTurn.isSensitive}
                    correcting={correcting}
                    busy={busy}
                    onConfirm={() =>
                      void act(currentTurn.id, { kind: "VERIFY_RESPONSE" }).catch(
                        () => {}
                      )
                    }
                    onCorrect={() => setCorrectingTurnId(currentTurn.id)}
                    onCancelSelection={() => {
                      setCorrectingTurnId(null);
                      void act(currentTurn.id, { kind: "REMOVE_RESPONSE" }).catch(
                        () => {}
                      );
                    }}
                  />
                )}

              {currentTurn.status === "RECONFIRMATION_PENDING" &&
                currentTurn.provisionalResponse && (
                  <ReconfirmPanel
                    response={currentTurn.provisionalResponse}
                    busy={busy}
                    onReconfirm={() =>
                      void act(currentTurn.id, {
                        kind: "RECONFIRM_RESPONSE",
                      }).catch(() => {})
                    }
                    onCorrect={() =>
                      void act(currentTurn.id, { kind: "REMOVE_RESPONSE" }).catch(
                        () => {}
                      )
                    }
                    // Sem reconfirmação, a resposta NÃO é registrada: a
                    // interação volta a aguardar. De lá o assistente ainda
                    // pode registrar ausência, se for o caso.
                    onFailedReconfirmation={() =>
                      void act(currentTurn.id, { kind: "REMOVE_RESPONSE" }).catch(
                        () => {}
                      )
                    }
                  />
                )}
            </>
          )}

          <SessionHistory
            turns={turns}
            paths={pathDetails}
            busy={busy}
            onOpen={sessionOver ? undefined : openHistoryEntry}
          />
        </div>
      </main>

      {historyEntry && (
        <HistoryActionsDialog
          entry={historyEntry}
          busy={busy}
          onDetails={() => {
            setHistoryDetail(historyEntry);
            setHistoryEntry(null);
          }}
          onReuse={() => {
            const entry = historyEntry;
            if (entry.kind === "TURN") {
              void reuse(
                () =>
                  persist.createTurn(patientId, session.id, {
                    text: entry.turn.presentedText || entry.turn.reviewedText,
                    isSensitive: entry.turn.isSensitive,
                    sensitiveCategory: entry.turn.sensitiveCategory,
                    reusedFromTurnId: entry.turn.id,
                  }),
                "TURN"
              );
            } else {
              void reuse(
                () =>
                  persist.reusePath(
                    patientId,
                    session.id,
                    entry.detail.path.id,
                    newRequestId("reuse-path")
                  ),
                "PATH"
              );
            }
          }}
          onClose={() => setHistoryEntry(null)}
        />
      )}

      {historyDetail && (
        <HistoryDetail
          entry={historyDetail}
          assistantName={session.assistantName}
          busy={busy}
          onReusePath={(pathId) =>
            void reuse(
              () =>
                persist.reusePath(
                  patientId,
                  session.id,
                  pathId,
                  newRequestId("reuse-path")
                ),
              "PATH"
            )
          }
          onReuseNode={(nodeId) =>
            void reuse(
              () =>
                persist.reuseNode(
                  patientId,
                  session.id,
                  nodeId,
                  newRequestId("reuse-node")
                ),
              "PATH"
            )
          }
          onReuseStatement={(statementId) =>
            void reuse(
              () =>
                persist.reuseStatement(
                  patientId,
                  session.id,
                  statementId,
                  newRequestId("reuse-stmt")
                ),
              "PATH"
            )
          }
          onReuseTurn={(turnId) => {
            const origem = turns.find((t) => t.id === turnId);
            if (!origem) return;
            void reuse(
              () =>
                persist.createTurn(patientId, session.id, {
                  text: origem.presentedText || origem.reviewedText,
                  isSensitive: origem.isSensitive,
                  sensitiveCategory: origem.sensitiveCategory,
                  reusedFromTurnId: origem.id,
                }),
              "TURN"
            );
          }}
          onClose={() => setHistoryDetail(null)}
        />
      )}

      {contextEditing && context && (
        <SessionContextDialog
          patientId={patientId}
          context={context}
          busy={busy}
          onSave={(draft: ContextDraft) =>
            void salvarContexto({
              interlocutorPersonId: draft.interlocutor.personId,
              interlocutorName: draft.interlocutor.name || null,
              interlocutorRelation: draft.interlocutor.relation || null,
              intention: draft.intention || null,
              environment: draft.environment || null,
              initialTopic: draft.initialTopic || null,
              notes: draft.notes || null,
            }).catch(() => {})
          }
          onClose={() => setContextEditing(false)}
        />
      )}

      {contextVersions && (
        <ContextVersionsList
          versions={contextVersions}
          onClose={() => setContextVersions(null)}
        />
      )}

      {!sessionOver && (
        // `relative`: sem contexto de posicionamento o véu (absolute) pintaria
        // por cima dos controles e eles ficariam lavados.
        <footer className="no-print pointer-events-auto relative flex flex-wrap items-center justify-center gap-2 px-6 pb-6">
          <span
            aria-live="polite"
            className={`text-sm ${busy ? "text-ink-soft" : "sr-only"}`}
          >
            {busy ? "Registrando…" : "Registro em dia"}
          </span>
          {!paused && (
            <Control onClick={() => void sessionAct("PAUSE").catch(() => {})}>
              ⏸ Pausar sessão
            </Control>
          )}
          <Control onClick={requestExit}>Encerrar sessão</Control>
        </footer>
      )}

      {exitOpen && (
        <ExitModal
          busy={leaving}
          onContinue={() => setExitOpen(false)}
          onPause={() => void pauseAndLeave()}
          onComplete={() => void finishAndLeave("COMPLETE")}
          onAbandon={() => void finishAndLeave("ABANDON")}
        />
      )}
    </div>
  );
}

