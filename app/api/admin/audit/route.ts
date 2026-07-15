import { listAudit } from "@/lib/access";
import { requireAdmin } from "@/lib/auth";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const events = await listAudit(100);
  return Response.json({ events });
}
