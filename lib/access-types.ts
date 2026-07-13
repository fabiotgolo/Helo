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
//
// Voz (arquitetura de catálogo controlado):
//   - o CATÁLOGO de vozes da plataforma e a VOZ CLONADA do paciente são
//     exclusivos do Admin (rotas /api/admin/* — não existem como permissão
//     de vínculo, por construção);
//   - "selectPatientVoiceSource" permite ao usuário vinculado escolher a
//     FONTE da voz das falas do paciente (clone dele ou voz aprovada do
//     catálogo). Substitui a antiga "manageVoice" (que deixava gravar um
//     voiceId livre) — vínculos antigos com manageVoice são mapeados;
//   - a permissão de escolher a voz da PLATAFORMA é do usuário (não do
//     vínculo): AppUser.canSelectPlatformVoice, concedida pelo Admin;
//   - VER o status da voz (configurada/não, nunca IDs) segue coberto pelo
//     próprio vínculo ativo — equivale à "viewPatientVoiceStatus".
export const PERMISSIONS = [
  "viewDashboard",
  "viewSessions",
  "viewMetrics",
  "editProfile",
  "editConversation",
  "editRoutine",
  "editEmergency",
  "editGestures",
  "selectPatientVoiceSource",
  "createSession",
  // Atividades (sessões personalizadas) — permissões próprias, POR VÍNCULO,
  // nunca derivadas da profissão (regra do produto — seção 12):
  "viewActivities",
  "runActivities",
  "createActivities",
  "editActivities",
  "deleteActivities",
  "viewActivityResults",
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
  selectPatientVoiceSource: "Escolher a voz das falas do paciente",
  createSession: "Usar a Helo (criar sessões)",
  viewActivities: "Ver Atividades personalizadas",
  runActivities: "Executar Atividades",
  createActivities: "Criar Atividades",
  editActivities: "Editar Atividades",
  deleteActivities: "Excluir Atividades",
  viewActivityResults: "Ver resultados das Atividades",
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
      // Familiares veem e executam Atividades; criar/editar conteúdo
      // (inclusive afetivo) é concessão explícita do Admin.
      return [
        "viewDashboard",
        "viewSessions",
        "viewMetrics",
        "createSession",
        "viewActivities",
        "runActivities",
      ];
    case "paciente":
      return ["viewDashboard", "viewSessions", "viewMetrics", "viewActivities"];
    default:
      // admin/profissional/cuidador: tudo, EXCETO:
      //   - selectPatientVoiceSource — a escolha da voz do paciente nunca é
      //     concedida automaticamente por papel, só por decisão explícita;
      //   - criar/editar/excluir Atividades — a permissão não depende da
      //     profissão (seção 12): ser profissional de saúde não concede
      //     edição sozinho. Ver/executar/acompanhar resultados entram.
      const explicitOnly: Permission[] = [
        "selectPatientVoiceSource",
        "createActivities",
        "editActivities",
        "deleteActivities",
      ];
      return PERMISSIONS.filter((p) => !explicitOnly.includes(p));
  }
}

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  professionalType: ProfessionalType | null;
  status: "active" | "inactive";
  /** Concedida pelo Admin: pode escolher a própria voz da plataforma. */
  canSelectPlatformVoice: boolean;
  /** Preferência do usuário: id de voz do CATÁLOGO (nunca voiceId técnico). */
  platformVoiceId: string | null;
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
