// ——— Perguntas em tempo real: tipos do domínio ———
// Módulo neutro (sem imports de servidor): tipos compartilhados entre a
// máquina de estados, a camada de persistência e as rotas de API.
//
// PRINCÍPIO CENTRAL (regra do produto): o Helo NÃO responde pelo paciente.
// O sistema registra somente a resposta OBSERVADA pelo assistente e preserva,
// em estados distintos, a diferença entre:
//   - resposta observada          → PROVISIONAL_RESPONSE (seleção provisória)
//   - seleção conferida           → assistantVerifiedAt
//   - resposta confirmada         → CONFIRMED
//   - gesto incerto               → UNCERTAIN_GESTURE
//   - ausência de resposta        → NO_RESPONSE
//   - resposta corrigida          → correctionCount + trilha de auditoria
//   - interação interrompida      → CANCELED
// Nenhuma resposta é ampliada, interpretada ou transformada em declaração
// diferente da observada.
//
// ESCOPO DOS GESTOS: neste modo — e SOMENTE nele — o segundo gesto significa
// TALVEZ (MAYBE). Fora daqui o significado atual do produto é preservado
// (lib/types.ts e lib/gestures.tsx: `talvez` = "não é bem assim"/reformular).
// Este arquivo não importa nem redefine nada daqueles módulos.

// ---------- Respostas semânticas ----------

/** As três respostas semânticas deste modo. */
export type SemanticResponse = "YES" | "MAYBE" | "NO";

export const SEMANTIC_RESPONSES: readonly SemanticResponse[] = [
  "YES",
  "MAYBE",
  "NO",
] as const;

export const SEMANTIC_RESPONSE_LABELS: Record<SemanticResponse, string> = {
  YES: "SIM",
  MAYBE: "TALVEZ",
  NO: "NÃO",
};

export function isSemanticResponse(v: unknown): v is SemanticResponse {
  return (
    typeof v === "string" &&
    (SEMANTIC_RESPONSES as readonly string[]).includes(v)
  );
}

// ---------- Modo de interação ----------
// O significado dos três sinais do paciente NUNCA é implícito: ele é uma
// propriedade declarada do que está na tela. Sem isto, "opção 2" e "TALVEZ"
// ocupariam o mesmo botão sem nada no modelo distinguindo os dois.
//
//   CLOSED_CONFIRMATION        → SIM · TALVEZ · NÃO (pergunta fechada)
//   OPTION_SELECTION           → opção 1 · opção 2 · opção 3
//   FINAL_STATEMENT_CONFIRMATION → SIM · TALVEZ · NÃO (frase completa)
//   CAREGIVER_INTERPRETATION   → SIM · TALVEZ · NÃO (o que o cuidador entendeu)
//
// Em OPTION_SELECTION os rótulos SIM/TALVEZ/NÃO ficam OCULTOS; o gesto físico
// e o emoji de cada posição continuam exatamente os mesmos do paciente.
//
// CAREGIVER_INTERPRETATION (Fase 4.2) é o único modo cujo nome fala da ORIGEM
// do texto, e não do significado dos sinais — que ali continuam sendo SIM,
// TALVEZ e NÃO. Ele existe porque a distinção importa para quem opera: o texto
// apresentado foi formulado pelo CUIDADOR, e o selo precisa dizer isso, sob
// pena de a tela sugerir que o paciente já declarou aquilo.

export type InteractionMode =
  | "CLOSED_CONFIRMATION"
  | "OPTION_SELECTION"
  | "FINAL_STATEMENT_CONFIRMATION"
  | "CAREGIVER_INTERPRETATION";

export const INTERACTION_MODES: readonly InteractionMode[] = [
  "CLOSED_CONFIRMATION",
  "OPTION_SELECTION",
  "FINAL_STATEMENT_CONFIRMATION",
  "CAREGIVER_INTERPRETATION",
] as const;

