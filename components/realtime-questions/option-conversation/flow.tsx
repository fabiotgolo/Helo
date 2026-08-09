"use client";

// ——— Conversa por opções: orquestrador do caminho ———
//
// Casca, exatamente como session.tsx: ela mostra o estado que veio do servidor
// e despacha a AÇÃO do assistente para a máquina de estados. Nunca escolhe o
// próximo estado.
//
// Consequências diretas, e é por isso que o desenho é este:
//   - nenhuma opção aparece confirmada antes da resposta do servidor;
//   - uma seleção provisória interrompida por pausa volta como provisória;
//   - a interface não tem como pular a conferência da opção observada, nem a
//     reconfirmação de um assunto sensível, nem transformar TALVEZ ou NÃO em
//     confirmação — quem decide é o domínio.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHeloDialog } from "@/components/helo-dialog";
import {
  Breadcrumb,
  buildCrumbs,
} from "@/components/realtime-questions/option-conversation/breadcrumb";
import {
  Composer,
  StatementConfirmation,
  StatementEditor,
} from "@/components/realtime-questions/option-conversation/composer";
import {
  draftFromNode,
  emptyDraft,
  NodeEditor,
  NodeReview,
  type NodeDraft,
} from "@/components/realtime-questions/option-conversation/node-editor";
import { RascunhoLocalAviso } from "@/components/realtime-questions/offline-chip";
import {
  NodeStage,
  useOptionChoices,
} from "@/components/realtime-questions/option-conversation/node-stage";
import { SelectionPanel } from "@/components/realtime-questions/option-conversation/selection-panel";
import { InterpretationReview } from "@/components/realtime-questions/interpretation";
import {
  Control,
  InteractionModeBadge,
  Primary,
} from "@/components/realtime-questions/ui";
import {
  rotuloDeAutoria,
  tryToConfirmedPatientStatement,
} from "@/lib/confirmed-patient-statement";
import {
  newRequestId,
  type RtqPersistence,
} from "@/lib/realtime-question-client";
import type { OfflineBridge } from "@/lib/offline/use-offline-session";
import {
  activeTrail,
  isTerminalPathStatus,
  isTerminalStatementStatus,
  trailLabels as toTrailLabels,
  type OptionConversationFinalStatement,
  type OptionConversationNode,
  type PathDetail,
} from "@/lib/option-conversation-types";
import {
  liveStatement,
  telaDerivada,
  type Screen,
} from "@/lib/option-conversation-screen";
import type {
  InteractionMode,
  PatientResponseProfile,
} from "@/lib/realtime-question-types";

export type { Screen };

