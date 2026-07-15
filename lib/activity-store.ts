import { firestore } from "@/lib/firestore";
import {
  cutoffIso,
  localDay,
  localHour,
  localTs,
  type Period,
} from "@/lib/store";
import type { Gesture } from "@/lib/types";
import {
  ACTIVITY_CATEGORIES,
  affirmedOptionId,
  BARE_QUESTION_OPTION_ID,
  computeCorrectness,
  MEDIA_ALLOWED_TYPES,
  MEDIA_MAX_BYTES,
  type ActivityCategory,
  type ActivityItem,
  type ActivityMedia,
  type ActivityOption,
  type ActivityResponse,
  type ActivityRun,
  type ActivityRunStatus,
  type ActivityTemplate,
  type ActivityTemplateStatus,
  type Correctness,
  type OptionGesture,
  type PatientMediaMeta,
} from "@/lib/activity-types";

// Camada de dados das Atividades (sessões personalizadas) sobre o Firestore.
// Complementa lib/store.ts sem duplicá-lo, seguindo as MESMAS regras de
// isolamento:
//   - templates e mídia vivem em SUBCOLEÇÕES de patients/{id} — uma escrita
//     nunca alcança outro paciente por construção;
//   - execuções (runs) e respostas seguem em coleções globais (série
//     histórica), sempre carimbadas com patientId e filtradas no servidor.
//
// Versionamento (seções 24–25): cada execução carrega um SNAPSHOT imutável
// dos itens exibidos. Editar o template sobe a versão e nunca altera
// retroativamente uma execução anterior.

const patientDoc = (pid: number) =>
  firestore.collection("patients").doc(String(pid));
const templatesCol = (pid: number) =>
  patientDoc(pid).collection("activityTemplates");
const mediaCol = (pid: number) => patientDoc(pid).collection("media");
const runsCol = () => firestore.collection("activityRuns");
const responsesCol = () => firestore.collection("activityResponses");

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

// ---------- Normalização (nenhuma escrita confia no cliente) ----------

const GESTURES: Gesture[] = ["sim", "talvez", "nao"];
const MAX_ITEMS = 40;
const MAX_OPTIONS = 3;
const MAX_MEDIA_PER_ITEM = 8;

function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function normalizeMedia(raw: unknown): ActivityMedia[] {
  if (!Array.isArray(raw)) return [];
  const out: ActivityMedia[] = [];
  for (const m of raw.slice(0, MAX_MEDIA_PER_ITEM)) {
    const v = m as Partial<ActivityMedia>;
    const kind = v.kind === "youtube" ? "youtube" : "imagem";
    const mediaId =
      typeof v.mediaId === "string" && /^[\w-]{1,40}$/.test(v.mediaId)
        ? v.mediaId
        : null;
    const url = cleanText(v.url, 2000) || null;
    if (!mediaId && !url) continue; // mídia sem fonte não entra
    out.push({ kind, mediaId, url, caption: cleanText(v.caption, 300) || null });
  }
  return out;
}

/** Sanitiza os itens recebidos do editor — ids estáveis, textos limitados. */
export function normalizeItems(raw: unknown): ActivityItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ITEMS).map((r, idx) => {
    const v = r as Partial<ActivityItem>;
    const id =
      typeof v.id === "string" && /^[\w-]{1,40}$/.test(v.id) ? v.id : newId("i");
    const options: ActivityOption[] = Array.isArray(v.options)
      ? v.options
          .slice(0, MAX_OPTIONS)
          .map((o, oi) => {
            const ov = o as Partial<ActivityOption>;
            return {
              id:
                typeof ov.id === "string" && /^[\w-]{1,40}$/.test(ov.id)
                  ? ov.id
                  : `${id}_op${oi}`,
              label: cleanText(ov.label, 120),
            };
          })
          .filter((o) => o.label.length > 0)
      : [];
    const question = cleanText(v.question, 300);
    const correctOptionId =
      typeof v.correctOptionId === "string" &&
      options.some((o) => o.id === v.correctOptionId)
        ? v.correctOptionId
        : null;
    return {
      id,
      order: idx,
      title: cleanText(v.title, 120),
      text: cleanText(v.text, 2000),
      media: normalizeMedia(v.media),
      question,
      options,
      correctOptionId,
      // Perguntas registram o gesto observado; conteúdo afetivo pode
      // dispensá-lo (nunca transformar memória em teste automaticamente).
      gesturesEnabled:
        question.length > 0 ? v.gesturesEnabled !== false : v.gesturesEnabled === true,
    };
  });
}

