// ——— Conversa por opções: tipos do domínio ———
// Módulo neutro (sem imports de servidor), irmão de realtime-question-types.ts:
// reusa dali os enums compartilhados (sensibilidade, resposta semântica, modo
// de interação, erro de domínio) e NÃO redefine nenhum deles.
//
// PRINCÍPIO CENTRAL (o mesmo das Fases 1–4): o Helo não interpreta nem responde
// pelo paciente. Aqui isso ganha uma segunda exigência, específica deste modo:
//
//   Durante um nível, os três sinais do paciente significam
//     opção 1 · opção 2 · opção 3
//   e NUNCA SIM · TALVEZ · NÃO.
//
// SIM/TALVEZ/NÃO só voltam a existir na pergunta fechada (CLOSED_CONFIRMATION,
// Fases 1–4) e na confirmação de uma frase completa
// (FINAL_STATEMENT_CONFIRMATION). O gesto físico e o emoji de cada posição
// continuam sendo os do paciente — o que muda é apenas o TEXTO de cada opção.
//
// IMUTABILIDADE: nada apresentado ao paciente é reescrito. Correções e
// reutilizações criam registros NOVOS vinculados ao original
// (replaces/replacedBy/reusedFrom), e nenhuma resposta anterior migra.

import {
  isSemanticResponse,
  isSensitiveCategory,
  RtqDomainError,
  type InteractionMode,
  type SemanticResponse,
  type SensitiveCategory,
} from "@/lib/realtime-question-types";

export {
  RtqDomainError,
  type InteractionMode,
  type SemanticResponse,
  type SensitiveCategory,
};

// ---------- Limites ----------

/** Nunca mais de três opções por nível (§6) — é o teto do produto, não do layout. */
export const MAX_OPTIONS_PER_NODE = 3;
export const MIN_OPTIONS_PER_NODE = 1;

export const MAX_PROMPT_LEN = 300;
export const MAX_OPTION_LABEL_LEN = 80;
export const MAX_STATEMENT_LEN = 500;
/** Teto de profundidade: protege a transação e o breadcrumb de um caminho infinito. */
export const MAX_NODE_DEPTH = 20;

export type OptionPosition = 1 | 2 | 3;

export const OPTION_POSITIONS: readonly OptionPosition[] = [1, 2, 3] as const;

export function isOptionPosition(v: unknown): v is OptionPosition {
  return v === 1 || v === 2 || v === 3;
}

// ---------- Estados ----------

export type PathStatus =
  | "ACTIVE"
  | "PAUSED"
  | "COMPLETED"
  | "INTERRUPTED"
  | "RESTARTED";

export const PATH_STATUSES: readonly PathStatus[] = [
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "INTERRUPTED",
  "RESTARTED",
] as const;

/** Caminho encerrado: não volta a ser ativo. Reutilizar cria um caminho NOVO (§25). */
export function isTerminalPathStatus(s: PathStatus): boolean {
  return s === "COMPLETED" || s === "INTERRUPTED" || s === "RESTARTED";
}

export type NodeStatus =
  | "DRAFT"
  | "REVIEWED"
  | "PRESENTED"
  | "AWAITING_SELECTION"
  | "PROVISIONAL_SELECTION"
  | "CONFIRMED"
  /** Ficou numa ramificação abandonada. NUNCA excluído (§14). */
  | "INACTIVE"
  | "CANCELED"
  /** Substituído por uma versão corrigida (§29). O original permanece. */
  | "REPLACED";

export const NODE_STATUSES: readonly NodeStatus[] = [
  "DRAFT",
  "REVIEWED",
  "PRESENTED",
  "AWAITING_SELECTION",
  "PROVISIONAL_SELECTION",
  "CONFIRMED",
  "INACTIVE",
  "CANCELED",
  "REPLACED",
] as const;

export function isTerminalNodeStatus(s: NodeStatus): boolean {
  return (
    s === "CONFIRMED" || s === "INACTIVE" || s === "CANCELED" || s === "REPLACED"
  );
}

/** O nível já foi mostrado ao paciente — daqui em diante o texto não se reescreve. */
export function wasPresentedToPatient(s: NodeStatus): boolean {
  return s !== "DRAFT" && s !== "REVIEWED" && s !== "CANCELED";
}

