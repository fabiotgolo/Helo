import { firestore } from "@/lib/firestore";
import type {
  HeloEvent,
  HeloItemMode,
  HeloMessage,
  ModeItem,
  ModeItemInput,
  Patient,
} from "@/lib/types";
import {
  DEFAULT_ITEMS,
  modeSpeakerRole,
  modeRequiresConfirmation,
  PATIENT_SETTING_KEYS,
} from "@/lib/defaults";

// Camada de acesso a dados da Helo sobre o Firestore.
// Substitui o SQLite (better-sqlite3), mantendo o mesmo contrato das rotas.
// IDs numéricos de sessão e pessoa são derivados de Date.now() — o cliente
// guarda e reutiliza esse número; o volume (poucos pacientes) torna colisão irreal.
//
// Isolamento por paciente: settings, people e items vivem em SUBCOLEÇÕES de
// patients/{id} — uma escrita nunca alcança outro paciente por construção.
// sessions/events/messages seguem globais (série histórica), carimbados com
// patientId.

const SP_TZ = "America/Sao_Paulo";

const col = {
  sessions: () => firestore.collection("sessions"),
  events: () => firestore.collection("events"),
  messages: () => firestore.collection("messages"),
  patients: () => firestore.collection("patients"),
  // Coleções legadas (fase de paciente único) — lidas apenas na migração.
  legacyPeople: () => firestore.collection("people"),
  legacySettings: () => firestore.collection("settings"),
};

const patientDoc = (patientId: number) =>
  col.patients().doc(String(patientId));
const sub = {
  settings: (pid: number) => patientDoc(pid).collection("settings"),
  people: (pid: number) => patientDoc(pid).collection("people"),
  items: (pid: number) => patientDoc(pid).collection("items"),
};

// ---------- Pacientes ----------

function toPatient(id: string, v: FirebaseFirestore.DocumentData): Patient {
  return {
    id: Number(id),
    name: (v.name as string) ?? "Paciente",
    active: v.active !== 0 && v.active !== false,
    createdAt: (v.createdAt as string) ?? "",
  };
}

export async function listPatients(includeInactive = false): Promise<Patient[]> {
  await ensureMigrated();
  const snap = await col.patients().get();
  return snap.docs
    .map((d) => toPatient(d.id, d.data()))
    .filter((p) => includeInactive || p.active)
    .sort((a, b) => a.id - b.id);
}

export async function getPatient(id: number): Promise<Patient | null> {
  const doc = await patientDoc(id).get();
  return doc.exists ? toPatient(doc.id, doc.data()!) : null;
}

/**
 * Exclusão definitiva (Admin, com confirmação reforçada na UI): remove o
 * perfil e as subcoleções do paciente. A série histórica global
 * (sessions/events/messages) é preservada para auditoria — carimbada com o
 * patientId, deixa de ser alcançável sem o perfil.
 */