export const INTERACTION_MODE_LABELS: Record<InteractionMode, string> = {
  CLOSED_CONFIRMATION: "Pergunta fechada",
  OPTION_SELECTION: "Escolha entre opções",
  FINAL_STATEMENT_CONFIRMATION: "Confirmação da frase",
  CAREGIVER_INTERPRETATION: "Interpretação do cuidador",
};

/** Explica ao assistente o que os três sinais significam AGORA. */
export const INTERACTION_MODE_HINTS: Record<InteractionMode, string> = {
  CLOSED_CONFIRMATION:
    "Os sinais do paciente significam SIM, TALVEZ e NÃO.",
  OPTION_SELECTION:
    "Os sinais do paciente significam opção 1, opção 2 e opção 3 — não SIM, TALVEZ e NÃO.",
  FINAL_STATEMENT_CONFIRMATION:
    "Os sinais do paciente significam SIM, TALVEZ e NÃO sobre a frase apresentada.",
  CAREGIVER_INTERPRETATION:
    "Os sinais do paciente significam SIM, TALVEZ e NÃO sobre o que o cuidador entendeu.",
};

export function isInteractionMode(v: unknown): v is InteractionMode {
  return (
    typeof v === "string" && (INTERACTION_MODES as readonly string[]).includes(v)
  );
}

/** Só nestes modos SIM/TALVEZ/NÃO podem aparecer como rótulo (§2). */
export function showsSemanticLabels(mode: InteractionMode): boolean {
  return mode !== "OPTION_SELECTION";
}

// ---------- Configuração: sinal físico → resposta semântica ----------
// O sistema NÃO detecta nem interpreta o sinal nesta fase. O assistente
// continua selecionando manualmente a resposta observada; esta camada apenas
// declara, por paciente, qual sinal físico corresponde a qual resposta.

/**
 * Métodos de entrada previstos. Só GESTURE é usado nesta fase; os demais
 * existem para que o modelo não precise mudar quando forem implementados.
 */
export type ResponseInputMethod =
  | "GESTURE"
  | "GAZE"
  | "BLINK"
  | "TOUCH"
  | "BODY_MOVEMENT"
  | "ASSISTIVE_DEVICE";

export const RESPONSE_INPUT_METHODS: readonly ResponseInputMethod[] = [
  "GESTURE",
  "GAZE",
  "BLINK",
  "TOUCH",
  "BODY_MOVEMENT",
  "ASSISTIVE_DEVICE",
] as const;

export function isResponseInputMethod(v: unknown): v is ResponseInputMethod {
  return (
    typeof v === "string" &&
    (RESPONSE_INPUT_METHODS as readonly string[]).includes(v)
  );
}

/**
 * Um sinal físico observável do paciente ligado a UMA resposta semântica.
 *
 *   gesto físico configurado → resposta semântica
 *   positivo      → YES
 *   palma aberta  → MAYBE
 *   mão fechada   → NO
 */
export interface ResponseSignalMapping {
  method: ResponseInputMethod;
  /** Chave estável do sinal dentro do método (ex.: "sim" | "talvez" | "nao"). */
  signalKey: string;
  /** Rótulo observável, escrito por quem configurou ("palma aberta"). */
  label: string;
  response: SemanticResponse;
}

/** Configuração vinculada ao paciente — nunca global, nunca por usuário. */
export interface PatientResponseProfile {
  patientId: number;
  mappings: ResponseSignalMapping[];
  updatedByUserId: string | null;
  updatedAt: string;
}

/**
 * Padrão inicial deste modo, e SOMENTE dele: as chaves de sinal coincidem com
 * os gestos atuais do Helo, mas o significado declarado aqui não altera o
 * significado deles em nenhuma outra atividade.
 */