function normalizeCategory(v: unknown): ActivityCategory {
  return ACTIVITY_CATEGORIES.includes(v as ActivityCategory)
    ? (v as ActivityCategory)
    : "entretenimento";
}

// ---------- Templates ----------

function toTemplate(
  patientId: number,
  id: string,
  v: FirebaseFirestore.DocumentData
): ActivityTemplate {
  return {
    id,
    patientId,
    title: String(v.title ?? ""),
    description: String(v.description ?? ""),
    category: normalizeCategory(v.category),
    status: v.status === "inativa" ? "inativa" : "ativa",
    version: Number(v.version ?? 1),
    items: (v.items as ActivityItem[]) ?? [],
    createdByUserId: (v.createdByUserId as string) ?? null,
    createdByName: (v.createdByName as string) ?? null,
    updatedByUserId: (v.updatedByUserId as string) ?? null,
    updatedByName: (v.updatedByName as string) ?? null,
    createdAt: String(v.createdAt ?? ""),
    updatedAt: String(v.updatedAt ?? ""),
  };
}

export async function listTemplates(
  patientId: number,
  includeInactive = false
): Promise<ActivityTemplate[]> {
  const snap = await templatesCol(patientId).get();
  return snap.docs
    .map((d) => toTemplate(patientId, d.id, d.data()))
    .filter((t) => includeInactive || t.status === "ativa")
    .sort(
      (a, b) =>
        a.category.localeCompare(b.category) || a.title.localeCompare(b.title, "pt-BR")
    );
}

export async function getTemplate(
  patientId: number,
  id: string
): Promise<ActivityTemplate | null> {
  const doc = await templatesCol(patientId).doc(id).get();
  return doc.exists ? toTemplate(patientId, doc.id, doc.data()!) : null;
}

export interface TemplateInput {
  title?: unknown;
  description?: unknown;
  category?: unknown;
  status?: unknown;
  items?: unknown;
}

export async function createTemplate(
  patientId: number,
  input: TemplateInput,
  author: { id: string; name: string }
): Promise<ActivityTemplate> {
  const title = cleanText(input.title, 120);
  if (!title) throw new Error("título é obrigatório");
  const now = new Date().toISOString();
  const id = newId("t");
  const data = {
    title,
    description: cleanText(input.description, 1000),
    category: normalizeCategory(input.category),
    status: "ativa" as ActivityTemplateStatus,
    version: 1,
    items: normalizeItems(input.items),
    createdByUserId: author.id,
    createdByName: author.name,
    updatedByUserId: author.id,
    updatedByName: author.name,
    createdAt: now,
    updatedAt: now,
  };
  await templatesCol(patientId).doc(id).set(data);
  return { id, patientId, ...data };
}

/**
 * Atualiza o template. Alterações de CONTEÚDO (itens ou título) sobem a
 * versão — execuções anteriores preservam o próprio snapshot e a versão em
 * que aconteceram. Ativar/desativar não é edição de conteúdo.
 */
