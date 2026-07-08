import { getStats, type Period } from "@/lib/store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const period = (url.searchParams.get("period") ?? "semana") as Period;
  const stats = await getStats(period);
  return Response.json(stats);
}
