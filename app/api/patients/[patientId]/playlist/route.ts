import { requirePatientAccess } from "@/lib/auth";
import { hasPermission } from "@/lib/access-types";
import { logAudit } from "@/lib/access";
import { firestore } from "@/lib/firestore";
import { findPlaylistTracks, listPatientPlaylist } from "@/lib/playlist";
import { getStorage } from "firebase-admin/storage";

function canManagePlaylist(auth: {
  user: { role: string };
  link: Parameters<typeof hasPermission>[0];
}): boolean {
  return auth.user.role === "admin" || hasPermission(auth.link, "canDeletePlaylistSongs");
}

/** Obtém apenas caminhos da pasta de músicas do bucket desta aplicação. */
type StorageTarget = { bucket?: string; path: string };

function storageTargetFromUrl(value: string): StorageTarget | null {
  try {
    const url = new URL(value);
    if (url.hostname === "firebasestorage.googleapis.com") {
      const segments = url.pathname.split("/").filter(Boolean);
      const bucketIndex = segments.indexOf("b");
      const objectIndex = segments.indexOf("o");
      const bucket = bucketIndex >= 0 ? segments[bucketIndex + 1] : "";
      const path = objectIndex >= 0
        ? decodeURIComponent(segments.slice(objectIndex + 1).join("/"))
        : "";
      return bucket && path.startsWith("musics/") ? { bucket, path } : null;
    }
    if (url.hostname === "storage.googleapis.com") {
      const segments = url.pathname.split("/").filter(Boolean);
      // URLs deste bucket têm o bucket como primeiro segmento.
      const path = decodeURIComponent(segments.slice(1).join("/"));
      return segments[0] && path.startsWith("musics/")
        ? { bucket: segments[0], path }
        : null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ patientId: string }> }
) {
  const { patientId: rawPatientId } = await params;
  const patientId = Number(rawPatientId);
  if (!patientId || Number.isNaN(patientId)) {
    return Response.json({ error: "patientId inválido" }, { status: 400 });
  }
  const auth = await requirePatientAccess(request, patientId, "viewMetrics");
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const tracks = findPlaylistTracks(await listPatientPlaylist(patientId), {
    dateReference: url.searchParams.get("dateReference") ?? undefined,
    period: url.searchParams.get("period") ?? undefined,
    genre: url.searchParams.get("genre") ?? undefined,
  });
  return Response.json({ tracks, canManage: canManagePlaylist(auth) });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ patientId: string }> }
) {
  const { patientId: rawPatientId } = await params;
  if (!rawPatientId?.trim()) {
    console.error("[PLAYLIST] patientId ausente na exclusão de música");
    return Response.json({ error: "patientId obrigatório" }, { status: 400 });
  }
  const patientId = Number(rawPatientId);
  if (!patientId || Number.isNaN(patientId)) {
    return Response.json({ error: "patientId inválido" }, { status: 400 });
  }

  const auth = await requirePatientAccess(request, patientId);
  if (auth instanceof Response) return auth;
  if (!canManagePlaylist(auth)) {
    return Response.json({ error: "permissão necessária: canDeletePlaylistSongs" }, { status: 403 });
  }

  let body: { id?: string };
  try {
    body = (await request.json()) as { id?: string };
  } catch {
    return Response.json({ error: "corpo inválido" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(id)) {
    return Response.json({ error: "id obrigatório" }, { status: 400 });
  }

  const trackRef = firestore
    .collection("patients")
    .doc(String(patientId))
    .collection("playlist")
    .doc(id);
  const track = await trackRef.get();
  if (!track.exists) return Response.json({ error: "música não encontrada" }, { status: 404 });

  const data = track.data() ?? {};
  const storedPath = typeof data.storagePath === "string" ? data.storagePath.trim() : "";
  const targetFromUrl = storageTargetFromUrl(typeof data.audioUrl === "string" ? data.audioUrl : "");
  const storageTarget = storedPath.startsWith("musics/")
    ? { path: storedPath, bucket: targetFromUrl?.bucket }
    : targetFromUrl;

  if (storageTarget) {
    try {
      // App Hosting não configura sempre um bucket padrão no Admin SDK. O
      // bucket é extraído da URL pública gerada pela Function, garantindo que
      // a exclusão atinja o mesmo arquivo — inclusive no bucket moderno
      // *.firebasestorage.app.
      const fallbackBucket = process.env.FIREBASE_STORAGE_BUCKET ?? "helo-app-7fbf8.firebasestorage.app";
      await getStorage()
        .bucket(storageTarget.bucket ?? fallbackBucket)
        .file(storageTarget.path)
        .delete({ ignoreNotFound: true });
    } catch (error) {
      // O documento do Firestore é a fonte de verdade da playlist. Um MP3
      // ausente, regra de CORS ou falha transitória do Storage não pode
      // impedir que o cuidador remova uma faixa do histórico.
      console.warn(
        "Storage audio file not found or already removed, proceeding with Firestore document deletion.",
        { error, patientId, songId: id, storagePath: storageTarget.path }
      );
    }
  } else {
    console.warn(
      "Storage audio file not found or already removed, proceeding with Firestore document deletion.",
      { patientId, songId: id, reason: "caminho do áudio indisponível" }
    );
  }

  try {
    await trackRef.delete();
  } catch (error) {
    console.error("Firestore track deletion failed:", error, { patientId, songId: id });
    return Response.json({ error: "não foi possível excluir a música" }, { status: 500 });
  }

  void logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId,
    action: "playlist.delete",
    entityType: "playlist",
    entityId: id,
    metadata: { title: String(data.title ?? "") },
  });
  return Response.json({ ok: true });
}