export type StatementStatus =
  | "DRAFT"
  | "REVIEWED"
  | "PRESENTED"
  | "PROVISIONAL_RESPONSE"
  | "RECONFIRMATION_PENDING"
  | "CONFIRMED"
  | "REJECTED"
  | "CANCELED"
  | "REPLACED";

export const STATEMENT_STATUSES: readonly StatementStatus[] = [
  "DRAFT",
  "REVIEWED",
  "PRESENTED",
  "PROVISIONAL_RESPONSE",
  "RECONFIRMATION_PENDING",
  "CONFIRMED",
  "REJECTED",
  "CANCELED",
  "REPLACED",
] as const;

export function isTerminalStatementStatus(s: StatementStatus): boolean {
  return (
    s === "CONFIRMED" || s === "REJECTED" || s === "CANCELED" || s === "REPLACED"
  );
}

export function statementWasPresented(s: StatementStatus): boolean {
  return s !== "DRAFT" && s !== "REVIEWED" && s !== "CANCELED";
}

// ---------- Entidades ----------
// Timestamps são strings ISO geradas NO SERVIDOR — convenção do projeto.

/**
 * Uma opção de um nível. Vive EMBUTIDA no documento do nó: posição e rótulo
 * mudam juntos, numa escrita só, e a posição não pode divergir da ordem
 * apresentada (§9).
 */
export interface OptionConversationOption {
  id: string;
  position: OptionPosition;
  label: string;

  /** Nível seguinte, quando já criado. Terminal não tem próximo nível. */
  nextNodeId: string | null;

  isTerminal: boolean;
  /** Frase sugerida por esta opção quando terminal — rascunho, nunca confirmada. */
  finalStatementDraft: string | null;

  isSensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;
}

export interface OptionConversationPath {
  id: string;
  sessionId: string;
  patientId: number;
  assistantId: string;

  status: PathStatus;

  rootNodeId: string | null;
  activeNodeId: string | null;
  activeBranchId: string | null;
  finalStatementId: string | null;

  /** Ordem do caminho dentro da sessão (1, 2, 3…) — reiniciar cria o seguinte. */
  sequence: number;

  /** Caminho que foi reiniciado e deu origem a este (§16). */
  restartedFromPathId: string | null;
  /** Caminho do histórico que foi reutilizado como base deste (§25). */
  reusedFromPathId: string | null;

  /** Deduplicação de criação por clique repetido (§33). */
  clientRequestId: string | null;

  startedAt: string;
  pausedAt: string | null;
  resumedAt: string | null;
  completedAt: string | null;
  interruptedAt: string | null;
  restartedAt: string | null;

  createdAt: string;
  updatedAt: string;
}

export interface OptionConversationNode {
  id: string;
  pathId: string;
  sessionId: string;
  patientId: number;
  assistantId: string;

  parentNodeId: string | null;
  /**
   * Ramificação a que este nível pertence. Voltar pelo breadcrumb e escolher
   * outra opção cria um branchId novo; o anterior fica preservado (§15).
   */
  branchId: string;

  depth: number;
  sequence: number;

  /** Sempre OPTION_SELECTION — o campo existe para o modo ser explícito (§3). */
  interactionMode: Extract<InteractionMode, "OPTION_SELECTION">;

  promptText: string;

  status: NodeStatus;

  options: OptionConversationOption[];

  provisionalOptionId: string | null;
  confirmedOptionId: string | null;

  reusedFromNodeId: string | null;
  replacesNodeId: string | null;
  replacedByNodeId: string | null;

  isSensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;

  /** Quantas vezes o assistente corrigiu a seleção observada neste nível. */
  correctionCount: number;

  clientRequestId: string | null;

  presentedAt: string | null;
  selectedAt: string | null;
  confirmedAt: string | null;
  deactivatedAt: string | null;
  canceledAt: string | null;
  replacedAt: string | null;

  createdAt: string;
  updatedAt: string;
}

export interface OptionConversationFinalStatement {
  id: string;
  pathId: string;
  sessionId: string;
  patientId: number;
  assistantId: string;

  /** Nível terminal que originou a frase, quando houve um. */
  originNodeId: string | null;

  /** Sempre FINAL_STATEMENT_CONFIRMATION quando apresentada (§20). */
  interactionMode: Extract<InteractionMode, "FINAL_STATEMENT_CONFIRMATION">;