export function OptionConversationFlow({
  patientId,
  sessionId,
  detail,
  profile,
  persist,
  onDetail,
  onLeave,
  onSwitchPath,
  offline,
}: {
  patientId: number;
  sessionId: string;
  detail: PathDetail;
  profile: PatientResponseProfile | null;
  persist: RtqPersistence;
  /**
   * Armazenamento local (Fase 4.9.2). Opcional: sem ele o editor volta ao
   * comportamento de sempre — rascunho em memória, perdido no refresh.
   */
  offline?: OfflineBridge;
  /** Substitui o estado local pelo que o servidor devolveu. */
  onDetail: (detail: PathDetail) => void;
  /** Sai do modo e volta à sessão de perguntas. O caminho continua como está. */
  onLeave: () => void;
  /** Reiniciar encerra este caminho e abre o novo, sem sair do modo. */
  onSwitchPath: (pathId: string) => void;
}) {
  const dialog = useHeloDialog();
  const { path, nodes, statements } = detail;

  // "Corrigir" reabre as opções SEM apagar a seleção: a próxima escolha vira
  // OPTION_CHANGED, preservando a anterior no evento. Guardamos QUAL nível
  // está em correção, para o modo nunca sobrar ligado no nível seguinte.
  const [correctingNodeId, setCorrectingNodeId] = useState<string | null>(null);
  // Interpretação (Fase 4.2): a tela padrão é a REVISÃO; o editor só reaparece
  // quando o cuidador pede para editar. Estado de tela, não de dados.
  const [revisandoInterpretacao, setRevisandoInterpretacao] = useState(false);

  const busy = persist.saving;

  // ——— Estado derivado ———

  const activeNode = useMemo(
    () => nodes.find((n) => n.id === path.activeNodeId) ?? null,
    [nodes, path.activeNodeId]
  );
  const trail = useMemo(
    () => activeTrail(nodes, path.activeNodeId),
    [nodes, path.activeNodeId]
  );
  const crumbs = useMemo(() => buildCrumbs(trail), [trail]);
  const pathLabels = useMemo(() => toTrailLabels(trail), [trail]);

  const activeStatement = useMemo(() => liveStatement(detail), [detail]);

  const confirmedOption = activeNode
    ? (activeNode.options.find((o) => o.id === activeNode.confirmedOptionId) ??
      null)
    : null;

  const derivedScreen = useMemo<Screen>(() => telaDerivada(detail), [detail]);

  /**
   * Assinatura do estado persistido. Uma tela FORÇADA pelo assistente (abrir a
   * edição, por exemplo) só vale enquanto esta assinatura não muda — assim um
   * retorno pelo breadcrumb nunca deixa ninguém preso numa tela que já não
   * corresponde ao caminho, e não precisamos de um efeito para "limpar".
   */
  const stamp = `${path.activeNodeId ?? ""}|${path.status}|${
    activeStatement?.id ?? ""
  }|${activeStatement?.status ?? ""}`;
  const [override, setOverride] = useState<{ stamp: string; screen: Screen } | null>(
    null
  );
  const setScreen = (next: Screen | null) => {
    setOverride(next ? { stamp, screen: next } : null);
  };

  const current = override?.stamp === stamp ? override.screen : derivedScreen;

  /**
   * O rascunho do editor é DERIVADO do nível persistido enquanto o assistente
   * não digita. Sem isso, um nível que chega em rascunho — vindo de uma
   * reutilização, de uma versão corrigida ou de um refresh da página —
   * apareceria com os campos vazios, e o conteúdo que o servidor já guardou
   * ficaria invisível (§32: restaurar versões em edição).
   */
  const editingNode =
    current.kind === "EDIT_NODE" && current.nodeId
      ? (nodes.find((n) => n.id === current.nodeId) ?? null)
      : null;
  const draftKey =
    current.kind === "EDIT_NODE"
      ? (current.nodeId ?? `novo:${current.parentNodeId ?? "raiz"}`)
      : "";
  const [typedDraft, setTypedDraft] = useState<{
    key: string;
    draft: NodeDraft;
  } | null>(null);

  /**
   * O nível em construção também é rascunho: o texto e as opções existem na
   * tela ANTES de qualquer registro nascer. Guardá-lo é o que faz um refresh
   * no meio da montagem não custar a digitação inteira.
   *
   * A chave carrega o nível (ou "novo:pai"), então dois níveis em edição não
   * se sobrescrevem — e a sessão já está no escopo do armazenamento.
   */
  const chaveDoRascunho = draftKey ? `nivel:${draftKey}` : "";
  // Leitura direta do que ficou guardado — sem estado, sem renderizar de novo
  // por causa disso. Quem manda enquanto o cuidador digita é `typedDraft`.
  const rascunhoGuardado =
    chaveDoRascunho && offline?.rascunhosProntos
      ? (offline.lerRascunho(chaveDoRascunho) as NodeDraft | undefined)
      : undefined;

  const draft =
    (typedDraft?.key === draftKey ? typedDraft.draft : undefined) ??
    rascunhoGuardado ??
    (editingNode ? draftFromNode(editingNode) : emptyDraft());

  // Função simples, sem memoização: o compilador do React cuida disso, e
  // tentar preservar memoização manual aqui o faz desistir do componente.
  const setDraft = (next: NodeDraft) => {
    setTypedDraft({ key: draftKey, draft: next });
    if (chaveDoRascunho) {
      offline?.definirRascunho(chaveDoRascunho, next, next.isSensitive);
    }
  };
  /** Submetido ou cancelado: o rascunho sai da tela E do aparelho. */
  const limparRascunho = () => {
    setTypedDraft(null);
    if (chaveDoRascunho) offline?.descartarRascunho(chaveDoRascunho);
  };

  // Numa interpretação (Fase 4.2) o contêiner não tem árvore: o selo precisa
  // dizer que os sinais valem sobre o que o CUIDADOR entendeu, e não fingir
  // que houve escolha entre opções.
  const interpretacao = path.kind === "CAREGIVER_INTERPRETATION";
  const mode: InteractionMode = interpretacao
    ? "CAREGIVER_INTERPRETATION"
    : current.kind === "CONFIRM_STATEMENT"
      ? "FINAL_STATEMENT_CONFIRMATION"
      : "OPTION_SELECTION";

  // O modo de correção morre sozinho quando o nível ativo muda: ele só vale
  // para o nível cujo id foi guardado.
  const correcting =
    activeNode != null &&
    activeNode.id === correctingNodeId &&
    activeNode.status === "PROVISIONAL_SELECTION";

  // ——— Recarregamento ———

  const reload = useCallback(async () => {
    const fresh = await persist.pathDetail(patientId, sessionId, path.id);
    onDetail(fresh);
    return fresh;
  }, [persist, patientId, sessionId, path.id, onDetail]);

  // ——— Ações sobre níveis ———

  /**
   * Ações já em curso. A fila do cliente deduplica requisições EM VOO, mas
   * entre o fim da gravação e o fim da releitura existe uma fresta em que o
   * botão ainda está na tela — e é nela que um clique acidental entraria de
   * novo, só para receber uma recusa do domínio e uma faixa de erro que o
   * cuidador não causou. O guarda só abre depois que a tela já refletiu o
   * resultado.
   */
  const inFlight = useRef(new Set<string>());

  const guarded = useCallback(
    async (key: string, op: () => Promise<unknown>) => {
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      try {
        await op();
      } finally {
        inFlight.current.delete(key);
      }
    },
    []
  );

  const nodeAct = useCallback(
    async (nodeId: string, action: Parameters<RtqPersistence["nodeAction"]>[4]) => {
      await guarded(`node:${nodeId}:${action.kind}`, async () => {
        persist.clearError();
        await persist.nodeAction(patientId, sessionId, path.id, nodeId, action);
        await reload();
      });
    },
    [guarded, persist, patientId, sessionId, path.id, reload]
  );

  const createNode = async (parentNodeId: string | null) => {
    persist.clearError();
    try {
      const options = draft.options.filter((o) => o.label.trim());
      const created = await persist.createNode(patientId, sessionId, path.id, {
        promptText: draft.promptText,
        options,
        parentNodeId,
        isSensitive: draft.isSensitive,
        sensitiveCategory: draft.sensitiveCategory,
        clientRequestId: newRequestId("node"),
      });
      // Escrever no editor JÁ é a revisão do assistente: o nível nasce em
      // rascunho e passa a REVISADO aqui, que é o único estado de onde ele
      // pode ser apresentado. Os dois eventos ficam na trilha.
      await persist.reviewNode(patientId, sessionId, path.id, created.id, {
        promptText: draft.promptText,
        options,
        isSensitive: draft.isSensitive,
        sensitiveCategory: draft.sensitiveCategory,
      });
      limparRascunho();
      setScreen(null);
      await reload();
    } catch {
      // A faixa de erro já explica; o rascunho continua na tela.
    }
  };

  const saveDraft = async (nodeId: string) => {
    persist.clearError();
    try {
      await persist.reviewNode(patientId, sessionId, path.id, nodeId, {
        promptText: draft.promptText,
        options: draft.options.filter((o) => o.label.trim()),
        isSensitive: draft.isSensitive,
        sensitiveCategory: draft.sensitiveCategory,
      });
      setScreen(null);
      await reload();
    } catch {
      /* faixa de erro */
    }
  };

  const present = useCallback(
    async (nodeId: string) => {
      try {
        await persist.nodeAction(patientId, sessionId, path.id, nodeId, {
          kind: "PRESENT",
        });
        await persist.nodeAction(patientId, sessionId, path.id, nodeId, {
          kind: "AWAIT_SELECTION",
        });
        setScreen(null);
        await reload();
      } catch {
        /* faixa de erro */
      }
    },
    [persist, patientId, sessionId, path.id, reload, setScreen]
  );

  const cancelNode = useCallback(
    async (nodeId: string) => {
      const ok = await dialog.confirm({
        title: "Cancelar este nível?",
        message:
          "O nível sai do fluxo e fica registrado como cancelado. Nada do que já foi observado é apagado.",
        confirmLabel: "Cancelar nível",
        cancelLabel: "Voltar",
        tone: "warning",
      });
      if (!ok) return;
      try {
        await nodeAct(nodeId, { kind: "CANCEL" });
      } catch {
        /* faixa de erro */
      }
    },
    [dialog, nodeAct]
  );

  /**
   * Editar depois de apresentado NÃO reescreve: cria uma versão corrigida, com
   * o original preservado e nenhuma resposta migrada (§28, §29).
   */
  const requestNodeEdit = async (node: OptionConversationNode) => {
    if (node.status === "DRAFT" || node.status === "REVIEWED") {
      limparRascunho();
      setScreen({
        kind: "EDIT_NODE",
        nodeId: node.id,
        parentNodeId: node.parentNodeId,
      });
      return;
    }
    const ok = await dialog.confirm({
      title: "Este conteúdo já foi apresentado ao paciente.",
      message:
        "Deseja criar uma versão corrigida? A versão original continua registrada, com tudo o que o paciente respondeu nela. Nenhuma resposta anterior passa para a nova versão.",
      confirmLabel: "Criar versão corrigida",
      cancelLabel: "Voltar",
      tone: "warning",
    });
    if (!ok) return;
    try {
      const { created } = await persist.replaceNode(
        patientId,
        sessionId,
        path.id,
        node.id,
        newRequestId("replace-node")
      );
      limparRascunho();
      setScreen({
        kind: "EDIT_NODE",
        nodeId: created.id,
        parentNodeId: created.parentNodeId,
      });
    await reload();
    } catch {
    /* faixa de erro */
    }
  };

  // ——— Breadcrumb ———

  const goToLevel = async (nodeId: string) => {
    persist.clearError();
    try {
      const fresh = await persist.returnToLevel(
        patientId,
        sessionId,
        path.id,
        nodeId,
        newRequestId("return")
      );
      onDetail(fresh);
    setScreen(null);
    } catch {
    /* faixa de erro */
    }
  };

  const goBackOneLevel = () => {
    const previous = crumbs.at(-2);
    if (previous) void goToLevel(previous.nodeId);
  };

  const restart = async () => {
    const temEscolhas = nodes.some((n) => n.confirmedOptionId);
    if (temEscolhas) {
      const ok = await dialog.confirm({
        title: "Deseja reiniciar esta conversa?",
        message:
          "O caminho atual será encerrado, mas permanecerá registrado — nenhum nível é excluído.",
        confirmLabel: "Reiniciar",
        cancelLabel: "Continuar conversa",
        tone: "warning",
      });
      if (!ok) return;
    }
    try {
      const { created } = await persist.restartPath(
        patientId,
        sessionId,
        path.id,
        newRequestId("restart")
      );
      limparRascunho();
      setScreen(null);
      // O caminho atual fica registrado como RESTARTED; a tela passa a ser a
      // do caminho novo, sem sair do modo.
      onSwitchPath(created.id);
    } catch {
      /* faixa de erro */
    }
  };

  // ——— Frase final ———

  const suggestion = confirmedOption?.finalStatementDraft ?? null;

  /**
   * O texto em edição também é DERIVADO enquanto o assistente não digita: parte
   * da frase que já existe, ou da frase associada à opção terminal escolhida.
   * Assim atualizar a página traz o rascunho de volta sem efeito nenhum (§32).
   */
  const statementKey =
    current.kind === "EDIT_STATEMENT" ? (current.statementId ?? "novo") : "";
  const [typed, setTyped] = useState<{ key: string; text: string } | null>(null);
  const statementText =
    typed?.key === statementKey
      ? typed.text
      : ((current.kind === "EDIT_STATEMENT" && current.statementId
          ? statements.find((s) => s.id === current.statementId)?.currentText
          : null) ??
        suggestion ??
        "");
  const setStatementText = (text: string) =>
    setTyped({ key: statementKey, text });

  const submitStatement = useCallback(
    async (statementId: string | null) => {
      const text = statementText.trim();
      if (!text) return;
      persist.clearError();
      try {
        let id = statementId;
        if (id) {
          await persist.statementAction(patientId, sessionId, path.id, id, {
            kind: "EDIT",
            text,
          });
        } else {
          const created = await persist.createStatement(
            patientId,
            sessionId,
            path.id,
            {
              text,
              originNodeId: activeNode?.id ?? null,
              clientRequestId: newRequestId("statement"),
            }
          );
          id = created.id;
          // Uma frase recém-criada nasce em DRAFT: revisá-la é o que a leva a
          // REVIEWED, o único estado de onde ela pode ser apresentada.
          await persist.statementAction(patientId, sessionId, path.id, id, {
            kind: "EDIT",
            text,
          });
        }
        await persist.statementAction(patientId, sessionId, path.id, id, {
          kind: "PRESENT",
        });
        setTyped(null);
        setScreen(null);
        await reload();
      } catch {
        /* faixa de erro */
      }
    },
    [statementText, persist, patientId, sessionId, path.id, activeNode, reload, setScreen]
  );

  const statementAct = useCallback(
    async (
      statementId: string,
      action: Parameters<RtqPersistence["statementAction"]>[4]
    ) => {
      await guarded(`statement:${statementId}:${action.kind}`, async () => {
        persist.clearError();
        try {
          await persist.statementAction(
            patientId,
            sessionId,
            path.id,
            statementId,
            action
          );
          await reload();
        } catch {
          /* faixa de erro */
        }
      });
    },
    [guarded, persist, patientId, sessionId, path.id, reload]
  );

  /** Ajustar/reformular uma frase JÁ apresentada = nova versão (§30). */
  const adjustStatement = useCallback(
    async (statement: OptionConversationFinalStatement) => {
      const ok = await dialog.confirm({
        title: "Esta frase já foi apresentada ao paciente.",
        message:
          "Deseja criar uma versão corrigida? A frase original continua registrada, e a resposta que ela recebeu permanece vinculada apenas a ela. A nova versão exigirá nova apresentação e nova confirmação.",
        confirmLabel: "Criar versão corrigida",
        cancelLabel: "Voltar",
        tone: "warning",
      });
      if (!ok) return;
      try {
        const { created } = await persist.replaceStatement(
          patientId,
          sessionId,
          path.id,
          statement.id,
          newRequestId("replace-statement")
        );
        setStatementText(created.currentText);
        setScreen({ kind: "EDIT_STATEMENT", statementId: created.id });
        await reload();
      } catch {
        /* faixa de erro */
      }
    },
    [dialog, persist, patientId, sessionId, path.id, reload, setScreen, setStatementText]
  );

  // ——— Atalhos 1/2/3 = OPÇÃO 1/2/3 ———
  // Enquanto o caminho está ativo, os números escolhem OPÇÕES. O mapa
  // semântico (1=SIM, 2=TALVEZ, 3=NÃO) de session.tsx vale só na pergunta
  // fechada e na confirmação da frase.
  useEffect(() => {
    if (!activeNode || activeNode.status !== "AWAITING_SELECTION") return;
    if (current.kind !== "STAGE") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement) {
        const tag = e.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      }
      const index = Number(e.key) - 1;
      if (!Number.isInteger(index) || index < 0) return;
      const option = [...activeNode.options].sort(
        (a, b) => a.position - b.position
      )[index];
      if (!option) return;
      void nodeAct(activeNode.id, {
        kind: "SELECT_OPTION",
        optionId: option.id,
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeNode, current.kind, nodeAct]);

  // ——— Render ———

  const choices = useOptionChoices(profile, activeNode?.options ?? []);
  const statementOnScreen =
    current.kind === "CONFIRM_STATEMENT"
      ? (statements.find((s) => s.id === current.statementId) ?? null)
      : null;

  /**
   * A interpretação em revisão — a frase viva enquanto ela ainda é rascunho.
   * `statementOnScreen` só existe na confirmação; aqui, ANTES de apresentar, é
   * a frase ativa que a tela de revisão precisa mostrar (Fase 4.2).
   */
  const interpretacaoEmRevisao =
    interpretacao &&
    current.kind === "EDIT_STATEMENT" &&
    activeStatement &&
    (activeStatement.status === "DRAFT" || activeStatement.status === "REVIEWED")
      ? activeStatement
      : null;

  const showComposer =
    current.kind === "EDIT_STATEMENT" ||
    current.kind === "CONFIRM_STATEMENT" ||
    current.kind === "DONE";

  return (
    <div className="flex w-full flex-col gap-6">
      {!interpretacao && (
        <Breadcrumb
          crumbs={crumbs}
          busy={busy}
          canGoBack={crumbs.length > 1 && !isTerminalPathStatus(path.status)}
          canRestart={!isTerminalPathStatus(path.status)}
          onNavigate={(nodeId) => void goToLevel(nodeId)}
          onBack={goBackOneLevel}
          onRestart={() => void restart()}
        />
      )}

      <InteractionModeBadge mode={mode} />

      {current.kind === "EDIT_NODE" && (
        <>
        {/* O nível em construção já era guardado no aparelho, mas a tela não
            dizia. Sem esta marca, o cuidador não tem como saber que pode
            fechar o navegador sem perder o que digitou — e a garantia só vale
            se ele souber que existe. */}
        <RascunhoLocalAviso
          visivel={
            Boolean(offline?.disponivel) &&
            (draft.promptText.trim().length > 0 ||
              draft.options.some((o) => o.label.trim().length > 0))
          }
        />
        <NodeEditor
          draft={draft}
          busy={busy}
          patientId={patientId}
          editing={current.nodeId != null}
          isRoot={current.parentNodeId == null && nodes.length === 0}
          onChange={setDraft}
          onSubmit={() =>
            current.nodeId
              ? void saveDraft(current.nodeId)
              : void createNode(current.parentNodeId)
          }
          onCancel={() => {
            limparRascunho();
            if (current.nodeId) void cancelNode(current.nodeId);
            else onLeave();
          }}
        />
        </>
      )}

      {current.kind === "REVIEW_NODE" &&
        activeNode &&
        activeNode.id === current.nodeId && (
          <NodeReview
            draft={draftFromNode(activeNode)}
            busy={busy}
            onEdit={() => void requestNodeEdit(activeNode)}
            onPresent={() => void present(activeNode.id)}
            onCancel={() => void cancelNode(activeNode.id)}
          />
        )}

      {current.kind === "STAGE" && activeNode && (
        <>
          <div className="flex justify-end">
            <EditRow
              node={activeNode}
              busy={busy}
              onEdit={() => void requestNodeEdit(activeNode)}
            />
          </div>
          <NodeStage
            prompt={activeNode.promptText}
            choices={choices}
            selectedOptionId={activeNode.provisionalOptionId}
            awaiting={activeNode.status !== "PRESENTED"}
            disabled={
              busy ||
              !(
                activeNode.status === "AWAITING_SELECTION" ||
                (activeNode.status === "PROVISIONAL_SELECTION" && correcting)
              )
            }
            onSelect={(optionId) => {
              const changing = activeNode.status === "PROVISIONAL_SELECTION";
              setCorrectingNodeId(null);
              // Reescolher a MESMA opção não é correção: só fecha o modo de
              // correção, sem gerar evento nem contar como uma.
              if (changing && optionId === activeNode.provisionalOptionId) return;
              void nodeAct(activeNode.id, {
                kind: changing ? "CHANGE_OPTION" : "SELECT_OPTION",
                optionId,
              }).catch(() => {});
            }}
          />

          {activeNode.status === "PROVISIONAL_SELECTION" &&
            activeNode.provisionalOptionId && (
              <SelectionPanel
                optionLabel={
                  activeNode.options.find(
                    (o) => o.id === activeNode.provisionalOptionId
                  )?.label ?? ""
                }
                position={
                  activeNode.options.find(
                    (o) => o.id === activeNode.provisionalOptionId
                  )?.position ?? 0
                }
                sensitive={
                  activeNode.isSensitive ||
                  activeNode.options.find(
                    (o) => o.id === activeNode.provisionalOptionId
                  )?.isSensitive === true
                }
                correcting={correcting}
                busy={busy}
                onConfirm={() =>
                  void nodeAct(activeNode.id, { kind: "CONFIRM_OPTION" }).catch(
                    () => {}
                  )
                }
                onCorrect={() => setCorrectingNodeId(activeNode.id)}
                onCancelSelection={() => {
                  setCorrectingNodeId(null);
                  void nodeAct(activeNode.id, {
                    kind: "REMOVE_SELECTION",
                  }).catch(() => {});
                }}
              />
            )}
        </>
      )}

      {showComposer && (
        <Composer
          trailLabels={pathLabels}
          statement={statementOnScreen ?? activeStatement}
          busy={busy}
          onEdit={
            current.kind === "EDIT_STATEMENT"
              ? null
              : statementOnScreen &&
                  !isTerminalStatementStatus(statementOnScreen.status)
                ? () => void adjustStatement(statementOnScreen)
                : null
          }
          interpretacao={interpretacao}
        >
          {/* Interpretação: a revisão vem ANTES de apresentar, e é onde o
              cuidador relê o que escreveu e classifica o assunto sensível
              (Fase 4.2, §13). Só ao pedir "Editar" volta para o editor. */}
          {interpretacaoEmRevisao && !revisandoInterpretacao && (
            <InterpretationReview
              text={interpretacaoEmRevisao.currentText}
              isSensitive={interpretacaoEmRevisao.isSensitive}
              sensitiveCategory={interpretacaoEmRevisao.sensitiveCategory}
              busy={busy}
              onChangeSensitive={(isSensitive, category) =>
                void statementAct(interpretacaoEmRevisao.id, {
                  kind: "EDIT",
                  text: interpretacaoEmRevisao.currentText,
                  isSensitive,
                  sensitiveCategory: category,
                })
              }
              onEdit={() => setRevisandoInterpretacao(true)}
              onPresent={() =>
                void (async () => {
                  // Apresentar a partir da revisão é DOIS atos do cuidador: ele
                  // atesta que leu (EDIT, que leva o rascunho a revisada) e só
                  // então mostra ao paciente. O domínio recusa apresentar
                  // direto do rascunho, e é essa recusa que garante que
                  // ninguém mostre ao paciente um texto que não releu.
                  if (interpretacaoEmRevisao.status === "DRAFT") {
                    await statementAct(interpretacaoEmRevisao.id, {
                      kind: "EDIT",
                      text: interpretacaoEmRevisao.currentText,
                      isSensitive: interpretacaoEmRevisao.isSensitive,
                      sensitiveCategory: interpretacaoEmRevisao.sensitiveCategory,
                    });
                  }
                  await statementAct(interpretacaoEmRevisao.id, {
                    kind: "PRESENT",
                  });
                })()
              }
              onCancel={() =>
                void statementAct(interpretacaoEmRevisao.id, { kind: "CANCEL" })
              }
            />
          )}

          {current.kind === "EDIT_STATEMENT" &&
            (!interpretacaoEmRevisao || revisandoInterpretacao) && (
              <StatementEditor
                text={statementText}
                busy={busy}
                patientId={patientId}
                suggestion={suggestion}
                onChange={setStatementText}
                onSubmit={() => {
                  setRevisandoInterpretacao(false);
                  void submitStatement(current.statementId);
                }}
                onCancel={() => {
                  setTyped(null);
                  setRevisandoInterpretacao(false);
                  setScreen(null);
                }}
              />
            )}
        </Composer>
      )}

      {current.kind === "CONFIRM_STATEMENT" && statementOnScreen && (
        <StatementConfirmation
          text={statementOnScreen.presentedText || statementOnScreen.currentText}
          profile={profile}
          observed={statementOnScreen.provisionalResponse}
          sensitive={statementOnScreen.isSensitive}
          awaitingReconfirmation={
            statementOnScreen.status === "RECONFIRMATION_PENDING"
          }
          canGoBack={crumbs.length > 1}
          busy={busy}
          prefixo={interpretacao ? "O cuidador entendeu:" : undefined}
          mostrarAcoesDeCaminho={!interpretacao}
          actions={{
            onRespond: (response) => {
              const changing = statementOnScreen.provisionalResponse !== null;
              if (changing && response === statementOnScreen.provisionalResponse) {
                return;
              }
              void statementAct(statementOnScreen.id, {
                kind: changing ? "CHANGE_RESPONSE" : "RESPOND",
                response,
              });
            },
            onConfirm: () =>
              void statementAct(statementOnScreen.id, { kind: "CONFIRM" }),
            onReconfirm: () =>
              void statementAct(statementOnScreen.id, { kind: "RECONFIRM" }),
            onReject: () =>
              void statementAct(statementOnScreen.id, { kind: "REJECT" }),
            onRepresent: () =>
              void statementAct(statementOnScreen.id, { kind: "PRESENT" }),
            onAdjust: () => void adjustStatement(statementOnScreen),
            onDeepen: () => {
              void statementAct(statementOnScreen.id, {
                kind: "CANCEL",
                reason: "aprofundar_assunto",
              });
            },
            onBackLevel: goBackOneLevel,
            onCancelStatement: () =>
              void statementAct(statementOnScreen.id, {
                kind: "CANCEL",
                reason: "cancelada_pelo_assistente",
              }),
            onRestart: () => void restart(),
            onFinishWithoutConfirming: () => {
              void persist
                .pathAction(patientId, sessionId, path.id, {
                  kind: "INTERRUPT",
                  reason: "encerrado_sem_confirmar",
                })
                .then(() => reload())
                .then(() => onLeave())
                .catch(() => {});
            },
          }}
        />
      )}

      {current.kind === "DONE" && (
        <FinishedPath
          statement={activeStatement}
          trailLabels={pathLabels}
          busy={busy}
          onLeave={onLeave}
          interpretacao={interpretacao}
        />
      )}

      {/* A saída fica SEMPRE disponível enquanto a conversa está viva — inclusive
          durante a edição de um nível. Sair não encerra nem descarta nada: o
          caminho continua como está e reaparece pelo histórico. */}
      {!isTerminalPathStatus(path.status) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Control onClick={onLeave} disabled={busy}>
            Sair da conversa por opções
          </Control>
        </div>
      )}
    </div>
  );
}

