// ——— A fila de intenções (Fase 4.9.2) ———
//
// Módulo PURO: sem IndexedDB, sem React, sem rede. Recebe a fila, devolve uma
// fila nova. É isso que permite provar o comportamento em milissegundos, sem
// navegador — e é a razão de a persistência viver em outro arquivo.
//
// O que esta fila promete, e por quê:
//
//   ORDEM CAUSAL. FIFO estrito por `sequence`. A ordem em que o cuidador agiu
//   é a ordem em que o servidor receberá — a mesma promessa que a `chain` de
//   `useRtqPersistence` já faz online. Uma operação bloqueada NÃO é
//   ultrapassada: passar por cima dela mandaria ao servidor um "confirmou a
//   opção" antes do "criou o nível".
//
//   PARAR NO PRIMEIRO PROBLEMA. Um CONFLICT ou FAILED interrompe a fila
//   daquela sessão. Nada depois dele é enviado. Continuar seria exatamente a
//   "sincronização silenciosa de conflitos" que a fase proíbe.
//
//   NUNCA APAGAR EM SILÊNCIO. `pruneSynced` remove SOMENTE o que o servidor
//   confirmou. CONFLICT e FAILED esperam decisão do cuidador; PENDING e
//   SYNCING esperam o servidor. Não há caminho que descarte qualquer um dos
//   quatro sem alguém dizer para descartar.
//
// Nesta fase nada é enviado. `nextSendable` existe, é testada e não é chamada
// por ninguém — ela é a interface que a 4.9.3 consome, e tê-la agora é o que
// mantém o modelo da fila honesto em vez de teórico.

import {
  assertPayloadSemSegredo,
  isDiscardable,
  isPendingStatus,
  OFFLINE_SCHEMA_VERSION,
  requiresCaregiverDecision,
  type OfflineOperation,
  type OfflineOperationError,
  type OfflineOperationStatus,
  type OfflineOperationType,
  type OfflineStatusSummary,
  type OfflineVisualState,
} from "@/lib/offline/types";
import { newIdempotencyKey, newOperationId } from "@/lib/offline/ids";
import { restoreConflict, type ConflictCase } from "@/lib/offline/conflicts";

export class OfflineQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineQueueError";
  }
}

/**
 * Janela de clique repetido. Duas operações idênticas dentro dela são o mesmo
 * gesto; fora dela são duas intenções.
 *
 * Isto não é um número escolhido no ar: é o equivalente offline do `inflight`
 * de `useRtqPersistence`, que deduplica enquanto a requisição está em voo.
 * Offline não há voo nenhum, então a janela precisa ser de tempo. E precisa
 * ser CURTA: "repetir" duas vezes seguidas é um pedido real do paciente
 * (Fase 4.7), e deduplicá-lo apagaria o segundo pedido dele.
 */
export const JANELA_CLIQUE_REPETIDO_MS = 2000;

export interface NovaOperacao {
  operationType: OfflineOperationType;
  sessionId: string;
  /** Chave do paciente, em string. */
  patientId: string;
  /** Quem formulou a intenção (R6). Vem do escopo, nunca do payload. */
  userId?: string | null;
  payload: unknown;
  /** Id do registro que esta operação cria, quando ela cria algum. */
  createdEntityId?: string | null;
  /** `updatedAt` da entidade alvo quando o cuidador agiu. */
  baseVersion?: string | null;
  /** Chave estável. Omitida, nasce aqui — e nasce UMA vez. */
  idempotencyKey?: string;
}

// ---------- Impressão digital do conteúdo ----------

/**
 * Serialização estável de um payload: chaves ordenadas, para que
 * `{a:1,b:2}` e `{b:2,a:1}` tenham a mesma impressão. `JSON.stringify` puro
 * não serve — a ordem das chaves depende de como o objeto foi montado, e dois
 * cliques no mesmo botão passam por caminhos diferentes na interface.
 */
export function fingerprint(operationType: string, payload: unknown): string {
  return `${operationType}|${estavel(payload)}`;
}

function estavel(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(estavel).join(",")}]`;
  const entradas = Object.entries(v as Record<string, unknown>)
    .filter(([, valor]) => valor !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entradas.map(([k, valor]) => `${JSON.stringify(k)}:${estavel(valor)}`).join(",")}}`;
}