  originalDraft: string;
  currentText: string;
  /** Texto congelado no momento da apresentação — editar depois não o reescreve. */
  presentedText: string;

  status: StatementStatus;

  provisionalResponse: SemanticResponse | null;
  /**
   * O TIPO já impede o erro mais grave deste modo: TALVEZ e NÃO não têm como
   * virar confirmação. Só SIM confirma uma frase (§20).
   */
  confirmedResponse: "YES" | null;

  reusedFromStatementId: string | null;
  replacesStatementId: string | null;
  replacedByStatementId: string | null;

  isSensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;

  /** Edições do texto antes da apresentação (§19). */
  editCount: number;
  correctionCount: number;

  clientRequestId: string | null;

  presentedAt: string | null;
  respondedAt: string | null;
  reconfirmedAt: string | null;
  confirmedAt: string | null;
  rejectedAt: string | null;
  canceledAt: string | null;
  replacedAt: string | null;

  createdAt: string;
  updatedAt: string;
}

/** Tudo o que a tela precisa de um caminho, numa leitura só. */
export interface PathDetail {
  path: OptionConversationPath;
  nodes: OptionConversationNode[];
  statements: OptionConversationFinalStatement[];
}

// ---------- Normalização das opções ----------

export interface OptionInput {
  label?: unknown;
  isTerminal?: unknown;
  finalStatementDraft?: unknown;
  isSensitive?: unknown;
  sensitiveCategory?: unknown;
}

