// ——— Catálogo controlado de vozes da plataforma Helo (Firestore) ———
// Três conceitos que NUNCA se misturam:
//   A. Catálogo da plataforma  → vozes ElevenLabs cadastradas e aprovadas
//      pelo Admin (coleção platformVoices). Usuários enxergam só o nome
//      amigável — o voiceId técnico nunca sai para o cliente comum.
//   B. Voz clonada do paciente → setting voice_id do paciente, atribuída
//      exclusivamente pelo Admin, isolada por patientId por construção
//      (subcoleção patients/{id}/settings).
//   C. Preferências            → escolhas feitas entre opções aprovadas:
//      a do usuário (voz da plataforma, users.platformVoiceId) e a do
//      paciente (fonte das falas dele, settings patient_voice_source).
//
// A listagem completa da conta ElevenLabs NUNCA alimenta combos de usuário:
// o único contato com a API externa aqui é a validação de um voiceId no
// momento em que o Admin o cadastra.

import { firestore } from "@/lib/firestore";
import { getPatientSetting, getPatientSettings } from "@/lib/store";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import type { AppUser } from "@/lib/access-types";

export interface PlatformVoice {
  id: string;
  provider: "elevenlabs";
  /** voiceId técnico — só circula em contexto de Admin e no servidor. */
  elevenLabsVoiceId: string;
  displayName: string;
  description: string | null;
  enabled: boolean;
  isDefault: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Projeção segura para usuários comuns — sem voiceId técnico. */
export interface PublicPlatformVoice {
  id: string;
  displayName: string;
  description: string | null;
  isDefault: boolean;
}

export function toPublicVoice(v: PlatformVoice): PublicPlatformVoice {
  return {
    id: v.id,
    displayName: v.displayName,
    description: v.description,
    isDefault: v.isDefault,
  };
}

const voicesCol = () => firestore.collection("platformVoices");

function toVoice(id: string, v: FirebaseFirestore.DocumentData): PlatformVoice {
  return {
    id,
    provider: "elevenlabs",
    elevenLabsVoiceId: String(v.elevenLabsVoiceId ?? ""),
    displayName: String(v.displayName ?? ""),
    description: v.description ? String(v.description) : null,
    enabled: v.enabled !== false,
    isDefault: v.isDefault === true,
    createdBy: v.createdBy ? String(v.createdBy) : null,
    createdAt: String(v.createdAt ?? ""),
    updatedAt: String(v.updatedAt ?? ""),
  };
}

// ——— Migração da fase de voz por variável de ambiente ———
// Se o catálogo está vazio e existe ELEVENLABS_HELO_VOICE_ID (a antiga voz
// única da plataforma), ela vira "Helo Principal", ativa e padrão. Doc id
// fixo → requisições concorrentes escrevem o mesmo documento (idempotente).
let seeded = false;
async function ensureSeeded(): Promise<void> {
  if (seeded) return;
  const snap = await voicesCol().limit(1).get();
  if (!snap.empty) {
    seeded = true;
    return;
  }
  const legacy = process.env.ELEVENLABS_HELO_VOICE_ID;
  if (legacy) {
    const now = new Date().toISOString();
    await voicesCol().doc("helo-principal").set({
      elevenLabsVoiceId: legacy,
      displayName: "Helo Principal",
      description: "Voz oficial da plataforma (migrada da configuração inicial).",
      enabled: true,
      isDefault: true,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  seeded = true;
}

export async function listPlatformVoices(
  includeDisabled = false
): Promise<PlatformVoice[]> {
  await ensureSeeded();
  const snap = await voicesCol().get();
  return snap.docs
    .map((d) => toVoice(d.id, d.data()))
    .filter((v) => includeDisabled || v.enabled)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "pt-BR"));
}

export async function getPlatformVoice(
  id: string
): Promise<PlatformVoice | null> {
  if (!id) return null;
  const doc = await voicesCol().doc(id).get();
  return doc.exists ? toVoice(doc.id, doc.data()!) : null;
}

/** Voz padrão da Helo — sempre uma voz ATIVA do catálogo aprovado. */
export async function getDefaultPlatformVoice(): Promise<PlatformVoice | null> {
  const voices = await listPlatformVoices();
  return voices.find((v) => v.isDefault) ?? voices[0] ?? null;
}

export async function addPlatformVoice(input: {
  elevenLabsVoiceId: string;
  displayName: string;
  description?: string | null;
  enabled?: boolean;
  isDefault?: boolean;
  createdBy: string | null;
}): Promise<PlatformVoice> {
  await ensureSeeded();
  const now = new Date().toISOString();
  const ref = voicesCol().doc();
  if (input.isDefault) await clearDefault();
  await ref.set({
    elevenLabsVoiceId: input.elevenLabsVoiceId.trim(),
    displayName: input.displayName.trim(),
    description: input.description?.trim() || null,
    enabled: input.enabled ?? true,
    isDefault: input.isDefault ?? false,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });
  return toVoice(ref.id, (await ref.get()).data()!);
}

async function clearDefault(): Promise<void> {
  const snap = await voicesCol().where("isDefault", "==", true).get();
  const batch = firestore.batch();
  snap.docs.forEach((d) => batch.set(d.ref, { isDefault: false }, { merge: true }));
  await batch.commit();
}

export async function updatePlatformVoice(
  id: string,
  updates: {
    displayName?: string;
    description?: string | null;
    enabled?: boolean;
    isDefault?: boolean;
  }
): Promise<void> {
  const data: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (updates.displayName?.trim()) data.displayName = updates.displayName.trim();
  if (updates.description !== undefined)
    data.description = updates.description?.trim() || null;
  if (updates.enabled !== undefined) data.enabled = updates.enabled;
  if (updates.isDefault !== undefined) {
    if (updates.isDefault) await clearDefault();
    data.isDefault = updates.isDefault;
  }
  await voicesCol().doc(id).set(data, { merge: true });
}

export async function removePlatformVoice(id: string): Promise<void> {
  await voicesCol().doc(id).delete();
}

/**
 * Onde uma voz do catálogo está em uso — pré-requisito para remover com
 * segurança e para o Admin visualizar o impacto de desativar.
 */
export interface VoiceUsage {
  /** Usuários que a escolheram como preferência de voz da plataforma. */
  userIds: string[];
  /** Pacientes cujas falas usam esta voz do catálogo. */
  patientIds: number[];
}

export async function getVoiceUsage(
  voiceId: string,
  patients: { id: number }[]
): Promise<VoiceUsage> {
  const usersSnap = await firestore
    .collection("users")
    .where("platformVoiceId", "==", voiceId)
    .get();
  const patientIds: number[] = [];
  for (const p of patients) {
    const pid = await getPatientSetting(
      p.id,
      PATIENT_SETTING_KEYS.patientVoicePlatformId
    ).catch(() => undefined);
    if (pid === voiceId) patientIds.push(p.id);
  }
  return { userIds: usersSnap.docs.map((d) => d.id), patientIds };
}

// ——— Resolução de voz (EXCLUSIVA do servidor) ———

export interface ResolvedVoice {
  /** voiceId técnico ElevenLabs — nunca devolvido ao cliente. */
  elevenLabsVoiceId: string | null;
  source: "heloElevenLabs" | "patientElevenLabsClone" | "platformCatalogVoice" | "approvedFallback";
}

/**
 * Voz da PLATAFORMA para um usuário: preferência dele (quando a voz segue
 * ativa no catálogo) → voz padrão da Helo → null (o chamador aplica o
 * fallback aprovado do ambiente). Escolher a voz da plataforma é liberado
 * a todo usuário — é apenas a voz da interface dele.
 */
export async function resolvePlatformVoiceForUser(
  user: AppUser
): Promise<ResolvedVoice> {
  if (user.platformVoiceId) {
    const pref = await getPlatformVoice(user.platformVoiceId);
    if (pref?.enabled) {
      return { elevenLabsVoiceId: pref.elevenLabsVoiceId, source: "heloElevenLabs" };
    }
  }
  const def = await getDefaultPlatformVoice();
  if (def) return { elevenLabsVoiceId: def.elevenLabsVoiceId, source: "heloElevenLabs" };
  return { elevenLabsVoiceId: null, source: "approvedFallback" };
}

/** Estado da voz de UM paciente — sempre lido da subcoleção dele. */
export interface PatientVoiceState {
  hasClone: boolean;
  cloneName: string | null;
  /** Fonte configurada. Sem configuração: clone quando existe, senão platform. */
  source: "clone" | "platform";
  /** Voz do catálogo escolhida quando source = platform (id interno). */
  platformVoiceId: string | null;
}

export async function getPatientVoiceState(
  patientId: number
): Promise<PatientVoiceState> {
  const settings = await getPatientSettings(patientId);
  const clone = settings[PATIENT_SETTING_KEYS.voiceId]?.trim() || null;
  const declared = settings[PATIENT_SETTING_KEYS.patientVoiceSource];
  // Fonte "clone" sem clone atribuído não existe: normaliza para platform.
  const source: "clone" | "platform" =
    declared === "platform" ? "platform" : clone ? "clone" : "platform";
  return {
    hasClone: Boolean(clone),
    cloneName: settings[PATIENT_SETTING_KEYS.voiceCloneName]?.trim() || null,
    source,
    platformVoiceId:
      settings[PATIENT_SETTING_KEYS.patientVoicePlatformId]?.trim() || null,
  };
}

/**
 * Voz das FALAS DO PACIENTE (Emergência, mensagens confirmadas):
 *   fonte "clone"    → voz clonada DESTE paciente (isolamento por subcoleção);
 *   fonte "platform" → a voz aprovada escolhida; se desativada/removida,
 *                      cai na voz padrão da Helo (nunca em clone de outro
 *                      paciente, nunca em voz fora do catálogo).
 * A autoria (speakerRole = patient) não muda com a fonte técnica.
 */
export async function resolvePatientVoice(
  patientId: number
): Promise<ResolvedVoice> {
  const state = await getPatientVoiceState(patientId);
  if (state.source === "clone" && state.hasClone) {
    const clone = await getPatientSetting(patientId, PATIENT_SETTING_KEYS.voiceId);
    if (clone) {
      return { elevenLabsVoiceId: clone, source: "patientElevenLabsClone" };
    }
  }
  if (state.platformVoiceId) {
    const voice = await getPlatformVoice(state.platformVoiceId);
    if (voice?.enabled) {
      return { elevenLabsVoiceId: voice.elevenLabsVoiceId, source: "platformCatalogVoice" };
    }
  }
  const def = await getDefaultPlatformVoice();
  if (def) {
    return { elevenLabsVoiceId: def.elevenLabsVoiceId, source: "platformCatalogVoice" };
  }
  return { elevenLabsVoiceId: null, source: "approvedFallback" };
}

// ——— Validação de um voiceId na ElevenLabs (só no cadastro pelo Admin) ———

export type VoiceValidation =
  | { status: "valid"; name: string | null }
  | { status: "invalid" }
  | { status: "unknown" }; // sem chave ou falha de rede — cadastro segue, sinalizado

export async function validateElevenLabsVoice(
  voiceId: string
): Promise<VoiceValidation> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return { status: "unknown" };
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`,
      { headers: { "xi-api-key": apiKey } }
    );
    if (res.ok) {
      const data = (await res.json()) as { name?: string };
      return { status: "valid", name: data.name ?? null };
    }
    if (res.status === 404 || res.status === 400 || res.status === 422) {
      return { status: "invalid" };
    }
    return { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}