export async function updateTemplate(
  patientId: number,
  id: string,
  input: TemplateInput,
  author: { id: string; name: string }
): Promise<ActivityTemplate> {
  const existing = await getTemplate(patientId, id);
  if (!existing) throw new Error("atividade não encontrada");
  const data: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
    updatedByUserId: author.id,
    updatedByName: author.name,
  };
  let contentChanged = false;
  if (input.title !== undefined) {
    const title = cleanText(input.title, 120);
    if (!title) throw new Error("título não pode ficar vazio");
    if (title !== existing.title) contentChanged = true;
    data.title = title;
  }
  if (input.description !== undefined) {
    data.description = cleanText(input.description, 1000);
  }
  if (input.category !== undefined) {
    data.category = normalizeCategory(input.category);
  }
  if (input.status !== undefined) {
    data.status = input.status === "inativa" ? "inativa" : "ativa";
  }
  if (input.items !== undefined) {
    data.items = normalizeItems(input.items);
    contentChanged = true;
  }
  if (contentChanged) data.version = existing.version + 1;
  await templatesCol(patientId).doc(id).set(data, { merge: true });
  return (await getTemplate(patientId, id))!;
}

export async function duplicateTemplate(
  patientId: number,
  id: string,
  author: { id: string; name: string }
): Promise<ActivityTemplate> {
  const existing = await getTemplate(patientId, id);
  if (!existing) throw new Error("atividade não encontrada");
  return createTemplate(
    patientId,
    {
      title: `${existing.title} (cópia)`.slice(0, 120),
      description: existing.description,
      category: existing.category,
      items: existing.items,
    },
    author
  );
}

/**
 * Exclusão do template. O histórico de execuções NÃO é apagado: cada
 * execução carrega snapshot e título próprios — o passado continua legível
 * no Dashboard mesmo sem o template.
 */
export async function deleteTemplate(
  patientId: number,
  id: string
): Promise<void> {
  await templatesCol(patientId).doc(id).delete();
}

// ---------- Execuções (runs) ----------

function toRun(id: string, v: FirebaseFirestore.DocumentData): ActivityRun {
  return {
    id,
    patientId: Number(v.patientId),
    templateId: String(v.templateId ?? ""),
    templateVersion: Number(v.templateVersion ?? 1),
    templateTitle: String(v.templateTitle ?? ""),
    category: normalizeCategory(v.category),
    operatorId: (v.operatorId as string) ?? null,
    operatorName: (v.operatorName as string) ?? null,
    startedAt: String(v.startedAt ?? ""),
    endedAt: v.endedAt ? String(v.endedAt) : null,
    status:
      v.status === "concluida" || v.status === "abandonada"
        ? (v.status as ActivityRunStatus)
        : "em_andamento",
    items: (v.items as ActivityItem[]) ?? [],
  };
}

export async function startRun(
  patientId: number,
  templateId: string,
  operator: { id: string; name: string }
): Promise<ActivityRun> {
  const template = await getTemplate(patientId, templateId);
  if (!template) throw new Error("atividade não encontrada");
  if (template.status !== "ativa") throw new Error("atividade desativada");
  if (template.items.length === 0) throw new Error("atividade sem itens");
  const id = newId("r");
  const run: Omit<ActivityRun, "id"> = {
    patientId,
    templateId,
    templateVersion: template.version,
    templateTitle: template.title,
    category: template.category,
    operatorId: operator.id,
    operatorName: operator.name,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "em_andamento",
    items: template.items, // snapshot imutável do conteúdo exibido
  };
  await runsCol().doc(id).set(run);
  return { id, ...run };
}

export async function getRun(
  patientId: number,
  runId: string
): Promise<ActivityRun | null> {
  const doc = await runsCol().doc(runId).get();
  if (!doc.exists) return null;
  const run = toRun(doc.id, doc.data()!);
  // Isolamento: a execução só existe para quem tem o MESMO patientId.
  return run.patientId === patientId ? run : null;
}

export async function endRun(
  patientId: number,
  runId: string,
  status: "concluida" | "abandonada"
): Promise<void> {
  const run = await getRun(patientId, runId);
  if (!run) throw new Error("execução não encontrada");
  // Encerramento é idempotente; um estado terminal nunca é sobrescrito
  // por outro (a conclusão não vira "abandonada" por um beforeunload tardio).
  if (run.status !== "em_andamento") return;
  await runsCol()
    .doc(runId)
    .set({ status, endedAt: new Date().toISOString() }, { merge: true });
}