export const DEFAULT_RESPONSE_MAPPINGS: readonly ResponseSignalMapping[] = [
  { method: "GESTURE", signalKey: "sim", label: "Positivo", response: "YES" },
  { method: "GESTURE", signalKey: "talvez", label: "Palma aberta", response: "MAYBE" },
  { method: "GESTURE", signalKey: "nao", label: "Mão fechada", response: "NO" },
] as const;

// ---------- Perguntas sensíveis ----------
// Preparação do modelo. NÃO há detecção automática nesta fase: quem marca a
// pergunta como sensível é o assistente.

export type SensitiveCategory =
  | "MEDICAL"
  | "LEGAL"
  | "FINANCIAL"
  | "FAMILY_CONFLICT"
  | "PROPERTY"
  | "RELIGION"
  | "FAREWELL"
  | "OTHER_SENSITIVE";

export const SENSITIVE_CATEGORIES: readonly SensitiveCategory[] = [
  "MEDICAL",
  "LEGAL",
  "FINANCIAL",
  "FAMILY_CONFLICT",
  "PROPERTY",
  "RELIGION",
  "FAREWELL",
  "OTHER_SENSITIVE",
] as const;

export const SENSITIVE_CATEGORY_LABELS: Record<SensitiveCategory, string> = {
  MEDICAL: "Saúde",
  LEGAL: "Jurídico",
  FINANCIAL: "Financeiro",
  FAMILY_CONFLICT: "Conflito familiar",
  PROPERTY: "Bens e patrimônio",
  RELIGION: "Religião",
  FAREWELL: "Despedida",
  OTHER_SENSITIVE: "Outro assunto sensível",
};

export function isSensitiveCategory(v: unknown): v is SensitiveCategory {
  return (
    typeof v === "string" &&
    (SENSITIVE_CATEGORIES as readonly string[]).includes(v)
  );
}

// ---------- Origem da pergunta ----------
//
// VOICE_TRANSCRIPTION passou a ser aceita na Fase 5.2A, e descreve UMA coisa:
// como o texto entrou no campo. O cuidador falou em vez de digitar.
//
// Ela não significa autoria do paciente, não significa confirmação, não
// significa consentimento, não vale como fala e não dispensa revisão. Uma
// pergunta ditada percorre exatamente o mesmo caminho de uma digitada, botão
// por botão — e é por isso que a origem cabe num campo descritivo em vez de
// virar um estado à parte.
//
// AI_SUGGESTION continua preparada no modelo e recusada: não existe sugestão
// por IA em lugar nenhum do produto.

export type QuestionSource =
  | "MANUAL_TEXT"
  | "VOICE_TRANSCRIPTION"
  | "AI_SUGGESTION";

export const QUESTION_SOURCES: readonly QuestionSource[] = [
  "MANUAL_TEXT",
  "VOICE_TRANSCRIPTION",
  "AI_SUGGESTION",
] as const;

/** Origens efetivamente aceitas: texto digitado e texto ditado (Fase 5.2A). */
export const IMPLEMENTED_QUESTION_SOURCES: readonly QuestionSource[] = [
  "MANUAL_TEXT",
  "VOICE_TRANSCRIPTION",
] as const;

export function isQuestionSource(v: unknown): v is QuestionSource {
  return (
    typeof v === "string" && (QUESTION_SOURCES as readonly string[]).includes(v)
  );
}

// ---------- Estados ----------

export type RtqSessionStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED";

export const RTQ_SESSION_STATUSES: readonly RtqSessionStatus[] = [
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "ABANDONED",
] as const;

/** Sessões encerradas: não aceitam novas perguntas nem novas respostas. */
export function isTerminalSessionStatus(s: RtqSessionStatus): boolean {
  return s === "COMPLETED" || s === "ABANDONED";
}

export type RtqTurnStatus =
  | "DRAFT"
  | "REVIEWED"
  | "PRESENTED"
  | "AWAITING_RESPONSE"
  | "PROVISIONAL_RESPONSE"
  | "RECONFIRMATION_PENDING"
  | "CONFIRMED"
  | "UNCERTAIN_GESTURE"
  | "NO_RESPONSE"
  | "CANCELED";

