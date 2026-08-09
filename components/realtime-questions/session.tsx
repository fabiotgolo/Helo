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
  OfflineChip,
  RascunhoLocalAviso,
} from "@/components/realtime-questions/offline-chip";
import { useOfflineSession } from "@/lib/offline/use-offline-session";
import {
  procedenciaInicial,
  registraDitado,
  registraEdicao,
  type ProcedenciaDoTexto,
} from "@/lib/voice/dictation";
import { pacienteEstaOlhando } from "@/lib/option-conversation-screen";
import { ConflictScreen } from "@/components/realtime-questions/conflict-screen";
import { restoreConflict, type ConflictCase } from "@/lib/offline/conflicts";
import type { OfflineOperation } from "@/lib/offline/types";
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
  RASCUNHO_CONTEXTO,
  RASCUNHO_CONTEXTO_EDICAO,
  type ContextDraft,
} from "@/components/realtime-questions/session-context";
import type { SessionContextVersion } from "@/lib/session-context-types";
import {
  NotUnderstoodFollowUp,
  PatientControlsPanel,
  PatientControlsTrigger,
} from "@/components/realtime-questions/patient-controls";
import {
  isTerminalControlStatus,
  type PatientCommand,
} from "@/lib/patient-control-types";
import type { PatientControlAction } from "@/lib/patient-control-machine";
import {
  EMPTY_INTERPRETATION,
  InterpretationEditor,
  type InterpretationDraft,
} from "@/components/realtime-questions/interpretation";
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

/**
 * Chaves dos rascunhos desta tela. Ficam aqui, juntas e nomeadas, porque uma
 * chave digitada à mão em dois lugares vira dois rascunhos que ninguém
 * reconcilia — e o segundo aparece vazio para o cuidador.
 */
const RASCUNHO_PERGUNTA = "pergunta";
const RASCUNHO_INTERPRETACAO = "interpretacao";

/**
 * O conflito que está travando a fila AGORA — o primeiro em ordem causal que
 * tem detalhe legível para mostrar.
 *
 * Um de cada vez, e sempre o mais antigo: quando vários se acumulam, o
 * primeiro costuma ser a CAUSA dos seguintes, e decidi-lo com frequência
 * resolve os outros sozinho (descartar a criação leva a cadeia junto).
 * Mostrar uma lista convidaria a decidir sobre efeitos antes da causa — o
 * oposto do que §10, caso 13, manda fazer.
 *
 * Uma operação em CONFLICT cujo detalhe não sobreviveu (gravação truncada,
 * schema antigo) continua travando a fila e continua exigindo decisão; ela só
 * não tem tela para oferecer, e por isso é pulada aqui em vez de abrir um
 * diálogo vazio.
 *
 * Função de módulo, e não `useMemo`: com o `return` dentro do laço o React
 * Compiler não consegue preservar a memoização manual, e desiste de otimizar o
 * componente inteiro. Fora do componente, ele memoiza a chamada sozinho.
 */
function primeiroConflitoLegivel(
  conflitos: readonly OfflineOperation[]
): { operacao: OfflineOperation; conflito: ConflictCase } | null {
  for (const operacao of conflitos) {
    const conflito = restoreConflict(operacao.conflict);
    if (conflito) return { operacao, conflito };
  }
  return null;
}

