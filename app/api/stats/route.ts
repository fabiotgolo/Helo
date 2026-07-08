import { db } from "@/lib/db";

export type Period = "hoje" | "semana" | "mes" | "ano" | "vitalicio";

function since(period: Period): string {
  switch (period) {
    case "hoje":
      return "datetime('now','localtime','start of day')";
    case "semana":
      return "datetime('now','localtime','-7 days')";
    case "mes":
      return "datetime('now','localtime','start of month')";
    case "ano":
      return "datetime('now','localtime','start of year')";
    case "vitalicio":
      return "'1900-01-01'";
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const period = (url.searchParams.get("period") ?? "semana") as Period;
  const cut = since(period);

  const one = <T>(sql: string): T =>
    db.prepare(sql).get() as T;
  const all = <T>(sql: string): T[] =>
    db.prepare(sql).all() as T[];

  const totals = {
    mensagensConfirmadas: one<{ n: number }>(
      `SELECT COUNT(*) n FROM messages WHERE status='confirmada' AND ts >= ${cut}`
    ).n,
    mensagensDescartadas: one<{ n: number }>(
      `SELECT COUNT(*) n FROM messages WHERE status='descartada' AND ts >= ${cut}`
    ).n,
    gestos: one<{ n: number }>(
      `SELECT COUNT(*) n FROM events WHERE type='gesto' AND ts >= ${cut}`
    ).n,
    gestosIncertos: one<{ n: number }>(
      `SELECT COUNT(*) n FROM events WHERE type='gesto_incerto' AND ts >= ${cut}`
    ).n,
    pausas: one<{ n: number }>(
      `SELECT COUNT(*) n FROM events WHERE type='pausa' AND ts >= ${cut}`
    ).n,
    reformulacoes: one<{ n: number }>(
      `SELECT COUNT(*) n FROM events WHERE type='reformulacao' AND ts >= ${cut}`
    ).n,
    sessoes: one<{ n: number }>(
      `SELECT COUNT(*) n FROM sessions WHERE started_at >= ${cut}`
    ).n,
    tempoMedioRespostaMs: one<{ v: number | null }>(
      `SELECT AVG(response_ms) v FROM events WHERE type='gesto' AND response_ms IS NOT NULL AND ts >= ${cut}`
    ).v,
  };

  const gestosPorTipo = all<{ gesture: string; n: number }>(
    `SELECT gesture, COUNT(*) n FROM events
     WHERE type='gesto' AND gesture IS NOT NULL AND ts >= ${cut}
     GROUP BY gesture`
  );

  const porDia = all<{ dia: string; gestos: number; mensagens: number }>(
    `SELECT dia, SUM(gestos) gestos, SUM(mensagens) mensagens FROM (
       SELECT date(ts) dia, COUNT(*) gestos, 0 mensagens FROM events
         WHERE type='gesto' AND ts >= ${cut} GROUP BY date(ts)
       UNION ALL
       SELECT date(ts) dia, 0, COUNT(*) FROM messages
         WHERE status='confirmada' AND ts >= ${cut} GROUP BY date(ts)
     ) GROUP BY dia ORDER BY dia`
  );

  const porCategoria = all<{ category: string; n: number }>(
    `SELECT COALESCE(category, 'outros') category, COUNT(*) n FROM messages
     WHERE status='confirmada' AND ts >= ${cut}
     GROUP BY category ORDER BY n DESC`
  );

  // Relatos de dor — quando o paciente confirmou uma mensagem da categoria dor
  const relatosDor = all<{ ts: string; text: string }>(
    `SELECT ts, text FROM messages
     WHERE status='confirmada' AND category='dor' AND ts >= ${cut}
     ORDER BY ts DESC LIMIT 100`
  );

  const mensagens = all<{
    id: number;
    ts: string;
    text: string;
    category: string | null;
    sensitive: number;
    status: string;
  }>(
    `SELECT id, ts, text, category, sensitive, status FROM messages
     WHERE ts >= ${cut} ORDER BY ts DESC LIMIT 200`
  );

  const porHora = all<{ hora: string; n: number }>(
    `SELECT strftime('%H', ts) hora, COUNT(*) n FROM events
     WHERE type='gesto' AND ts >= ${cut} GROUP BY hora ORDER BY hora`
  );

  return Response.json({
    period,
    geradoEm: new Date().toISOString(),
    totals,
    gestosPorTipo,
    porDia,
    porCategoria,
    porHora,
    relatosDor,
    mensagens,
  });
}