export const RTQ_TURN_STATUSES: readonly RtqTurnStatus[] = [
  "DRAFT",
  "REVIEWED",
  "PRESENTED",
  "AWAITING_RESPONSE",
  "PROVISIONAL_RESPONSE",
  "RECONFIRMATION_PENDING",
  "CONFIRMED",
  "UNCERTAIN_GESTURE",
  "NO_RESPONSE",
  "CANCELED",
] as const;

export function isTerminalTurnStatus(s: RtqTurnStatus): boolean {
  return s === "CONFIRMED" || s === "NO_RESPONSE" || s === "CANCELED";
}

/**
 * Turnos "abertos": a pergunta foi apresentada e ainda não houve resposta
 * observada. Só estes viram NO_RESPONSE quando o assistente CONCLUI a sessão
 * (seção 4). Nunca por tempo, nunca no abandono.
 */
export function isOpenAwaitingTurnStatus(s: RtqTurnStatus): boolean {
  return (
    s === "PRESENTED" || s === "AWAITING_RESPONSE" || s === "UNCERTAIN_GESTURE"
  );
}

// ---------- Eventos de auditoria ----------
// Os nomes vivem em lib/audit-events/, um arquivo por domínio, e são reunidos
// aqui numa união só. Reexportamos para que máquinas, stores e rotas continuem
// importando `InteractionEventType` deste módulo, como sempre fizeram — quem
// grava a trilha não precisa saber de qual domínio veio o evento.

import type { InteractionEventType } from "@/lib/audit-events";

export {
  INTERACTION_EVENT_TYPES,
  isInteractionEventType,
  type InteractionEventType,
} from "@/lib/audit-events";

/**
 * Trilha imutável. Nunca é sobrescrita nem apagada, e o cliente não possui
 * rota de escrita: os eventos nascem apenas dentro das transações do domínio.
 * Os horários vêm do servidor; a autoria vem da sessão autenticada.
 */
export interface InteractionAuditEvent {
  id: string;
  sessionId: string;
  turnId: string | null;
  /**
   * Vínculos da conversa por opções. Eventos antigos não têm estes campos e
   * são lidos como `null` — nenhuma migração de dados é necessária (§33).
   */
  pathId: string | null;
  nodeId: string | null;
  statementId: string | null;
  /** Vínculo do contexto da sessão (Fase 4.8) — `null` nos eventos anteriores. */
  contextId: string | null;
  patientId: number;
  assistantId: string;
  eventType: InteractionEventType;
  previousValue: unknown;
  newValue: unknown;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ---------- Entidades ----------
// Timestamps são strings ISO geradas NO SERVIDOR — convenção de todo o
// projeto (lib/store.ts, lib/activity-store.ts, lib/access.ts).

export interface ConversationQuestionSession {
  id: string;
  patientId: number;
  /** Identidade REAL de quem conduz — sempre o userId autenticado. */
  assistantId: string;
  /** Snapshot do nome para leitura do histórico; nunca fonte de identidade. */
  assistantName: string | null;
  status: RtqSessionStatus;

  startedAt: string;
  pausedAt: string | null;
  resumedAt: string | null;
  completedAt: string | null;
  abandonedAt: string | null;

  /** Perguntas já criadas — origem do `sequence`, preserva a ordem. */
  turnCount: number;

  createdAt: string;
  updatedAt: string;
}

export interface ConversationQuestionTurn {
  id: string;
  sessionId: string;
  patientId: number;
  assistantId: string;

  /** Ordem da pergunta na sessão (1, 2, 3…), atribuída no servidor. */
  sequence: number;

