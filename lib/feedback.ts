// ——— Feedback & Support: acesso ao Firestore somente pelo servidor ———

import { firestore } from "@/lib/firestore";
import type { AppUser } from "@/lib/access-types";
import type {
  AdminFeedbackRequest,
  FeedbackMetadata,
  FeedbackRequest,
  FeedbackStatus,
  FeedbackType,
  FeedbackVisibility,
} from "@/lib/feedback-types";

type StoredFeedback = {
  id: string;
  title: string;
  description: string;
  type: FeedbackType;
  status: FeedbackStatus;
  visibility: FeedbackVisibility;
  createdByUserId: string;
  createdByName: string;
  createdByRole: AppUser["role"];
  patientId: number | null;
  appVersion: string;
  route: string;
  createdAt: string;
  updatedAt: string;
  votesCount: number;
  metadata: FeedbackMetadata | null;
  archived: boolean;
};

const requests = () => firestore.collection("feedbackRequests");

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toStored(id: string, data: FirebaseFirestore.DocumentData): StoredFeedback {
  const type: FeedbackType = data.type === "bug" ? "bug" : "feature";
  const allowedStatuses = new Set<FeedbackStatus>([
    "new",
    "underReview",
    "planned",
    "inProgress",
    "completed",
    "rejected",
    "duplicate",
  ]);
  const status = allowedStatuses.has(data.status as FeedbackStatus)
    ? (data.status as FeedbackStatus)
    : "new";
  return {
    id,
    title: asString(data.title),
    description: asString(data.description),
    type,
    status,
    visibility: data.visibility === "private" ? "private" : "public",
    createdByUserId: asString(data.createdByUserId),
    createdByName: asString(data.createdByName, "Usuário"),
    createdByRole: data.createdByRole as AppUser["role"],
    patientId: typeof data.patientId === "number" ? data.patientId : null,
    appVersion: asString(data.appVersion),
    route: asString(data.route),
    createdAt: asString(data.createdAt),
    updatedAt: asString(data.updatedAt),
    votesCount: Math.max(0, Number(data.votesCount) || 0),
    metadata:
      data.metadata && typeof data.metadata === "object"
        ? {
            browser: asString(data.metadata.browser) || null,
            operatingSystem: asString(data.metadata.operatingSystem) || null,
            viewport: asString(data.metadata.viewport) || null,
          }
        : null,
    archived: data.archived === true,
  };
}

function toUserRequest(
  request: StoredFeedback,
  userId: string,
  voted: Set<string>
): FeedbackRequest {
  return {
    id: request.id,
    title: request.title,
    description: request.description,
    type: request.type,
    status: request.status,
    visibility: request.visibility,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    votesCount: request.votesCount,
    hasVoted: voted.has(request.id),
    isOwner: request.createdByUserId === userId,
    archived: request.archived,
  };
}

function toAdminRequest(request: StoredFeedback): AdminFeedbackRequest {
  return {
    id: request.id,
    title: request.title,
    description: request.description,
    type: request.type,
    status: request.status,
    visibility: request.visibility,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    votesCount: request.votesCount,
    archived: request.archived,
    createdByUserId: request.createdByUserId,
    createdByName: request.createdByName,
    createdByRole: request.createdByRole,
    patientId: request.patientId,
    appVersion: request.appVersion,
    route: request.route,
    metadata: request.metadata,
  };
}

export async function createFeedback(input: {
  user: AppUser;
  title: string;
  description: string;
  type: FeedbackType;
  patientId: number | null;
  appVersion: string;
  route: string;
  metadata: FeedbackMetadata | null;
}): Promise<FeedbackRequest> {
  const now = new Date().toISOString();
  const ref = requests().doc();
  const visibility: FeedbackVisibility = input.type === "bug" ? "private" : "public";
  await ref.set({
    title: input.title,
    description: input.description,
    type: input.type,
    status: "new",
    visibility,
    createdByUserId: input.user.id,
    createdByName: input.user.name,
    createdByRole: input.user.role,
    patientId: input.patientId,
    appVersion: input.appVersion,
    route: input.route,
    createdAt: now,
    updatedAt: now,
    votesCount: 0,
    metadata: input.metadata,
    archived: false,
  });
  return toUserRequest(
    toStored(ref.id, (await ref.get()).data()!),
    input.user.id,
    new Set()
  );
}