export async function hardDeletePatient(id: number): Promise<void> {
  for (const subCol of [sub.settings(id), sub.people(id), sub.items(id)]) {
    const snap = await subCol.get();
    const batch = firestore.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await patientDoc(id).delete();
}

export async function createPatient(name: string): Promise<Patient> {
  const id = Date.now();
  const patient: Patient = {
    id,
    name: name.trim() || "Paciente",
    active: true,
    createdAt: new Date().toISOString(),
  };
  await patientDoc(id).set({
    name: patient.name,
    active: 1,
    createdAt: patient.createdAt,
  });
  // Cópia inicial do conteúdo padrão — a partir daqui, tudo é do paciente.
  await Promise.all([
    seedDefaults(id, "rotina"),
    seedDefaults(id, "emergencia"),
    seedDefaults(id, "conversa"),
    setPatientSettings(id, { [PATIENT_SETTING_KEYS.name]: patient.name }),
  ]);
  return patient;
}

export async function updatePatient(
  id: number,
  updates: { name?: string; active?: boolean }
): Promise<void> {
  const data: Record<string, unknown> = {};
  if (updates.name?.trim()) data.name = updates.name.trim();
  if (updates.active !== undefined) data.active = updates.active ? 1 : 0;
  if (Object.keys(data).length === 0) return;
  await patientDoc(id).set(data, { merge: true });
  if (typeof data.name === "string") {
    await setPatientSettings(id, { [PATIENT_SETTING_KEYS.name]: data.name });
  }
}

// ——— Migração da fase de paciente único ———
// Na primeira leitura sem nenhum paciente cadastrado, cria o paciente inicial
// a partir dos dados globais legados (settings.patient_name, people) e
// semeia o conteúdo padrão. Nada é apagado das coleções legadas.
//
// O id do paciente migrado é FIXO (1): requisições concorrentes no primeiro
// acesso escrevem o mesmo documento (e os itens têm ids determinísticos),
// então a migração é idempotente — nunca nascem dois pacientes.
const MIGRATED_PATIENT_ID = 1;
let migrated = false;
async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  const snap = await col.patients().limit(1).get();
  if (!snap.empty) {
    migrated = true;
    return;
  }
  const legacy = await getLegacySettings();
  const id = MIGRATED_PATIENT_ID;
  await patientDoc(id).set({
    name: legacy.patient_name || "Paciente",
    active: 1,
    createdAt: new Date().toISOString(),
  });
  const settingsCopy: Record<string, string> = {};
  for (const key of Object.values(PATIENT_SETTING_KEYS)) {
    if (legacy[key]) settingsCopy[key] = legacy[key];
  }
  if (!settingsCopy[PATIENT_SETTING_KEYS.name]) {
    settingsCopy[PATIENT_SETTING_KEYS.name] = legacy.patient_name || "Paciente";
  }
  const legacyPeopleSnap = await col.legacyPeople().where("active", "==", 1).get();
  const batch = firestore.batch();
  legacyPeopleSnap.docs.forEach((d) => {
    batch.set(sub.people(id).doc(d.id), d.data());
  });
  await batch.commit();
  await Promise.all([
    setPatientSettings(id, settingsCopy),
    seedDefaults(id, "rotina"),
    seedDefaults(id, "emergencia"),
    seedDefaults(id, "conversa"),
  ]);
  migrated = true;
}

async function getLegacySettings(): Promise<Record<string, string>> {
  const snap = await col.legacySettings().get();
  const out: Record<string, string> = {};
  snap.docs.forEach((d) => {
    const v = d.data().value;
    if (v != null) out[d.id] = String(v);
  });
  return out;
}

// ---------- Itens de modo (Rotina, Emergência, expressões de Conversa) ----------

function defaultDocId(defaultKey: string): string {
  return defaultKey.replace(/[^\w.-]/g, "_");
}

function itemFromDefault(
  patientId: number,
  mode: HeloItemMode,
  d: (typeof DEFAULT_ITEMS)[HeloItemMode][number],
  order: number
): Omit<ModeItem, "id"> {
  return {
    patientId,
    mode,
    label: d.label,
    spokenText: d.spokenText,
    category: d.category,
    enabled: true,
    order,
    isDefault: true,
    defaultKey: d.defaultKey,
    speakerRole: modeSpeakerRole(mode),
    requiresConfirmation: modeRequiresConfirmation(mode),
    updatedAt: new Date().toISOString(),
  };
}

async function seedDefaults(patientId: number, mode: HeloItemMode): Promise<void> {
  const batch = firestore.batch();
  DEFAULT_ITEMS[mode].forEach((d, i) => {
    batch.set(
      sub.items(patientId).doc(defaultDocId(d.defaultKey)),
      itemFromDefault(patientId, mode, d, i)
    );
  });
  await batch.commit();
}

/** Modo de um item existente — usado pela autorização de edição por modo. */
export async function getItemMode(
  patientId: number,
  itemId: string
): Promise<HeloItemMode | null> {
  const doc = await sub.items(patientId).doc(itemId).get();
  return doc.exists ? ((doc.data()?.mode as HeloItemMode) ?? null) : null;
}

