"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePatient, usePatientItems } from "@/lib/patient";
import { DEFAULT_ITEMS } from "@/lib/defaults";
import { logEvent, saveMessage, startSession, endSession } from "@/lib/log";
import { useHelo } from "@/lib/helo-state";
import type { SpeakResult } from "@/lib/useSpeech";
import {
  beginPatientVoiceOverride,
  endPatientVoiceOverride,
  isPlatformMuted,
} from "@/lib/audio-coordinator";
import { OverlayVeil } from "@/components/overlay-panel";
import { ContextualEdit } from "@/components/contextual-edit";
import { buildEditLink } from "@/lib/edit-link";
import { useRegisterHeloUIActions, type HeloUIAction } from "@/lib/helo-action-registry";

// Modo emergência: frases críticas DO PACIENTE (editáveis em Ajustes, nunca
// aqui), sem IA e sem etapas. O toque do assistente é a confirmação — a voz
// sai na hora. O espelho local garante o modo mesmo sem rede; sem nada em
// cache (primeiro uso offline), o conteúdo padrão entra como rede de
// segurança — a Emergência nunca abre vazia.
//
// Fase 8 — Emergência imersiva: o orbe âmbar assume o centro do palco e as
// ações flutuam direto sobre ele, que segue visível e animado ao fundo.
// Diferente dos outros modos, o conteúdo entra SEM animação (nada de
// fade-rise): as ações de socorro estão legíveis e clicáveis no primeiro
// frame, enquanto a transição visual do orbe termina por conta própria.
type EmergencyAction = {
  itemId: string | null;
  /** Id estável para o Action Registry: itemId real ou defaultKey do padrão. */
  actionKey: string;
  label: string;
  phrase: string;
};

