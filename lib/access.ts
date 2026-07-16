// ——— Camada de dados de usuários, vínculos e auditoria (Firestore) ———
// Complementa lib/store.ts (dados do paciente) sem duplicá-lo: aqui vivem
// as contas (users), os vínculos usuário↔paciente (userPatientAccess) e o
// registro de auditoria (auditEvents).
//
// A unidade de armazenamento dos DADOS continua sendo o paciente — vínculos
// concedem acesso, nunca criam cópias.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { firestore } from "@/lib/firestore";
import type {
  AccessLink,
  AppUser,
  HeloVoicePreference,
  AuditEvent,
  Permission,
  ProfessionalType,
  UserRole,
} from "@/lib/access-types";
import { PERMISSIONS, sanitizeFontScales } from "@/lib/access-types";

const col = {
  users: () => firestore.collection("users"),
  access: () => firestore.collection("userPatientAccess"),
  audit: () => firestore.collection("auditEvents"),
  authSessions: () => firestore.collection("authSessions"),
};

// ---------- Senhas (scrypt, sem dependências novas) ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

// ---------- Usuários ----------

function toUser(id: string, v: FirebaseFirestore.DocumentData): AppUser {
  return {
    id,
    name: String(v.name ?? ""),
    email: String(v.email ?? ""),
    role: (v.role as UserRole) ?? "familiar",
    professionalType: (v.professionalType as ProfessionalType) ?? null,
    status: v.status === "inactive" ? "inactive" : "active",
    canSelectPlatformVoice: v.canSelectPlatformVoice === true,
    platformVoiceId: v.platformVoiceId ? String(v.platformVoiceId) : null,
    heloVoicePreference:
      v.heloVoicePreference === "male" || v.heloVoicePreference === "female"
        ? v.heloVoicePreference
        : null,
    themePreference: v.themePreference ? String(v.themePreference) : null,
    themeFontScales: sanitizeFontScales(v.themeFontScales),
    createdAt: String(v.createdAt ?? ""),
    updatedAt: String(v.updatedAt ?? ""),
  };
}

export async function countUsers(): Promise<number> {
  const snap = await col.users().limit(1).get();
  return snap.size;
}