// ---------- Respostas ----------

function toResponse(
  id: string,
  v: FirebaseFirestore.DocumentData
): ActivityResponse {
  return {
    id,
    runId: String(v.runId ?? ""),
    patientId: Number(v.patientId),
    templateId: String(v.templateId ?? ""),
    itemId: String(v.itemId ?? ""),
    optionGestures: Array.isArray(v.optionGestures)
      ? (v.optionGestures as OptionGesture[]).filter((g) =>
          GESTURES.includes(g?.gesture)
        )
      : [],
    selectedOptionId: (v.selectedOptionId as string) ?? null,
    selectedOptionLabel: (v.selectedOptionLabel as string) ?? null,
    correctness: (v.correctness as Correctness) ?? null,
    responseTimeMs: v.responseTimeMs != null ? Number(v.responseTimeMs) : null,
    operatorId: (v.operatorId as string) ?? null,
    ts: String(v.ts ?? ""),
    revision: Number(v.revision ?? 1),
  };
}

/**
 * Registra a resposta de UM item de UMA execução. O id do documento é
 * determinístico (runId_itemId): duplo toque não cria resposta duplicada e
 * nenhuma resposta nasce órfã — ela sempre referencia execução, item,
 * paciente e operador. Uma correção explícita sobrescreve com revision+1.
 *
 * A correção (correta/incorreta/incerta/não respondida) é calculada AQUI,
 * a partir do snapshot da execução — nunca confiada ao cliente.
 */
export async function recordResponse(
  patientId: number,
  runId: string,
  input: {
    itemId?: unknown;
    optionGestures?: unknown;
    responseTimeMs?: unknown;
  },
  operator: { id: string }
): Promise<ActivityResponse> {
  const run = await getRun(patientId, runId);
  if (!run) throw new Error("execução não encontrada");
  if (run.status !== "em_andamento") {
    throw new Error("a sessão já foi encerrada");
  }
  const itemId = typeof input.itemId === "string" ? input.itemId : "";
  const item = run.items.find((i) => i.id === itemId);
  if (!item) throw new Error("item não pertence a esta sessão");

  // Aceita só gestos em alternativas do snapshot (uma por opção; o último
  // valor vence). Um sentinela permite gesto único sobre uma pergunta SEM
  // alternativas. Nada fora do snapshot entra — resposta nunca fica órfã.
  const validIds = new Set<string>([
    ...item.options.map((o) => o.id),
    BARE_QUESTION_OPTION_ID,
  ]);
  const seen = new Map<string, Gesture>();
  if (Array.isArray(input.optionGestures)) {
    for (const raw of input.optionGestures) {
      const og = raw as Partial<OptionGesture>;
      if (
        typeof og.optionId === "string" &&
        validIds.has(og.optionId) &&
        GESTURES.includes(og.gesture as Gesture)
      ) {
        seen.set(og.optionId, og.gesture as Gesture);
      }
    }
  }
  const optionGestures: OptionGesture[] = [...seen.entries()].map(
    ([optionId, gesture]) => ({ optionId, gesture })
  );
  if (optionGestures.length === 0) {
    throw new Error("nenhum gesto válido para registrar");
  }

  const responseTimeMs =
    typeof input.responseTimeMs === "number" &&
    input.responseTimeMs >= 0 &&
    input.responseTimeMs < 60 * 60 * 1000
      ? Math.round(input.responseTimeMs)
      : null;

  const selectedOptionId = affirmedOptionId(optionGestures);
  const id = `${runId}_${itemId}`;
  const ref = responsesCol().doc(id);
  const prev = await ref.get();
  const response: Omit<ActivityResponse, "id"> = {
    runId,
    patientId,
    templateId: run.templateId,
    itemId,
    optionGestures,
    selectedOptionId,
    selectedOptionLabel:
      item.options.find((o) => o.id === selectedOptionId)?.label ?? null,
    correctness: computeCorrectness(item, optionGestures),
    responseTimeMs,
    operatorId: operator.id,
    ts: new Date().toISOString(),
    revision: prev.exists ? Number(prev.data()?.revision ?? 1) + 1 : 1,
  };
  await ref.set(response);
  return { id, ...response };
}