export async function listItems(
  patientId: number,
  mode: HeloItemMode
): Promise<ModeItem[]> {
  const snap = await sub.items(patientId).where("mode", "==", mode).get();
  return snap.docs
    .map((d) => ({ ...(d.data() as Omit<ModeItem, "id">), id: d.id }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

export async function addItem(
  patientId: number,
  mode: HeloItemMode,
  input: ModeItemInput
): Promise<ModeItem> {
  if (!input.label?.trim() || !input.spokenText?.trim()) {
    throw new Error("label e spokenText são obrigatórios");
  }
  const existing = await listItems(patientId, mode);
  const item: Omit<ModeItem, "id"> = {
    patientId,
    mode,
    label: input.label.trim(),
    spokenText: input.spokenText.trim(),
    category: input.category?.trim() || (mode === "emergencia" ? "emergencia" : "geral"),
    enabled: input.enabled ?? true,
    order: input.order ?? (existing.length > 0 ? existing[existing.length - 1].order + 1 : 0),
    isDefault: false,
    defaultKey: null,
    speakerRole: modeSpeakerRole(mode),
    requiresConfirmation: modeRequiresConfirmation(mode),
    updatedAt: new Date().toISOString(),
  };
  const id = `c${Date.now()}`;
  await sub.items(patientId).doc(id).set(item);
  return { ...item, id };
}

export async function updateItem(
  patientId: number,
  itemId: string,
  input: ModeItemInput
): Promise<void> {
  const data: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.label !== undefined) data.label = input.label.trim();
  if (input.spokenText !== undefined) data.spokenText = input.spokenText.trim();
  if (input.category !== undefined) data.category = input.category.trim();
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.order !== undefined) data.order = input.order;
  if (data.label === "" || data.spokenText === "") {
    throw new Error("label e spokenText não podem ficar vazios");
  }
  await sub.items(patientId).doc(itemId).set(data, { merge: true });
}

/** Reordena todos os itens do modo na sequência recebida. */
export async function reorderItems(
  patientId: number,
  ids: string[]
): Promise<void> {
  const batch = firestore.batch();
  const ts = new Date().toISOString();
  ids.forEach((id, i) => {
    batch.set(sub.items(patientId).doc(id), { order: i, updatedAt: ts }, { merge: true });
  });
  await batch.commit();
}

// Itens padrão não são excluídos — são desativados (não desaparecem em
// silêncio e podem ser restaurados). Só itens criados pela família saem.
export async function deleteItem(
  patientId: number,
  itemId: string
): Promise<{ deleted: boolean; reason?: string }> {
  const ref = sub.items(patientId).doc(itemId);
  const doc = await ref.get();
  if (!doc.exists) return { deleted: false, reason: "não encontrado" };
  if (doc.data()?.isDefault) {
    await ref.set(
      { enabled: false, updatedAt: new Date().toISOString() },
      { merge: true }
    );
    return { deleted: false, reason: "item padrão foi desativado, não excluído" };
  }
  await ref.delete();
  return { deleted: true };
}

/**
 * Restaura o conteúdo padrão do modo: itens padrão voltam ao texto, ordem e
 * estado originais (recriados se excluídos); itens personalizados são
 * preservados, reordenados após os padrão.
 */
export async function restoreDefaults(
  patientId: number,
  mode: HeloItemMode
): Promise<void> {
  const existing = await listItems(patientId, mode);
  const custom = existing.filter((i) => !i.isDefault);
  const batch = firestore.batch();
  const defaults = DEFAULT_ITEMS[mode];
  defaults.forEach((d, i) => {
    batch.set(
      sub.items(patientId).doc(defaultDocId(d.defaultKey)),
      itemFromDefault(patientId, mode, d, i)
    );
  });
  custom.forEach((c, i) => {
    batch.set(
      sub.items(patientId).doc(c.id),
      { order: defaults.length + i, updatedAt: new Date().toISOString() },
      { merge: true }
    );
  });
  await batch.commit();
}

// ---------- Sessões ----------

export async function createSession(opts: {
  mode: string;
  patientId?: number | null;
  /** Identidade REAL do operador — sempre o userId autenticado. */
  operatorId?: string | null;
  /** Snapshot do nome para leitura do histórico; nunca fonte de identidade. */
  operatorName?: string | null;
  operatorRole?: string | null;
}): Promise<number> {
  const id = Date.now();
  await col.sessions().doc(String(id)).set({
    startedAt: new Date().toISOString(),
    endedAt: null,
    operator: opts.operatorName ?? null,
    operatorId: opts.operatorId ?? null,
    operatorRole: opts.operatorRole ?? null,
    mode: opts.mode ?? "conversa",
    patientId: opts.patientId ?? null,
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
    patientId: e.patientId ?? null,
    itemId: e.itemId ?? null,
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
    patientId: m.patientId ?? null,
    text: m.text,
    category: m.category ?? null,
    sensitive: m.sensitive ? 1 : 0,
    status: m.status,
    confirmations: m.confirmations ?? 1,
    // Contrato da orquestração de voz: a voz clonada do paciente só poderá
    // ser usada com speakerRole "patient" + confirmationStatus "confirmed".
    speakerRole: m.speakerRole ?? "patient",
    confirmationStatus:
      m.confirmationStatus ??
      (m.status === "confirmada" ? "confirmed" : "rejected"),
    ts: new Date().toISOString(),
  });
  return ref.id;
}

// ---------- Pessoas (por paciente) ----------

export type Person = { id: number; name: string; relation: string | null };

export async function listPeople(patientId: number): Promise<Person[]> {
  const snap = await sub.people(patientId).where("active", "==", 1).get();
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
  patientId: number,
  name: string,
  relation?: string | null
): Promise<number> {
  const id = Date.now();
  await sub.people(patientId).doc(String(id)).set({
    name,
    relation: relation?.trim() || null,
    active: 1,
    createdAt: new Date().toISOString(),
  });
  return id;
}

export async function deactivatePerson(
  patientId: number,
  id: number
): Promise<void> {
  await sub.people(patientId).doc(String(id)).set({ active: 0 }, { merge: true });
}

// ---------- Configurações (por paciente) ----------

export async function getPatientSettings(
  patientId: number
): Promise<Record<string, string>> {
  const snap = await sub.settings(patientId).get();
  const out: Record<string, string> = {};
  snap.docs.forEach((d) => {
    const v = d.data().value;
    if (v != null) out[d.id] = String(v);
  });
  return out;
}

export async function setPatientSettings(
  patientId: number,
  updates: Record<string, string>
): Promise<void> {
  const batch = firestore.batch();
  for (const [key, value] of Object.entries(updates)) {
    batch.set(sub.settings(patientId).doc(key), { value }, { merge: true });
  }
  await batch.commit();
}

export async function getPatientSetting(
  patientId: number,
  key: string
): Promise<string | undefined> {
  const doc = await sub.settings(patientId).doc(key).get();
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
  sessionId: number | null;
  detail: string | null;
};
type MessageRow = {
  id: string;
  ts: string;
  text: string;
  category: string | null;
  sensitive: number;
  status: string;
};

// Isolamento por paciente na série histórica global: um registro pertence ao
// paciente do seu carimbo patientId. Registros da fase de paciente único
// (patientId null) pertencem ao paciente migrado (id 1) — a MESMA regra da
// migração de settings/people em ensureMigrated. Nada é atribuído a outro
// paciente em hipótese alguma.
function belongsTo(patientId: number, recordPid: unknown): boolean {
  if (recordPid == null) return patientId === MIGRATED_PATIENT_ID;
  return Number(recordPid) === patientId;
}

export async function getStats(period: Period, patientId: number) {
  const cut = cutoffIso(period);

  const [eventsSnap, messagesSnap, sessionsSnap] = await Promise.all([
    col.events().where("ts", ">=", cut).get(),
    col.messages().where("ts", ">=", cut).get(),
    col.sessions().where("startedAt", ">=", cut).get(),
  ]);

  // O modo da sessão distingue registros de Rotina, Conversa e Emergência
  // (o evento carrega a categoria do item, não o modo).
  const sessionMode = new Map<number, string>();
  const sessionDocs = sessionsSnap.docs.filter((d) =>
    belongsTo(patientId, d.data().patientId)
  );
  sessionDocs.forEach((d) => {
    sessionMode.set(Number(d.id), (d.data().mode as string) ?? "conversa");
  });

  const events: EventRow[] = eventsSnap.docs
    .filter((d) => belongsTo(patientId, d.data().patientId))
    .map((d) => {
      const v = d.data();
      return {
        type: v.type as string,
        gesture: (v.gesture ?? null) as string | null,
        responseMs: (v.responseMs ?? null) as number | null,
        ts: v.ts as string,
        sessionId: (v.sessionId ?? null) as number | null,
        detail: (v.detail ?? null) as string | null,
      };
    });

  const messages: MessageRow[] = messagesSnap.docs
    .filter((d) => belongsTo(patientId, d.data().patientId))
    .map((d) => {
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
    emergencias: countEvt("emergencia"),
    sessoes: sessionDocs.length,
    tempoMedioRespostaMs,
  };

  // Itens de Rotina mais acionados (confirmações em sessões de Rotina)
  const rotinaMap = new Map<string, number>();
  for (const e of events) {
    if (
      e.type === "confirmacao" &&
      e.detail &&
      e.sessionId != null &&
      sessionMode.get(e.sessionId) === "rotina"
    ) {
      rotinaMap.set(e.detail, (rotinaMap.get(e.detail) ?? 0) + 1);
    }
  }
  const rotinaMaisUsadas = [...rotinaMap.entries()]
    .map(([text, n]) => ({ text, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);

  // Emergências acionadas — quando e qual frase
  const emergenciasRecentes = events
    .filter((e) => e.type === "emergencia")
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 20)
    .map((e) => ({ ts: localTs(e.ts), text: e.detail ?? "" }));

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
    patientId,
    geradoEm: new Date().toISOString(),
    totals,
    gestosPorTipo,
    porDia,
    porCategoria,
    porHora,
    relatosDor,
    rotinaMaisUsadas,
    emergenciasRecentes,
    mensagens,
  };
}

// ---------- Resumo multi-paciente (Dashboard Geral) ----------
// Uma leitura por coleção (janela recente) + settings/people por paciente.
// Nenhum conteúdo de mensagem sai daqui: a visão geral resume ATIVIDADE,
// não comunicação — dados sensíveis ficam no Dashboard Individual.

export interface PatientSummary {
  patientId: number;
  name: string;
  createdAt: string;
  /** Última atividade registrada (evento/mensagem/sessão) — null se nada na janela. */
  lastActivityAt: string | null;
  /** Contagens dos últimos 7 dias. */
  sessions7d: number;
  approvedPhrases7d: number;
  reformulations7d: number;
  pauses7d: number;
  emergencies7d: number;
  /** Voz clonada do paciente configurada? (status, nunca o ID) */
  voiceConfigured: boolean;
  /** Itens do perfil preenchidos, para o indicador de configuração. */
  profile: { name: boolean; voice: boolean; speechStyle: boolean; people: boolean };
  profileCompletion: number; // 0–1
}

const SUMMARY_WINDOW_DAYS = 30;

/**
 * Resumos do Dashboard Geral. `allowedIds` restringe aos pacientes
 * vinculados ao usuário autenticado (null = todos, uso do Admin) — o
 * filtro acontece AQUI, no servidor, nunca só na interface.
 */
export async function getPatientSummaries(
  allowedIds: number[] | null = null
): Promise<PatientSummary[]> {
  let patients = await listPatients();
  if (allowedIds !== null) {
    const allowed = new Set(allowedIds);
    patients = patients.filter((p) => allowed.has(p.id));
  }
  const windowCut = new Date(
    Date.now() - SUMMARY_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const cut7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [eventsSnap, messagesSnap, sessionsSnap] = await Promise.all([
    col.events().where("ts", ">=", windowCut).get(),
    col.messages().where("ts", ">=", windowCut).get(),
    col.sessions().where("startedAt", ">=", windowCut).get(),
  ]);

  return Promise.all(
    patients.map(async (p) => {
      const ev = eventsSnap.docs
        .map((d) => d.data())
        .filter((v) => belongsTo(p.id, v.patientId));
      const ms = messagesSnap.docs
        .map((d) => d.data())
        .filter((v) => belongsTo(p.id, v.patientId));
      const ss = sessionsSnap.docs
        .map((d) => d.data())
        .filter((v) => belongsTo(p.id, v.patientId));

      const stamps = [
        ...ev.map((v) => v.ts as string),
        ...ms.map((v) => v.ts as string),
        ...ss.map((v) => (v.endedAt ?? v.startedAt) as string),
      ].filter(Boolean);
      const lastActivityAt =
        stamps.length > 0 ? stamps.sort().at(-1)! : null;

      const [settings, people] = await Promise.all([
        getPatientSettings(p.id),
        listPeople(p.id),
      ]);
      const profile = {
        name: Boolean(settings[PATIENT_SETTING_KEYS.name]?.trim()),
        voice: Boolean(settings[PATIENT_SETTING_KEYS.voiceId]?.trim()),
        speechStyle: Boolean(settings[PATIENT_SETTING_KEYS.speechStyle]?.trim()),
        people: people.length > 0,
      };
      const done = Object.values(profile).filter(Boolean).length;

      return {
        patientId: p.id,
        name: p.name,
        createdAt: p.createdAt,
        lastActivityAt,
        sessions7d: ss.filter((v) => (v.startedAt as string) >= cut7d).length,
        approvedPhrases7d: ms.filter(
          (v) => v.status === "confirmada" && (v.ts as string) >= cut7d
        ).length,
        reformulations7d: ev.filter(
          (v) => v.type === "reformulacao" && (v.ts as string) >= cut7d
        ).length,
        pauses7d: ev.filter(
          (v) => v.type === "pausa" && (v.ts as string) >= cut7d
        ).length,
        emergencies7d: ev.filter(
          (v) => v.type === "emergencia" && (v.ts as string) >= cut7d
        ).length,
        voiceConfigured: profile.voice,
        profile,
        profileCompletion: done / Object.keys(profile).length,
      };
    })
  );
}

// ---------- Sessões recentes de um paciente (Dashboard Individual) ----------

export interface SessionSummary {
  id: number;
  startedAt: string; // horário local (SP)
  endedAt: string | null;
  durationMin: number | null;
  operator: string | null;
  mode: string;
  phrasesShown: number;
  confirmed: number;
  reformulations: number;
  rejections: number;
  emergencies: number;
}

export async function listRecentSessions(
  patientId: number,
  limit = 20
): Promise<SessionSummary[]> {
  const windowCut = new Date(
    Date.now() - 90 * 24 * 60 * 60 * 1000
  ).toISOString();
  const [sessionsSnap, eventsSnap] = await Promise.all([
    col.sessions().where("startedAt", ">=", windowCut).get(),
    col.events().where("ts", ">=", windowCut).get(),
  ]);

  const sessions = sessionsSnap.docs
    .filter((d) => belongsTo(patientId, d.data().patientId))
    .map((d) => {
      const v = d.data();
      return {
        id: Number(d.id),
        startedAt: String(v.startedAt),
        endedAt: v.endedAt ? String(v.endedAt) : null,
        operator: (v.operator ?? null) as string | null,
        mode: (v.mode as string) ?? "conversa",
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);

  const wanted = new Set(sessions.map((s) => s.id));
  const bySession = new Map<number, { type: string }[]>();
  eventsSnap.docs.forEach((d) => {
    const v = d.data();
    // Dupla checagem: o evento precisa pertencer À SESSÃO e AO PACIENTE.
    if (v.sessionId == null || !wanted.has(Number(v.sessionId))) return;
    if (!belongsTo(patientId, v.patientId)) return;
    const list = bySession.get(Number(v.sessionId)) ?? [];
    list.push({ type: v.type as string });
    bySession.set(Number(v.sessionId), list);
  });

  return sessions.map((s) => {
    const ev = bySession.get(s.id) ?? [];
    const count = (t: string) => ev.filter((e) => e.type === t).length;
    const started = String(s.startedAt);
    const ended = s.endedAt ? String(s.endedAt) : null;
    return {
      id: s.id,
      startedAt: localTs(started),
      endedAt: ended ? localTs(ended) : null,
      durationMin: ended
        ? Math.max(
            0,
            Math.round(
              (new Date(ended).getTime() - new Date(started).getTime()) / 60000
            )
          )
        : null,
      operator: (s.operator ?? null) as string | null,
      mode: (s.mode as string) ?? "conversa",
      phrasesShown: count("pergunta_apresentada") + count("opcao_apresentada"),
      confirmed: count("confirmacao"),
      reformulations: count("reformulacao"),
      rejections: count("descarte"),
      emergencies: count("emergencia"),
    };
  });
}
