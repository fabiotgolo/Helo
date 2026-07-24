import { requirePatientAccess } from "@/lib/auth";
import { findPlaylistTracks, listPatientPlaylist } from "@/lib/playlist";

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
  return Response.json({ tracks });
}