// ---------- Leitura para o Dashboard ----------

export interface ActivityRunSummary {
  id: string;
  templateId: string;
  templateTitle: string;
  templateVersion: number;
  category: ActivityCategory;
  operatorId: string | null;
  operatorName: string | null;
  startedAt: string; // horário local (SP)
  durationMin: number | null;
  status: ActivityRunStatus;
  respostas: number;
  corretas: number;
  incorretas: number;
  incertas: number;
  naoRespondidas: number;
  gestos: Record<Gesture, number>;
  tempoMedioMs: number | null;
}

export interface ActivityStats {
  totals: {
    sessoes: number;
    concluidas: number;
    abandonadas: number;
    emAndamento: number;
    respostas: number;
    comCriterio: number;
    corretas: number;
    incorretas: number;
    incertas: number;
    naoRespondidas: number;
    tempoMedioMs: number | null;
    duracaoMediaMin: number | null;
    gestos: Record<Gesture, number>;
  };
  porDia: { dia: string; respostas: number; corretas: number; comCriterio: number; sessoes: number }[];
  porHora: { hora: string; respostas: number; corretas: number; comCriterio: number; tempoTotalMs: number; tempoN: number }[];
  porCategoria: { category: ActivityCategory; sessoes: number }[];
  porTemplate: { templateId: string; titulo: string; sessoes: number }[];
  porOperador: { operatorId: string; nome: string; sessoes: number }[];
}

export interface ActivityRunFilters {
  period: Period;
  templateId?: string | null;
  category?: ActivityCategory | null;
  operatorId?: string | null;
}

/**
 * Execuções + agregados de UM paciente no período. Mesmo padrão do
 * getStats existente: leitura por janela + filtro por patientId no
 * servidor e agregação em memória (volume pequeno, sem índices compostos).
 */