/** Lápis ao lado do nível apresentado (§26). */
function EditRow({
  node,
  busy,
  onEdit,
}: {
  node: OptionConversationNode;
  busy: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="sr-only">{node.promptText}</span>
      <button
        type="button"
        onClick={onEdit}
        disabled={busy}
        aria-label={`Editar o nível: ${node.promptText}`}
        title="Editar"
        className="inline-flex min-h-9 min-w-9 items-center gap-1 rounded-full border border-line bg-card/90 px-3 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:border-ink-mute hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span aria-hidden="true">✎</span> Editar
      </button>
    </div>
  );
}

function FinishedPath({
  statement,
  trailLabels,
  busy,
  onLeave,
  interpretacao,
}: {
  statement: OptionConversationFinalStatement | null;
  trailLabels: string[];
  busy: boolean;
  onLeave: () => void;
  /** Interpretação do cuidador: o desfecho fala dela, não de "mensagem". */
  interpretacao: boolean;
}) {
  // Só o portão da autoria decide se esta tela está mostrando fala do
  // paciente. Um CONFIRMED incoerente (sem SIM observado, sem a reconfirmação
  // de um assunto sensível) não vira "Mensagem confirmada" aqui.
  const fala = tryToConfirmedPatientStatement(statement);
  const confirmada = fala !== null;
  const rejeitada = statement?.status === "REJECTED";
  return (
    <section className="flex w-full flex-col items-center gap-4 text-center">
      {/* Cabeçalho de verdade: é o título da tela, e quem navega por leitor
          precisa alcançá-lo. */}
      <h2 className="text-3xl font-medium">
        {confirmada
          ? interpretacao
            ? "Interpretação confirmada"
            : "Mensagem confirmada"
          : rejeitada
            ? interpretacao
              ? "Interpretação rejeitada"
              : "Frase rejeitada"
            : "Conversa encerrada"}
      </h2>
      {trailLabels.length > 0 && (
        <p className="text-ink-soft">{trailLabels.join(" › ")}</p>
      )}
      {/* Confirmada, o texto vem do portão — o congelado na apresentação.
          Fora disso é só a frase proposta, que não é fala do paciente. */}
      {statement && (
        <blockquote className="max-w-xl text-xl font-medium text-ink">
          {fala ? fala.text : statement.presentedText || statement.currentText}
        </blockquote>
      )}
      <p className="max-w-md text-sm text-ink-soft">
        {fala
          ? // Quem escreve a frase de autoria é o portão: uma interpretação
            // confirmada não pode aparecer como se o paciente a tivesse
            // formulado (Fase 4.2).
            `${rotuloDeAutoria(fala)} Ficou registrada.`
          : rejeitada
            ? "A frase não foi confirmada. Ela fica registrada como rejeitada e nunca será tratada como comunicação confirmada."
            : "O caminho foi encerrado e permanece registrado. Para retomar este conteúdo, reutilize-o pelo histórico."}
      </p>
      <Primary onClick={onLeave} disabled={busy}>
        Voltar
      </Primary>
    </section>
  );
}