// ---------- Referências entre operações ----------

/** Todos os identificadores citados num payload, em qualquer profundidade. */
function idsCitados(payload: unknown, saida = new Set<string>()): Set<string> {
  if (typeof payload === "string") {
    saida.add(payload);
    return saida;
  }
  if (payload === null || typeof payload !== "object") return saida;
  if (Array.isArray(payload)) {
    for (const item of payload) idsCitados(item, saida);
    return saida;
  }
  for (const valor of Object.values(payload as Record<string, unknown>)) {
    idsCitados(valor, saida);
  }
  return saida;
}

/**
 * De quem esta operação depende.
 *
 * Duas fontes, e as duas importam:
 *
 *   1. criação citada — a operação fala de um registro que outra ainda não
 *      gravou. Enviar antes daria 404;
 *   2. mesma entidade — duas ações sobre o mesmo registro precisam chegar na
 *      ordem em que foram feitas, senão a máquina de estados recusa a segunda
 *      por estar num estado que a primeira ainda não produziu.
 *
 * Só operações ainda NÃO confirmadas entram: depender do que o servidor já
 * aceitou seria manter um bloqueio que não existe mais.
 */
export function calcularDependencias(
  fila: readonly OfflineOperation[],
  entrada: NovaOperacao
): number[] {
  const citados = idsCitados(entrada.payload);
  const deps = new Set<number>();

  for (const op of fila) {
    if (op.sessionId !== entrada.sessionId) continue;
    if (op.status === "SYNCED") continue;

    if (op.createdEntityId && citados.has(op.createdEntityId)) {
      deps.add(op.sequence);
      continue;
    }
    // Mesma entidade alvo: a última operação sobre ela precisa ir antes.
    const alvoAnterior = alvoDe(op);
    const alvoNovo = alvoDe({ ...vazia(entrada), payload: entrada.payload });
    if (alvoAnterior && alvoNovo && alvoAnterior === alvoNovo) {
      deps.add(op.sequence);
    }
  }

  return [...deps].sort((a, b) => a - b);
}

function vazia(entrada: NovaOperacao): OfflineOperation {
  return {
    id: "",
    idempotencyKey: "",
    sessionId: entrada.sessionId,
    patientId: entrada.patientId,
    userId: entrada.userId ?? null,
    operationType: entrada.operationType,
    payload: entrada.payload,
    status: "PENDING",
    createdAt: "",
    retryCount: 0,
    sequence: 0,
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    updatedAt: "",
    dependsOn: [],
    baseVersion: null,
    lastError: null,
    nextRetryAt: null,
    createdEntityId: entrada.createdEntityId ?? null,
    remoteConfirmedAt: null,
    remoteEntityId: null,
    conflict: null,
  };
}

/**
 * O registro que a operação MODIFICA (não o que ela cria). Uma criação não
 * tem alvo anterior — ela é o alvo de quem vier depois.
 */
export function alvoDe(op: OfflineOperation): string | null {
  const p = (op.payload ?? {}) as Record<string, unknown>;
  const campo = (nome: string): string | null =>
    typeof p[nome] === "string" && p[nome] ? (p[nome] as string) : null;

  switch (op.operationType) {
    case "turnAction":
      return campo("turnId");
    case "nodeAction":
    case "reviewNode":
      return campo("nodeId");
    case "statementAction":
      return campo("statementId");
    case "pathAction":
      return campo("pathId");
    case "patientControlAction":
      return campo("requestId");
    case "sessionAction":
      return op.sessionId;
    default:
      return null;
  }
}

// ---------- Inserção ----------

export interface ResultadoInsercao {
  fila: OfflineOperation[];
  operacao: OfflineOperation;
  /** Verdadeiro quando a entrada foi reconhecida como repetição. */
  deduplicada: boolean;
}

/**
 * Acrescenta uma intenção à fila.
 *
 * Recusa antes de gravar: paciente diferente do da fila, payload com
 * credencial, sessão vazia. Nenhuma dessas é um erro recuperável — são sinais
 * de que algo montou a operação errado, e deixá-las passar seria gravar dado
 * clínico no lugar errado.
 */