export async function listRunsWithStats(
  patientId: number,
  filters: ActivityRunFilters
): Promise<{ runs: ActivityRunSummary[]; stats: ActivityStats }> {
  const cut = cutoffIso(filters.period);
  const [runsSnap, respSnap] = await Promise.all([
    runsCol().where("startedAt", ">=", cut).get(),
    responsesCol().where("ts", ">=", cut).get(),
  ]);

  const matchesFilters = (run: ActivityRun) =>
    run.patientId === patientId &&
    (!filters.templateId || run.templateId === filters.templateId) &&
    (!filters.category || run.category === filters.category) &&
    (!filters.operatorId || run.operatorId === filters.operatorId);

  const runs = runsSnap.docs
    .map((d) => toRun(d.id, d.data()))
    .filter(matchesFilters)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const runIds = new Set(runs.map((r) => r.id));

  // Respostas do paciente, das execuções filtradas (dupla checagem).
  const responses = respSnap.docs
    .map((d) => toResponse(d.id, d.data()))
    .filter((r) => r.patientId === patientId && runIds.has(r.runId));

  const byRun = new Map<string, ActivityResponse[]>();
  for (const r of responses) {
    const list = byRun.get(r.runId) ?? [];
    list.push(r);
    byRun.set(r.runId, list);
  }

  const emptyGestos = (): Record<Gesture, number> => ({ sim: 0, talvez: 0, nao: 0 });

  const summaries: ActivityRunSummary[] = runs.map((run) => {
    const rs = byRun.get(run.id) ?? [];
    const gestos = emptyGestos();
    let tempoTotal = 0;
    let tempoN = 0;
    for (const r of rs) {
      // Cada alternativa carrega seu próprio gesto — todos entram na
      // distribuição observada.
      for (const og of r.optionGestures) gestos[og.gesture] += 1;
      if (r.responseTimeMs != null) {
        tempoTotal += r.responseTimeMs;
        tempoN += 1;
      }
    }
    const count = (c: Correctness) => rs.filter((r) => r.correctness === c).length;
    return {
      id: run.id,
      templateId: run.templateId,
      templateTitle: run.templateTitle,
      templateVersion: run.templateVersion,
      category: run.category,
      operatorId: run.operatorId,
      operatorName: run.operatorName,
      startedAt: localTs(run.startedAt),
      durationMin: run.endedAt
        ? Math.max(
            0,
            Math.round(
              (new Date(run.endedAt).getTime() -
                new Date(run.startedAt).getTime()) /
                60000
            )
          )
        : null,
      status: run.status,
      respostas: rs.length,
      corretas: count("correta"),
      incorretas: count("incorreta"),
      incertas: count("incerta"),
      naoRespondidas: count("nao_respondida"),
      gestos,
      tempoMedioMs: tempoN > 0 ? tempoTotal / tempoN : null,
    };
  });

  // ——— Agregados ———
  const gestos = emptyGestos();
  let tempoTotal = 0;
  let tempoN = 0;
  const countAll = (c: Correctness) =>
    responses.filter((r) => r.correctness === c).length;
  for (const r of responses) {
    for (const og of r.optionGestures) gestos[og.gesture] += 1;
    if (r.responseTimeMs != null) {
      tempoTotal += r.responseTimeMs;
      tempoN += 1;
    }
  }
  const durations = summaries
    .map((s) => s.durationMin)
    .filter((d): d is number => d != null);

  const diaMap = new Map<string, { respostas: number; corretas: number; comCriterio: number; sessoes: number }>();
  for (const run of runs) {
    const dia = localDay(run.startedAt);
    const cur = diaMap.get(dia) ?? { respostas: 0, corretas: 0, comCriterio: 0, sessoes: 0 };
    cur.sessoes += 1;
    diaMap.set(dia, cur);
  }
  const horaMap = new Map<string, { respostas: number; corretas: number; comCriterio: number; tempoTotalMs: number; tempoN: number }>();
  for (const r of responses) {
    const dia = localDay(r.ts);
    const dCur = diaMap.get(dia) ?? { respostas: 0, corretas: 0, comCriterio: 0, sessoes: 0 };
    dCur.respostas += 1;
    if (r.correctness && r.correctness !== "nao_respondida") {
      dCur.comCriterio += 1;
      if (r.correctness === "correta") dCur.corretas += 1;
    }
    diaMap.set(dia, dCur);

    const hora = localHour(r.ts);
    const hCur =
      horaMap.get(hora) ??
      { respostas: 0, corretas: 0, comCriterio: 0, tempoTotalMs: 0, tempoN: 0 };
    hCur.respostas += 1;
    if (r.correctness && r.correctness !== "nao_respondida") {
      hCur.comCriterio += 1;
      if (r.correctness === "correta") hCur.corretas += 1;
    }
    if (r.responseTimeMs != null) {
      hCur.tempoTotalMs += r.responseTimeMs;
      hCur.tempoN += 1;
    }
    horaMap.set(hora, hCur);
  }

  const catMap = new Map<ActivityCategory, number>();
  const tplMap = new Map<string, { titulo: string; sessoes: number }>();
  const opMap = new Map<string, { nome: string; sessoes: number }>();
  for (const run of runs) {
    catMap.set(run.category, (catMap.get(run.category) ?? 0) + 1);
    const tpl = tplMap.get(run.templateId) ?? { titulo: run.templateTitle, sessoes: 0 };
    tpl.sessoes += 1;
    tplMap.set(run.templateId, tpl);
    if (run.operatorId) {
      const op = opMap.get(run.operatorId) ?? { nome: run.operatorName ?? "—", sessoes: 0 };
      op.sessoes += 1;
      opMap.set(run.operatorId, op);
    }
  }

  const stats: ActivityStats = {
    totals: {
      sessoes: runs.length,
      concluidas: runs.filter((r) => r.status === "concluida").length,
      abandonadas: runs.filter((r) => r.status === "abandonada").length,
      emAndamento: runs.filter((r) => r.status === "em_andamento").length,
      respostas: responses.length,
      comCriterio: responses.filter(
        (r) => r.correctness && r.correctness !== "nao_respondida"
      ).length,
      corretas: countAll("correta"),
      incorretas: countAll("incorreta"),
      incertas: countAll("incerta"),
      naoRespondidas: countAll("nao_respondida"),
      tempoMedioMs: tempoN > 0 ? tempoTotal / tempoN : null,
      duracaoMediaMin:
        durations.length > 0
          ? durations.reduce((s, d) => s + d, 0) / durations.length
          : null,
      gestos,
    },
    porDia: [...diaMap.entries()]
      .map(([dia, v]) => ({ dia, ...v }))
      .sort((a, b) => a.dia.localeCompare(b.dia)),
    porHora: [...horaMap.entries()]
      .map(([hora, v]) => ({ hora, ...v }))
      .sort((a, b) => a.hora.localeCompare(b.hora)),
    porCategoria: [...catMap.entries()]
      .map(([category, sessoes]) => ({ category, sessoes }))
      .sort((a, b) => b.sessoes - a.sessoes),
    porTemplate: [...tplMap.entries()]
      .map(([templateId, v]) => ({ templateId, titulo: v.titulo, sessoes: v.sessoes }))
      .sort((a, b) => b.sessoes - a.sessoes),
    porOperador: [...opMap.entries()]
      .map(([operatorId, v]) => ({ operatorId, nome: v.nome, sessoes: v.sessoes }))
      .sort((a, b) => b.sessoes - a.sessoes),
  };

  return { runs: summaries.slice(0, 100), stats };
}

