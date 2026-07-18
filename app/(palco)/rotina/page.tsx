"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Gesture, ModeItem } from "@/lib/types";
import { useGestures } from "@/lib/gestures";
import { usePatient, usePatientItems } from "@/lib/patient";
import { DEFAULT_ITEMS, modeSpeakerRole } from "@/lib/defaults";
import { logEvent, saveMessage, startSession, endSession } from "@/lib/log";
import { useHelo } from "@/lib/helo-state";
import { GestureTriplet } from "@/components/ui";
import { OverlayVeil } from "@/components/overlay-panel";
import { ContextualEdit } from "@/components/contextual-edit";
import { buildEditLink } from "@/lib/edit-link";
import { useRegisterHeloUIActions, type HeloUIAction } from "@/lib/helo-action-registry";

// Modo rotina: as frases rápidas são DO PACIENTE (personalizáveis em
// Ajustes), com espelho local — o modo continua funcionando sem IA e sem
// rede. Se ainda não há nada carregado (primeiro uso offline), o conteúdo
// padrão da Helo entra como rede de segurança.

type Pending = {
  itemId: string | null;
  /** Id estável para o Action Registry: itemId real ou defaultKey do padrão. */
  actionKey: string;
  label: string;
  phrase: string;
  category: string;
};

export default function RotinaPage() {
  const router = useRouter();
  const { speak, stop } = useHelo();
  const gestures = useGestures();
  const { patientId } = usePatient();
  const { enabledItems, loading, canEdit } = usePatientItems("rotina");
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
        actionKey: i.id,
        label: i.label,
        phrase: i.spokenText,
        category: i.category,
      }));
    }
    if (loading) return [];
    return DEFAULT_ITEMS.rotina.map((d) => ({
      itemId: null,
      actionKey: d.defaultKey,
      label: d.label,
      phrase: d.spokenText,
      category: d.category,
    }));
  }, [enabledItems, loading]);

  const ensureSession = useCallback(async () => {
    if (sessionRef.current == null) {
      sessionRef.current = (await startSession("rotina", patientId)).id;
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
      console.log("[HELO ROUTINE] item selected", item.label);
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
        // A frase da Rotina é fala DO PACIENTE: sai na voz dele (clone/catálogo
        // configurado em Ajustes) quando disponível, senão no fallback aprovado
        // — nunca fingindo ser a voz do paciente. A autoria vem de
        // modeSpeakerRole (ponto único); a resolução técnica é do servidor.
        const speakerRole = modeSpeakerRole("rotina");
        console.log("[HELO VOICE] role:", speakerRole);
        void speak(pending.phrase, {
          speakerRole,
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

  // Voltar da confirmação para a lista de rotinas, sem responder o gesto:
  // interrompe a pergunta em curso e volta à grade — preserva paciente ativo,
  // sessão e itens. Nunca navega para Home/Dashboard/Conversar. É o mesmo
  // handler do botão "Voltar" e da ação routine.backToMenu do Agente.
  const backToMenu = useCallback(() => {
    console.log("[HELO ROUTINE] back to menu");
    stop();
    answeredRef.current = true; // um gesto atrasado não reabre a confirmação
    setPending(null);
  }, [stop]);

  // Action Registry: espelha o que está clicável agora — a grade de frases
  // (com edição contextual quando permitida) ou, durante uma confirmação,
  // os três gestos. Os handlers são os MESMOS do toque manual.
  const registryActions = useMemo<HeloUIAction[]>(() => {
    if (pending) {
      const gestureRun = (g: Gesture) => () => onGesture(g);
      return [
        { actionId: "gesto.confirmar", label: `Confirmar: ${pending.phrase}`, type: "gesture", enabled: true, run: gestureRun("sim") },
        { actionId: "gesto.reformular", label: "Não é bem isso", type: "gesture", enabled: true, run: gestureRun("talvez") },
        { actionId: "gesto.recusar", label: "Descartar", type: "gesture", enabled: true, run: gestureRun("nao") },
        // O Agente Helo também volta ao menu por voz — mesmo handler do botão.
        { actionId: "routine.backToMenu", label: "Voltar para menu de rotinas", type: "navigation", enabled: true, run: () => backToMenu() },
      ];
    }
    const list: HeloUIAction[] = [];
    for (const item of items) {
      list.push({
        actionId: `rotina.item.${item.actionKey}`,
        label: item.label,
        type: "modeItem",
        enabled: true,
        run: () => void propose(item),
      });
      if (canEdit && item.itemId) {
        const itemId = item.itemId;
        list.push({
          actionId: `rotina.editar.${itemId}`,
          label: `Editar ${item.label}`,
          type: "edit",
          enabled: true,
          requiredPermission: "editRoutine",
          run: () => router.push(buildEditLink({ entityType: "modeItem", mode: "rotina", itemId }, "/rotina")),
        });
      }
    }
    return list;
  }, [backToMenu, canEdit, items, onGesture, pending, propose, router]);
  useRegisterHeloUIActions(registryActions);

  return (
    <div className="relative flex flex-1 flex-col">
      {/* Fase 7 — Rotina imersiva: o orbe Rotina assume o centro do palco e
          um véu leve cobre a cena; as frases flutuam DIRETO sobre ele, que
          segue visível e animado através da camada. Só o conteúdo troca
          (com fade) entre grade e confirmação — o palco nunca desmonta. */}
      <OverlayVeil />
      <main className="relative flex w-full flex-1 flex-col items-center justify-center px-4 pb-6 pl-14 sm:px-6 sm:pl-20 xl:pl-6">
        {pending ? (
          <section
            key="confirmar"
            aria-live="polite"
            aria-label="Confirmar frase"
            className="fade-rise pointer-events-auto mx-auto flex w-full max-w-3xl flex-col items-center gap-10 py-8"
          >
            {/* Voltar para a lista de rotinas sem responder — âncora clara de
                retorno, alinhada à esquerda acima da frase. */}
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
                <div key={item.itemId ?? item.label} className="relative">
                  <button
                    type="button"
                    onClick={() => void propose(item)}
                    className="w-full rounded-3xl border border-line/70 bg-card/70 px-5 py-8 text-xl font-medium tracking-tight shadow-soft backdrop-blur-md transition-transform hover:scale-[1.03] active:scale-[0.98]"
                  >
                    {item.label}
                  </button>
                  {/* Edição contextual: direto no item exato, em Ajustes —
                      só com permissão do vínculo e só para itens reais do
                      paciente (o conteúdo padrão offline não tem id). */}
                  {canEdit && item.itemId && (
                    <ContextualEdit
                      target={{ entityType: "modeItem", mode: "rotina", itemId: item.itemId }}
                      source="/rotina"
                      label={item.label}
                      className="absolute -right-2 -top-2"
                    />
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
