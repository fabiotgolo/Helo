import { firestore } from "@/lib/firestore";
import { caminhoDeMusicaEhValido } from "@/lib/midia-privada";

export type PlaylistPeriod = "manhã" | "tarde" | "noite";

// ——— A faixa deixou de carregar um endereço (Fase 5.4B / A-12, R-14) ———
//
// `audioUrl` era um Firebase download URL: ia para o Firestore, de lá para o
// navegador (`<source src={track.audioUrl}>`) e, no caminho da música gerada
// por voz, de lá para dentro do resultado da tool — ou seja, para a ElevenLabs,
// onde ficava na transcrição da conversa. Um endereço sem prazo, que funciona
// sem sessão, guardado em três lugares diferentes.
//
// Ele saiu do tipo. O que o cliente recebe é o `id` da faixa, que já recebia, e
// com ele pede os bytes à rota autenticada. O caminho real fica em
// `storagePath` e não atravessa a fronteira do servidor.
export type PatientPlaylistTrack = {
  id: string;
  title: string;
  prompt: string;
  genre: string;
  createdAt: string;
  dateKey: string;
  period: PlaylistPeriod;
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

/**
 * O caminho no Storage escondido dentro de uma URL pública legada.
 *
 * Registros antigos guardavam só `audioUrl`. A URL não é usada para BUSCAR
 * nada — ela é lida como se fosse um endereço interno, para descobrir de qual
 * objeto ela falava. Vivia na rota de exclusão da playlist; subiu para cá
 * porque a reprodução passou a precisar da mesma tradução, e duas cópias dessa
 * lógica seriam duas chances de discordarem.
 */
export function caminhoNaUrlLegada(value: string): { bucket?: string; path: string } | null {
  try {
    const url = new URL(value);
    if (url.hostname === "firebasestorage.googleapis.com") {
      const segments = url.pathname.split("/").filter(Boolean);
      const bucketIndex = segments.indexOf("b");
      const objectIndex = segments.indexOf("o");
      const bucket = bucketIndex >= 0 ? segments[bucketIndex + 1] : "";
      const path = objectIndex >= 0 ? decodeURIComponent(segments.slice(objectIndex + 1).join("/")) : "";
      return bucket && path ? { bucket, path } : null;
    }
    if (url.hostname === "storage.googleapis.com") {
      const segments = url.pathname.split("/").filter(Boolean);
      // URLs deste bucket têm o bucket como primeiro segmento.
      const path = decodeURIComponent(segments.slice(1).join("/"));
      return segments[0] && path ? { bucket: segments[0], path } : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Onde estão os bytes desta faixa — resolvido pelo servidor, a partir do id.
 *
 * Aceita o `storagePath` novo (`patients/{id}/musics/…`), o legado (`musics/…`,
 * o namespace global que a A-12 abandonou) e, para registros ainda mais
 * antigos, o caminho lido de dentro da `audioUrl` guardada.
 *
 * Ler o legado é deliberado: o documento já vive sob o paciente, então quem
 * chega até ele já passou pela autorização, e recusar só tiraria a música de
 * quem tem direito a ela — sem tirar nada de quem tem a URL antiga. Quem mata
 * a URL antiga é a migração, não esta recusa.
 */
export function caminhoDaFaixa(
  patientId: number,
  value: FirebaseFirestore.DocumentData
): string | null {
  const candidato =
    readString(value.storagePath) ||
    caminhoNaUrlLegada(readString(value.audioUrl))?.path ||
    "";
  if (!candidato || !caminhoDeMusicaEhValido(candidato, patientId)) return null;
  return candidato;
}

export function toPlaylistTrack(id: string, value: FirebaseFirestore.DocumentData): PatientPlaylistTrack | null {
  const title = readString(value.title);
  const prompt = readString(value.prompt);
  const genre = readString(value.genre);
  const createdAt = readString(value.createdAt);
  const dateKey = readString(value.dateKey) || (createdAt ? brazilDateKey(new Date(createdAt)) : "");
  const period = readString(value.period);
  // Uma faixa vale se existe de onde buscar o áudio — pelo campo novo, pelo
  // legado, ou pelo caminho lido de dentro da URL antiga.
  const temAudio = Boolean(
    readString(value.storagePath) || caminhoNaUrlLegada(readString(value.audioUrl))
  );
  if (!title || !prompt || !temAudio || !createdAt || !dateKey || !isPeriod(period)) return null;
  return { id, title, prompt, genre, createdAt, dateKey, period };
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