export interface RunDetailItem {
  itemId: string;
  title: string;
  question: string;
  options: ActivityOption[];
  correctOptionId: string | null;
  hasMedia: boolean;
  response: {
    /** Gesto observado por alternativa (mapa optionId → gesto). */
    optionGestures: OptionGesture[];
    selectedOptionId: string | null;
    selectedOptionLabel: string | null;
    correctness: Correctness | null;
    responseTimeMs: number | null;
    ts: string;
    revision: number;
  } | null;
}

/** Histórico detalhado de UMA execução: o conteúdo exibido + as respostas. */
export async function getRunDetail(
  patientId: number,
  runId: string
): Promise<{
  run: Omit<ActivityRun, "items"> & { startedAtLocal: string };
  items: RunDetailItem[];
} | null> {
  const run = await getRun(patientId, runId);
  if (!run) return null;
  const respSnap = await responsesCol().where("runId", "==", runId).get();
  const responses = respSnap.docs
    .map((d) => toResponse(d.id, d.data()))
    .filter((r) => r.patientId === patientId);
  const byItem = new Map(responses.map((r) => [r.itemId, r]));
  const items: RunDetailItem[] = [...run.items]
    .sort((a, b) => a.order - b.order)
    .map((item) => {
      const r = byItem.get(item.id) ?? null;
      return {
        itemId: item.id,
        title: item.title,
        question: item.question,
        options: item.options,
        correctOptionId: item.correctOptionId,
        hasMedia: item.media.length > 0,
        response: r
          ? {
              optionGestures: r.optionGestures,
              selectedOptionId: r.selectedOptionId,
              selectedOptionLabel: r.selectedOptionLabel,
              correctness: r.correctness,
              responseTimeMs: r.responseTimeMs,
              ts: localTs(r.ts),
              revision: r.revision,
            }
          : null,
      };
    });
  return {
    run: {
      id: run.id,
      patientId: run.patientId,
      templateId: run.templateId,
      templateVersion: run.templateVersion,
      templateTitle: run.templateTitle,
      category: run.category,
      operatorId: run.operatorId,
      operatorName: run.operatorName,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      status: run.status,
      startedAtLocal: localTs(run.startedAt),
    },
    items,
  };
}

