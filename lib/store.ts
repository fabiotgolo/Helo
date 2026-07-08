import { firestore } from "@/lib/firestore";
import type { HeloEvent, HeloMessage } from "@/lib/types";

// Camada de acesso a dados da Helo sobre o Firestore.
// Substitui o SQLite (better-sqlite3), mantendo o mesmo contrato das rotas.
// IDs numéricos de sessão e pessoa são derivados de Date.now() — o cliente
// guarda e reutiliza esse número; o volume (um paciente) torna colisão irreal.

const SP_TZ = "America/Sao_Paulo";

const col = {
  sessions: () => firestore.collection("sessions"),
  events: () => firestore.collection("events"),
  messages: () => firestore.collection("messages"),
  people: () => firestore.collection("people"),
  settings: () => firestore.collection("settings"),
};

// ---------- Sessões ----------

export async function createSession(
  mode: string,
  operator?: string
): Promise<number> {
  const id = Date.now();
  await col.sessions().doc(String(id)).set({
    startedAt: new Date().toISOString(),
    endedAt: null,
    operator: operator ?? null,
    mode: mode ?? "conversa",
  });
  return id;
}

export async function endSession(id: number): Promise<void> {
  await col
    .sessions()
    .doc(String(id))
    .set({ endedAt: new Date().toISOString() }, { merge: true });
}

// ---------- Eventos ----------

export async function insertEvent(e: HeloEvent): Promise<void> {
  await col.events().add({
    sessionId: e.sessionId ?? null,
    type: e.type,
    category: e.category ?? null,
    question: e.question ?? null,
    options: e.options ?? null,
    gesture: e.gesture ?? null,
    detail: e.detail ?? null,
    responseMs: e.responseMs ?? null,
    ts: new Date().toISOString(),
  });
}

// ---------- Mensagens ----------

export async function insertMessage(m: HeloMessage): Promise<string> {
  const ref = await col.messages().add({
    sessionId: m.sessionId ?? null,
    text: m.text,
    category: m.category ?? null,
    sensitive: m.sensitive ? 1 : 0,
    status: m.status,
    confirmations: m.confirmations ?? 1,
    ts: new Date().toISOString(),
  });
  return ref.id;
}

// ---------- Pessoas ----------

export type Person = { id: number; name: string; relation: string | null };

export async function listPeople(): Promise<Person[]> {
  const snap = await col.people().where("active", "==", 1).get();
  return snap.docs
    .map((d) => {
      const v = d.data();
      return {
        id: Number(d.id),
        name: v.name as string,
        relation: (v.relation ?? null) as string | null,
      };
    })
    .sort((a, b) => a.id - b.id);
}

export async function addPerson(
  name: string,
  relation?: string | null
): Promise<number> {
  const id = Date.now();
  await col.people().doc(String(id)).set({
    name,
    relation: relation?.trim() || null,
    active: 1,
    createdAt: new Date().toISOString(),
  });
  return id;
}

export async function deactivatePerson(id: number): Promise<void> {
  await col.people().doc(String(id)).set({ active: 0 }, { merge: true });
}

// ---------- Configurações ----------

export async function getSettings(): Promise<Record<string, string>> {
  const snap = await col.settings().get();
  const out: Record<string, string> = {};
  snap.docs.forEach((d) => {
    const v = d.data().value;
    if (v != null) out[d.id] = String(v);
  });
  return out;
}

export async function setSettings(updates: Record<string, string>): Promise<void> {
  const batch = firestore.batch();
  for (const [key, value] of Object.entries(updates)) {
    batch.set(col.settings().doc(key), { value }, { merge: true });
  }
  await batch.commit();
}

export async function getSetting(key: string): Promise<string | undefined> {
  const doc = await col.settings().doc(key).get();
  const v = doc.exists ? doc.data()?.value : undefined;
  return v != null ? String(v) : undefined;
}

// ---------- Estatísticas (dashboard) ----------
// O Firestore não faz GROUP BY / date bucketing. Como o volume é pequeno,
// lemos os documentos do período e agregamos em memória, no fuso de São Paulo
// (equivalente ao 'localtime' que o SQLite usava).

export type Period = "hoje" | "semana" | "mes" | "ano" | "vitalicio";

type SpParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

function spParts(d: Date): SpParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: SP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(
    fmt.formatToParts(d).map((x) => [x.type, x.value])
  ) as unknown as SpParts;
  return p;
}

// Instante UTC correspondente à meia-noite local (São Paulo) de uma data.
function spMidnightInstant(now: Date, y: number, m: number, d: number): number {
  const p = spParts(now);
  const offset =
    Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) -
    now.getTime();
  return Date.UTC(y, m - 1, d, 0, 0, 0) - offset;
}

function cutoffIso(period: Period): string {
  const now = new Date();
  const p = spParts(now);
  let instant: number;
  switch (period) {
    case "hoje":
      instant = spMidnightInstant(now, +p.year, +p.month, +p.day);
      break;
    case "semana":
      instant = now.getTime() - 7 * 24 * 60 * 60 * 1000;
      break;
    case "mes":
      instant = spMidnightInstant(now, +p.year, +p.month, 1);
      break;
    case "ano":
      instant = spMidnightInstant(now, +p.year, 1, 1);
      break;
    case "vitalicio":
      instant = 0;
      break;
  }
  return new Date(instant).toISOString();
}