export function RealtimeQuestionSession({
  patientId,
  initial,
  onLeave,
  userId,
  userName,
}: {
  patientId: number;
  initial: SessionDetail;
  /** Sai do modo depois que a sessão já foi encerrada como o assistente quis. */
  onLeave: () => void;
  /** Cuidador autenticado — escopa o armazenamento local (Fase 4.9). */
  userId?: string | null;
  userName?: string | null;
}) {
  // Estes dois estados vêm ANTES da ponte de propósito: ela recebe a função
  // que os hidrata, e uma referência usada antes da declaração faz o
  // compilador do React desistir de memoizar o componente inteiro.
  const [draft, setDraft] = useState("");
  const [interpretationDraft, setInterpretationDraftLocal] =
    useState<InterpretationDraft>(EMPTY_INTERPRETATION);

  // A continuidade sem conexão é ligada AQUI, e só aqui: esta é a única tela
  // que opera uma sessão manual já autenticada, que é exatamente o escopo da
  // Fase 4.9. A tela de escolha de sessão continua exigindo rede — começar uma
  // conversa sem servidor seria criar identidade offline, que a fase proíbe.
  const offline = useOfflineSession({
    userId: userId ?? null,
    patientId,
    sessionId: initial.session.id,
    assistantName: userName ?? null,
    sementeSessao: initial,
    // Hidratação: uma vez, quando o armazenamento local termina de ler. É aqui
    // que "o texto digitado sobrevive a refresh e a fechar o navegador"
    // acontece. Durante a digitação quem manda é o estado local — uma versão
    // anterior lia do armazenamento a cada tecla, e o preço foi a árvore
    // inteira renderizando por caractere.
    aoCarregarRascunhos: (valores) => {
      const pergunta = valores[RASCUNHO_PERGUNTA];
      if (typeof pergunta === "string" && pergunta) setDraft(pergunta);
      const interpretacao = valores[RASCUNHO_INTERPRETACAO] as
        | InterpretationDraft
        | undefined;
      if (interpretacao?.text) setInterpretationDraftLocal(interpretacao);
    },
  });
  const persist = useRtqPersistence(offline);
  const dialog = useHeloDialog();

  const [detail, setDetail] = useState<SessionDetail>(initial);
  const [profile, setProfile] = useState<PatientResponseProfile | null>(null);
  const [composing, setComposing] = useState(initial.turns.length === 0);

  /**
   * O texto do compositor, agora com rascunho guardado no aparelho.
   *
   * Antes, uma pergunta digitada pela metade morria num refresh, numa aba
   * fechada por engano ou numa bateria acabando — e quem digitava de novo era
   * o cuidador, no meio de uma conversa. Agora ela volta.
   *
   * A ORDEM IMPORTA, e custou três testes de interface para ficar clara: quem
   * manda é o que foi digitado, e o rascunho guardado é só o valor INICIAL. A
   * primeira versão fazia o contrário — o campo lia direto do armazenamento —,
   * e enquanto a ponte offline não estava pronta (usuário ainda carregando,
   * navegador sem Web Crypto) ela não tinha escopo para gravar: o texto ia
   * para lugar nenhum e o botão continuava desabilitado. Digitar não pode
   * depender de o armazenamento funcionar.
   *
   * O que um rascunho NÃO é: intenção. Ele não entra na fila, não vira
   * operação, não gera evento de auditoria e não chega perto do portão de
   * autoria. Só a submissão faz alguma dessas coisas.
   */
  /**
   * De onde veio o texto que está no campo (Fase 5.2A, precisada na 5.2B).
   *
   * As regras estão em `lib/voice/dictation.ts` e o resumo é este: a pergunta
   * só é "ditada" se ela NASCEU de uma transcrição. Digitar metade e ditar o
   * resto mantém a origem manual — a metade escrita à mão é da pessoa, e
   * atribuí-la ao microfone seria uma afirmação falsa num registro clínico.
   *
   * Deliberadamente NÃO persistida junto do rascunho: depois de um refresh o
   * texto volta, mas nada garante que ele ainda seja o que a voz produziu, e
   * afirmar procedência a mais é pior que afirmar a menos. Uma pergunta
   * restaurada é registrada como digitada.
   */
  const [procedencia, setProcedencia] = useState<ProcedenciaDoTexto>(procedenciaInicial);

  const setDraftEPersistir = useCallback(
    (valor: string) => {
      setDraft(valor);
      // Campo esvaziado: o que a voz escreveu não existe mais, e a origem
      // tampouco. O que for digitado a partir daqui é texto digitado.
      setProcedencia((atual) => registraEdicao(atual, valor));
      if (valor) offline.definirRascunho(RASCUNHO_PERGUNTA, valor);
      else offline.descartarRascunho(RASCUNHO_PERGUNTA);
    },
    [offline]
  );

  /** Uma transcrição entrou no campo. Só aqui a origem pode virar voz. */
  const registraPerguntaDitada = useCallback(
    ({ transcricao, textoAntes }: { transcricao: string; textoAntes: string }) => {
      setProcedencia((atual) => registraDitado(atual, textoAntes, transcricao));
    },
    []
  );

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
  // Interpretação do cuidador (Fase 4.2): o texto é escrito ANTES de o
  // registro nascer, então o rascunho vive aqui até o cuidador confirmar.
  const [interpreting, setInterpreting] = useState(false);
  // O texto que o cuidador escreve como interpretação nasce ANTES do registro
  // existir (Fase 4.2) — é o rascunho mais caro de perder da tela inteira,
  // porque ninguém o digitou duas vezes com o mesmo cuidado.
  const setInterpretationDraft = useCallback(
    (valor: InterpretationDraft) => {
      setInterpretationDraftLocal(valor);
      offline.definirRascunho(RASCUNHO_INTERPRETACAO, valor, valor.isSensitive);
    },
    [offline]
  );
  const descartarInterpretacao = useCallback(() => {
    setInterpretationDraftLocal(EMPTY_INTERPRETATION);
    offline.descartarRascunho(RASCUNHO_INTERPRETACAO);
  }, [offline]);


  // Controles do paciente (Fase 4.7). O painel SOBREPÕE a conversa: `openPath`
  // e o switch continuam montados, e é isso que faz "Voltar para a conversa"
  // devolver texto digitado, seleção provisória e breadcrumb sem restaurar
  // nada. `notUnderstood` guarda o desdobramento de NÃO ENTENDI, que é uma
  // decisão do cuidador — nunca automática.
  const [controlsOpen, setControlsOpen] = useState(false);
  const [notUnderstood, setNotUnderstood] = useState(false);
  // Contexto da conversa (Fase 4.8). Edição e consulta durante a sessão.
  const [contextEditing, setContextEditing] = useState(false);
  const [contextVersions, setContextVersions] = useState<
    SessionContextVersion[] | null
  >(null);
  // Conflito de sincronização (Fase 4.9.3-C.2). Começa FECHADO e só abre por
  // clique no chip: §11 é explícito — um conflito espera, ele não interrompe
  // uma conversa em curso, e nenhum modal se abre sozinho.
  const [conflitoAberto, setConflitoAberto] = useState(false);
  const [avisoDeDecisao, setAvisoDeDecisao] = useState<string | null>(null);
  // A ação que falhou fica guardada para "Tentar novamente" repetir
  // exatamente ela — nada é reconstruído por adivinhação.
  const failed = useRef<
    | { kind: "turn"; turnId: string; action: TurnAction }
    | { kind: "session"; action: "PAUSE" | "RESUME" | "COMPLETE" | "ABANDON" }
    | { kind: "create"; text: string }
    | null
  >(null);
  const [retryable, setRetryable] = useState(false);

  const { session, turns, context, controlRequest } = detail;
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
    // A carga inicial é exatamente a de sempre: imediata, sem esperar nada.
    //
    // Ela JÁ foi adiada uma vez, para esperar o armazenamento local abrir, e o
    // preço foi alto: a leitura chegava depois de o cuidador ter criado um
    // caminho e o apagava da tela. O caminho feliz não paga por um caso de
    // borda — a recuperação sem rede virou o efeito de baixo, que só age
    // quando esta aqui não trouxe nada.
    let cancelled = false;
    void persist
      .pathDetails(patientId, session.id)
      .then((details) => {
        if (cancelled) return;
        primeiraCargaTrouxe.current = true;
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

  /**
   * Segunda chance, e SÓ isso.
   *
   * Sem rede, a leitura acima falha porque o armazenamento local ainda não
   * abriu — são alguns milissegundos, e ela chega antes. Quando ele abre, esta
   * tenta uma vez. Ela nunca substitui nada: se a primeira trouxe caminhos, ou
   * se algum já está na tela, ela não faz coisa alguma.
   */
  const primeiraCargaTrouxe = useRef(false);
  const jaTentouRecuperar = useRef(false);
  useEffect(() => {
    if (!offline.pronto || primeiraCargaTrouxe.current) return;
    if (jaTentouRecuperar.current) return;
    jaTentouRecuperar.current = true;

    let cancelled = false;
    void persist
      .pathDetails(patientId, session.id)
      .then((details) => {
        if (cancelled || details.length === 0) return;
        setPathDetails((atual) => (atual.length > 0 ? atual : details));
        const alive = details.find((d) => !isTerminalPathStatus(d.path.status));
        if (alive) setOpenPathId((atual) => atual ?? alive.path.id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline.pronto, patientId, session.id]);

  /**
   * O snapshot local acompanha o que o servidor devolveu (Fase 4.9.2).
   *
   * A condição é estreita, e precisa ser: gravamos SÓ quando há rede E a fila
   * está vazia. Com a fila vazia, `detail` só pode ter vindo do servidor —
   * toda mutação passou por ele e voltou. Com qualquer pendência, `detail` é a
   * projeção (snapshot + fila), e regravá-la como snapshot aplicaria a mesma
   * intenção duas vezes na leitura seguinte.
   *
   * Sem isto, uma sessão RECÉM-CRIADA não teria snapshot nenhum: a tela a
   * recebe pronta de `createSession`, sem passar por `sessionDetail`. Ela cairia
   * offline sem ter o que continuar — que foi exatamente o que os testes de
   * interface encontraram.
   */
  // Extraídos por VALOR: com o objeto inteiro nas dependências, estes efeitos
  // rodavam a cada renderização — uma cifragem AES e uma gravação no
  // IndexedDB por quadro. Foi isso que deixou a interface lenta o bastante
  // para estourar timeouts em testes que não têm nada a ver com offline.
  const {
    disponivel: offlineDisponivel,
    guardarSessao,
    guardarCaminhos,
  } = offline;
  const podeGuardarSnapshot = offline.online && offline.status.pending === 0;

  useEffect(() => {
    // Sem esperar por `pronto`: gravar o snapshot não depende da fila ter
    // sido lida, e esperar reabriria a janela que a semente fechou.
    if (!offlineDisponivel || !podeGuardarSnapshot) return;
    guardarSessao(detail);
  }, [detail, offlineDisponivel, guardarSessao, podeGuardarSnapshot]);

  const openPath = useMemo(
    () => pathDetails.find((d) => d.path.id === openPathId) ?? null,
    [pathDetails, openPathId]
  );

  useEffect(() => {
    if (!offlineDisponivel || !podeGuardarSnapshot) return;
    // Um caminho recém-criado chega por `createPath`, não por uma releitura —
    // mesma razão do efeito acima.
    if (pathDetails.length === 0) return;
    guardarCaminhos(pathDetails);
  }, [pathDetails, offlineDisponivel, guardarCaminhos, podeGuardarSnapshot]);

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
   * "Registrar o que entendi" (Fase 4.2). O cuidador escreve PRIMEIRO, e só ao
   * confirmar o registro nasce — nada de rascunho vazio no banco. Criado, o
   * fluxo aberto é o mesmo da frase final, porque é a mesma entidade.
   */
  const saveCaregiverInterpretation = useCallback(
    async (draft: InterpretationDraft) => {
      persist.clearError();
      try {
        const { path } = await persist.createCaregiverInterpretation(
          patientId,
          session.id,
          {
            text: draft.text,
            isSensitive: draft.isSensitive,
            sensitiveCategory: draft.sensitiveCategory,
            clientRequestId: newRequestId("interp"),
          }
        );
        const details = await loadPaths();
        setOpenPathId(
          details.find((d) => d.path.id === path.id)?.path.id ?? path.id
        );
        setInterpreting(false);
        // Submetido: o rascunho cumpriu o papel e sai do aparelho.
        descartarInterpretacao();
        setComposing(false);
      } catch {
        // A faixa de erro já explica; o texto digitado continua na tela.
      }
    },
    [persist, patientId, session.id, loadPaths, descartarInterpretacao]
  );

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
      // Gravado: os rascunhos das duas telas de contexto cumpriram o papel e
      // saem do aparelho. Só aqui — enquanto a gravação não volta, o texto
      // continua guardado, porque é justamente a falha que ele existe para
      // atravessar.
      offline.descartarRascunho(RASCUNHO_CONTEXTO);
      offline.descartarRascunho(RASCUNHO_CONTEXTO_EDICAO);
      return salvo;
    },
    [persist, patientId, session.id, offline]
  );

  const verContexto = useCallback(async () => {
    if (!context) return;
    // A consulta é auditada, mas nunca bloqueia a leitura se o registro falhar.
    void persist.openSessionContext(patientId, session.id, context.id).catch(() => {});
    const versions = await persist.sessionContextVersions(patientId, session.id);
    setContextVersions(versions);
  }, [persist, patientId, session.id, context]);

  // ——— Controles do paciente (Fase 4.7) ———

  /** O que está no ar agora — alvo de REPETIR e de MUDAR DE ASSUNTO. */
  const alvoAtual = useMemo(() => {
    if (openPath) {
      const frase = openPath.statements
        .filter((x) => x.status !== "CANCELED" && x.status !== "REPLACED")
        .at(-1);
      if (frase && frase.status === "PRESENTED") {
        return {
          targetType: "STATEMENT" as const,
          targetId: frase.id,
          targetPathId: openPath.path.id,
        };
      }
      const nivel = openPath.nodes.find(
        (n) => n.id === openPath.path.activeNodeId
      );
      return {
        targetType: nivel ? ("NODE" as const) : null,
        targetId: nivel?.id ?? null,
        targetPathId: openPath.path.id,
      };
    }
    return {
      targetType: currentTurn ? ("TURN" as const) : null,
      targetId: currentTurn?.id ?? null,
      targetPathId: null,
    };
  }, [openPath, currentTurn]);

  const abrirControles = useCallback(async () => {
    persist.clearError();
    setControlsOpen(true);
    try {
      const aberto = await persist.openPatientControl(patientId, session.id, {
        clientRequestId: newRequestId("ctrl"),
        ...alvoAtual,
      });
      setDetail((d) => ({ ...d, controlRequest: aberto }));
    } catch {
      setControlsOpen(false);
    }
  }, [persist, patientId, session.id, alvoAtual]);

  const controlAct = useCallback(
    async (action: PatientControlAction) => {
      if (!controlRequest) return;
      persist.clearError();
      try {
        const r = await persist.patientControlAction(
          patientId,
          session.id,
          controlRequest.id,
          action
        );
        // O que a execução tocou substitui o que a tela tinha — nada é
        // adivinhado localmente.
        if (r.turn) applyTurn(r.turn);
        if (r.path || r.node || r.statement) await loadPaths();
        if (r.sessionStatus) {
          setDetail((d) => ({
            ...d,
            session: { ...d.session, status: r.sessionStatus! },
          }));
        }
        setDetail((d) => ({ ...d, controlRequest: r.request }));

        // Desdobramentos que são decisão do CUIDADOR, nunca automáticos.
        if (action.kind === "EXECUTE") {
          const cmd: PatientCommand | null = controlRequest.confirmedCommand;
          if (cmd === "NOT_UNDERSTOOD") {
            setNotUnderstood(true);
            setControlsOpen(false);
          } else if (cmd === "PAUSE") {
            setControlsOpen(false);
          } else if (cmd === "REPEAT") {
            setControlsOpen(false);
          } else if (cmd === "CHANGE_SUBJECT") {
            setControlsOpen(false);
            setOpenPathId(null);
            setComposing(true);
          } else if (cmd === "END_CONVERSATION") {
            // Encerrar de verdade continua sendo ato do cuidador, pelo fluxo
            // de saída que ele já conhece.
            setControlsOpen(false);
            setExitOpen(true);
          }
        }
        // Fechar depende do ESTADO resultante, não do nome da ação: um NÃO na
        // confirmação final cancela o pedido sem que a ação se chame CANCEL, e
        // o painel precisa sair de cena do mesmo jeito.
        if (isTerminalControlStatus(r.request.status)) {
          setControlsOpen(false);
        }
        return r;
      } catch {
        // A faixa de erro já explica; o painel continua onde estava.
      }
    },
    [persist, patientId, session.id, controlRequest, applyTurn, loadPaths]
  );

  // ——— Ações do fluxo ———

  const startQuestion = useCallback(() => {
    // Começar uma pergunta nova descarta o rascunho da anterior: é uma
    // decisão do cuidador, não um esquecimento.
    setDraftEPersistir("");
    setSensitive(false);
    setCategory(null);
    setComposing(true);
  }, [setDraftEPersistir]);

  const continueToReview = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    if (currentTurn) {
      // Voltou da revisão para editar: o turno já existe em DRAFT e o texto
      // definitivo só é persistido ao apresentar.
      setComposing(false);
      return;
    }
    // A origem descreve COMO o texto entrou, e mais nada. Não confere
    // confiança, não dispensa a revisão que acabou de acontecer e não muda um
    // passo do fluxo daqui para frente.
    const ditada = procedencia.origem === "VOICE_TRANSCRIPTION";
    try {
      const turn = await persist.createTurn(patientId, session.id, {
        text,
        questionSource: procedencia.origem,
        // As transcrições cruas, na ordem em que a voz as produziu. O texto
        // final — com as correções que o cuidador fez ao reler — é o `text`
        // acima, e a diferença entre os dois é o registro de que houve revisão.
        originalText: ditada ? procedencia.original : null,
      });
      applyTurn(turn);
      // Submetido: o texto virou registro (ou intenção na fila, sem rede), e o
      // rascunho não tem mais o que guardar.
      offline.descartarRascunho(RASCUNHO_PERGUNTA);
      setDraft("");
      setProcedencia(procedenciaInicial());
      setComposing(false);
      failed.current = null;
      setRetryable(false);
    } catch {
      // O texto digitado permanece no campo — nada se perde.
      failed.current = { kind: "create", text };
      setRetryable(true);
    }
  }, [draft, currentTurn, persist, patientId, session.id, applyTurn, offline, procedencia]);

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
        // Apresentado: o texto está congelado no registro e o rascunho cumpriu
        // o papel. Só aqui, e só se as três transições passaram — uma falha no
        // meio deixa o turno editável, e com ele o que o cuidador escreveu.
        offline.descartarRascunho(RASCUNHO_PERGUNTA);
        setDraft("");
      } catch {
        // A faixa de erro já explica; o turno continua editável.
      }
    },
    [act, draft, sensitive, category, offline]
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
    // Com o painel aberto, 1/2/3 significam COMANDO 1/2/3 e quem escuta é ele.
    if (openPath || controlsOpen) return;
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
  }, [currentTurn, paused, act, openPath, controlsOpen]);

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

  // Quem responde por isto é o próprio flow, pela mesma função que escolhe a
  // tela: se um dia a regra mudar lá, muda aqui junto.
  const pacienteNoCaminho = openPath != null && pacienteEstaOlhando(openPath);

  /**
   * O conflito que está travando a fila AGORA — o primeiro em ordem causal.
   *
   * Um de cada vez, e sempre o mais antigo: quando vários se acumulam, o
   * primeiro costuma ser a CAUSA dos seguintes, e decidi-lo com frequência
   * resolve os outros sozinho (descartar a criação leva a cadeia junto).
   * Mostrar uma lista convidaria a decidir sobre efeitos antes da causa.
   *
   * `conflict` é validado na leitura: uma operação em CONFLICT cujo detalhe
   * não sobreviveu (schema antigo, gravação truncada) continua travando a
   * fila e continua pedindo decisão — só não tem tela para oferecer, e por
   * isso é filtrada aqui em vez de renderizar um diálogo vazio.
   */
  const conflitoAtual = primeiroConflitoLegivel(offline.conflitos);

  /**
   * A tela é do PACIENTE. Uma expressão só, usada pela barra de contexto e
   * pela faixa do armazenamento local — as duas coisas que existem para o
   * cuidador e que não podem aparecer sobre o palco.
   *
   * Calcular isto duas vezes seria o começo de duas regras, e a que
   * divergisse mostraria ao paciente algo que não é para ele. É o mesmo
   * cuidado que levou `pacienteEstaOlhando` para lib/ no commit 286a3f9.
   */
  const telaEDoPaciente = showStage || pacienteNoCaminho;

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
              o palco do paciente — o contexto não é para ele ver.

              Com um caminho aberto (conversa por opções ou interpretação), a
              barra acompanha as telas de composição, revisão e navegação, e
              some quando o caminho passa a ser do paciente. Escondê-la o
              caminho inteiro obrigava o cuidador a SAIR do caminho para
              consultar o contexto — e sair no meio é justamente o que não
              pode custar uma conversa. */}
          {context && !sessionOver && !telaEDoPaciente && (
            <SessionContextBar
              context={context}
              busy={busy}
              onEdit={() => setContextEditing(true)}
              onView={() => void verContexto().catch(() => {})}
            />
          )}

          {/* O que este aparelho guardou sem conexão. MESMA fronteira da barra
              de contexto, pela MESMA expressão: nunca sobre o palco. */}
          {!telaEDoPaciente && (
            <OfflineChip
              status={offline.status}
              aviso={offline.avisoDeDescarte}
              onReconhecerAviso={offline.reconhecerDescarte}
              pendenciasDeOutroPaciente={offline.pendenciasDeOutroPaciente}
              onSincronizarAgora={offline.tentarNovamente}
              onDecidirConflito={() => setConflitoAberto(true)}
              armazenamento={offline.armazenamento}
            />
          )}

          {/* A tela de decisão (Fase C.2, §10).

              Três guardas, e cada uma responde por uma coisa diferente:
              `conflitoAberto` — só abre por clique do cuidador, nunca sozinha;
              `!telaEDoPaciente` — a MESMA fronteira do chip e da barra de
              contexto, porque um conflito é assunto do cuidador e o palco é do
              paciente; `conflitoAtual` — a fila pode ter esvaziado entre o
              clique e o render (outra aba decidiu, por exemplo). */}
          {conflitoAberto && !telaEDoPaciente && conflitoAtual && (
            <ConflictScreen
              operacao={conflitoAtual.operacao}
              conflito={conflitoAtual.conflito}
              fila={offline.fila}
              onFechar={() => setConflitoAberto(false)}
              onDecidir={(opcao) => {
                void offline
                  .decidirConflito(conflitoAtual.operacao.id, opcao)
                  .then((descricao) => {
                    if (descricao) setAvisoDeDecisao(descricao);
                    // Fecha só quando a decisão foi TERMINAL. As informativas
                    // (ver a cadeia) devolvem frase vazia e mantêm a tela
                    // aberta — fechar ali obrigaria o cuidador a reabrir para
                    // decidir o que ele acabou de pedir para ver.
                    if (descricao) setConflitoAberto(false);
                  })
                  .catch(() => {});
              }}
            />
          )}

          {/* O que a decisão fez. `status`/`polite`: informa sem interromper. */}
          {avisoDeDecisao && (
            <div
              role="status"
              aria-live="polite"
              data-testid="aviso-de-decisao"
              className="flex flex-wrap items-center gap-2 self-start rounded-2xl border border-line bg-surface/60 px-3 py-2 text-xs text-ink"
            >
              <span>{avisoDeDecisao}</span>
              <button
                type="button"
                onClick={() => setAvisoDeDecisao(null)}
                className="rounded-full border border-line px-3 py-1 font-semibold"
              >
                Entendi
              </button>
            </div>
          )}

          {notUnderstood && !sessionOver && (
            <NotUnderstoodFollowUp
              busy={busy}
              canGoBack={false}
              onRepeat={() => {
                if (currentTurn) void act(currentTurn.id, { kind: "REPRESENT" });
                setNotUnderstood(false);
              }}
              /* Versão simplificada (§27): a pergunta já apresentada NÃO é
                 reescrita — o domínio recusa editar o que o paciente viu, e
                 com razão. A simplificada é um registro NOVO: a original sai
                 do fluxo preservada, e o cuidador escreve a outra. O Helo não
                 gera texto. */
              onSimplify={
                currentTurn
                  ? () => {
                      void (async () => {
                        await act(currentTurn.id, {
                          kind: "CANCEL",
                          reason: "versão simplificada a pedido do paciente",
                        });
                        setDraftEPersistir("");
                        setComposing(true);
                        setNotUnderstood(false);
                      })();
                    }
                  : null
              }
              onBackLevel={null}
              onCancelContent={
                currentTurn
                  ? () => {
                      void cancelQuestion(currentTurn);
                      setNotUnderstood(false);
                    }
                  : null
              }
              onDismiss={() => setNotUnderstood(false)}
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
              offline={offline}
            />
          ) : interpreting ? (
            /* O cuidador escreve; o registro só nasce ao confirmar. Sair daqui
               não deixa rascunho nenhum no banco. */
            <>
            <RascunhoLocalAviso
              visivel={
                offline.disponivel && interpretationDraft.text.trim().length > 0
              }
            />
            <InterpretationEditor
              draft={interpretationDraft}
              busy={busy}
              patientId={patientId}
              onChange={setInterpretationDraft}
              onSubmit={() =>
                void saveCaregiverInterpretation(interpretationDraft)
              }
              onCancel={() => {
                // Cancelamento EXPLÍCITO do cuidador: aí sim o texto some.
                setInterpreting(false);
                descartarInterpretacao();
              }}
            />
            </>
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
              offline={offline}
            />
          ) : composing ? (
            <>
            <RascunhoLocalAviso
              visivel={offline.disponivel && draft.trim().length > 0}
            />
            <ComposeScreen
              draft={draft}
              busy={busy}
              patientId={patientId}
              editing={currentTurn != null}
              onChange={setDraftEPersistir}
              onContinue={() => void continueToReview()}
              onCancel={() => {
                if (currentTurn) void cancelQuestion(currentTurn);
                else setComposing(false);
              }}
              onDictated={registraPerguntaDitada}
              cancelable={currentTurn != null || turns.length > 0}
              onOptionConversation={
                currentTurn == null
                  ? () => void startOptionConversation()
                  : null
              }
              onCaregiverInterpretation={
                currentTurn == null ? () => setInterpreting(true) : null
              }
            />
            </>
          ) : currentTurn?.status === "DRAFT" ? (
            <ReviewScreen
              text={draft.trim() || currentTurn.reviewedText}
              sensitive={sensitive}
              category={category}
              busy={busy}
              onEdit={() => {
                setDraftEPersistir(draft.trim() || currentTurn.reviewedText);
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
              onCaregiverInterpretation={() => setInterpreting(true)}
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
          offline={offline}
        />
      )}

      {contextVersions && (
        <ContextVersionsList
          versions={contextVersions}
          onClose={() => setContextVersions(null)}
        />
      )}

      {/* O painel SOBREPÕE: o switch acima continua montado, então texto
          digitado, seleção provisória e breadcrumb sobrevivem intactos e
          "Voltar para a conversa" não precisa restaurar nada. */}
      {controlsOpen && controlRequest && !sessionOver && (
        <PatientControlsPanel
          request={controlRequest}
          profile={profile}
          busy={busy}
          actions={{
            onPresent: () => void controlAct({ kind: "PRESENT" }),
            onAwaitSelection: () => void controlAct({ kind: "AWAIT_SELECTION" }),
            onSelect: (command) =>
              void controlAct({ kind: "SELECT_COMMAND", command }),
            onChange: (command) =>
              void controlAct({ kind: "CHANGE_COMMAND", command }),
            onRemoveSelection: () => void controlAct({ kind: "REMOVE_SELECTION" }),
            onConfirm: () => void controlAct({ kind: "CONFIRM_COMMAND" }),
            onAskEndConfirmation: () =>
              void controlAct({ kind: "ASK_END_CONFIRMATION" }),
            onRespondEnd: (response) =>
              void controlAct({ kind: "RESPOND_END", response }),
            onExecute: () => void controlAct({ kind: "EXECUTE" }),
            onCancel: () => void controlAct({ kind: "CANCEL" }),
            onClose: () => void controlAct({ kind: "CLOSE" }),
          }}
        />
      )}

      {!sessionOver && (
        // `relative`: sem contexto de posicionamento o véu (absolute) pintaria
        // por cima dos controles e eles ficariam lavados.
        // `sm:pl-80`: o crachá decorativo da ElevenLabs ocupa ~297px no canto
        // inferior esquerdo a partir de 640px, e o LINK dele é clicável. Sem
        // esta folga, o rodapé quebra linha por baixo dele e o clique nos
        // controles do paciente é engolido pelo logo.
        <footer className="no-print pointer-events-auto relative z-30 flex flex-wrap items-center justify-center gap-2 px-6 pb-6 sm:pl-80">
          <span
            aria-live="polite"
            className={`text-sm ${busy ? "text-ink-soft" : "sr-only"}`}
          >
            {busy ? "Registrando…" : "Registro em dia"}
          </span>
          {/* Permanente: o paciente precisa alcançar os controles em qualquer
              tela — pergunta fechada, opções, compositor, interpretação,
              confirmação ou espera. */}
          {!controlsOpen && (
            // Sem `disabled`: os controles do paciente não podem sumir por
            // causa de uma gravação em voo. A fila do cliente já serializa, e
            // ficar inalcançável por um instante é justamente o que o paciente
            // não pode enfrentar quando quer pedir uma pausa.
            <PatientControlsTrigger onOpen={() => void abrirControles()} />
          )}
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

