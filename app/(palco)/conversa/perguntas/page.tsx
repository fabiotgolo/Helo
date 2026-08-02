"use client";

// ——— Perguntas em tempo real ———
// Rota irmã da conversa guiada, no MESMO palco (o orbe Conversar segue
// central). Sendo uma rota própria, a conversa guiada desmonta por completo
// ao entrar aqui: os fluxos atuais e as ações que ela publica no Action
// Registry não coexistem com este modo — onde o segundo gesto significa
// TALVEZ, e só aqui.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { OverlayPanel } from "@/components/overlay-panel";
import { RealtimeQuestionSession } from "@/components/realtime-questions/session";
import { usePatient } from "@/lib/patient";
import { useAuthUser, redirectToLogin } from "@/lib/use-auth";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import {
  useRtqPersistence,
  type SessionDetail,
} from "@/lib/realtime-question-client";
import { isTerminalSessionStatus } from "@/lib/realtime-question-types";
import type { ConversationQuestionSession } from "@/lib/realtime-question-types";

export default function PerguntasEmTempoRealPage() {
  const persist = useRtqPersistence();
  const { user, loading: authLoading } = useAuthUser();
  const { patient, patientId, settings, loading: patientLoading } = usePatient();
  const patientName = settings[PATIENT_SETTING_KEYS.name] ?? patient?.name ?? "";

  // `checkedFor` guarda QUAL paciente já foi consultado — trocar de paciente
  // volta ao estado "carregando" sem precisar de setState dentro do efeito.
  const [checkedFor, setCheckedFor] = useState<number | null>(null);
  // Sobe ao voltar de uma sessão: força reconsultar o que ficou recuperável.
  const [recheck, setRecheck] = useState(0);
  const [resumable, setResumable] = useState<ConversationQuestionSession | null>(
    null
  );
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const loading = patientId != null && checkedFor !== patientId;

  useEffect(() => {
    if (!authLoading && !user) redirectToLogin();
  }, [authLoading, user]);

  // Sessão recuperável: pausada, ou ainda ativa (a página foi recarregada
  // antes de a pausa automática chegar ao servidor). Nunca uma encerrada.
  useEffect(() => {
    if (patientId == null) return;
    let cancelled = false;
    void persist
      .listSessions(patientId)
      .then((sessions) => {
        if (cancelled) return;
        setResumable(sessions.find((s) => !isTerminalSessionStatus(s.status)) ?? null);
        setFailure(null);
      })
      .catch((e: Error) => {
        if (!cancelled) setFailure(e.message);
      })
      .finally(() => {
        if (!cancelled) setCheckedFor(patientId);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, recheck]);

  const startNew = useCallback(async () => {
    if (patientId == null) return;
    try {
      const session = await persist.createSession(patientId);
      setDetail({ session, turns: [] });
      setFailure(null);
    } catch (e) {
      setFailure((e as Error).message);
    }
  }, [persist, patientId]);

  const resume = useCallback(async () => {
    if (patientId == null || !resumable) return;
    try {
      const fresh = await persist.sessionDetail(patientId, resumable.id);
      // Uma sessão pausada volta ao ar por RESUME; uma que ficou ativa segue
      // como está. Em nenhum caso uma resposta provisória vira confirmada.
      const session =
        fresh.session.status === "PAUSED"
          ? await persist.sessionAction(patientId, resumable.id, "RESUME")
          : fresh.session;
      setDetail({ session, turns: fresh.turns });
      setFailure(null);
    } catch (e) {
      setFailure((e as Error).message);
    }
  }, [persist, patientId, resumable]);

  // Sair de uma sessão devolve à abertura DO MODO — não à conversa guiada.
  // O assistente costuma encadear sessões; tirá-lo do modo a cada término
  // transformaria "encerrar" em "sair", que são coisas diferentes.
  const leave = useCallback(() => {
    setDetail(null);
    setCheckedFor(null);
    setRecheck((n) => n + 1);
  }, []);

  // Trocar de paciente no meio do caminho não pode manter a sessão anterior
  // aberta — a checagem é por igualdade de patientId, não por limpeza manual.
  if (detail && patientId != null && detail.session.patientId === patientId) {
    return (
      <RealtimeQuestionSession
        key={detail.session.id}
        patientId={patientId}
        initial={detail}
        onLeave={leave}
      />
    );
  }

  const busy = loading || authLoading || patientLoading || persist.saving;

  return (
    <div className="relative flex flex-1 flex-col">
      <main className="relative flex w-full flex-1 flex-col items-center justify-center px-4 pb-4 sm:px-6">
        <OverlayPanel label="Perguntas em tempo real" variant="imersivo">
          <section className="mx-auto flex w-full max-w-xl flex-col items-center gap-7 text-center">
            <div>
              <h1 className="text-4xl font-medium tracking-tight">
                Perguntas em tempo real
              </h1>
              <p className="mt-3 text-lg text-ink-soft">
                Você escreve a pergunta, apresenta ao paciente e registra a
                resposta observada. O Helo não responde nem interpreta pelo
                paciente.
              </p>
            </div>

            <div className="flex w-full flex-col gap-4 sm:flex-row sm:justify-center sm:gap-8">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-ink-mute">
                  Assistente:
                </span>
                <span className="text-xl font-medium">{user?.name ?? "—"}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-ink-mute">
                  Paciente:
                </span>
                <span className="text-xl font-medium">
                  {patientId != null ? patientName || "Paciente sem nome" : "—"}
                </span>
              </div>
            </div>

            {patientId == null && !patientLoading && (
              <p className="text-ink-soft">
                Selecione um paciente no{" "}
                <Link href="/dashboard" className="underline">
                  Dashboard
                </Link>{" "}
                para iniciar.
              </p>
            )}

            {failure && (
              <p
                role="alert"
                className="w-full rounded-2xl bg-nao-soft px-5 py-3 text-nao"
              >
                {failure}
              </p>
            )}

            {loading ? (
              <p className="animate-pulse text-ink-mute">Verificando sessões…</p>
            ) : (
              <div className="flex flex-col items-center gap-3">
                {resumable && (
                  <>
                    <button
                      type="button"
                      onClick={() => void resume()}
                      disabled={busy}
                      className="rounded-full bg-accent px-10 py-4 text-lg font-medium text-on-accent transition-transform hover:scale-[1.02] hover:bg-accent-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Retomar sessão de {horaDe(resumable.startedAt)}
                    </button>
                    <p className="text-sm text-ink-mute">
                      {resumable.turnCount}{" "}
                      {resumable.turnCount === 1
                        ? "pergunta já registrada"
                        : "perguntas já registradas"}
                    </p>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => void startNew()}
                  disabled={patientId == null || busy}
                  className={
                    resumable
                      ? "rounded-full border border-line bg-card px-8 py-3 font-medium text-ink transition-colors hover:border-ink-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40"
                      : "rounded-full bg-accent px-10 py-4 text-lg font-medium text-on-accent transition-transform hover:scale-[1.02] hover:bg-accent-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40"
                  }
                >
                  Iniciar nova sessão
                </button>
              </div>
            )}

            <Link
              href="/conversa"
              className="text-sm text-ink-mute underline-offset-4 hover:underline"
            >
              ← Voltar para a conversa guiada
            </Link>
          </section>
        </OverlayPanel>
      </main>
    </div>
  );
}

function horaDe(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
}
