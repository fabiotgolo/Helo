import type { Permission } from "@/lib/access-types";

// Contrato fechado entre as Client Tools configuradas no Agent e a interface.
// Nunca derive URLs ou permissões de valores enviados pelo Agent.
export const HELO_NAVIGATION_AREAS = [
  "helo",
  "conversar",
  "rotina",
  "emergencia",
  "atividades",
  "ajustes",
  "dashboard",
] as const;

export type HeloNavigationArea = (typeof HELO_NAVIGATION_AREAS)[number];

export const HELO_SETTINGS_SECTIONS = [
  "paciente",
  "aparencia",
  "voz_helo",
  "gestos",
  "comunicacao",
] as const;

export type HeloSettingsSection = (typeof HELO_SETTINGS_SECTIONS)[number];

export type HeloClientToolAction =
  | "navigateHeloArea"
  | "openPatientSettings"
  | "openRoutineMode"
  | "openEmergencyMode"
  | "openActivitiesMode"
  | "showGestureChoices";

export const HELO_AREA_ROUTES: Record<HeloNavigationArea, string> = {
  helo: "/helo",
  conversar: "/conversa",
  rotina: "/rotina",
  emergencia: "/emergencia",
  atividades: "/atividades",
  ajustes: "/ajustes",
  dashboard: "/dashboard",
};

const ACTION_PERMISSIONS: Partial<Record<HeloClientToolAction, Permission>> = {
  openActivitiesMode: "viewActivities",
};

const AREA_PERMISSIONS: Partial<Record<HeloNavigationArea, Permission>> = {
  atividades: "viewActivities",
  dashboard: "viewDashboard",
};

const SETTINGS_SECTION_PERMISSIONS: Partial<Record<HeloSettingsSection, Permission>> = {
  paciente: "editProfile",
  gestos: "editGestures",
  comunicacao: "editConversation",
};

export function isHeloNavigationArea(value: unknown): value is HeloNavigationArea {
  return typeof value === "string" && (HELO_NAVIGATION_AREAS as readonly string[]).includes(value);
}

export function isHeloSettingsSection(value: unknown): value is HeloSettingsSection {
  return typeof value === "string" && (HELO_SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/** Permissão mínima para autorizar uma navegação; indefinida significa vínculo ativo. */
export function permissionForHeloTool(
  action: HeloClientToolAction,
  options?: { area?: HeloNavigationArea; section?: HeloSettingsSection }
): Permission | undefined {
  if (options?.section) return SETTINGS_SECTION_PERMISSIONS[options.section];
  if (options?.area) return AREA_PERMISSIONS[options.area];
  return ACTION_PERMISSIONS[action];
}
