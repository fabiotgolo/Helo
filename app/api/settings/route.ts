import { getSettings, setSettings } from "@/lib/store";

export async function GET() {
  const settings = await getSettings();
  return Response.json(settings);
}

export async function POST(request: Request) {
  const updates = (await request.json()) as Record<string, string>;
  await setSettings(updates);
  return Response.json({ ok: true });
}
