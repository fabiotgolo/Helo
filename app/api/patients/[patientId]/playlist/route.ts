import { requirePatientAccess } from "@/lib/auth";
import { hasPermission } from "@/lib/access-types";
import { logAudit } from "@/lib/access";
import { firestore } from "@/lib/firestore";
import { caminhoDaFaixa, findPlaylistTracks, listPatientPlaylist } from "@/lib/playlist";
import { apagaObjeto } from "@/lib/midia-privada";

function canManagePlaylist(auth: {
  user: { role: string };
  link: Parameters<typeof hasPermission>[0];
}): boolean {
  return auth.user.role === "admin" || hasPermission(auth.link, "canDeletePlaylistSongs");
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
  // O caminho vem da MESMA função que a reprodução usa (`caminhoDaFaixa`): o
  // arquivo que o cuidador ouve é o arquivo que a exclusão apaga, por
  // construção. A resolução do bucket também deixou de ser adivinhada aqui —
  // ela mora em `lib/midia-privada.ts`, num lugar só.
  const caminho = caminhoDaFaixa(patientId, data);
  if (!caminho) {
    console.warn("[PLAYLIST] faixa sem caminho de áudio resolvível", { songId: id });
  } else if (!(await apagaObjeto(caminho))) {
    // O documento do Firestore é a fonte de verdade da playlist. Um MP3
    // ausente ou uma falha transitória do Storage não pode impedir que o
    // cuidador remova uma faixa do histórico. O log leva o id da faixa e mais
    // nada: nem caminho, nem título, nem o erro do provedor.
    console.warn("[PLAYLIST] áudio não removido do Storage", { songId: id });
  }

  try {
    await trackRef.delete();
  } catch {
    console.error("[PLAYLIST] exclusão do documento falhou", { songId: id });
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
