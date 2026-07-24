"use client";

import { useEffect, useState } from "react";
import { Card, Empty } from "@/components/dashboard-ui";
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

export function PatientPlaylistWidget({ patientId }: { patientId: number }) {
  const [tracks, setTracks] = useState<PatientPlaylistTrack[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stale = false;
    setTracks(null);
    setFailed(false);
    void fetch(`/api/patients/${patientId}/playlist`)
      .then(async (response) => {
        if (!response.ok) throw new Error("playlist");
        return (await response.json()) as { tracks: PatientPlaylistTrack[] };
      })
      .then((data) => {
        if (!stale) setTracks(data.tracks);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [patientId]);

  return (
    <Card title="Playlist da Helo" subtitle={tracks ? `${tracks.length} música${tracks.length === 1 ? "" : "s"}` : "carregando"}>
      {failed ? (
        <p role="alert" className="text-sm text-danger">Não foi possível carregar a playlist.</p>
      ) : tracks == null ? (
        <p className="text-sm text-ink-mute">Carregando músicas…</p>
      ) : tracks.length === 0 ? (
        <Empty>Nenhuma música foi criada para este paciente ainda.</Empty>
      ) : (
        <ul className="flex max-h-[34rem] flex-col gap-3 overflow-y-auto pr-1">
          {tracks.map((track) => (
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
                <span className="rounded-full bg-talvez-soft px-2.5 py-1 text-xs font-medium text-talvez">
                  {PERIOD_LABEL[track.period]}
                </span>
              </div>
              <p className="mt-2 text-xs text-ink-mute">{formattedDate(track.createdAt)}</p>
              <audio controls preload="metadata" className="mt-3 w-full" aria-label={`Reproduzir ${track.title}`}>
                <source src={track.audioUrl} type="audio/mpeg" />
                Seu navegador não suporta a reprodução de áudio.
              </audio>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