export async function listUsers(): Promise<AppUser[]> {
  const snap = await col.users().get();
  return snap.docs
    .map((d) => toUser(d.id, d.data()))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export async function getUserById(id: string): Promise<AppUser | null> {
  const doc = await col.users().doc(id).get();
  return doc.exists ? toUser(doc.id, doc.data()!) : null;
}

export async function getUserByEmail(
  email: string
): Promise<(AppUser & { passwordHash: string }) | null> {
  const snap = await col
    .users()
    .where("email", "==", email.trim().toLowerCase())
    .limit(1)
    .get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { ...toUser(d.id, d.data()), passwordHash: String(d.data().passwordHash ?? "") };
}

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  professionalType?: ProfessionalType | null;
}): Promise<AppUser> {
  const email = input.email.trim().toLowerCase();
  if (await getUserByEmail(email)) {
    throw new Error("já existe um usuário com este email");
  }
  const now = new Date().toISOString();
  const ref = col.users().doc();
  await ref.set({
    name: input.name.trim(),
    email,
    passwordHash: hashPassword(input.password),
    role: input.role,
    professionalType: input.professionalType ?? null,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return toUser(ref.id, (await ref.get()).data()!);
}

export async function updateUser(
  id: string,
  updates: {
    name?: string;
    email?: string;
    role?: UserRole;
    professionalType?: ProfessionalType | null;
    status?: "active" | "inactive";
    password?: string;
    canSelectPlatformVoice?: boolean;
  }
): Promise<void> {
  const data: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (updates.name?.trim()) data.name = updates.name.trim();
  if (updates.email?.trim()) data.email = updates.email.trim().toLowerCase();
  if (updates.role) data.role = updates.role;
  if (updates.professionalType !== undefined)
    data.professionalType = updates.professionalType;
  if (updates.status) data.status = updates.status;
  if (updates.password) data.passwordHash = hashPassword(updates.password);
  if (updates.canSelectPlatformVoice !== undefined)
    data.canSelectPlatformVoice = updates.canSelectPlatformVoice;
  await col.users().doc(id).set(data, { merge: true });
  // Conta desativada não mantém sessões vivas.
  if (updates.status === "inactive") await invalidateUserSessions(id);
}

/** Exclusão de usuário: remove conta, sessões e vínculos. Pacientes ficam. */
export async function deleteUser(id: string): Promise<void> {
  await invalidateUserSessions(id);
  const links = await listLinksForUser(id, true);
  const batch = firestore.batch();
  links.forEach((l) => batch.delete(col.access().doc(l.id)));
  batch.delete(col.users().doc(id));
  await batch.commit();
}

/**
 * Preferência de voz da plataforma DO USUÁRIO (id do catálogo interno,
 * nunca voiceId técnico). null limpa — volta à voz padrão da Helo.
 * A escolha de um usuário nunca altera a experiência dos demais.
 */
export async function setUserPlatformVoice(
  userId: string,
  platformVoiceId: string | null
): Promise<void> {
  await col.users().doc(userId).set(
    { platformVoiceId, updatedAt: new Date().toISOString() },
    { merge: true }
  );
}

/** Preferência da voz do Agent Helo; não é uma configuração do paciente. */
export async function setUserHeloVoicePreference(
  userId: string,
  heloVoicePreference: HeloVoicePreference
): Promise<void> {
  await col.users().doc(userId).set(
    { heloVoicePreference, updatedAt: new Date().toISOString() },
    { merge: true }
  );
}

/**
 * Preferências VISUAIS do usuário (tema de cores e escala de fonte por tema).
 * Escopo estritamente pessoal: nunca toca no paciente nem na experiência de
 * outros usuários. Campos omitidos ficam como estão; null limpa (volta ao
 * padrão/armazenamento local).
 */
export async function setUserTheme(
  userId: string,
  prefs: {
    themePreference?: string | null;
    themeFontScales?: Record<string, number> | null;
  }
): Promise<void> {
  const data: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (prefs.themePreference !== undefined) data.themePreference = prefs.themePreference;
  if (prefs.themeFontScales !== undefined) data.themeFontScales = prefs.themeFontScales;
  await col.users().doc(userId).set(data, { merge: true });
}

// ---------- Sessões de autenticação ----------

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createAuthSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  await col.authSessions().doc(token).set({
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  });
  return token;
}

export async function getSessionUserId(token: string): Promise<string | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const doc = await col.authSessions().doc(token).get();
  if (!doc.exists) return null;
  const v = doc.data()!;
  if (String(v.expiresAt) < new Date().toISOString()) {
    await doc.ref.delete();
    return null;
  }
  return String(v.userId);
}

export async function destroyAuthSession(token: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(token)) return;
  await col.authSessions().doc(token).delete();
}

