import { getLink, logAudit } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { createFeedback, listFeedbackForUser } from "@/lib/feedback";
import { isFeedbackType, type FeedbackMetadata } from "@/lib/feedback-types";
import { APP_VERSION } from "@/lib/version";

const MAX_TITLE = 140;
const MAX_DESCRIPTION = 5000;

function clientContext(request: Request, input: unknown): FeedbackMetadata {
  const viewport = input as { width?: unknown; height?: unknown } | undefined;
  const width = typeof viewport?.width === "number" ? Math.round(viewport.width) : null;
  const height = typeof viewport?.height === "number" ? Math.round(viewport.height) : null;
  const userAgent = request.headers.get("user-agent") ?? "";
  const browser = /Firefox/i.test(userAgent)
    ? "Firefox"
    : /Edg/i.test(userAgent)
      ? "Microsoft Edge"
      : /Chrome|CriOS/i.test(userAgent)
        ? "Chrome"
        : /Safari/i.test(userAgent)
          ? "Safari"
          : "Não identificado";
  const operatingSystem = /Windows/i.test(userAgent)
    ? "Windows"
    : /Android/i.test(userAgent)
      ? "Android"
      : /iPhone|iPad|iPod/i.test(userAgent)
        ? "iOS/iPadOS"
        : /Mac OS X/i.test(userAgent)
          ? "macOS"
          : /Linux/i.test(userAgent)
            ? "Linux"
            : null;
  return {
    browser,
    operatingSystem,
    viewport: width && height ? `${width}×${height}` : null,
  };
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  return Response.json({ requests: await listFeedbackForUser(auth.user) });
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  const body = (await request.json()) as {
    title?: unknown;
    description?: unknown;
    type?: unknown;
    patientId?: unknown;
    route?: unknown;
    viewport?: unknown;
  };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!title || !description || !isFeedbackType(body.type)) {
    return Response.json({ error: "título, descrição e tipo são obrigatórios" }, { status: 400 });
  }
  if (title.length > MAX_TITLE || description.length > MAX_DESCRIPTION) {
    return Response.json({ error: "a solicitação excede o tamanho permitido" }, { status: 400 });
  }
  const patientId =
    typeof body.patientId === "number" && Number.isInteger(body.patientId) && body.patientId > 0
      ? body.patientId
      : null;
  if (patientId != null && auth.user.role !== "admin" && !(await getLink(auth.user.id, patientId))) {
    return Response.json({ error: "sem vínculo com este paciente" }, { status: 403 });
  }
  const route =
    typeof body.route === "string" && body.route.startsWith("/")
      ? body.route.slice(0, 300)
      : "/feedback";
  const feedback = await createFeedback({
    user: auth.user,
    title,
    description,
    type: body.type,
    patientId,
    appVersion: APP_VERSION,
    route,
    metadata: body.type === "bug" ? clientContext(request, body.viewport) : null,
  });
  await logAudit({
    userId: auth.user.id,
    userName: auth.user.name,
    patientId,
    action: "feedback.create",
    entityType: "feedbackRequest",
    entityId: feedback.id,
    metadata: { type: feedback.type },
  });
  return Response.json({ feedback }, { status: 201 });
}
