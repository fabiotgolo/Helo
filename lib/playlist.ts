import { firestore } from "@/lib/firestore";

export type PlaylistPeriod = "manhã" | "tarde" | "noite";

export type PatientPlaylistTrack = {
  id: string;
  title: string;
  prompt: string;
  genre: string;
  audioUrl: string;
  createdAt: string;
  dateKey: string;
  period: PlaylistPeriod;
  /** Caminho interno no Storage; ausente em registros antigos. */
  storagePath?: string;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isPeriod(value: string): value is PlaylistPeriod {
  return value === "manhã" || value === "tarde" || value === "noite";
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function brazilDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function dateKeyFromReference(value: string): string | null {
  const reference = normalize(value);
  if (!reference) return null;
  const today = new Date();
  if (reference === "hoje") return brazilDateKey(today);
  if (reference === "ontem") return brazilDateKey(new Date(today.getTime() - 24 * 60 * 60 * 1000));
  const brazilMatch = reference.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brazilMatch) return `${brazilMatch[3]}-${brazilMatch[2]}-${brazilMatch[1]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(reference) ? reference : null;
}

export function toPlaylistTrack(id: string, value: FirebaseFirestore.DocumentData): PatientPlaylistTrack | null {
  const title = readString(value.title);
  const prompt = readString(value.prompt);
  const genre = readString(value.genre);
  const audioUrl = readString(value.audioUrl);
  const createdAt = readString(value.createdAt);
  const dateKey = readString(value.dateKey) || (createdAt ? brazilDateKey(new Date(createdAt)) : "");
  const period = readString(value.period);
  const storagePath = readString(value.storagePath);
  if (!title || !prompt || !audioUrl || !createdAt || !dateKey || !isPeriod(period)) return null;
  return {
    id,
    title,
    prompt,
    genre,
    audioUrl,
    createdAt,
    dateKey,
    period,
    ...(storagePath ? { storagePath } : {}),
  };
}

export async function listPatientPlaylist(patientId: number): Promise<PatientPlaylistTrack[]> {
  const snapshot = await firestore
    .collection("patients")
    .doc(String(patientId))
    .collection("playlist")
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  return snapshot.docs
    .map((doc) => toPlaylistTrack(doc.id, doc.data()))
    .filter((track): track is PatientPlaylistTrack => track != null);
}

export function findPlaylistTracks(
  tracks: PatientPlaylistTrack[],
  filters: { dateReference?: string; period?: string; genre?: string }
): PatientPlaylistTrack[] {
  const dateKey = dateKeyFromReference(filters.dateReference ?? "");
  const period = normalize(filters.period ?? "");
  const genre = normalize(filters.genre ?? "");
  return tracks.filter((track) => {
    if (dateKey && track.dateKey !== dateKey) return false;
    if (period && normalize(track.period) !== period) return false;
    if (genre && !normalize(track.genre).includes(genre) && !genre.includes(normalize(track.genre))) return false;
    return true;
  });
}