export async function invalidateUserSessions(userId: string): Promise<void> {
  const snap = await col.authSessions().where("userId", "==", userId).get();
  const batch = firestore.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

// ---------- Vínculos usuário ↔ paciente ----------

function toLink(id: string, v: FirebaseFirestore.DocumentData): AccessLink {
  const perms = Array.isArray(v.permissions)
    ? (v.permissions as string[])
        // Migração: a antiga "manageVoice" equivale à atual escolha da
        // fonte da voz do paciente — vínculos existentes nada perdem.
        .map((p) => (p === "manageVoice" ? "selectPatientVoiceSource" : p))
        .filter((p): p is Permission =>
          (PERMISSIONS as readonly string[]).includes(p)
        )
    : [];
  return {
    id,
    userId: String(v.userId ?? ""),
    patientId: Number(v.patientId),
    accessRole: String(v.accessRole ?? ""),
    permissions: perms,
    status: v.status === "revoked" ? "revoked" : "active",
    grantedByUserId: (v.grantedByUserId as string) ?? null,
    createdAt: String(v.createdAt ?? ""),
    updatedAt: String(v.updatedAt ?? ""),
  };
}

export async function listLinks(): Promise<AccessLink[]> {
  const snap = await col.access().get();
  return snap.docs.map((d) => toLink(d.id, d.data()));
}

export async function listLinksForUser(
  userId: string,
  includeRevoked = false
): Promise<AccessLink[]> {
  const snap = await col.access().where("userId", "==", userId).get();
  return snap.docs
    .map((d) => toLink(d.id, d.data()))
    .filter((l) => includeRevoked || l.status === "active");
}

export async function listLinksForPatient(
  patientId: number
): Promise<AccessLink[]> {
  const snap = await col.access().where("patientId", "==", patientId).get();
  return snap.docs
    .map((d) => toLink(d.id, d.data()))
    .filter((l) => l.status === "active");
}

/** Vínculo ativo de um usuário com um paciente — a chave da autorização. */
export async function getLink(
  userId: string,
  patientId: number
): Promise<AccessLink | null> {
  const links = await listLinksForUser(userId);
  return links.find((l) => l.patientId === patientId) ?? null;
}

export async function getLinkById(id: string): Promise<AccessLink | null> {
  const doc = await col.access().doc(id).get();
  return doc.exists ? toLink(doc.id, doc.data()!) : null;
}

/** Cria (ou reativa) o vínculo — nunca duplica: 1 usuário × 1 paciente. */
export async function grantAccess(input: {
  userId: string;
  patientId: number;
  accessRole: string;
  permissions: Permission[];
  grantedByUserId: string | null;
}): Promise<AccessLink> {
  const now = new Date().toISOString();
  // id determinístico: um doc por par usuário-paciente.
  const id = `${input.userId}_${input.patientId}`;
  await col.access().doc(id).set({
    userId: input.userId,
    patientId: input.patientId,
    accessRole: input.accessRole,
    permissions: input.permissions,
    status: "active",
    grantedByUserId: input.grantedByUserId,
    createdAt: now,
    updatedAt: now,
  });
  return (await getLinkById(id))!;
}

export async function updateLink(
  id: string,
  updates: { accessRole?: string; permissions?: Permission[] }
): Promise<void> {
  const data: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (updates.accessRole !== undefined) data.accessRole = updates.accessRole;
  if (updates.permissions !== undefined) data.permissions = updates.permissions;
  await col.access().doc(id).set(data, { merge: true });
}

/** Revogar acesso NÃO deleta o paciente — só remove o vínculo. */
export async function revokeLink(id: string): Promise<void> {
  await col.access().doc(id).delete();
}

export async function listPatientIdsForUser(userId: string): Promise<number[]> {
  const links = await listLinksForUser(userId);
  return links.map((l) => l.patientId);
}

// ---------- Auditoria ----------
// Rastreabilidade sem exposição: registra quem/o quê/quando, nunca o
// conteúdo sensível da comunicação.

export async function logAudit(e: {
  userId: string | null;
  userName?: string | null;
  patientId?: number | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, string> | null;
}): Promise<void> {
  try {
    await col.audit().add({
      userId: e.userId,
      userName: e.userName ?? null,
      patientId: e.patientId ?? null,
      action: e.action,
      entityType: e.entityType ?? null,
      entityId: e.entityId ?? null,
      metadata: e.metadata ?? null,
      ts: new Date().toISOString(),
    });
  } catch {
    // Auditoria nunca derruba a operação principal.
  }
}

export async function listAudit(limit = 100): Promise<AuditEvent[]> {
  const snap = await col.audit().get();
  return snap.docs
    .map((d) => {
      const v = d.data();
      return {
        id: d.id,
        userId: (v.userId as string) ?? null,
        userName: (v.userName as string) ?? null,
        patientId: v.patientId != null ? Number(v.patientId) : null,
        action: String(v.action ?? ""),
        entityType: (v.entityType as string) ?? null,
        entityId: (v.entityId as string) ?? null,
        ts: String(v.ts ?? ""),
        metadata: (v.metadata as Record<string, string>) ?? null,
      };
    })
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, limit);
}