  /**
   * Uma pergunta livre é sempre fechada. O campo existe para que o modo esteja
   * EXPLÍCITO no registro (§3) e para que o histórico saiba, sem adivinhar, o
   * que os três sinais significavam naquele momento. Turnos gravados antes
   * desta fase são lidos como CLOSED_CONFIRMATION.
   */
  interactionMode: InteractionMode;

  questionSource: QuestionSource;

  /** Texto bruto de origem (voz/IA nas próximas fases). Hoje sempre null. */
  originalText: string | null;
  /** Texto revisado pelo assistente antes de apresentar. */
  reviewedText: string;
  /** Texto efetivamente apresentado ao paciente (congelado ao apresentar). */
  presentedText: string;

  status: RtqTurnStatus;

  /** Resposta observada e ainda não confirmada. */
  provisionalResponse: SemanticResponse | null;
  /** Só existe em CONFIRMED, e sempre igual à provisória conferida. */
  confirmedResponse: SemanticResponse | null;

  isSensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;

  /**
   * Pergunta criada a partir de outra, pelo histórico (§24). O texto é
   * copiado; respostas e confirmações NUNCA são. Registros antigos leem null.
   */
  reusedFromTurnId: string | null;

  presentedAt: string | null;
  responseObservedAt: string | null;
  assistantVerifiedAt: string | null;
  reconfirmedAt: string | null;
  confirmedAt: string | null;
  canceledAt: string | null;

  /** Tempo entre apresentar e observar a resposta. Registro, nunca decisão. */
  responseTimeMs: number | null;
  correctionCount: number;
  /** Quantas vezes a MESMA pergunta foi reapresentada ao paciente. */
  representCount: number;

  createdAt: string;
  updatedAt: string;
}

// ---------- Invariantes (seção 12) ----------

/** Erro de regra de domínio — as rotas o traduzem para 400. */
export class RtqDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RtqDomainError";
  }
}

// ---------- Conflitos nomeados (Fase 4.9.3-C, §10) ----------
//
// O servidor sempre soube distinguir estas recusas; ele só nunca precisou
// DIZER qual era, porque quem chamava era uma tela online que já estava
// olhando o estado atual. Uma fila offline não está: ela precisa saber que
// foi "a sessão foi concluída em outro aparelho" e não "a pergunta foi
// substituída", para poder oferecer ao cuidador a decisão certa.
//
// Por que um CÓDIGO e não a mensagem: classificar lendo o texto em português
// acoplaria a decisão clínica à redação de um erro — bastaria alguém melhorar
// a frase para o produto voltar, em silêncio, a tratar tudo como recusa
// genérica. O código é contrato entre servidor e cliente; a frase é para o
// humano, e pode ser reescrita à vontade.

/** Ver `lib/offline/conflicts.ts` para o significado de cada linha da matriz. */
export type RtqConflictCode =
  | "SESSION_COMPLETED"
  | "SESSION_PAUSED"
  | "TURN_REPLACED"
  | "RESPONSE_CHANGED"
  | "PATH_ENDED"
  | "STATEMENT_REPLACED"
  | "CONTEXT_VERSION"
  | "ACCESS_REVOKED"
  | "IDEMPOTENCY_MISMATCH"
  /** A fila é de outro cuidador (R6). Ver `assertIdentidadeEsperada`. */
  | "IDENTITY_MISMATCH";

export const RTQ_CONFLICT_CODES: readonly RtqConflictCode[] = [
  "SESSION_COMPLETED",
  "SESSION_PAUSED",
  "TURN_REPLACED",
  "RESPONSE_CHANGED",
  "PATH_ENDED",
  "STATEMENT_REPLACED",
  "CONTEXT_VERSION",
  "ACCESS_REVOKED",
  "IDEMPOTENCY_MISMATCH",
  "IDENTITY_MISMATCH",
] as const;

export function isRtqConflictCode(v: unknown): v is RtqConflictCode {
  return (
    typeof v === "string" && (RTQ_CONFLICT_CODES as readonly string[]).includes(v)
  );
}

