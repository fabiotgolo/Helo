"use client";

import { useEffect, useState } from "react";
import { Card, Empty } from "@/components/dashboard-ui";
import { ModalShell } from "@/components/modal-shell";
import type { PatientPlaylistTrack } from "@/lib/playlist";

const PERIOD_LABEL: Record<PatientPlaylistTrack["period"], string> = {
  manhã: "Manhã",
  tarde: "Tarde",
  noite: "Noite",
};

function formattedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data indisponível";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(date).replace(",", " às");
}

export function PatientPlaylistWidget({ patientId, patientName }: { patientId: number; patientName?: string | null }) {
  const [tracks, setTracks] = useState<PatientPlaylistTrack[] | null>(null);
  const [loadedPatientId, setLoadedPatientId] = useState<number | null>(null);
  const [failedPatientId, setFailedPatientId] = useState<number | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [confirmTrack, setConfirmTrack] = useState<PatientPlaylistTrack | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const playlistTitle = patientName?.trim()
    ? `Playlist de ${patientName.trim()}`
    : "Playlist do Paciente";

  useEffect(() => {
    let stale = false;
    void fetch(`/api/patients/${patientId}/playlist`)
      .then(async (response) => {
        if (!response.ok) throw new Error("playlist");
        return (await response.json()) as { tracks: PatientPlaylistTrack[]; canManage?: boolean };
      })
      .then((data) => {
        if (!stale) {
          setTracks(data.tracks);
          setLoadedPatientId(patientId);
          setFailedPatientId(null);
          setCanManage(data.canManage === true);
        }
      })
      .catch(() => {
        if (!stale) {
          setLoadedPatientId(patientId);
          setFailedPatientId(patientId);
        }
      });
    return () => {
      stale = true;
    };
  }, [patientId]);

  const loading = loadedPatientId !== patientId;
  const currentTracks = loadedPatientId === patientId ? tracks : null;
  const failed = failedPatientId === patientId;
  // O servidor decide a autorização a partir da sessão e do vínculo do
  // paciente; o cliente apenas usa esse sinal para não renderizar a lixeira.
  const canDeleteTrack = canManage === true;

  async function deleteTrack(): Promise<void> {
    if (!confirmTrack || deleting) return;
    const songId = confirmTrack.id.trim();
    if (!Number.isSafeInteger(patientId) || patientId <= 0 || !songId) {
      console.error("[PLAYLIST] IDs inválidos para exclusão de música", {
        patientId,
        songId: confirmTrack.id,
      });
      setToast({ kind: "error", text: "Não foi possível identificar a música para exclusão." });
      return;
    }
    setDeleting(true);
    setToast(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/playlist`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: songId }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(typeof payload?.error === "string" ? payload.error : "delete playlist track");
      }
      setTracks((current) => current?.filter((track) => track.id !== songId) ?? current);
      setConfirmTrack(null);
      setToast({ kind: "success", text: "Música excluída com sucesso." });
    } catch (error) {
      console.error("Firestore track deletion failed:", error);
      setToast({ kind: "error", text: "Erro ao excluir a música. Tente novamente." });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card title={playlistTitle} subtitle={currentTracks ? `${currentTracks.length} música${currentTracks.length === 1 ? "" : "s"}` : "carregando"}>
      {toast && (
        <p
          role={toast.kind === "error" ? "alert" : "status"}
          className={`mb-3 rounded-xl px-3 py-2 text-sm ${toast.kind === "error" ? "bg-nao-soft text-nao" : "bg-sim-soft text-sim"}`}
        >
          {toast.text}
        </p>
      )}
      {failed ? (
        <p role="alert" className="text-sm text-danger">Não foi possível carregar a playlist.</p>
      ) : loading || currentTracks == null ? (
        <p className="text-sm text-ink-mute">Carregando músicas…</p>
      ) : currentTracks.length === 0 ? (
        <Empty>Nenhuma música foi criada para este paciente ainda.</Empty>
      ) : (
        <ul className="flex max-h-[34rem] flex-col gap-3 overflow-y-auto pr-1">
          {currentTracks.map((track) => (
            <li key={track.id} className="rounded-2xl border border-line bg-cream/60 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{track.title}</p>
                  {track.genre && (
                    <span className="mt-1 inline-flex rounded-full border border-line bg-card px-2 py-0.5 text-xs text-ink-soft">
                      {track.genre}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <span className="rounded-full bg-talvez-soft px-2.5 py-1 text-xs font-medium text-talvez">
                    {PERIOD_LABEL[track.period]}
                  </span>
                  {canDeleteTrack && (
                    <button
                      type="button"
                      onClick={() => {
                        setToast(null);
                        setConfirmTrack(track);
                      }}
                      className="rounded-md p-1.5 text-ink-mute transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30"
                      aria-label="Deletar música"
                      title="Deletar música"
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M8 6V4h8v2" />
                        <path d="M19 6l-1 14H6L5 6" />
                        <path d="M10 11v5M14 11v5" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-2 text-xs text-ink-mute">{formattedDate(track.createdAt)}</p>
              <audio controls preload="metadata" className="mt-3 w-full" aria-label={`Reproduzir ${track.title}`}>
                {/* Fase 5.4B: era `track.audioUrl`, um Firebase download URL
                    durável no HTML da página. Agora o áudio vem pela rota
                    autenticada, pelo id da faixa. */}
                <source
                  src={`/api/patients/${patientId}/playlist/audio?id=${encodeURIComponent(track.id)}`}
                  type="audio/mpeg"
                />
                Seu navegador não suporta a reprodução de áudio.
              </audio>
            </li>
          ))}
        </ul>
      )}

      {confirmTrack && (
        <ModalShell
          role="alertdialog"
          onClose={() => setConfirmTrack(null)}
          labelledBy="playlist-delete-title"
          disableDismiss={deleting}
          className="max-w-md"
        >
            <h2 id="playlist-delete-title" className="text-lg font-semibold text-ink">Excluir música?</h2>
            <p className="mt-2 text-sm leading-6 text-ink-soft">
              Tem certeza de que deseja deletar a música &quot;{confirmTrack.title}&quot; para sempre? Esta ação não poderá ser desfeita.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmTrack(null)}
                disabled={deleting}
                className="min-h-10 rounded-xl border border-line bg-card px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-cream disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void deleteTrack()}
                disabled={deleting}
                className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-nao px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleting && <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
                Sim, excluir
              </button>
            </div>
        </ModalShell>
      )}
    </Card>
  );
}
