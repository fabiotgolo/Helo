// Os três gestos do Helo. ✊ substitui o 👎 convencional,
// que o paciente não consegue fazer.
export type Gesture = "sim" | "nao" | "talvez";

export const GESTURES: Record<
  Gesture,
  { emoji: string; label: string; hint: string }
> = {
  sim: { emoji: "👍", label: "Sim", hint: "Positivo" },
  talvez: { emoji: "✋", label: "Talvez", hint: "Não é bem assim" },
  nao: { emoji: "✊", label: "Não", hint: "Mão fechada" },
};

// ——— Paciente ———
// Cada paciente tem sua própria Helo: frases, gestos, voz, pessoas e
// preferências vivem sob o patientId — nunca em estado global.

export interface Patient {
  id: number;
  name: string;
  active: boolean;
  createdAt: string;
}

// ——— Itens de modo (Rotina, Emergência, expressões de Conversa) ———

export type HeloItemMode = "rotina" | "emergencia" | "conversa";

// Preparação para a orquestração de voz: quem "fala" o item e se a voz
// clonada do paciente exige confirmação por gesto antes de soar.
export type SpeakerRole = "helo" | "patient";
export type ConfirmationStatus =
  | "notRequired"
  | "pending"
  | "confirmed"
  | "rejected";

export interface ModeItem {
  id: string;
  patientId: number;
  mode: HeloItemMode;
  /** Título curto exibido no botão (ex.: "Falta de ar"). */
  label: string;
  /** Frase completa falada em nome do paciente. */
  spokenText: string;
  category: string;
  enabled: boolean;
  /** Ordem de exibição (menor primeiro). Em Emergência, é a prioridade. */
  order: number;
  /** Veio do conteúdo padrão da Helo (pode ser restaurado). */
  isDefault: boolean;
  /** Chave estável do item padrão de origem — permite restaurar sem duplicar. */
  defaultKey: string | null;
  speakerRole: SpeakerRole;
  /** Rotina/Conversa confirmam por gesto; Emergência fala no toque. */
  requiresConfirmation: boolean;
  updatedAt: string;
}

/** Campos editáveis de um item — o restante é derivado no servidor. */
export type ModeItemInput = Partial<
  Pick<ModeItem, "label" | "spokenText" | "category" | "enabled" | "order">
>;

export type EventType =
  | "pergunta_apresentada"
  | "opcao_apresentada"
  | "gesto"
  | "gesto_incerto"
  | "pausa"
  | "retomada"
  | "confirmacao"
  | "reformulacao"
  | "descarte"
  | "emergencia";

export interface HeloEvent {
  sessionId: number | null;
  patientId?: number | null;
  type: EventType;
  category?: string;
  question?: string;
  options?: string[];
  gesture?: Gesture;
  detail?: string;
  responseMs?: number;
  /** Item de modo associado ao gesto (auditoria da resposta observada). */
  itemId?: string;
}

export interface HeloMessage {
  sessionId: number | null;
  patientId?: number | null;
  text: string;
  category?: string;
  sensitive?: boolean;
  status: "confirmada" | "descartada";
  confirmations?: number;
  /** Autoria da fala — contrato para a orquestração de voz. */
  speakerRole?: SpeakerRole;
  confirmationStatus?: ConfirmationStatus;
}
