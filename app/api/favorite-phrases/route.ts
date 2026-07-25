import { requirePatientAccess } from "@/lib/auth";
import { logAudit } from "@/lib/access";
import { createFavoritePhrase, deleteFavoritePhrase, listFavoritePhrases, updateFavoritePhrase } from "@/lib/favorite-phrases";

export async function GET(request: Request) {
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  const auth = await requirePatientAccess(request, patientId, "viewActivities");
  if (auth instanceof Response) return auth;
  return Response.json({ phrases: await listFavoritePhrases(patientId) });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { patientId?: number; text?: string; category?: string };
  const patientId = Number(body.patientId);
  const auth = await requirePatientAccess(request, patientId, "createActivities");
  if (auth instanceof Response) return auth;
  try {
    const phrase = await createFavoritePhrase(patientId, { text: body.text ?? "", category: body.category });
    void logAudit({
      userId: auth.user.id, userName: auth.user.name, patientId,
      action: "favorite_phrase.create", entityType: "favoritePhrase", entityId: phrase.id,
      metadata: { text: phrase.text },
    });
    return Response.json({ phrase }, { status: 201 });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as { patientId?: number; phraseId?: string; text?: string; category?: string };
  const patientId = Number(body.patientId);
  const auth = await requirePatientAccess(request, patientId, "editActivities");
  if (auth instanceof Response) return auth;
  try {
    const phrase = await updateFavoritePhrase(patientId, String(body.phraseId ?? ""), { text: body.text ?? "", category: body.category });
    void logAudit({
      userId: auth.user.id, userName: auth.user.name, patientId,
      action: "favorite_phrase.update", entityType: "favoritePhrase", entityId: phrase.id,
      metadata: { text: phrase.text },
    });
    return Response.json({ phrase });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const body = (await request.json()) as { patientId?: number; phraseId?: string };
  const patientId = Number(body.patientId);
  const auth = await requirePatientAccess(request, patientId, "deleteActivities");
  if (auth instanceof Response) return auth;
  try {
    const phraseId = String(body.phraseId ?? "");
    await deleteFavoritePhrase(patientId, phraseId);
    void logAudit({
      userId: auth.user.id, userName: auth.user.name, patientId,
      action: "favorite_phrase.delete", entityType: "favoritePhrase", entityId: phraseId,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
