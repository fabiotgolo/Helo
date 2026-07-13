import { requirePatientAccess } from "@/lib/auth";
import { hasPermission } from "@/lib/access-types";
import { logAudit } from "@/lib/access";
import {
  deleteMedia,
  getMedia,
  listMedia,
  saveMedia,
} from "@/lib/activity-store";

// Biblioteca de mídia interna do paciente (fotos familiares — conteúdo
// sensível). Nada aqui é público: os bytes só saem por esta rota, que
// exige vínculo ativo com o patientId. Não existe listagem sem vínculo,
// nem URL que funcione sem a sessão autenticada.

/** Enviar/gerenciar mídia acompanha quem pode montar Atividades. */
function canManageMedia(auth: {
  user: { role: string };
  link: Parameters<typeof hasPermission>[0];
}): boolean {
  return (
    auth.user.role === "admin" ||
    hasPermission(auth.link, "createActivities") ||
    hasPermission(auth.link, "editActivities")
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const id = url.searchParams.get("id");
  // Vínculo ativo é o mínimo para VER a mídia usada nas Atividades do
  // paciente (mesma régua da leitura de itens de modo).
  const auth = await requirePatientAccess(request, patientId);
  if (auth instanceof Response) return auth;

  if (!id) {
    // Listagem da biblioteca — só para quem monta Atividades.
    if (!canManageMedia(auth)) {
      return Response.json({ error: "acesso negado" }, { status: 403 });
    }
    return Response.json({ media: await listMedia(patientId) });
  }

  const media = await getMedia(patientId, id);
  if (!media) {
    return Response.json({ error: "mídia não encontrada" }, { status: 404 });
  }
  return new Response(new Uint8Array(media.data), {
    headers: {
      "Content-Type": media.meta.contentType,
      "Content-Length": String(media.data.length),
      // privado: nunca cacheável por proxies compartilhados
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="${encodeURIComponent(media.meta.name)}"`,
    },
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    patientId?: number;
    name?: string;
    contentType?: string;
    dataBase64?: string;
  };
  const patientId = Number(body.patientId);
  const auth = await requirePatientAccess(request, patientId);
  if (auth instanceof Response) return auth;
  if (!canManageMedia(auth)) {
    return Response.json(
      { error: "permissão necessária: createActivities ou editActivities" },
      { status: 403 }
    );
  }
  try {
    const media = await saveMedia(patientId, body, { id: auth.user.id });
    void logAudit({
      userId: auth.user.id,
      userName: auth.user.name,
      patientId,
      action: "media.upload",
      entityType: "media",
      entityId: media.id,
      // auditoria registra o fato, nunca o conteúdo
      metadata: { name: media.name, size: String(media.size) },
    });
    return Response.json({ media });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const body = (await request.json()) as { patientId?: number; id?: string };
  const patientId = Number(body.patientId);
  if (!body.id) {
    return Response.json({ error: "patientId e id obrigatórios" }, { status: 400 });
  }
  const auth = await requirePatientAccess(request, patientId);
  if (auth instanceof Response) return auth;
  if (!canManageMedia(auth)) {
    return Response.json(
      { error: "permissão necessária: createActivities ou editActivities" },
      { status: 403 }
    );
  }
  await deleteMedia(patientId, body.id);
  void logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId,
    action: "media.delete",
    entityType: "media",
    entityId: body.id,
  });
  return Response.json({ ok: true });
}
