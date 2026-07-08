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
  type: EventType;
  category?: string;
  question?: string;
  options?: string[];
  gesture?: Gesture;
  detail?: string;
  responseMs?: number;
}

export interface HeloMessage {
  sessionId: number | null;
  text: string;
  category?: string;
  sensitive?: boolean;
  status: "confirmada" | "descartada";
  confirmations?: number;
}