function trimTo(v: unknown, max: number): string {
  // Apara espaços excedentes (inclusive internos) e respeita o teto,
  // preservando acentos e pontuação (§6).
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/**
 * Converte a lista crua do cliente em opções válidas e posicionadas.
 *
 * Recusa (§6): mais de três, nenhuma, e lacuna entre opções preenchidas —
 * uma opção vazia no meio deslocaria as posições e o terceiro sinal do
 * paciente passaria a apontar para outra coisa.
 */
export function normalizeOptions(
  raw: unknown,
  makeId: () => string
): OptionConversationOption[] {
  if (!Array.isArray(raw)) {
    throw new RtqDomainError("as opções do nível são obrigatórias");
  }
  if (raw.length > MAX_OPTIONS_PER_NODE) {
    throw new RtqDomainError(
      `um nível aceita no máximo ${MAX_OPTIONS_PER_NODE} opções`
    );
  }

  const labels = raw.map((r) => trimTo((r as OptionInput)?.label, MAX_OPTION_LABEL_LEN));
  const firstEmpty = labels.findIndex((l) => !l);
  if (firstEmpty !== -1 && labels.slice(firstEmpty).some((l) => l)) {
    throw new RtqDomainError(
      "não pode haver opção vazia entre opções preenchidas"
    );
  }

  const filled = labels.filter((l) => l).length;
  if (filled < MIN_OPTIONS_PER_NODE) {
    throw new RtqDomainError("o nível precisa de ao menos uma opção");
  }

  const options: OptionConversationOption[] = [];
  for (let i = 0; i < filled; i++) {
    const input = (raw[i] ?? {}) as OptionInput;
    const isTerminal = input.isTerminal === true;
    const draft = trimTo(input.finalStatementDraft, MAX_STATEMENT_LEN);
    if (!isTerminal && draft) {
      throw new RtqDomainError(
        "frase final só pode ser associada a uma opção terminal"
      );
    }
    const isSensitive = input.isSensitive === true;
    let sensitiveCategory: SensitiveCategory | null = null;
    if (input.sensitiveCategory != null) {
      if (!isSensitive) {
        throw new RtqDomainError(
          "categoria sensível exige a opção marcada como sensível"
        );
      }
      if (!isSensitiveCategory(input.sensitiveCategory)) {
        throw new RtqDomainError("categoria sensível inválida");
      }
      sensitiveCategory = input.sensitiveCategory;
    }
    const position = (i + 1) as OptionPosition;
    options.push({
      id: makeId(),
      position,
      label: labels[i],
      nextNodeId: null,
      isTerminal,
      finalStatementDraft: isTerminal && draft ? draft : null,
      isSensitive,
      sensitiveCategory,
    });
  }
  return options;
}

// ---------- Invariantes (§33) ----------
// Checagem defensiva executada antes de CADA gravação, dentro da transação.
// Se alguma combinação proibida aparecer, nada é salvo.

export function assertOptionsInvariants(
  options: OptionConversationOption[]
): void {
  const bad = (msg: string): never => {
    throw new RtqDomainError(msg);
  };
  if (options.length < MIN_OPTIONS_PER_NODE) bad("o nível ficou sem opções");
  if (options.length > MAX_OPTIONS_PER_NODE) {
    bad(`um nível aceita no máximo ${MAX_OPTIONS_PER_NODE} opções`);
  }
  const seen = new Set<number>();
  options.forEach((o, i) => {
    if (!isOptionPosition(o.position)) bad("posição de opção inválida");
    // As posições precisam ser 1..n, na ordem: é o que amarra "terceiro sinal"
    // a "terceira opção".
    if (o.position !== i + 1) bad("as posições das opções precisam ser sequenciais");
    if (seen.has(o.position)) bad("posição de opção repetida");
    seen.add(o.position);
    if (!o.label.trim()) bad("opção sem texto");
    if (!o.isTerminal && o.finalStatementDraft) {
      bad("frase final só pode ser associada a uma opção terminal");
    }
    if (!o.isSensitive && o.sensitiveCategory) {
      bad("categoria sensível exige a opção marcada como sensível");
    }
  });
}

export function assertNodeInvariants(node: OptionConversationNode): void {
  const bad = (msg: string): never => {
    throw new RtqDomainError(msg);
  };

  assertOptionsInvariants(node.options);

  if (node.interactionMode !== "OPTION_SELECTION") {
    bad("um nível de opções só existe no modo OPTION_SELECTION");
  }
  if (!node.promptText.trim()) bad("o nível precisa de uma pergunta ou título");
  if (node.depth < 0) bad("profundidade inválida");
  if (node.depth > MAX_NODE_DEPTH) bad("profundidade máxima do caminho atingida");
  if (node.sequence < 1) bad("sequence inválido");
  if (node.correctionCount < 0) bad("correctionCount inválido");
  if (!node.branchId) bad("o nível precisa pertencer a uma ramificação");

  const known = (id: string | null) =>
    id === null || node.options.some((o) => o.id === id);
  if (!known(node.provisionalOptionId)) {
    bad("a seleção provisória não corresponde a nenhuma opção deste nível");
  }
  if (!known(node.confirmedOptionId)) {
    bad("a opção confirmada não corresponde a nenhuma opção deste nível");
  }

  if (node.status === "CONFIRMED") {
    if (!node.confirmedOptionId) bad("nível confirmado exige uma opção confirmada");
    // A confirmação NÃO escolhe: ela atesta que a opção marcada é a que o
    // assistente observou. Divergir aqui seria o Helo decidindo pelo paciente.
    if (node.confirmedOptionId !== node.provisionalOptionId) {
      bad("a confirmação não pode alterar a opção observada");
    }
    if (!node.confirmedAt) bad("nível confirmado exige horário de confirmação");
  } else if (
    node.confirmedOptionId !== null &&
    // INACTIVE e REPLACED PRESERVAM a escolha que receberam enquanto estavam
    // ativos: voltar pelo breadcrumb ou criar uma versão corrigida desativa o
    // nível, nunca apaga o que o paciente escolheu nele (§2, §14, §29).
    node.status !== "INACTIVE" &&
    node.status !== "REPLACED"
  ) {
    bad("só um nível confirmado, desativado ou substituído registra opção confirmada");
  }

  if (node.status === "PROVISIONAL_SELECTION" && !node.provisionalOptionId) {
    bad("seleção provisória exige uma opção selecionada");
  }
  if (node.status === "AWAITING_SELECTION" && node.provisionalOptionId) {
    bad("aguardando seleção não pode ter opção selecionada");
  }

  if (node.status === "REPLACED" && !node.replacedByNodeId) {
    bad("um nível substituído precisa apontar para a versão que o substitui");
  }
  if (node.replacesNodeId && node.replacesNodeId === node.id) {
    bad("um nível não pode substituir a si mesmo");
  }
}

export function assertStatementInvariants(
  statement: OptionConversationFinalStatement
): void {
  const bad = (msg: string): never => {
    throw new RtqDomainError(msg);
  };

  if (!statement.currentText.trim()) bad("a frase não pode ficar vazia");
  if (statement.editCount < 0) bad("editCount inválido");
  if (statement.correctionCount < 0) bad("correctionCount inválido");

  if (statement.provisionalResponse !== null) {
    if (!isSemanticResponse(statement.provisionalResponse)) {
      bad("resposta semântica inválida");
    }
  }

  if (statement.status === "CONFIRMED") {
    // A regra mais importante deste modo: SOMENTE SIM confirma.
    if (statement.confirmedResponse !== "YES") {
      bad("somente SIM confirma uma frase");
    }
    if (statement.provisionalResponse !== "YES") {
      bad("a confirmação não pode alterar a resposta observada");
    }
    if (!statement.confirmedAt) bad("frase confirmada exige horário de confirmação");
    if (statement.isSensitive && !statement.reconfirmedAt) {
      bad("frase sensível não pode ser confirmada sem reconfirmação");
    }
  } else if (
    statement.confirmedResponse !== null &&
    // Uma frase SUBSTITUÍDA preserva a confirmação que recebeu: ela continua
    // válida para o texto original, e é justamente isso que a versão corrigida
    // não pode herdar (§30).
    statement.status !== "REPLACED"
  ) {
    bad("só uma frase confirmada ou substituída registra resposta confirmada");
  }

  if (statement.status === "REJECTED") {
    // Uma frase rejeitada NUNCA é comunicação confirmada (§20).
    if (statement.confirmedResponse !== null) {
      bad("frase rejeitada não registra confirmação");
    }
    if (statement.provisionalResponse !== "NO") {
      bad("frase rejeitada exige a resposta observada NÃO");
    }
  }

  if (statement.status === "RECONFIRMATION_PENDING") {
    if (!statement.isSensitive) {
      bad("reconfirmação reforçada só existe em frase sensível");
    }
    if (statement.provisionalResponse !== "YES") {
      bad("reconfirmação exige a resposta observada SIM");
    }
  }

  if (statement.status === "REPLACED" && !statement.replacedByStatementId) {
    bad("uma frase substituída precisa apontar para a versão que a substitui");
  }
  if (statement.replacesStatementId === statement.id) {
    bad("uma frase não pode substituir a si mesma");
  }
  if (!statement.isSensitive && statement.sensitiveCategory) {
    bad("categoria sensível exige a frase marcada como sensível");
  }
}

// ---------- Leitura do caminho ----------

/**
 * O caminho ATIVO, da raiz até o nível atual — a fonte do breadcrumb (§13).
 * Só percorre nós vivos: ramificações desativadas e versões substituídas
 * continuam no banco, mas não aparecem na trilha ativa.
 */
export function activeTrail(
  nodes: OptionConversationNode[],
  activeNodeId: string | null
): OptionConversationNode[] {
  if (!activeNodeId) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const trail: OptionConversationNode[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(activeNodeId) ?? null;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    trail.unshift(cursor);
    cursor = cursor.parentNodeId ? (byId.get(cursor.parentNodeId) ?? null) : null;
  }
  return trail;
}

/** Rótulo da opção confirmada de um nível — o degrau do breadcrumb. */
export function confirmedLabel(node: OptionConversationNode): string | null {
  if (!node.confirmedOptionId) return null;
  return (
    node.options.find((o) => o.id === node.confirmedOptionId)?.label ?? null
  );
}

/** "Saúde › Dor › Perna" — só os degraus já confirmados. */
export function trailLabels(trail: OptionConversationNode[]): string[] {
  return trail
    .map((n) => confirmedLabel(n))
    .filter((l): l is string => l !== null);
}

/** Um nível ou opção sensível contamina a frase final (§21). */
export function trailSensitivity(
  trail: OptionConversationNode[]
): { isSensitive: boolean; sensitiveCategory: SensitiveCategory | null } {
  let sensitiveCategory: SensitiveCategory | null = null;
  let isSensitive = false;
  for (const node of trail) {
    if (node.isSensitive) {
      isSensitive = true;
      sensitiveCategory ??= node.sensitiveCategory;
    }
    const chosen = node.options.find((o) => o.id === node.confirmedOptionId);
    if (chosen?.isSensitive) {
      isSensitive = true;
      sensitiveCategory ??= chosen.sensitiveCategory;
    }
  }
  return { isSensitive, sensitiveCategory };
}
