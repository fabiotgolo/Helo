// ——— Feedback & Support: acesso ao Firestore somente pelo servidor ———

import { firestore } from "@/lib/firestore";
import type { AppUser } from "@/lib/access-types";
import type {
  AdminFeedbackRequest,
  FeedbackMetadata,
  FeedbackMessage,
  FeedbackMessageSenderRole,
  FeedbackConversationStatus,
  FeedbackResolutionSource,
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
  conversationStatus: FeedbackConversationStatus;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  resolvedByName: string | null;
  resolvedByRole: AppUser["role"] | null;
  resolutionSource: FeedbackResolutionSource | null;
  ownerLastReadAt: string | null;
  adminLastReadAt: string | null;
  lastMessageAt: string | null;
  lastMessageSenderRole: FeedbackMessageSenderRole | null;
};

const requests = () => firestore.collection("feedbackRequests");
const messages = (requestId: string) => requests().doc(requestId).collection("messages");

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
    ownerLastReadAt: typeof data.ownerLastReadAt === "string" ? data.ownerLastReadAt : null,
    adminLastReadAt: typeof data.adminLastReadAt === "string" ? data.adminLastReadAt : null,
    lastMessageAt: typeof data.lastMessageAt === "string" ? data.lastMessageAt : null,
    lastMessageSenderRole:
      data.lastMessageSenderRole === "admin" || data.lastMessageSenderRole === "user" || data.lastMessageSenderRole === "system"
        ? data.lastMessageSenderRole
        : null,
    conversationStatus: data.conversationStatus === "resolved" ? "resolved" : "open",
    resolvedAt: typeof data.resolvedAt === "string" ? data.resolvedAt : null,
    resolvedByUserId: typeof data.resolvedByUserId === "string" ? data.resolvedByUserId : null,
    resolvedByName: typeof data.resolvedByName === "string" ? data.resolvedByName : null,
    resolvedByRole: typeof data.resolvedByRole === "string" ? data.resolvedByRole as AppUser["role"] : null,
    resolutionSource:
      data.resolutionSource === "admin" || data.resolutionSource === "user"
        ? data.resolutionSource
        : null,
  };
}

async function unreadMessagesCount(request: StoredFeedback, user: Pick<AppUser, "id" | "role">): Promise<number> {
  const recipient: { senderRoles: FeedbackMessageSenderRole[]; lastReadAt: string | null } | null =
    user.role === "admin" ? { senderRoles: ["user", "system"], lastReadAt: request.adminLastReadAt } :
      request.createdByUserId === user.id ? { senderRoles: ["admin"], lastReadAt: request.ownerLastReadAt } :
        null;
  if (!recipient || !request.lastMessageSenderRole || !recipient.senderRoles.includes(request.lastMessageSenderRole) || !request.lastMessageAt) return 0;
  const snapshot = await messages(request.id).orderBy("createdAt", "asc").get();
  return snapshot.docs.filter((doc) => {
    const data = doc.data();
    return recipient.senderRoles.includes(data.senderRole) && asString(data.createdAt) > (recipient.lastReadAt ?? "");
  }).length;
}

async function toUserRequest(
  request: StoredFeedback,
  user: AppUser,
  voted: Set<string>
): Promise<FeedbackRequest> {
  const unreadCount = await unreadMessagesCount(request, user);
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
    isOwner: request.createdByUserId === user.id,
    archived: request.archived,
    conversationStatus: request.conversationStatus,
    resolvedAt: request.resolvedAt,
    resolutionSource: request.resolutionSource,
    hasUnreadMessages: unreadCount > 0,
    unreadMessagesCount: unreadCount,
  };
}