export async function listFeedbackForUser(user: AppUser): Promise<FeedbackRequest[]> {
  const [snapshot, votes] = await Promise.all([
    requests().get(),
    firestore.collectionGroup("votes").where("userId", "==", user.id).get(),
  ]);
  const voted = new Set(
    votes.docs
      .map((vote) => vote.ref.parent.parent?.id)
      .filter((id): id is string => Boolean(id))
  );
  return snapshot.docs
    .map((doc) => toStored(doc.id, doc.data()))
    .filter(
      (request) =>
        request.createdByUserId === user.id ||
        (request.type === "feature" && request.visibility === "public" && !request.archived)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((request) => toUserRequest(request, user.id, voted));
}

export async function listFeedbackForAdmin(): Promise<AdminFeedbackRequest[]> {
  const snapshot = await requests().get();
  return snapshot.docs
    .map((doc) => toStored(doc.id, doc.data()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(toAdminRequest);
}

export async function toggleFeedbackVote(input: {
  requestId: string;
  userId: string;
}): Promise<{ hasVoted: boolean; votesCount: number }> {
  const requestRef = requests().doc(input.requestId);
  const voteRef = requestRef.collection("votes").doc(input.userId);
  return firestore.runTransaction(async (transaction) => {
    const [requestDoc, voteDoc] = await Promise.all([
      transaction.get(requestRef),
      transaction.get(voteRef),
    ]);
    if (!requestDoc.exists) throw new Error("solicitação não encontrada");
    const request = toStored(requestDoc.id, requestDoc.data()!);
    if (
      request.type !== "feature" ||
      request.visibility !== "public" ||
      request.archived
    ) {
      throw new Error("esta solicitação não aceita votos");
    }
    const hasVoted = !voteDoc.exists;
    const votesCount = Math.max(0, request.votesCount + (hasVoted ? 1 : -1));
    if (hasVoted) {
      transaction.set(voteRef, { userId: input.userId, createdAt: new Date().toISOString() });
    } else {
      transaction.delete(voteRef);
    }
    transaction.update(requestRef, { votesCount, updatedAt: new Date().toISOString() });
    return { hasVoted, votesCount };
  });
}

export async function updateFeedback(input: {
  id: string;
  status?: FeedbackStatus;
  visibility?: FeedbackVisibility;
  archived?: boolean;
}): Promise<void> {
  const ref = requests().doc(input.id);
  const current = await ref.get();
  if (!current.exists) throw new Error("solicitação não encontrada");
  const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.status) update.status = input.status;
  if (input.visibility) update.visibility = input.visibility;
  if (typeof input.archived === "boolean") update.archived = input.archived;
  await ref.update(update);
}

/** Edição do conteúdo: exclusiva de quem criou a solicitação. */
export async function updateFeedbackContent(input: {
  id: string;
  userId: string;
  title: string;
  description: string;
}): Promise<void> {
  const ref = requests().doc(input.id);
  const current = await ref.get();
  if (!current.exists) throw new Error("solicitação não encontrada");
  const request = toStored(current.id, current.data()!);
  if (request.createdByUserId !== input.userId) {
    throw new Error("você só pode editar solicitações enviadas por você");
  }
  await ref.update({
    title: input.title,
    description: input.description,
    updatedAt: new Date().toISOString(),
  });
}

async function deleteFeedbackRef(ref: FirebaseFirestore.DocumentReference): Promise<void> {
  const votes = await ref.collection("votes").get();
  const batch = firestore.batch();
  votes.docs.forEach((vote) => batch.delete(vote.ref));
  batch.delete(ref);
  await batch.commit();
}

/** Exclusão administrativa: Admin pode remover qualquer solicitação. */
export async function deleteFeedback(id: string): Promise<void> {
  const ref = requests().doc(id);
  const current = await ref.get();
  if (!current.exists) throw new Error("solicitação não encontrada");
  await deleteFeedbackRef(ref);
}

/** Autor remove a própria solicitação; Admin pode remover qualquer uma. */
export async function deleteFeedbackForUser(input: {
  id: string;
  user: AppUser;
}): Promise<void> {
  const ref = requests().doc(input.id);
  const current = await ref.get();
  if (!current.exists) throw new Error("solicitação não encontrada");
  const request = toStored(current.id, current.data()!);
  if (request.createdByUserId !== input.user.id && input.user.role !== "admin") {
    throw new Error("você só pode excluir solicitações enviadas por você");
  }
  await deleteFeedbackRef(ref);
}