/**
 * Fatos que acompanham a recusa. Só o que a TELA DE DECISÃO precisa mostrar —
 * nunca o documento inteiro. Mandar o registro completo numa resposta de erro
 * vazaria, para um cliente que já foi recusado, dado clínico que ele talvez
 * não devesse mais ver (caso 9 é exatamente isso).
 */
export interface RtqConflictFacts {
  serverStatus?: string;
  serverAt?: string;
  serverValue?: string;
  replacedById?: string;
}

/**
 * Recusa de domínio que o cliente consegue CLASSIFICAR. Continua sendo um
 * `RtqDomainError` — as rotas que ainda não distinguem nada seguem
 * traduzindo para 400 sem mudança nenhuma.
 */
export class RtqConflictError extends RtqDomainError {
  readonly code: RtqConflictCode;
  readonly facts: RtqConflictFacts;

  constructor(code: RtqConflictCode, message: string, facts: RtqConflictFacts = {}) {
    super(message);
    this.name = "RtqConflictError";
    this.code = code;
    this.facts = facts;
  }
}

/** Pergunta sensível nunca vai de provisória direto a confirmada. */
export function requiresReconfirmation(
  turn: Pick<ConversationQuestionTurn, "isSensitive">
): boolean {
  return turn.isSensitive;
}

/**
 * Checagem defensiva executada antes de CADA gravação, dentro da transação.
 * Se alguma combinação proibida aparecer, nada é salvo.
 */
export function assertTurnInvariants(turn: ConversationQuestionTurn): void {
  const bad = (msg: string): never => {
    throw new RtqDomainError(msg);
  };

  if (turn.status === "CONFIRMED") {
    if (!isSemanticResponse(turn.confirmedResponse)) {
      bad("resposta confirmada exige uma resposta semântica válida");
    }
    if (turn.confirmedResponse !== turn.provisionalResponse) {
      bad("a confirmação não pode alterar a resposta observada");
    }
    if (!turn.confirmedAt || !turn.assistantVerifiedAt) {
      bad("resposta confirmada exige conferência e horário de confirmação");
    }
    if (turn.isSensitive && !turn.reconfirmedAt) {
      bad("pergunta sensível não pode ser confirmada sem reconfirmação");
    }
  } else if (turn.confirmedResponse !== null) {
    bad("só uma interação CONFIRMED pode ter resposta confirmada");
  }

  if (turn.status === "UNCERTAIN_GESTURE") {
    if (turn.provisionalResponse !== null || turn.confirmedResponse !== null) {
      bad("gesto incerto não registra SIM, TALVEZ ou NÃO");
    }
  }

  if (turn.status === "NO_RESPONSE") {
    if (turn.provisionalResponse !== null || turn.confirmedResponse !== null) {
      bad("ausência de resposta não registra resposta semântica");
    }
  }

  if (turn.status === "RECONFIRMATION_PENDING") {
    if (!turn.isSensitive) {
      bad("reconfirmação só existe em pergunta sensível");
    }
    if (!isSemanticResponse(turn.provisionalResponse)) {
      bad("reconfirmação exige uma resposta provisória");
    }
  }

  if (turn.status === "PROVISIONAL_RESPONSE" && !isSemanticResponse(turn.provisionalResponse)) {
    bad("seleção provisória exige uma resposta semântica válida");
  }

  // Texto de origem só existe quando houve uma origem além do teclado. Sem
  // isto, `originalText` viraria um campo livre onde qualquer coisa poderia
  // ser guardada como "o que foi dito" — inclusive numa pergunta digitada.
  if (turn.originalText !== null && turn.questionSource !== "VOICE_TRANSCRIPTION") {
    bad("texto de origem só existe em pergunta ditada");
  }

  if (turn.correctionCount < 0) bad("correctionCount inválido");
  if (turn.representCount < 0) bad("representCount inválido");
  if (turn.sequence < 1) bad("sequence inválido");
}
