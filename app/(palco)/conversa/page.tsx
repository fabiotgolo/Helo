"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { flow, compose, START_NODE, type FlowNode, type Option } from "@/lib/flow";
import { useRegisterHeloUIActions, type HeloUIAction } from "@/lib/helo-action-registry";
import { guardaDeContexto } from "@/lib/helo-agent-context";
import { GESTURES, type Gesture } from "@/lib/types";
import { useGestures } from "@/lib/gestures";
import { usePatient, usePatientItems } from "@/lib/patient";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import { logEvent, saveMessage, startSession, endSession } from "@/lib/log";
import { useAuthUser, redirectToLogin } from "@/lib/use-auth";
import {
  ROLE_LABELS,
  PROFESSIONAL_TYPE_LABELS,
  type AppUser,
} from "@/lib/access-types";
import { useHelo } from "@/lib/helo-state";
import {
  beginPatientVoiceOverride,
  endPatientVoiceOverride,
} from "@/lib/audio-coordinator";
import type { SpeakResult } from "@/lib/useSpeech";
import { GestureOptionsBar } from "@/components/gesture-options-bar";
import { OverlayPanel, OverlayVeil } from "@/components/overlay-panel";

const LOTE = 3; // nunca mais de 3 opções na tela
const GESTURE_ORDER: Gesture[] = ["sim", "talvez", "nao"];

type Confirm = {
  phrase: string;
  category: string;
  sensitive: boolean;
  step: 1 | 2;
  originNode: string;
  fromAI: boolean;
};

type AIOption = { label: string; phrase: string; sensitive: boolean };

type Phase = "intro" | "node" | "confirm" | "done";

type Person = { id: number; name: string; relation: string | null };

// ——— A conversa pertence a UMA pessoa (Fase 5.3C) ———
//
// Toda a conversa vive em estado local: a fase, o nó atual, o contexto
// acumulado, a frase composta, o histórico, as sugestões da IA, o id da sessão
// e — em referências — o caminho percorrido e a frase JÁ confirmada, com o id
// do registro que autoriza falá-la na voz do paciente.
//
// Nada disso dependia de `patientId`. Trocar de paciente no meio de uma
// conversa deixava tudo na tela: a pergunta de A, a frase de A pronta para ser
// repetida, a sessão de A recebendo os eventos seguintes. Era o defeito irmão
// dos de `/rotina` — estado que sobrevive a uma troca de autoridade —, e o
// maior deles: `confirmedPhrase` faria a mensagem de A soar na voz do paciente
// com B na tela.
//
// A correção é a chave. Remontar não é um mecanismo novo nem uma lista de
// campos para zerar (uma lista é onde se esquece um): o React descarta o
// estado inteiro de uma vez, e a tela volta ao SEU próprio estado inicial, o
// mesmo de sempre — nenhuma UI nova, nenhum redirecionamento.
//
// O que a remontagem não alcança é uma promessa já em voo: a closure dela não
// morre com o componente. Para isso, dentro, a mesma guarda de contexto de L1,
// L2 e L3.
//
// A sessão de A **não** é encerrada. Ela nasceu autorizada e permanece dela,
// como qualquer sessão aberta e não concluída — trocar de paciente não é
// concluir uma conversa, e inventar esse lifecycle aqui seria decidir por
// quem cuida.
// A chave conta TROCAS, não o paciente. A diferença importa: numa carga
// direta da rota o paciente chega depois do primeiro render, e uma chave
// derivada dele remontaria a tela por causa disso — uma remontagem que não
// corresponde a nenhuma troca, e que faria o Agent receber CONTEXT_EXPIRED
// (corretamente: a ação teria mesmo saído do registry) por um pedido legítimo
// feito logo depois de a tela abrir. Contando trocas, a primeira vez que o
// paciente fica conhecido não é uma troca — e a tela monta uma vez só.
//
// O ajuste acontece DURANTE o render, que é o padrão do React para derivar de
// um valor anterior. Não é efeito e não cascateia: o React reprocessa o mesmo
// render antes de pintar.
export default function ConversaPage() {
  const { patientId } = usePatient();
  const [pacienteDaTela, setPacienteDaTela] = useState<number | null>(null);
  const [trocas, setTrocas] = useState(0);
  if (patientId != null && patientId !== pacienteDaTela) {
    setPacienteDaTela(patientId);
    if (pacienteDaTela !== null) setTrocas((n) => n + 1);
  }
  return <ConversaDoPaciente key={trocas} />;
}