function localTs(iso: string): string {
  const p = spParts(new Date(iso));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function localDay(iso: string): string {
  const p = spParts(new Date(iso));
  return `${p.year}-${p.month}-${p.day}`;
}
function localHour(iso: string): string {
  return spParts(new Date(iso)).hour;
}

type EventRow = {
  type: string;
  gesture: string | null;
  responseMs: number | null;
  ts: string;
};
type MessageRow = {
  id: string;
  ts: string;
  text: string;
  category: string | null;
  sensitive: number;
  status: string;
};

export async function getStats(period: Period) {
  const cut = cutoffIso(period);

  const [eventsSnap, messagesSnap, sessionsSnap] = await Promise.all([
    col.events().where("ts", ">=", cut).get(),
    col.messages().where("ts", ">=", cut).get(),
    col.sessions().where("startedAt", ">=", cut).get(),
  ]);

  const events: EventRow[] = eventsSnap.docs.map((d) => {
    const v = d.data();
    return {
      type: v.type as string,
      gesture: (v.gesture ?? null) as string | null,
      responseMs: (v.responseMs ?? null) as number | null,
      ts: v.ts as string,
    };
  });

  const messages: MessageRow[] = messagesSnap.docs.map((d) => {
    const v = d.data();
    return {
      id: d.id,
      ts: v.ts as string,
      text: v.text as string,
      category: (v.category ?? null) as string | null,
      sensitive: Number(v.sensitive ?? 0),
      status: v.status as string,
    };
  });

  const countEvt = (t: string) => events.filter((e) => e.type === t).length;
  const confirmadas = messages.filter((m) => m.status === "confirmada");

  const gestoResp = events.filter(
    (e) => e.type === "gesto" && e.responseMs != null
  );
  const tempoMedioRespostaMs =
    gestoResp.length > 0
      ? gestoResp.reduce((s, e) => s + (e.responseMs as number), 0) /
        gestoResp.length
      : null;

  const totals = {
    mensagensConfirmadas: confirmadas.length,
    mensagensDescartadas: messages.filter((m) => m.status === "descartada")
      .length,
    gestos: countEvt("gesto"),
    gestosIncertos: countEvt("gesto_incerto"),
    pausas: countEvt("pausa"),
    reformulacoes: countEvt("reformulacao"),
    sessoes: sessionsSnap.size,
    tempoMedioRespostaMs,
  };

  // gestos por tipo
  const gestoMap = new Map<string, number>();
  for (const e of events) {
    if (e.type === "gesto" && e.gesture) {
      gestoMap.set(e.gesture, (gestoMap.get(e.gesture) ?? 0) + 1);
    }
  }
  const gestosPorTipo = [...gestoMap.entries()].map(([gesture, n]) => ({
    gesture,
    n,
  }));

  // por dia (gestos + mensagens confirmadas)
  const diaMap = new Map<string, { gestos: number; mensagens: number }>();
  const bumpDia = (dia: string, key: "gestos" | "mensagens") => {
    const cur = diaMap.get(dia) ?? { gestos: 0, mensagens: 0 };
    cur[key] += 1;
    diaMap.set(dia, cur);
  };
  for (const e of events) if (e.type === "gesto") bumpDia(localDay(e.ts), "gestos");
  for (const m of confirmadas) bumpDia(localDay(m.ts), "mensagens");
  const porDia = [...diaMap.entries()]
    .map(([dia, v]) => ({ dia, ...v }))
    .sort((a, b) => a.dia.localeCompare(b.dia));

  // por categoria (mensagens confirmadas)
  const catMap = new Map<string, number>();
  for (const m of confirmadas) {
    const c = m.category ?? "outros";
    catMap.set(c, (catMap.get(c) ?? 0) + 1);
  }
  const porCategoria = [...catMap.entries()]
    .map(([category, n]) => ({ category, n }))
    .sort((a, b) => b.n - a.n);

  // por hora (gestos)
  const horaMap = new Map<string, number>();
  for (const e of events) {
    if (e.type === "gesto") {
      const h = localHour(e.ts);
      horaMap.set(h, (horaMap.get(h) ?? 0) + 1);
    }
  }
  const porHora = [...horaMap.entries()]
    .map(([hora, n]) => ({ hora, n }))
    .sort((a, b) => a.hora.localeCompare(b.hora));

  // relatos de dor
  const relatosDor = confirmadas
    .filter((m) => m.category === "dor")
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 100)
    .map((m) => ({ ts: localTs(m.ts), text: m.text }));

  // mensagens recentes
  const mensagens = [...messages]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 200)
    .map((m) => ({
      id: m.id,
      ts: localTs(m.ts),
      text: m.text,
      category: m.category,
      sensitive: m.sensitive,
      status: m.status,
    }));

  return {
    period,
    geradoEm: new Date().toISOString(),
    totals,
    gestosPorTipo,
    porDia,
    porCategoria,
    porHora,
    relatosDor,
    mensagens,
  };
}
