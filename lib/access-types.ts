// ——— Tipos de usuários, papéis, vínculos e permissões ———
// Módulo neutro (sem imports de servidor): usado tanto pelas rotas de API
// quanto pelas telas de login, Dashboard e Admin.
//
// Princípio central: usuários e pacientes têm relação muitos-para-muitos.
// O papel (role) define o nível GERAL de acesso; o vínculo (AccessLink)
// define QUAIS pacientes o usuário alcança e com quais permissões.

export type UserRole =
  | "admin"
  | "profissional"
  | "cuidador"
  | "familiar"
  | "paciente";

export type ProfessionalType =
  | "enfermeiro"
  | "fonoaudiologo"
  | "terapeuta"
  | "medico"
  | "fisioterapeuta"
  | "terapeuta_ocupacional"
  | "outro";

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Administrador",
  profissional: "Profissional de saúde",
  cuidador: "Cuidador",
  familiar: "Familiar",
  paciente: "Paciente",
};

export const PROFESSIONAL_TYPE_LABELS: Record<ProfessionalType, string> = {
  enfermeiro: "Enfermeiro(a)",
  fonoaudiologo: "Fonoaudiólogo(a)",
  terapeuta: "Terapeuta",
  medico: "Médico(a)",
  fisioterapeuta: "Fisioterapeuta",
  terapeuta_ocupacional: "Terapeuta ocupacional",
  outro: "Outro",
};

// Permissões granulares POR VÍNCULO — não por título profissional.
// Dois familiares do mesmo paciente podem ter conjuntos diferentes.
export const PERMISSIONS = [
  "viewDashboard",
  "viewSessions",
  "viewMetrics",
  "editProfile",
  "editConversation",
  "editRoutine",
  "editEmergency",
  "editGestures",
  "manageVoice",
  "createSession",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  viewDashboard: "Ver Dashboard",
  viewSessions: "Ver sessões",
  viewMetrics: "Ver métricas observacionais",
  editProfile: "Editar perfil e pessoas",
  editConversation: "Editar Conversa",
  editRoutine: "Editar Rotina",
  editEmergency: "Editar Emergência",
  editGestures: "Editar gestos",
  manageVoice: "Gerenciar voz do paciente",
  createSession: "Usar a Helo (criar sessões)",
};

/** Papéis que podem criar pacientes (regra do produto — seção 11). */
export const ROLES_THAT_CREATE_PATIENTS: UserRole[] = [
  "admin",
  "profissional",
  "cuidador",
  "familiar",
];

/** Conjunto inicial sugerido ao criar um vínculo — o Admin pode ajustar. */
export function defaultPermissionsFor(role: UserRole): Permission[] {
  switch (role) {
    case "familiar":
      return ["viewDashboard", "viewSessions", "viewMetrics", "createSession"];
    case "paciente":
      return ["viewDashboard", "viewSessions", "viewMetrics"];
    default:
      // admin/profissional/cuidador: tudo (o vínculo de admin é opcional —
      // o papel admin já dá acesso global).
      return [...PERMISSIONS];
  }
}

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  professionalType: ProfessionalType | null;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface AccessLink {
  id: string;
  userId: string;
  patientId: number;
  /** Papel do usuário NO CONTEXTO deste paciente (herda o role por padrão). */
  accessRole: string;
  permissions: Permission[];
  status: "active" | "revoked";
  grantedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  userId: string | null;
  userName: string | null;
  patientId: number | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  ts: string;
  metadata: Record<string, string> | null;
}

export function hasPermission(
  link: Pick<AccessLink, "permissions" | "status"> | null,
  permission: Permission
): boolean {
  return Boolean(
    link && link.status === "active" && link.permissions.includes(permission)
  );
}