export function appendOperation(
  fila: readonly OfflineOperation[],
  entrada: NovaOperacao,
  agora: number = Date.now()
): ResultadoInsercao {
  if (!entrada.sessionId) {
    throw new OfflineQueueError("operação sem sessão");
  }
  if (!entrada.patientId) {
    throw new OfflineQueueError("operação sem paciente");
  }
  // Uma fila NUNCA mistura pacientes. Se isto disparar, o erro está a
  // montante — e gravar mesmo assim colocaria a fala de um paciente no
  // prontuário de outro.
  const outro = fila.find((op) => op.patientId !== entrada.patientId);
  if (outro) {
    throw new OfflineQueueError(
      `a fila é do paciente ${outro.patientId}; recusando operação do paciente ${entrada.patientId}`
    );
  }
  assertPayloadSemSegredo(entrada.payload);

  // Duplicação local, dois caminhos:
  //   1. mesma chave de idempotência — é literalmente a mesma intenção;
  //   2. mesmo conteúdo dentro da janela de clique repetido.
  if (entrada.idempotencyKey) {
    const mesma = fila.find((op) => op.idempotencyKey === entrada.idempotencyKey);
    if (mesma) return { fila: [...fila], operacao: mesma, deduplicada: true };
  }
  const impressao = fingerprint(entrada.operationType, entrada.payload);
  const recente = fila.find(
    (op) =>
      op.status === "PENDING" &&
      fingerprint(op.operationType, op.payload) === impressao &&
      agora - Date.parse(op.createdAt) < JANELA_CLIQUE_REPETIDO_MS
  );
  if (recente) return { fila: [...fila], operacao: recente, deduplicada: true };

  const sequence = fila.reduce((max, op) => Math.max(max, op.sequence), 0) + 1;
  const iso = new Date(agora).toISOString();

  const operacao: OfflineOperation = {
    id: newOperationId(),
    idempotencyKey:
      entrada.idempotencyKey ?? newIdempotencyKey(entrada.operationType),
    sessionId: entrada.sessionId,
    patientId: entrada.patientId,
    userId: entrada.userId ?? null,
    operationType: entrada.operationType,
    payload: entrada.payload,
    status: "PENDING",
    createdAt: iso,
    retryCount: 0,
    sequence,
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    updatedAt: iso,
    dependsOn: calcularDependencias(fila, entrada),
    baseVersion: entrada.baseVersion ?? null,
    lastError: null,
    nextRetryAt: null,
    createdEntityId: entrada.createdEntityId ?? null,
    remoteConfirmedAt: null,
    remoteEntityId: null,
    conflict: null,
  };

  return { fila: [...fila, operacao], operacao, deduplicada: false };
}

// ---------- Transições de status ----------

const TRANSICOES: Record<OfflineOperationStatus, readonly OfflineOperationStatus[]> = {
  PENDING: ["SYNCING", "CONFLICT", "FAILED"],
  SYNCING: ["SYNCED", "PENDING", "CONFLICT", "FAILED"],
  // SYNCED é terminal: o servidor aceitou, e nada local desfaz isso.
  SYNCED: [],
  // Conflito e falha só saem por decisão do cuidador, que reenfileira.
  CONFLICT: ["PENDING"],
  FAILED: ["PENDING"],
};

export function markStatus(
  fila: readonly OfflineOperation[],
  operationId: string,
  status: OfflineOperationStatus,
  extra: {
    error?: OfflineOperationError | null;
    nextRetryAt?: string | null;
    incrementRetry?: boolean;
    /** Só faz sentido junto de `status: "SYNCED"` — o fato que o servidor devolveu. */
    remoteConfirmedAt?: string | null;
    remoteEntityId?: string | null;
    /** Só faz sentido junto de `status: "CONFLICT"` — qual linha da matriz (§10). */
    conflict?: ConflictCase | null;
  } = {},
  agora: number = Date.now()
): OfflineOperation[] {
  return fila.map((op) => {
    if (op.id !== operationId) return op;
    if (op.status === status) return op;
    if (!TRANSICOES[op.status].includes(status)) {
      throw new OfflineQueueError(
        `transição inválida na fila: ${op.status} → ${status}`
      );
    }
    return {
      ...op,
      status,
      updatedAt: new Date(agora).toISOString(),
      retryCount: extra.incrementRetry ? op.retryCount + 1 : op.retryCount,
      lastError: extra.error === undefined ? op.lastError : extra.error,
      nextRetryAt:
        extra.nextRetryAt === undefined ? op.nextRetryAt : extra.nextRetryAt,
      remoteConfirmedAt:
        extra.remoteConfirmedAt === undefined
          ? op.remoteConfirmedAt
          : extra.remoteConfirmedAt,
      remoteEntityId:
        extra.remoteEntityId === undefined ? op.remoteEntityId : extra.remoteEntityId,
      conflict: extra.conflict === undefined ? op.conflict : extra.conflict,
    };
  });
}

