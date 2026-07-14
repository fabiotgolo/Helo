// Tipos compartilhados entre a interface e as rotas de Feedback & Support.

import type { UserRole } from "@/lib/access-types";

export const FEEDBACK_TYPES = ["feature", "bug"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const FEEDBACK_STATUSES = [
  "new",
  "underReview",
  "planned",
  "inProgress",
  "completed",
  "rejected",
  "duplicate",
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export type FeedbackVisibility = "public" | "private";
export type FeedbackMessageSenderRole = "user" | "admin";

export const FEEDBACK_TYPE_LABELS: Record<FeedbackType, string> = {
  feature: "Recurso",
  bug: "Bug",
};

export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  new: "Novo",
  underReview: "Em análise",
  planned: "Planejada",
  inProgress: "Em desenvolvimento",
  completed: "Concluída",
  rejected: "Rejeitada",
  duplicate: "Duplicada",
};

export function isFeedbackType(value: unknown): value is FeedbackType {
  return typeof value === "string" && (FEEDBACK_TYPES as readonly string[]).includes(value);
}

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === "string" && (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

export interface FeedbackMetadata {
  browser: string | null;
  operatingSystem: string | null;
  viewport: string | null;
}

export interface FeedbackRequest {
  id: string;
  title: string;
  description: string;
  type: FeedbackType;
  status: FeedbackStatus;
  visibility: FeedbackVisibility;
  createdAt: string;
  updatedAt: string;
  votesCount: number;
  hasVoted: boolean;
  isOwner: boolean;
  archived: boolean;
  hasUnreadMessages: boolean;
  unreadMessagesCount: number;
}

export interface AdminFeedbackRequest extends Omit<FeedbackRequest, "hasVoted" | "isOwner"> {
  createdByUserId: string;
  createdByName: string;
  createdByRole: UserRole;
  patientId: number | null;
  appVersion: string;
  route: string;
  metadata: FeedbackMetadata | null;
}

/** Mensagem imutável da conversa vinculada a uma solicitação de feedback. */
export interface FeedbackMessage {
  id: string;
  requestId: string;
  senderUserId: string;
  senderName: string;
  senderRole: FeedbackMessageSenderRole;
  senderAppRole: UserRole;
  message: string;
  visibility: FeedbackVisibility;
  createdAt: string;
  editedAt: null;
}
