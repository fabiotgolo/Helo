import { PERMISSIONS, type Permission } from "@/lib/access-types";

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
  | "showGestureChoices"
  // Ponte com o Action Registry: descoberta é local (leitura da tela);
  // execução autoriza no servidor com a permissão declarada pela ação.
  | "getCurrentHeloActions"
  | "interactWithHeloUI";

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

// Forma canônica: sem acentos, minúscula, só tokens alfanuméricos. O Agent
// raramente manda o nome exato da área — vem "Rotina", "routine", "modo
// rotina", "ir para rotinas"… Tudo converge para o mesmo esqueleto de tokens.
function canonicalTokens(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

// Palavras de comando/ligação que antecedem o nome da área e não ajudam a
// identificá-la ("abra rotina", "ir para a rotina", "modo rotina", "tela de
// emergência"). Removidas antes do casamento por sinônimo.
const AREA_FILLER_TOKENS = new Set([
  "abrir", "abra", "abre", "ir", "para", "pra", "vai", "va", "entrar", "entre",
  "entra", "acessar", "acesse", "acessa", "acionar", "acione", "aciona",
  "mostrar", "mostre", "mostra", "modo", "tela", "area", "de", "da", "do", "das",
  "dos", "a", "o", "as", "os", "em", "no", "na", "me", "leve", "leva", "quero",
]);

// Sinônimos/aliases por área — casados como TOKEN inteiro (nunca substring, para
// não confundir "rotina" com "atividades" etc.). O primeiro token exato vence.
const AREA_SYNONYMS: Record<HeloNavigationArea, readonly string[]> = {
  helo: ["helo", "assistente", "agente", "conversar-helo"],
  conversar: ["conversar", "conversa", "conversas", "converse", "papo"],
  rotina: ["rotina", "rotinas", "routine", "routines"],
  emergencia: ["emergencia", "emergencias", "emergency", "socorro", "urgencia"],
  atividades: ["atividades", "atividade", "activities", "activity"],
  ajustes: ["ajustes", "ajuste", "configuracoes", "configuracao", "settings", "preferencias"],
  dashboard: ["dashboard", "painel", "paineis"],
};

/**
 * Resolve a área de navegação de forma tolerante: aceita o nome canônico, o
 * plural, o termo em inglês, e frases com verbo/ligação ("abrir rotina", "ir
 * para as rotinas", "modo rotina"). Retorna undefined quando nada casa — o
 * chamador trata como área inválida. Nunca confunde áreas: o casamento é por
 * token inteiro de sinônimo, não por substring.
 */
export function resolveHeloNavigationArea(value: unknown): HeloNavigationArea | undefined {
  if (typeof value !== "string") return undefined;
  // Atalho: já veio o nome canônico exato.
  if (isHeloNavigationArea(value)) return value;
  const tokens = canonicalTokens(value);
  if (tokens.length === 0) return undefined;
  const meaningful = tokens.filter((t) => !AREA_FILLER_TOKENS.has(t));
  const search = meaningful.length > 0 ? meaningful : tokens;
  for (const token of search) {
    for (const area of HELO_NAVIGATION_AREAS) {
      if (AREA_SYNONYMS[area].includes(token)) return area;
    }
  }
  return undefined;
}

export function isHeloSettingsSection(value: unknown): value is HeloSettingsSection {
  return typeof value === "string" && (HELO_SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export function isHeloPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/** Permissão mínima para autorizar uma navegação; indefinida significa vínculo ativo. */
export function permissionForHeloTool(
  action: HeloClientToolAction,
  options?: {
    area?: HeloNavigationArea;
    section?: HeloSettingsSection;
    /** Permissão declarada pela ação do registry (interactWithHeloUI). */
    permission?: Permission;
  }
): Permission | undefined {
  if (options?.permission) return options.permission;
  if (options?.section) return SETTINGS_SECTION_PERMISSIONS[options.section];
  if (options?.area) return AREA_PERMISSIONS[options.area];
  return ACTION_PERMISSIONS[action];
}