// ---------- Mídia interna do paciente ----------
// Não há Firebase Storage provisionado no projeto (auditoria): as imagens
// vivem no Firestore, em chunks sob patients/{id}/media — mesma unidade de
// isolamento do restante dos dados do paciente. Nada é público: os bytes
// só saem por /api/media, que exige vínculo ativo. Vídeo pesado fica fora
// (YouTube cobre vídeo) até haver um bucket de Storage.

const CHUNK_CHARS = 700_000; // base64 por documento — abaixo do limite de 1 MiB

function toMediaMeta(id: string, v: FirebaseFirestore.DocumentData): PatientMediaMeta {
  return {
    id,
    name: String(v.name ?? ""),
    contentType: String(v.contentType ?? ""),
    size: Number(v.size ?? 0),
    createdByUserId: (v.createdByUserId as string) ?? null,
    createdAt: String(v.createdAt ?? ""),
  };
}

export async function saveMedia(
  patientId: number,
  input: { name?: unknown; contentType?: unknown; dataBase64?: unknown },
  author: { id: string }
): Promise<PatientMediaMeta> {
  const contentType = typeof input.contentType === "string" ? input.contentType : "";
  if (!MEDIA_ALLOWED_TYPES.includes(contentType)) {
    throw new Error("formato não permitido (use JPEG, PNG, WebP ou GIF)");
  }
  const dataBase64 =
    typeof input.dataBase64 === "string"
      ? input.dataBase64.replace(/^data:[^;]+;base64,/, "")
      : "";
  if (!dataBase64 || !/^[A-Za-z0-9+/=\s]+$/.test(dataBase64.slice(0, 1000))) {
    throw new Error("conteúdo da imagem inválido");
  }
  const clean = dataBase64.replace(/\s/g, "");
  const size = Math.floor((clean.length * 3) / 4);
  if (size > MEDIA_MAX_BYTES) {
    throw new Error(
      `imagem grande demais (${(size / 1_000_000).toFixed(1)} MB — máximo 2,5 MB)`
    );
  }
  const id = newId("m");
  const meta: PatientMediaMeta = {
    id,
    name: cleanText(input.name, 140) || "imagem",
    contentType,
    size,
    createdByUserId: author.id,
    createdAt: new Date().toISOString(),
  };
  const ref = mediaCol(patientId).doc(id);
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += CHUNK_CHARS) {
    chunks.push(clean.slice(i, i + CHUNK_CHARS));
  }
  const batch = firestore.batch();
  batch.set(ref, { ...meta, chunkCount: chunks.length });
  chunks.forEach((data, i) => {
    batch.set(ref.collection("chunks").doc(String(i)), { data });
  });
  await batch.commit();
  return meta;
}

export async function getMedia(
  patientId: number,
  id: string
): Promise<{ meta: PatientMediaMeta; data: Buffer } | null> {
  const ref = mediaCol(patientId).doc(id);
  const doc = await ref.get();
  if (!doc.exists) return null;
  const meta = toMediaMeta(doc.id, doc.data()!);
  const chunkCount = Number(doc.data()?.chunkCount ?? 0);
  const chunkDocs = await Promise.all(
    Array.from({ length: chunkCount }, (_, i) =>
      ref.collection("chunks").doc(String(i)).get()
    )
  );
  const base64 = chunkDocs.map((c) => String(c.data()?.data ?? "")).join("");
  return { meta, data: Buffer.from(base64, "base64") };
}

export async function listMedia(patientId: number): Promise<PatientMediaMeta[]> {
  const snap = await mediaCol(patientId).get();
  return snap.docs
    .map((d) => toMediaMeta(d.id, d.data()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteMedia(patientId: number, id: string): Promise<void> {
  const ref = mediaCol(patientId).doc(id);
  const chunks = await ref.collection("chunks").get();
  const batch = firestore.batch();
  chunks.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(ref);
  await batch.commit();
}
