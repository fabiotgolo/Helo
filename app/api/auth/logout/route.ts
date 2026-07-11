import { destroyAuthSession } from "@/lib/access";
import { clearSessionCookieHeader, readSessionToken } from "@/lib/auth";

export async function POST(request: Request) {
  const token = readSessionToken(request);
  if (token) await destroyAuthSession(token);
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": clearSessionCookieHeader() } }
  );
}