function ConversaDoPaciente() {
  const router = useRouter();
  // Voz global da Helo — a mesma do palco; o orbe reage a esta fala
  const { speak, speaking } = useHelo();

  const gestures = useGestures();
  const gestureOptions = useMemo(
    () => GESTURE_ORDER.map((gesture) => ({ id: gesture, ...gestures[gesture], sublabel: gestures[gesture].hint })),
    [gestures],
  );
  // Perfil do paciente ativo: nome, estilo de fala, temas evitados e
  // expressões preferidas alimentam a conversa e as sugestões da IA.
  const { patient, patientId, settings, loading: patientLoading } = usePatient();
  const { enabledItems: preferredExpressions } = usePatientItems("conversa");
  const patientName = settings[PATIENT_SETTING_KEYS.name] ?? patient?.name ?? "";
  // Operador = usuário autenticado. Nenhum nome digitado define identidade;
  // o servidor ignora qualquer nome vindo do cliente ao criar a sessão.
  const { user, loading: authLoading, logout } = useAuthUser();
  const [phase, setPhase] = useState<Phase>("intro");
  const [paused, setPaused] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [people, setPeople] = useState<Person[]>([]);

  const [nodeId, setNodeId] = useState(START_NODE);
  const [batch, setBatch] = useState(0);
  const [marks, setMarks] = useState<Record<number, Gesture>>({});
  const [ctx, setCtx] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [history, setHistory] = useState<{ nodeId: string; batch: number }[]>([]);
  // Opções geradas por IA quando a árvore curada se esgota — sempre sinalizadas
  const [aiOptions, setAiOptions] = useState<AIOption[] | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  // Caminho da conversa (pergunta → gesto) para dar contexto à IA
  const pathLog = useRef<{ question: string; answer: string }[]>([]);
  const rejectedLog = useRef<string[]>([]);

  const shownAt = useRef(Date.now());
  const node: FlowNode = flow[nodeId];

  // Rede de pessoas cadastrada substitui as opções fixas de "Com quem falar?"
  const effectiveOptions: Option[] = useMemo(() => {
    if (node.kind !== "opcoes") return [];
    if (node.id === "pessoas" && people.length > 0) {
      return [
        ...people.map((p) => ({
          label: p.relation ? `${p.name} (${p.relation})` : p.name,
          set: { pessoa: p.name },
          next: "pessoas_mensagem",
        })),
        { label: "Outra pessoa", set: { pessoa: "outra pessoa" }, next: "pessoas_mensagem" },
      ];
    }
    return node.options;
  }, [node, people]);

  const batchOptions: Option[] = useMemo(
    () => effectiveOptions.slice(batch * LOTE, batch * LOTE + LOTE),
    [effectiveOptions, batch]
  );

  // Sem usuário autenticado não há operador — a tela não pergunta nome,
  // ela exige login antes de qualquer sessão.
  useEffect(() => {
    if (!authLoading && !user) redirectToLogin();
  }, [authLoading, user]);

  // Rede de pessoas DO paciente ativo — troca de paciente, troca a rede.
  useEffect(() => {
    if (patientId == null) return;
    setPeople([]);
    void fetch(`/api/people?patientId=${patientId}`)
      .then((r) => r.json())
      .then((d: { people: Person[] }) => setPeople(d.people ?? []))
      .catch(() => {});
  }, [patientId]);

  // ——— Navegação entre nós ———

  const enterNode = useCallback(
    (id: string, opts?: { pushHistory?: { nodeId: string; batch: number } }) => {
      const n = flow[id];
      if (opts?.pushHistory) setHistory((h) => [...h, opts.pushHistory!]);
      setNodeId(id);
      setBatch(0);
      setMarks({});
      setAiOptions(null);
      rejectedLog.current = [];
      setPhase("node");
      shownAt.current = Date.now();
      logEvent({
        sessionId,
        patientId,
        type: "pergunta_apresentada",
        category: n.category,
        question: n.question,
      });
      void speak(n.question);
    },
    [sessionId, patientId, speak]
  );

  const toConfirm = useCallback(
    (phrase: string, category: string, sensitive: boolean, originNode: string, fromAI = false) => {
      setConfirm({ phrase, category, sensitive, step: 1, originNode, fromAI });
      setPhase("confirm");
      shownAt.current = Date.now();
      void speak(`Você quer dizer: ${phrase} — Confirma?`);
    },
    [speak]
  );

  // Fala FINAL atribuída ao PACIENTE (frase confirmada / repetida). Mesmo
  // padrão validado da Emergência e das Atividades: prioridade máxima da voz
  // do paciente (assume o áudio, interrompe a plataforma e SUPRIME o Agente
  // Helo via beginPatientVoiceOverride) e atravessa o gate do Audio Manager
  // com `priority: "patientResponse"` — sem isso a frase é silenciada quando o
  // Agente está ativo. O mute global continua vencendo. A voz (clone do
  // paciente → voz configurada em Ajustes → fallback aprovado) é resolvida no
  // servidor por patientId; a condução da conversa segue na voz da plataforma.
  // A frase confirmada é REGISTRADA antes de ser falada, e é o registro que a
  // autoriza. Guardamos o id — não o grant: "Repetir" pode ser tocado muito
  // depois, e um id não vence.
  const confirmedPhrase = useRef<{ text: string; messageId: string } | null>(null);

  const speakPatientPhrase = useCallback(
    async (text: string): Promise<SpeakResult> => {
      console.log("[HELO VOICE] source conversation");
      console.log("[HELO VOICE] role patient");
      console.log("[HELO AUDIO] suppressing platform narration");
      const registered = confirmedPhrase.current;
      // Sem registro confirmado para ESTE texto não há voz do paciente.
      // Acontece quando a gravação falhou — e aí não existe frase confirmada
      // no servidor, então não há nada a dizer em nome dele.
      if (!registered || registered.text !== text) {
        console.error("[VOZ] frase do paciente sem registro confirmado — não será falada");
        return "erro";
      }
      beginPatientVoiceOverride();
      try {
        return await speak(text, {
          speakerRole: "patient",
          confirmationStatus: "confirmed",
          patientId,
          source: { kind: "confirmedMessage", messageId: registered.messageId },
          mode: "conversa",
          priority: "patientResponse",
        });
      } finally {
        endPatientVoiceOverride();
      }
    },
    [speak, patientId]
  );

  // Quando as opções curadas se esgotam, a IA formula até 3 novas —
  // sempre marcadas como sugestão, nunca decidindo pelo paciente.
  const trySuggestions = useCallback(
    async (n: FlowNode) => {
      // As sugestões são formuladas a partir do PERFIL do paciente atual —
      // nome, estilo de fala, expressões preferidas, rede de pessoas. Chegar
      // depois de uma troca significaria apresentar (e anunciar em voz alta)
      // sugestões feitas para outra pessoa.
      const aindaVale = guardaDeContexto();
      setAiLoading(true);
      try {
        const res = await fetch("/api/suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: n.question,
            category: n.category,
            rejected: rejectedLog.current,
            path: pathLog.current.slice(-8),
            // Perfil do paciente: adapta estilo e vocabulário das sugestões.
            // A confirmação por gesto continua obrigatória — perfil não é
            // consentimento.
            profile: {
              name: patientName || undefined,
              speechStyle: settings[PATIENT_SETTING_KEYS.speechStyle] || undefined,
              avoidedTopics: settings[PATIENT_SETTING_KEYS.avoidedTopics] || undefined,
              preferredExpressions: preferredExpressions
                .slice(0, 12)
                .map((e) => e.spokenText),
              people: people.map((p) => ({ name: p.name, relation: p.relation })),
            },
          }),
        });
        if (!res.ok) return false;
        const data = (await res.json()) as { options: AIOption[] };
        if (!data.options?.length) return false;
        if (!aindaVale()) {
          console.warn("[HELO CONVERSAR] contexto expirou — sugestões de outro paciente descartadas");
          return false;
        }
        setAiOptions(data.options.slice(0, LOTE));
        setMarks({});
        shownAt.current = Date.now();
        logEvent({
          sessionId,
          patientId,
          type: "opcao_apresentada",
          category: n.category,
          question: n.question,
          options: data.options.map((o) => o.label),
          detail: "sugeridas por IA",
        });
        void speak("Tenho outras sugestões.");
        return true;
      } catch {
        return false;
      } finally {
        setAiLoading(false);
      }
    },
    [sessionId, patientId, speak, patientName, settings, preferredExpressions, people]
  );

  const goBackToPrevious = useCallback(() => {
    void speak("Tudo bem. Vamos voltar.");
    const prev = history[history.length - 1];
    setAiOptions(null);
    if (prev) {
      setHistory((h) => h.slice(0, -1));
      setNodeId(prev.nodeId);
      setBatch(prev.batch);
      setMarks({});
      shownAt.current = Date.now();
    } else {
      enterNode(START_NODE);
    }
  }, [history, speak, enterNode]);

  const advanceBatch = useCallback(
    async (n: FlowNode) => {
      if (aiOptions) {
        // Nem as sugestões da IA serviram — devolve a direção ao paciente
        logEvent({
          sessionId,
          patientId,
          type: "opcao_apresentada",
          category: n.category,
          question: n.question,
          detail: "nenhuma opção escolhida (inclusive IA)",
        });
        goBackToPrevious();
        return;
      }
      const nextBatch = batch + 1;
      if (nextBatch * LOTE < effectiveOptions.length) {
        setBatch(nextBatch);
        setMarks({});
        shownAt.current = Date.now();
        logEvent({
          sessionId,
          patientId,
          type: "opcao_apresentada",
          category: n.category,
          question: n.question,
          options: effectiveOptions
            .slice(nextBatch * LOTE, nextBatch * LOTE + LOTE)
            .map((o) => o.label),
        });
        void speak("Vou mostrar outras opções.");
      } else {
        const gotAI = await trySuggestions(n);
        if (!gotAI) {
          logEvent({
            sessionId,
            patientId,
            type: "opcao_apresentada",
            category: n.category,
            question: n.question,
            detail: "nenhuma opção escolhida",
          });
          goBackToPrevious();
        }
      }
    },
    [batch, effectiveOptions, aiOptions, sessionId, patientId, speak, trySuggestions, goBackToPrevious]
  );

  // ——— Gestos ———

  const onQuestionGesture = useCallback(
    (g: Gesture) => {
      if (node.kind !== "pergunta") return;
      logEvent({
        sessionId,
        patientId,
        type: "gesto",
        category: node.category,
        question: node.question,
        gesture: g,
        responseMs: Date.now() - shownAt.current,
      });
      pathLog.current.push({ question: node.question, answer: GESTURES[g].label });
      const target = node[g];
      if ("next" in target) {
        enterNode(target.next, { pushHistory: { nodeId: node.id, batch } });
      } else {
        toConfirm(compose(target.phrase, ctx), node.category, Boolean(node.sensitive), node.id);
      }
    },
    [node, batch, ctx, sessionId, patientId, enterNode, toConfirm]
  );

  const onOptionGesture = useCallback(
    (idx: number, g: Gesture) => {
      if (node.kind !== "opcoes") return;
      const isAI = aiOptions !== null;
      const option = isAI ? aiOptions[idx] : batchOptions[idx];
      if (!option || marks[idx]) return;
      logEvent({
        sessionId,
        patientId,
        type: "gesto",
        category: node.category,
        question: option.label,
        gesture: g,
        detail: isAI ? `${node.question} (sugestão IA)` : node.question,
        responseMs: Date.now() - shownAt.current,
      });
      pathLog.current.push({ question: option.label, answer: GESTURES[g].label });

      if (g === "sim") {
        if (isAI) {
          const ai = option as AIOption;
          toConfirm(ai.phrase, node.category, ai.sensitive || Boolean(node.sensitive), node.id, true);
          return;
        }
        const opt = option as Option;
        const newCtx = opt.set ? { ...ctx, ...opt.set } : ctx;
        if (opt.set) setCtx(newCtx);
        if (opt.next) {
          enterNode(opt.next, { pushHistory: { nodeId: node.id, batch } });
        } else if (opt.phrase) {
          toConfirm(compose(opt.phrase, newCtx), node.category, Boolean(node.sensitive), node.id);
        }
        return;
      }

      rejectedLog.current.push(option.label);
      const newMarks = { ...marks, [idx]: g };
      setMarks(newMarks);
      const total = isAI ? aiOptions.length : batchOptions.length;
      if (Array.from({ length: total }, (_, i) => i).every((i) => newMarks[i])) {
        void advanceBatch(node);
      }
    },
    [node, batchOptions, aiOptions, marks, ctx, batch, sessionId, patientId, enterNode, toConfirm, advanceBatch]
  );

  const onConfirmGesture = useCallback(
    (g: Gesture) => {
      // A guarda do instante em que a pessoa registrou o gesto. Gravar a
      // mensagem é um round-trip, e a fala vem depois dele.
      const aindaVale = guardaDeContexto();
      if (!confirm) return;
      console.log("[HELO CONVERSAR] confirmation selected", g);
      logEvent({
        sessionId,
        patientId,
        type: "gesto",
        category: confirm.category,
        question:
          confirm.step === 2 ? "Confirmação reforçada" : `Confirma: ${confirm.phrase}`,
        gesture: g,
        responseMs: Date.now() - shownAt.current,
      });

      if (g === "sim") {
        if (confirm.sensitive && confirm.step === 1) {
          // Tema sensível: o app pergunta de novo antes de registrar.
          setConfirm({ ...confirm, step: 2 });
          shownAt.current = Date.now();
          void speak("Este é um assunto importante. É exatamente isso que você quer dizer?");
          return;
        }
        logEvent({
          sessionId,
          patientId,
          type: "confirmacao",
          category: confirm.category,
          detail: confirm.fromAI ? `${confirm.phrase} (sugestão IA)` : confirm.phrase,
        });
        setPhase("done");
        // Frase confirmada em nome do PACIENTE: sai na voz do paciente (clone
        // → voz configurada em Ajustes → fallback), com prioridade máxima.
        //
        // A ordem inverteu na Fase 5.1A: REGISTRA e só então fala. Antes as
        // duas coisas corriam em paralelo, e a voz não dependia do registro —
        // era justamente o que permitia falar sem que existisse frase
        // confirmada nenhuma no servidor.
        console.log("[HELO CONVERSAR] patient message confirmed");
        void saveMessage({
          sessionId,
          patientId,
          text: confirm.phrase,
          category: confirm.category,
          sensitive: confirm.sensitive,
          status: "confirmada",
          confirmations: confirm.sensitive ? 2 : 1,
          speakerRole: "patient",
          confirmationStatus: "confirmed",
        }).then((saved) => {
          if (!saved) {
            console.error("[HELO CONVERSAR] frase não registrada — a voz do paciente não soa");
            return;
          }
          // O registro de A é legítimo e fica. A FALA, não: se o cuidador
          // trocou de paciente enquanto a mensagem era gravada, a voz do
          // paciente soaria com outra pessoa na tela — que é a coisa mais
          // grave que esta tela pode fazer.
          if (!aindaVale()) {
            console.warn("[HELO CONVERSAR] contexto expirou antes da fala — a voz do paciente não soa");
            return;
          }
          confirmedPhrase.current = { text: confirm.phrase, messageId: saved.id };
          void speakPatientPhrase(confirm.phrase);
        });
        return;
      }

      if (g === "talvez") {
        logEvent({
          sessionId,
          patientId,
          type: "reformulacao",
          category: confirm.category,
          detail: confirm.phrase,
        });
        void speak("Tudo bem, vamos ajustar.");
        setConfirm(null);
        enterNode(confirm.originNode);
        return;
      }

      // ✊ descartar — nada é dito em nome do paciente
      logEvent({
        sessionId,
        patientId,
        type: "descarte",
        category: confirm.category,
        detail: confirm.phrase,
      });
      void saveMessage({
        sessionId,
        patientId,
        text: confirm.phrase,
        category: confirm.category,
        sensitive: confirm.sensitive,
        status: "descartada",
        speakerRole: "patient",
        confirmationStatus: "rejected",
      });
      void speak("Mensagem descartada.");
      setConfirm(null);
      enterNode(START_NODE);
    },
    [confirm, sessionId, patientId, speak, speakPatientPhrase, enterNode]
  );

  // ——— Controles do assistente ———

  const begin = useCallback(async (payload?: Record<string, unknown>) => {
    if (!user) {
      redirectToLogin();
      return;
    }
    if (patientId == null) {
      setStartError("Nenhum paciente selecionado. Escolha um paciente no Dashboard.");
      return;
    }
    // ——— O contexto de agora, para conferir depois do await (L1, 5.3C) ———
    //
    // `patientId` daqui em diante é uma cópia congelada no closure. Criar a
    // sessão é um round-trip, e no meio dele o cuidador pode trocar de paciente
    // ou sair da tela — e então tudo o que vem depois (o evento de pergunta
    // apresentada, a fala) pertenceria a um mundo que não existe mais.
    const aindaVale = guardaDeContexto(payload);
    setStartError(null);
    setStarting(true);
    // A identidade do operador é resolvida no servidor a partir do cookie de
    // sessão — aqui só vai o modo e o paciente ativo.
    const { id, error } = await startSession("conversa", patientId);
    setStarting(false);
    if (id == null) {
      setStartError(error ?? "Não foi possível iniciar a conversa. Tente novamente.");
      return;
    }
    if (!aindaVale()) {
      // A sessão de A foi criada com autorização legítima e FICA: apagá-la
      // seria inventar um rollback que o produto não tem. O que não acontece é
      // a continuação — nada é gravado, nada é falado, nada é apresentado.
      console.warn("[HELO CONVERSAR] contexto expirou durante a criação da sessão — nada é apresentado");
      return;
    }
    setSessionId(id);
    setPhase("node");
    setNodeId(START_NODE);
    setHistory([]);
    setCtx({});
    setMarks({});
    setBatch(0);
    setAiOptions(null);
    pathLog.current = [];
    rejectedLog.current = [];
    shownAt.current = Date.now();
    logEvent({
      sessionId: id,
      patientId,
      type: "pergunta_apresentada",
      category: "geral",
      question: flow[START_NODE].question,
    });
    // Vocativo com o nome do paciente: "Dr. Fábio, o que você quer comunicar?"
    const q = flow[START_NODE].question;
    void speak(patientName ? `${patientName}, ${q.charAt(0).toLowerCase()}${q.slice(1)}` : q);
  }, [user, patientName, patientId, speak]);

  const repeat = useCallback(() => {
    if (phase === "confirm" && confirm) {
      void speak(`Você quer dizer: ${confirm.phrase} — Confirma?`);
    } else {
      void speak(node.question);
    }
  }, [phase, confirm, node, speak]);

  const uncertain = useCallback(() => {
    logEvent({
      sessionId,
      patientId,
      type: "gesto_incerto",
      category: node.category,
      question: phase === "confirm" ? confirm?.phrase : node.question,
    });
    void speak("Sem problema. Vou repetir.");
    // A única fala PROGRAMADA da tela. 400 ms é pouco, mas é tempo: um
    // temporizador não morre com a remontagem, e a pergunta de A não pode
    // soar depois que a tela já é de B.
    const aindaVale = guardaDeContexto();
    setTimeout(() => {
      if (aindaVale()) repeat();
    }, 400);
  }, [sessionId, patientId, node, phase, confirm, speak, repeat]);

  const togglePause = useCallback(() => {
    if (paused) {
      logEvent({ sessionId, patientId, type: "retomada" });
      setPaused(false);
      shownAt.current = Date.now();
    } else {
      logEvent({ sessionId, patientId, type: "pausa" });
      setPaused(true);
    }
  }, [paused, sessionId, patientId]);

  const goBack = useCallback(() => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setConfirm(null);
    setAiOptions(null);
    setNodeId(prev.nodeId);
    setBatch(prev.batch);
    setMarks({});
    setPhase("node");
    shownAt.current = Date.now();
    void speak(flow[prev.nodeId].question);
  }, [history, speak]);

  const finish = useCallback(() => {
    endSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    const handler = () => endSession(sessionId);
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [sessionId]);

  // Atalhos para o assistente: 1 = 👍, 2 = ✋, 3 = ✊ (perguntas e confirmação)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused || phase === "intro" || phase === "done") return;
      const map: Record<string, Gesture> = { "1": "sim", "2": "talvez", "3": "nao" };
      const g = map[e.key];
      if (!g) return;
      if (phase === "confirm") onConfirmGesture(g);
      else if (node.kind === "pergunta") onQuestionGesture(g);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paused, phase, node, onConfirmGesture, onQuestionGesture]);

  // ——— Render ———

  // Memoizado: era recriado a cada render, e uma lista nova a cada render
  // reconstruía TODO o Action Registry desta tela — a mesma lição de churn da
  // 5.3B. Aqui o custo não era desempenho: era o Agent. O dispatcher confere,
  // depois de autorizar no servidor, se a ação ainda é A MESMA (identidade de
  // objeto, e de propósito — um remount devolveria outra instância). Com o
  // array renascendo a cada render, qualquer render durante o round-trip de
  // autorização — a chegada da rede de pessoas, por exemplo — fazia um pedido
  // legítimo voltar como CONTEXT_EXPIRED. A recusa estava certa; o que estava
  // errado era a tela mudar de identidade sem ter mudado de nada.
  const displayOptions = useMemo<{ label: string; ai: boolean }[]>(
    () =>
      aiOptions
        ? aiOptions.map((o) => ({ label: o.label, ai: true }))
        : batchOptions.map((o) => ({ label: o.label, ai: false })),
    [aiOptions, batchOptions]
  );

  const pronto = !authLoading && !patientLoading && user != null && patientId != null;
  // A ação da introdução mora num memo próprio porque ela não depende de NADA
  // da conversa — nem de opções, nem de gestos, nem de histórico. Mantê-la no
  // memo geral a fazia renascer junto com tudo o que muda durante a conversa,
  // e é justamente nessa fase que o Agent é chamado para começar.
  const acaoDeComecar = useMemo<HeloUIAction[]>(
    () => [{
      actionId: "conversa.comecar",
      actionClass: "operational",
      label: "Começar",
      type: "activity",
      enabled: pronto && !starting,
      run: (payload) => void begin(payload),
    }],
    [pronto, starting, begin]
  );

  // Action Registry da Conversa guiada — espelha os botões visíveis por fase,
  // com os MESMOS handlers do toque manual. Os gestos são o sinal do paciente
  // relatado pelo operador, e por isso vêm classificados como
  // "patientResponse": o Agent os ENXERGA, mas não os aciona (R-02).
  const registryActions = useMemo<HeloUIAction[]>(() => {
    if (phase === "done") {
      return [
        {
          // Repetir a mensagem final na VOZ DO PACIENTE (mesma da comunicação
          // original) — nunca na voz da plataforma. O Agente não narra nada.
          // Faz a voz dele soar, portanto é do canal dele.
          //
          // Id PRÓPRIO, e não `conversa.repetir`. As duas ações moram em fases
          // diferentes e nunca coexistem na tela, mas compartilhar o id fazia
          // um mesmo identificador significar `operational` numa fase e
          // `patientResponse` na outra — uma classe que dependia do contexto,
          // exatamente o que a classificação existe para não ser. Quem lê o
          // log, o teste ou o registry vê agora duas ações distintas, porque
          // é isso que elas são: uma repete a pergunta da Helo, a outra faz a
          // voz do paciente soar de novo.
          actionId: "conversa.repetirMensagemPaciente",
          actionClass: "patientResponse",
          label: "Repetir mensagem",
          type: "activity",
          enabled: confirm != null && !speaking,
          run: () => {
            if (!confirm) return;
            console.log("[HELO CONVERSAR] patient message repeated");
            void speakPatientPhrase(confirm.phrase);
          },
        },
        {
          actionId: "conversa.continuar",
          actionClass: "operational",
          label: "Continuar a conversa",
          type: "activity",
          enabled: true,
          run: () => { setConfirm(null); enterNode(START_NODE); },
        },
        {
          actionId: "conversa.encerrar",
          actionClass: "sensitive",
          label: "Encerrar",
          type: "activity",
          enabled: true,
          run: () => { finish(); router.push("/"); },
        },
      ];
    }
    const list: HeloUIAction[] = [];
    // Gestos do paciente por fase — a semântica (confirmar/reformular/recusar)
    // é a mesma dos três botões de gesto na tela.
    if (phase === "confirm" && confirm) {
      list.push(
        { actionId: "gesto.confirmar", actionClass: "patientResponse", label: "Confirmar mensagem", type: "gesture", enabled: !paused, run: () => onConfirmGesture("sim") },
        { actionId: "gesto.reformular", actionClass: "patientResponse", label: "Reformular mensagem", type: "gesture", enabled: !paused, run: () => onConfirmGesture("talvez") },
        { actionId: "gesto.recusar", actionClass: "patientResponse", label: "Descartar mensagem", type: "gesture", enabled: !paused, run: () => onConfirmGesture("nao") },
      );
    } else if (phase === "node" && node.kind === "pergunta") {
      list.push(
        { actionId: "gesto.confirmar", actionClass: "patientResponse", label: "Responder sim", type: "gesture", enabled: !paused, run: () => onQuestionGesture("sim") },
        { actionId: "gesto.reformular", actionClass: "patientResponse", label: "Responder talvez", type: "gesture", enabled: !paused, run: () => onQuestionGesture("talvez") },
        { actionId: "gesto.recusar", actionClass: "patientResponse", label: "Responder não", type: "gesture", enabled: !paused, run: () => onQuestionGesture("nao") },
      );
    } else if (phase === "node" && node.kind === "opcoes") {
      displayOptions.forEach((option, idx) => {
        list.push({
          actionId: `conversa.opcao.${idx + 1}`,
          // Escolher a opção É a resposta do paciente — e leva à frase que
          // sairá na voz dele. Nunca do Agent.
          actionClass: "patientResponse",
          label: `Opção: ${option.label}`,
          type: "gesture",
          enabled: !paused && !aiLoading && !marks[idx],
          run: (payload) => {
            const g = payload?.gesto;
            onOptionGesture(idx, g === "talvez" || g === "nao" ? g : "sim");
          },
        });
      });
    }
    // Controles do assistente, sempre presentes nas fases ativas.
    list.push(
      { actionId: "conversa.repetir", actionClass: "operational", label: "Repetir", type: "activity", enabled: !speaking, run: () => repeat() },
      // "Gesto incerto" registra uma observação SOBRE a resposta do paciente:
      // é do canal dele, não do Agent.
      { actionId: "conversa.gestoIncerto", actionClass: "patientResponse", label: "Gesto incerto", type: "activity", enabled: true, run: () => uncertain() },
      { actionId: paused ? "conversa.retomar" : "conversa.pausar", actionClass: "operational", label: paused ? "Retomar" : "Pausar", type: "activity", enabled: true, run: () => togglePause() },
      { actionId: "conversa.voltar", actionClass: "navigation", label: "Voltar", type: "activity", enabled: history.length > 0, run: () => goBack() },
      { actionId: "conversa.encerrar", actionClass: "sensitive", label: "Encerrar sessão", type: "activity", enabled: true, run: () => { finish(); router.push("/"); } },
    );
    return list;
  }, [phase, confirm, paused, node, displayOptions, aiLoading, marks, onConfirmGesture, onQuestionGesture, onOptionGesture, speaking, speakPatientPhrase, repeat, uncertain, togglePause, goBack, finish, history, enterNode, router]);
  // Na introdução, a lista registrada é a estável — nada da conversa a
  // reconstrói, porque nada da conversa existe ainda.
  useRegisterHeloUIActions(phase === "intro" ? acaoDeComecar : registryActions);

  return (
    <div className="relative flex flex-1 flex-col">
      {/* Fase 6 — conversa ativa: um véu leve cobre o palco e a pergunta
          flutua DIRETO sobre o orbe Conversar, que segue central, visível e
          animado através da camada. Só o conteúdo troca (com fade) — o palco
          nunca desmonta. A intro mantém o painel translúcido da Fase 5. */}
      {phase !== "intro" && <OverlayVeil />}
      <main className="relative flex w-full flex-1 flex-col items-center justify-center gap-4 px-4 pb-4 sm:px-6">
        {phase === "intro" ? (
          <OverlayPanel label="Conversa guiada" variant="imersivo">
            <Intro
              user={user}
              loading={authLoading || patientLoading}
              patientName={patientName}
              hasPatient={patientId != null}
              starting={starting}
              error={startError}
              onBegin={begin}
              onSwitchOperator={logout}
            />
          </OverlayPanel>
        ) : (
        <section
          key={`${phase}-${nodeId}-${batch}-${aiOptions ? "ai" : "curadas"}`}
          aria-label="Conversa guiada"
          className="fade-rise pointer-events-auto mx-auto w-full max-w-3xl py-8"
        >
        {phase === "node" && node.kind === "pergunta" && (
          <section aria-live="polite" className="mx-auto flex w-full flex-col items-center gap-12">
            <h1 className="text-center text-4xl font-medium tracking-tight sm:text-5xl">
              {node.question}
            </h1>
            <GestureOptionsBar
              options={gestureOptions}
              onSelectOption={(option) => onQuestionGesture(option.id as Gesture)}
              disabled={paused}
            />
          </section>
        )}

        {phase === "node" && node.kind === "opcoes" && (
          <section aria-live="polite" className="mx-auto flex w-full flex-col items-center gap-8">
            <h1 className="text-center text-3xl font-medium tracking-tight text-ink-soft sm:text-4xl">
              {node.question}
            </h1>
            {aiLoading && (
              <p className="text-ink-mute animate-pulse">Formulando outras opções…</p>
            )}
            <div className="flex w-full flex-col gap-6">
              {displayOptions.map((option, idx) => {
                const marked = marks[idx];
                return (
                  <div
                    key={`${nodeId}-${batch}-${aiOptions ? "ai" : "c"}-${idx}`}
                    className={`flex flex-col items-center gap-3 rounded-3xl px-6 py-5 transition-opacity ${
                      marked ? "opacity-35" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <h2 className="text-center text-4xl font-medium tracking-tight sm:text-5xl">
                        {option.label}
                      </h2>
                      <button
                        type="button"
                        onClick={() => void speak(option.label)}
                        aria-label={`Ler em voz alta: ${option.label}`}
                        className="rounded-full border border-line bg-card px-3 py-1.5 text-sm text-ink-soft hover:border-ink-mute"
                      >
                        🔊
                      </button>
                      {option.ai && (
                        <span className="rounded-full bg-talvez-soft px-3 py-1 text-xs font-medium text-talvez">
                          ✦ sugerida por IA
                        </span>
                      )}
                    </div>
                    {marked ? (
                      <span className="text-lg" aria-label={`Resposta: ${gestures[marked].label}`}>
                        {gestures[marked].emoji} {gestures[marked].label}
                      </span>
                    ) : (
                      <GestureOptionsBar
                        options={gestureOptions}
                        onSelectOption={(option) => onOptionGesture(idx, option.id as Gesture)}
                        disabled={paused || aiLoading}
                        ariaLabel={`Gesto do paciente para: ${option.label}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            {!aiOptions && effectiveOptions.length > LOTE && (
              <p className="text-sm text-ink-mute">
                opções {batch * LOTE + 1}–{Math.min((batch + 1) * LOTE, effectiveOptions.length)} de{" "}
                {effectiveOptions.length}
              </p>
            )}
          </section>
        )}

        {phase === "confirm" && confirm && (
          <section aria-live="polite" className="mx-auto flex w-full flex-col items-center gap-10">
            <p className="text-sm font-semibold uppercase tracking-widest text-ink-soft">
              {confirm.step === 2 ? "Confirmação reforçada — assunto importante" : "Confirmar mensagem"}
              {confirm.fromAI && " · frase sugerida por IA"}
            </p>
            <blockquote className="text-center text-4xl font-medium leading-snug tracking-tight sm:text-5xl">
              “{confirm.phrase}”
            </blockquote>
            <p className="text-lg text-ink-soft">
              {confirm.step === 2
                ? "É exatamente isso que você quer dizer?"
                : "Confirma esta mensagem?"}
            </p>
            <GestureOptionsBar
              options={gestureOptions}
              onSelectOption={(option) => onConfirmGesture(option.id as Gesture)}
              disabled={paused}
            />
            <p className="text-sm text-ink-mute">
              {gestures.sim.emoji} confirmar · {gestures.talvez.emoji} reformular · {gestures.nao.emoji} descartar
            </p>
          </section>
        )}

        {phase === "done" && confirm && (
          <section aria-live="polite" className="mx-auto flex w-full flex-col items-center gap-8">
            <blockquote className="text-center text-4xl font-medium leading-snug tracking-tight sm:text-5xl">
              “{confirm.phrase}”
            </blockquote>
            <p className="text-lg text-ink-soft">Mensagem comunicada e registrada.</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => {
                  console.log("[HELO CONVERSAR] patient message repeated");
                  void speakPatientPhrase(confirm.phrase);
                }}
                className="rounded-full border border-line bg-card px-6 py-3 font-medium hover:border-ink-mute"
              >
                🔊 Repetir
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirm(null);
                  enterNode(START_NODE);
                }}
                className="rounded-full bg-accent px-6 py-3 font-medium text-on-accent hover:bg-accent-strong"
              >
                Continuar a conversa
              </button>
              <Link
                href="/"
                onClick={finish}
                className="rounded-full border border-line bg-card px-6 py-3 font-medium hover:border-ink-mute"
              >
                Encerrar
              </Link>
            </div>
          </section>
        )}
        </section>
        )}

      {phase !== "intro" && phase !== "done" && (
        <footer className="no-print pointer-events-auto flex flex-wrap items-center justify-center gap-2 px-6 py-4">
          <Control onClick={repeat} disabled={speaking}>
            🔊 Repetir
          </Control>
          <Control onClick={uncertain}>❓ Gesto incerto</Control>
          <Control onClick={togglePause}>{paused ? "▶ Retomar" : "⏸ Pausar"}</Control>
          <Control onClick={goBack} disabled={history.length === 0}>
            ← Voltar
          </Control>
          <Link
            href="/"
            onClick={finish}
            className="rounded-full border border-line bg-card px-5 py-2.5 text-sm font-medium text-ink-soft hover:border-ink-mute"
          >
            Encerrar sessão
          </Link>
        </footer>
      )}
      </main>

      {/* Pausa cobre só a área de conteúdo — os orbes seguem visíveis acima */}
      {paused && (
        <div
          role="dialog"
          aria-label="Conversa pausada"
          className="pointer-events-auto absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 rounded-3xl bg-cream/70 backdrop-blur-md"
        >
          <p className="text-3xl font-medium">Conversa pausada</p>
          <p className="max-w-md text-center text-ink-soft">
            O silêncio também é uma resposta. Retome quando o paciente quiser.
          </p>
          <button
            type="button"
            onClick={togglePause}
            className="rounded-full bg-accent px-8 py-4 text-lg font-medium text-on-accent hover:bg-accent-strong"
          >
            ▶ Retomar conversa
          </button>
        </div>
      )}
    </div>
  );
}

/** Rótulo humano do papel — profissionais mostram a especialidade. */
function operatorRoleLabel(user: AppUser): string {
  if (user.role === "profissional" && user.professionalType) {
    return PROFESSIONAL_TYPE_LABELS[user.professionalType];
  }
  return ROLE_LABELS[user.role];
}

function Intro({
  user,
  loading,
  patientName,
  hasPatient,
  starting,
  error,
  onBegin,
  onSwitchOperator,
}: {
  user: AppUser | null;
  loading: boolean;
  patientName: string;
  hasPatient: boolean;
  starting: boolean;
  error: string | null;
  onBegin: () => void;
  onSwitchOperator: () => void;
}) {
  const gestures = useGestures();
  const ready = !loading && user != null && hasPatient;
  return (
    <section className="mx-auto flex w-full max-w-xl flex-col items-center gap-8 text-center">
      <div>
        <h1 className="text-4xl font-medium tracking-tight">Iniciar conversa</h1>
        <p className="mt-3 text-lg text-ink-soft">
          O Helo faz perguntas em voz alta. O paciente responde com um gesto, e
          você seleciona o gesto correspondente na tela.
        </p>
      </div>
      <div className="flex items-center gap-6 text-lg">
        <span>{gestures.sim.emoji} Sim</span>
        <span>{gestures.talvez.emoji} Talvez</span>
        <span>{gestures.nao.emoji} Não</span>
      </div>

      {/* Identificação somente leitura: operador = usuário autenticado,
          paciente = seleção feita no Dashboard. Nada é digitado aqui. */}
      {loading ? (
        <p className="text-ink-mute animate-pulse">Identificando operador…</p>
      ) : user ? (
        <div className="flex w-full flex-col gap-4 sm:flex-row sm:justify-center sm:gap-8">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-mute">
              Você está acompanhando como:
            </span>
            <span className="text-xl font-medium">{user.name}</span>
            <span className="text-sm text-ink-soft">{operatorRoleLabel(user)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-mute">Paciente:</span>
            <span className="text-xl font-medium">
              {hasPatient ? patientName || "Paciente sem nome" : "—"}
            </span>
            {!hasPatient && (
              <span className="text-sm text-ink-soft">
                Selecione um paciente no{" "}
                <Link href="/dashboard" className="underline">
                  Dashboard
                </Link>
                .
              </span>
            )}
          </div>
        </div>
      ) : (
        <p className="text-ink-soft" role="alert">
          É preciso entrar na plataforma para operar o Helo. Redirecionando para
          o login…
        </p>
      )}

      {error && (
        <p role="alert" className="w-full rounded-2xl bg-nao-soft px-5 py-3 text-nao">
          {error}
        </p>
      )}

      <div className="flex flex-col items-center gap-3">
        {/* `onBegin()` sem argumento: `begin` recebe o payload da tool, e o
            objeto de evento do React não é um payload. */}
        <button
          type="button"
          onClick={() => onBegin()}
          disabled={!ready || starting}
          className="rounded-full bg-accent px-10 py-4 text-lg font-medium text-on-accent transition-transform hover:scale-[1.02] hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
        >
          {starting ? "Iniciando…" : "Começar"}
        </button>
        {/* Segundo modo da tela Conversar: o assistente formula a pergunta e
            registra a resposta observada. O fluxo guiado acima segue igual. */}
        <Link
          href="/conversa/perguntas"
          aria-disabled={!ready}
          tabIndex={ready ? undefined : -1}
          className={`rounded-full border border-line bg-card px-8 py-3 font-medium text-ink transition-colors hover:border-ink-mute ${
            ready ? "" : "pointer-events-none opacity-40"
          }`}
        >
          Perguntas em tempo real
        </Link>
      </div>
      {user && (
        <button
          type="button"
          onClick={onSwitchOperator}
          className="text-sm text-ink-mute underline-offset-4 hover:underline"
        >
          Trocar operador (sair e entrar com outra conta)
        </button>
      )}
      <p className="text-sm text-ink-mute">
        O Helo nunca fala pelo paciente. Toda mensagem é confirmada antes de ser comunicada.
      </p>
    </section>
  );
}

function Control({
  children,
  onClick,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-line bg-card px-5 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:border-ink-mute disabled:opacity-40"
    >
      {children}
    </button>
  );
}