// ---------- Leitura da fila ----------

export function ordenada(fila: readonly OfflineOperation[]): OfflineOperation[] {
  return [...fila].sort((a, b) => a.sequence - b.sequence);
}

export function pendentes(fila: readonly OfflineOperation[]): OfflineOperation[] {
  return ordenada(fila).filter((op) => isPendingStatus(op.status));
}

export function bloqueantes(fila: readonly OfflineOperation[]): OfflineOperation[] {
  return ordenada(fila).filter((op) => requiresCaregiverDecision(op.status));
}

/**
 * A próxima operação que pode ir ao servidor — ou o motivo de nenhuma poder.
 *
 * Não é usada nesta fase (nada é enviado). Existe, e é testada, porque é o
 * contrato que a 4.9.3 vai consumir: um modelo de fila que ninguém nunca
 * consultou é um modelo que não se sabe se fecha.
 */
export type ProximaOperacao =
  | { kind: "ENVIAR"; operacao: OfflineOperation }
  | { kind: "VAZIA" }
  | { kind: "BLOQUEADA_POR_DECISAO"; operacao: OfflineOperation }
  | { kind: "BLOQUEADA_POR_DEPENDENCIA"; operacao: OfflineOperation; dependsOn: number[] }
  | { kind: "AGUARDANDO_BACKOFF"; operacao: OfflineOperation; nextRetryAt: string };

export function nextSendable(
  fila: readonly OfflineOperation[],
  agora: number = Date.now()
): ProximaOperacao {
  const porSequence = new Map(fila.map((op) => [op.sequence, op]));

  for (const op of ordenada(fila)) {
    if (op.status === "SYNCED") continue;
    // Para no primeiro problema: nada depois de um conflito é enviado.
    if (requiresCaregiverDecision(op.status)) {
      return { kind: "BLOQUEADA_POR_DECISAO", operacao: op };
    }
    if (op.status === "SYNCING") {
      return { kind: "BLOQUEADA_POR_DEPENDENCIA", operacao: op, dependsOn: [] };
    }
    const faltando = op.dependsOn.filter(
      (seq) => porSequence.get(seq)?.status !== "SYNCED"
    );
    if (faltando.length > 0) {
      return { kind: "BLOQUEADA_POR_DEPENDENCIA", operacao: op, dependsOn: faltando };
    }
    if (op.nextRetryAt && Date.parse(op.nextRetryAt) > agora) {
      return {
        kind: "AGUARDANDO_BACKOFF",
        operacao: op,
        nextRetryAt: op.nextRetryAt,
      };
    }
    return { kind: "ENVIAR", operacao: op };
  }
  return { kind: "VAZIA" };
}

// ---------- Limpeza ----------

/**
 * Remove SOMENTE o que o servidor confirmou.
 *
 * A assinatura poderia aceitar um filtro; não aceita de propósito. Um
 * `pruneWhere(predicado)` seria o caminho por onde, um dia, alguém apagaria
 * uma operação pendente sem perceber — e §8 diz que isso nunca acontece em
 * silêncio.
 */
export function pruneSynced(
  fila: readonly OfflineOperation[]
): { fila: OfflineOperation[]; removidas: number } {
  const restante = fila.filter((op) => !isDiscardable(op.status));
  return { fila: restante, removidas: fila.length - restante.length };
}

/** Há algo que o cuidador perderia se a área local fosse apagada agora? */
export function temPendenciaIrrecuperavel(fila: readonly OfflineOperation[]): boolean {
  return fila.some((op) => op.status !== "SYNCED");
}

// ---------- Estado visual ----------