async function toAdminRequest(request: StoredFeedback): Promise<AdminFeedbackRequest> {
  const unreadCount = await unreadMessagesCount(request, { id: "", role: "admin" });
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
    conversationStatus: request.conversationStatus,
    resolvedAt: request.resolvedAt,
    resolutionSource: request.resolutionSource,
    createdByUserId: request.createdByUserId,
    createdByName: request.createdByName,
    createdByRole: request.createdByRole,
    patientId: request.patientId,
    appVersion: request.appVersion,
    route: request.route,
    metadata: request.metadata,
    resolvedByUserId: request.resolvedByUserId,
    resolvedByName: request.resolvedByName,
    resolvedByRole: request.resolvedByRole,
    hasUnreadMessages: unreadCount > 0,
    unreadMessagesCount: unreadCount,
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
    conversationStatus: "open",
    resolvedAt: null,
    resolvedByUserId: null,
    resolvedByName: null,
    resolvedByRole: null,
    resolutionSource: null,
    ownerLastReadAt: now,
    adminLastReadAt: null,
    lastMessageAt: null,
    lastMessageSenderRole: null,
  });
  return await toUserRequest(
    toStored(ref.id, (await ref.get()).data()!),
    input.user,
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
  const visibleRequests = snapshot.docs
    .map((doc) => toStored(doc.id, doc.data()))
    .filter(
      (request) =>
        user.role === "admin" ||
        request.createdByUserId === user.id ||
        (request.type === "feature" && request.visibility === "public" && !request.archived)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return Promise.all(visibleRequests.map((request) => toUserRequest(request, user, voted)));
}

export async function listFeedbackForAdmin(): Promise<AdminFeedbackRequest[]> {
  const snapshot = await requests().get();
  const allRequests = snapshot.docs
    .map((doc) => toStored(doc.id, doc.data()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return Promise.all(allRequests.map(toAdminRequest));
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
  if (input.visibility) {
    const request = toStored(current.id, current.data()!);
    if (request.type === "bug" && input.visibility !== "private") {
      throw new Error("bugs devem permanecer privados");
    }
    update.visibility = input.visibility;
  }
  if (typeof input.archived === "boolean") update.archived = input.archived;
  await ref.update(update);
}

function canReadFeedbackConversation(request: StoredFeedback, user: AppUser): boolean {
  if (user.role === "admin" || request.createdByUserId === user.id) return true;
  return request.type === "feature" && request.visibility === "public";
}

function toFeedbackMessage(
  id: string,
  requestId: string,
  data: FirebaseFirestore.DocumentData
): FeedbackMessage {
  return {
    id,
    requestId,
    senderUserId: asString(data.senderUserId),
    senderName: asString(data.senderName, "Usuário"),
    senderRole:
      data.senderRole === "admin" || data.senderRole === "system" ? data.senderRole : "user",
    senderAppRole: data.senderRole === "system" ? null : data.senderAppRole as AppUser["role"],
    message: asString(data.message),
    visibility: data.visibility === "public" ? "public" : "private",
    createdAt: asString(data.createdAt),
    editedAt: null,
  };
}

/** Lista e marca como lida a conversa que o usuário tem autorização para ver. */
export async function listFeedbackMessages(input: {
  requestId: string;
  user: AppUser;
}): Promise<FeedbackMessage[]> {
  const ref = requests().doc(input.requestId);
  const requestDoc = await ref.get();
  if (!requestDoc.exists) throw new Error("solicitação não encontrada");
  const request = toStored(requestDoc.id, requestDoc.data()!);
  if (!canReadFeedbackConversation(request, input.user)) throw new Error("acesso negado");
  const snapshot = await messages(input.requestId).orderBy("createdAt", "asc").get();
  const isParticipant = input.user.role === "admin" || request.createdByUserId === input.user.id;
  const visible = snapshot.docs
    .map((doc) => toFeedbackMessage(doc.id, input.requestId, doc.data()))
    .filter((message) => isParticipant || message.visibility === "public");
  if (isParticipant) {
    await ref.update(
      input.user.role === "admin"
        ? { adminLastReadAt: new Date().toISOString() }
        : { ownerLastReadAt: new Date().toISOString() }
    );
  }
  return visible;
}

/** Cria mensagem imutável; papel, remetente e privacidade são sempre derivados no servidor. */
export async function createFeedbackMessage(input: {
  requestId: string;
  user: AppUser;
  message: string;
  visibility?: FeedbackVisibility;
}): Promise<FeedbackMessage> {
  const requestRef = requests().doc(input.requestId);
  const requestDoc = await requestRef.get();
  if (!requestDoc.exists) throw new Error("solicitação não encontrada");
  const request = toStored(requestDoc.id, requestDoc.data()!);
  if (request.conversationStatus !== "open") {
    throw new Error("esta conversa está encerrada");
  }
  const isAdmin = input.user.role === "admin";
  if (!isAdmin && request.createdByUserId !== input.user.id) {
    throw new Error("acesso negado");
  }
  // Respostas de usuários são privadas; Admin decide a visibilidade de features.
  const visibility: FeedbackVisibility =
    request.type === "bug" || !isAdmin ? "private" : input.visibility === "private" ? "private" : "public";
  const now = new Date().toISOString();
  const ref = messages(input.requestId).doc();
  const senderRole: FeedbackMessageSenderRole = isAdmin ? "admin" : "user";
  await firestore.runTransaction(async (transaction) => {
    transaction.set(ref, {
      requestId: input.requestId,
      senderUserId: input.user.id,
      senderName: isAdmin ? "Admin Helo" : input.user.name,
      senderRole,
      senderAppRole: input.user.role,
      message: input.message,
      visibility,
      createdAt: now,
      editedAt: null,
    });
    transaction.update(requestRef, {
      updatedAt: now,
      lastMessageAt: now,
      lastMessageSenderRole: senderRole,
      ...(isAdmin ? { adminLastReadAt: now } : { ownerLastReadAt: now }),
    });
  });
  return {
    id: ref.id,
    requestId: input.requestId,
    senderUserId: input.user.id,
    senderName: isAdmin ? "Admin Helo" : input.user.name,
    senderRole,
    senderAppRole: input.user.role,
    message: input.message,
    visibility,
    createdAt: now,
    editedAt: null,
  };
}

/**
 * O autor ou um Admin encerram a conversa. A mensagem de sistema e o bloqueio
 * de novas respostas são gravados na mesma transação para não haver estado parcial.
 */
export async function resolveFeedbackConversation(input: {
  requestId: string;
  user: AppUser;
}): Promise<FeedbackMessage> {
  const requestRef = requests().doc(input.requestId);
  const messageRef = messages(input.requestId).doc();
  const now = new Date().toISOString();
  const resolutionSource: FeedbackResolutionSource = input.user.role === "admin" ? "admin" : "user";
  const message = resolutionSource === "admin"
    ? "Esta questão foi marcada como resolvida pelo administrador e a conversa foi encerrada."
    : "Esta questão foi marcada como resolvida pelo usuário e a conversa foi encerrada.";

  await firestore.runTransaction(async (transaction) => {
    const requestDoc = await transaction.get(requestRef);
    if (!requestDoc.exists) throw new Error("solicitação não encontrada");
    const feedback = toStored(requestDoc.id, requestDoc.data()!);
    if (feedback.createdByUserId !== input.user.id && input.user.role !== "admin") {
      throw new Error("acesso negado");
    }
    if (feedback.conversationStatus !== "open") throw new Error("esta conversa já está encerrada");

    transaction.set(messageRef, {
      requestId: input.requestId,
      senderUserId: "",
      senderName: "Sistema Helo",
      senderRole: "system",
      senderAppRole: null,
      message,
      // A resolução é um evento da conversa autor/Admin; não expõe o autor
      // na thread pública de uma feature.
      visibility: "private",
      createdAt: now,
      editedAt: null,
    });
    transaction.update(requestRef, {
      conversationStatus: "resolved",
      resolvedAt: now,
      resolvedByUserId: input.user.id,
      resolvedByName: input.user.name,
      resolvedByRole: input.user.role,
      resolutionSource,
      updatedAt: now,
      lastMessageAt: now,
      lastMessageSenderRole: "system",
      ...(input.user.role === "admin" ? { adminLastReadAt: now } : { ownerLastReadAt: now }),
    });
  });

  return {
    id: messageRef.id,
    requestId: input.requestId,
    senderUserId: "",
    senderName: "Sistema Helo",
    senderRole: "system",
    senderAppRole: null,
    message,
    visibility: "private",
    createdAt: now,
    editedAt: null,
  };
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
  const [votes, conversation] = await Promise.all([ref.collection("votes").get(), ref.collection("messages").get()]);
  const batch = firestore.batch();
  votes.docs.forEach((vote) => batch.delete(vote.ref));
  conversation.docs.forEach((message) => batch.delete(message.ref));
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