export default function EmergenciaPage() {
  const router = useRouter();
  const { speak, prime } = useHelo();
  const { patientId } = usePatient();
  const { enabledItems, loading, canEdit } = usePatientItems("emergencia");
  const sessionRef = useRef<number | null>(null);
  const sessionPending = useRef<Promise<number | null> | null>(null);

  const actions: EmergencyAction[] = useMemo(() => {
    if (enabledItems.length > 0) {
      return enabledItems.map((i) => ({
        itemId: i.id,
        actionKey: i.id,
        label: i.label,
        phrase: i.spokenText,
      }));
    }
    if (loading) return [];
    return DEFAULT_ITEMS.emergencia.map((d) => ({
      itemId: null,
      actionKey: d.defaultKey,
      label: d.label,
      phrase: d.spokenText,
    }));
  }, [enabledItems, loading]);

  // Pré-aquece o áudio das frases: o toque reproduz na hora, com a voz
  // clonada, e continua falando mesmo se a rede cair depois de entrar.
  // Autoria do paciente: Emergência é, por definição do produto, fala DELE —
  // e o fluxo dispensa confirmação (o toque do assistente é a confirmação).
  useEffect(() => {
    if (actions.length > 0 && patientId != null) {
      void prime(
        actions.map((item) => item.phrase),
        { speakerRole: "patient", confirmationStatus: "notRequired", patientId }
      );
    }
  }, [prime, actions, patientId]);

  useEffect(() => {
    const handler = () => endSession(sessionRef.current);
    window.addEventListener("beforeunload", handler);
    return () => {
      handler();
      window.removeEventListener("beforeunload", handler);
    };
  }, []);

  // Sessão em segundo plano: toques simultâneos compartilham a mesma
  // criação; se a rede falhar, o próximo toque tenta de novo.
  const ensureSession = useCallback(() => {
    if (sessionRef.current != null) return Promise.resolve(sessionRef.current);
    if (!sessionPending.current) {
      sessionPending.current = startSession("emergencia", patientId).then(({ id }) => {
        sessionRef.current = id;
        if (id == null) sessionPending.current = null;
        return id;
      });
    }
    return sessionPending.current;
  }, [patientId]);

  // Feedback visível do toque: nenhum caminho pode ser silencioso — o
  // assistente sempre vê que o toque foi recebido e se a voz falhou.
  const [feedback, setFeedback] = useState<
    { label: string; status: "falando" | "erro" | "silenciada"; detail?: string } | null
  >(null);

  const trigger = useCallback(
    (item: EmergencyAction) => {
      console.log("[HELO EMERGENCY] card action requested", item.label);
      console.log("[HELO VOICE] emergency phrase voiceRole patient");
      // O registro é SILENCIOSO: nenhuma voz da plataforma nem do Agente diz
      // "registrado" — a única fala é a frase do paciente.
      console.log("[HELO EMERGENCY] suppressing platform confirmation voice");
      setFeedback({ label: item.label, status: "falando" });
      // Fala do PACIENTE — prioridade MÁXIMA. Não espera brecha: assume o áudio
      // na hora, interrompendo a plataforma e suprimindo a voz do Agente Helo
      // (beginPatientVoiceOverride), que fica bloqueado até a frase terminar.
      // "priority: patientEmergency" autoriza a fala a atravessar o gate do
      // Audio Manager. O mute continua bloqueando tudo, inclusive esta.
      const speakPatientPhrase = async (): Promise<SpeakResult> => {
        beginPatientVoiceOverride();
        try {
          return await speak(item.phrase, {
            speakerRole: "patient",
            confirmationStatus: "notRequired",
            patientId,
            mode: "emergencia",
            priority: "patientEmergency",
          });
        } finally {
          endPatientVoiceOverride();
        }
      };
      speakPatientPhrase()
        .then((result) => {
          if (result === "concluida") console.log("[HELO AUDIO] patient phrase played");
          if (result === "silenciada" && isPlatformMuted()) console.log("[HELO AUDIO] blocked by mute");
          if (result === "erro" || result === "bloqueada") {
            setFeedback({
              label: item.label,
              status: "erro",
              detail: result === "bloqueada" ? "o navegador bloqueou o áudio" : "a reprodução falhou",
            });
            window.setTimeout(
              () => setFeedback((f) => (f?.status === "erro" ? null : f)),
              8000
            );
          } else if (result === "silenciada") {
            // A ação de socorro foi registrada (log + mensagem seguem no
            // segundo plano). A frase do paciente tem prioridade máxima e
            // atravessa o Agente — só o MUTE a silencia.
            setFeedback({
              label: item.label,
              status: "silenciada",
              detail: "a voz da plataforma está mutada",
            });
            window.setTimeout(
              () => setFeedback((f) => (f?.status === "silenciada" ? null : f)),
              6000
            );
          } else {
            // concluída ou interrompida por outro toque: limpa só o próprio estado
            setFeedback((f) =>
              f?.label === item.label && f.status === "falando" ? null : f
            );
          }
        })
        .catch((err: unknown) => {
          const e = err as Error;
          console.error("[EMERGENCY ERROR] speak rejeitou:", e?.message ?? err);
          if (e?.stack) console.error("[EMERGENCY ERROR] stack:", e.stack);
          setFeedback({ label: item.label, status: "erro", detail: "erro inesperado na voz" });
        });
      // Registro SILENCIOSO em segundo plano: salva no banco, atualiza
      // histórico/logs — sem nenhuma confirmação vocal. Falha de rede não
      // silencia o pedido.
      console.log("[HELO EMERGENCY] internal registration silent");
      void ensureSession().then((sid) => {
        logEvent({
          sessionId: sid,
          patientId,
          itemId: item.itemId ?? undefined,
          type: "emergencia",
          category: "emergencia",
          detail: item.phrase,
        });
        void saveMessage({
          sessionId: sid,
          patientId,
          text: item.phrase,
          category: "emergencia",
          status: "confirmada",
          speakerRole: "patient",
          // Regra do produto: em emergência o toque do assistente é a
          // confirmação — não há gesto na frente do socorro.
          confirmationStatus: "confirmed",
        }).then(() => console.log("[HELO EMERGENCY] silent registration saved"));
      });
    },
    [speak, ensureSession, patientId]
  );

  // Action Registry: as ações de socorro (e a edição contextual, quando
  // permitida) com os MESMOS handlers do toque manual — o toque do Agent
  // também é confirmação, pela regra do produto da Emergência.
  const registryActions = useMemo<HeloUIAction[]>(() => {
    const list: HeloUIAction[] = [];
    for (const item of actions) {
      list.push({
        actionId: `emergencia.item.${item.actionKey}`,
        label: item.label,
        type: "modeItem",
        enabled: true,
        run: () => trigger(item),
        // Retorno TÉCNICO e não-narrável ao Agente: acionar por tool executa o
        // MESMO handler do clique (registro silencioso + fala do paciente com
        // prioridade máxima). Sem mensagem em linguagem natural — o Agente não
        // deve ler nada em voz alta; quem fala é o paciente.
        toolSuccess: {
          result: "handled",
          mode: "silent",
          speechOwner: "patient",
          suppressAgentSpeech: true,
          suppressAssistantNarration: true,
        },
      });
      if (canEdit && item.itemId) {
        const itemId = item.itemId;
        list.push({
          actionId: `emergencia.editar.${itemId}`,
          label: `Editar ${item.label}`,
          type: "edit",
          enabled: true,
          requiredPermission: "editEmergency",
          run: () => router.push(buildEditLink({ entityType: "modeItem", mode: "emergencia", itemId }, "/emergencia")),
        });
      }
    }
    return list;
  }, [actions, canEdit, router, trigger]);
  useRegisterHeloUIActions(registryActions);

  return (
    <div className="relative flex flex-1 flex-col">
      <OverlayVeil />
      <main className="relative flex w-full flex-1 flex-col items-center justify-center px-4 pb-6 pl-14 sm:px-6 sm:pl-20 xl:pl-6">
        <section
          aria-label="Emergência"
          className="pointer-events-auto mx-auto flex w-full max-w-3xl flex-col gap-6 py-6"
        >
          <div className="text-center">
            <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">Emergência</h1>
            <p className="mt-2 text-lg text-ink-soft">
              Um toque fala na hora, em voz alta. Sempre disponível, sem depender de IA.
            </p>
          </div>

          {/* Estado do toque — sempre perceptível, mesmo sem som */}
          <div aria-live="assertive" className="min-h-10 text-center">
            {feedback?.status === "falando" && (
              <span className="inline-block rounded-full bg-nao px-5 py-2 text-base font-semibold text-white">
                🔊 Falando: {feedback.label}
              </span>
            )}
            {feedback?.status === "silenciada" && (
              <span className="inline-block rounded-full border-2 border-line bg-card px-5 py-2 text-base font-semibold text-ink-soft">
                ✅ Ação registrada ({feedback.detail}).
              </span>
            )}
            {feedback?.status === "erro" && (
              <span className="inline-block rounded-full border-2 border-nao bg-white px-5 py-2 text-base font-semibold text-nao">
                ⚠️ A voz não saiu ({feedback.detail}). Toque de novo.
              </span>
            )}
          </div>

          {actions.length === 0 && loading && (
            <p className="text-center text-ink-mute">Carregando as ações do paciente…</p>
          )}

          <div className="flex flex-col gap-4">
            {actions.map((item) => {
              const isActive = feedback?.label === item.label && feedback.status === "falando";
              return (
                <div key={item.itemId ?? item.label} className="relative">
                  <button
                    type="button"
                    onClick={() => trigger(item)}
                    className={`w-full rounded-3xl border-2 px-6 py-7 text-left shadow-soft backdrop-blur-md transition-transform hover:scale-[1.02] active:scale-[0.98] ${
                      isActive
                        ? "border-nao bg-nao-soft ring-4 ring-nao/40"
                        : "border-nao/30 bg-nao-soft/90"
                    }`}
                  >
                    <span className="block pr-20 text-2xl font-semibold tracking-tight text-nao">
                      {item.label}
                    </span>
                    <span className="mt-1 block text-lg text-ink-soft">“{item.phrase}”</span>
                  </button>
                  {/* Edição contextual FORA do botão de socorro: tocar em
                      Editar nunca dispara a fala. Ajustes abre já no item. */}
                  {canEdit && item.itemId && (
                    <ContextualEdit
                      target={{ entityType: "modeItem", mode: "emergencia", itemId: item.itemId }}
                      source="/emergencia"
                      label={item.label}
                      className="absolute right-3 top-3"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