/**
 * O que o cuidador vê. "Sincronizado" só aparece quando `SYNCED` existe de
 * verdade na fila — nunca da mera ausência de pendência (§6, e agora também
 * a garantia inversa: ausência de pendência não vira "sincronizado" sozinha).
 *
 * A prioridade entre estados segue o que exige mais atenção primeiro:
 * conflito e falha (decisão do cuidador) vêm antes de sincronizando, que vem
 * antes de "aguardando" ou "pendente".
 */
export function resumo(
  fila: readonly OfflineOperation[],
  online: boolean
): OfflineStatusSummary {
  const pending = fila.filter((op) => isPendingStatus(op.status)).length;
  const syncing = fila.filter((op) => op.status === "SYNCING").length;
  const conflicts = fila.filter((op) => op.status === "CONFLICT").length;
  const failures = fila.filter((op) => op.status === "FAILED").length;
  const synced = fila.filter((op) => op.status === "SYNCED").length;
  // 401/403 (Fase B, §9): a fila fica FAILED, mas a decisão que resolve não
  // é "tentar de novo" — é entrar de novo. O chip precisa dizer isso, não
  // "não conseguimos enviar", que sugeriria um problema de rede.
  const exigeAutenticacao = fila.some(
    (op) => op.status === "FAILED" && op.lastError?.kind === "unauthorized"
  );

  let state: OfflineVisualState;
  if (conflicts > 0) state = "CONFLITO";
  else if (exigeAutenticacao) state = "AUTENTICACAO_NECESSARIA";
  else if (failures > 0) state = "FALHA";
  else if (syncing > 0) state = "SINCRONIZANDO";
  else if (pending === 0 && synced > 0) state = "SINCRONIZADO";
  else if (pending === 0) state = "SEM_PENDENCIA";
  else if (!online) state = "AGUARDANDO_CONEXAO";
  else state = "SINCRONIZACAO_PENDENTE";

  return { state, pending, syncing, conflicts, failures, synced, online };
}

// ---------- Restauração ----------

/**
 * Valida uma linha lida do banco local. Uma operação malformada é DESCARTADA
 * com aviso, nunca "corrigida": adivinhar o que faltava numa intenção clínica
 * é pior do que admitir que ela se perdeu.
 */
export function restoreOperation(bruto: unknown): OfflineOperation | null {
  if (bruto === null || typeof bruto !== "object") return null;
  const v = bruto as Record<string, unknown>;
  const texto = (k: string): string | null =>
    typeof v[k] === "string" && v[k] ? (v[k] as string) : null;

  const id = texto("id");
  const idempotencyKey = texto("idempotencyKey");
  const sessionId = texto("sessionId");
  const patientId = texto("patientId");
  const operationType = texto("operationType");
  const status = texto("status");
  const createdAt = texto("createdAt");

  if (!id || !idempotencyKey || !sessionId || !patientId || !operationType) {
    return null;
  }
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) return null;
  if (
    status !== "PENDING" &&
    status !== "SYNCING" &&
    status !== "SYNCED" &&
    status !== "CONFLICT" &&
    status !== "FAILED"
  ) {
    return null;
  }
  if (Number(v.schemaVersion) !== OFFLINE_SCHEMA_VERSION) return null;

  return {
    id,
    idempotencyKey,
    sessionId,
    patientId,
    userId: texto("userId"),
    operationType: operationType as OfflineOperationType,
    payload: v.payload,
    // SYNCING não sobrevive a um refresh: ninguém está mais em voo. Volta a
    // PENDING, senão a operação ficaria presa num estado sem dono.
    status: status === "SYNCING" ? "PENDING" : status,
    createdAt,
    retryCount: Number(v.retryCount ?? 0),
    sequence: Number(v.sequence ?? 0),
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    updatedAt: texto("updatedAt") ?? createdAt,
    dependsOn: Array.isArray(v.dependsOn)
      ? (v.dependsOn as unknown[]).map(Number).filter((n) => Number.isFinite(n))
      : [],
    baseVersion: texto("baseVersion"),
    lastError: (v.lastError as OfflineOperationError | null) ?? null,
    nextRetryAt: texto("nextRetryAt"),
    createdEntityId: texto("createdEntityId"),
    remoteConfirmedAt: texto("remoteConfirmedAt"),
    remoteEntityId: texto("remoteEntityId"),
    conflict: restoreConflict(v.conflict),
  };
}
