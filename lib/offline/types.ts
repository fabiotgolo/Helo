// ——— Continuidade sem conexão: tipos do armazenamento local (Fase 4.9.2) ———
//
// Módulo neutro: sem IndexedDB, sem Web Crypto, sem React. É o vocabulário que
// a fila, a projeção, o banco local e a interface compartilham — e é aqui que
// mora a única regra que nenhuma das quatro pode contornar.
//
// O PRINCÍPIO, e a razão de tudo abaixo ter a forma que tem:
//
//   O armazenamento local é um registro de INTENÇÕES, nunca uma réplica do
//   banco.
//
// Três estatutos, separados de propósito e com tipos diferentes:
//
//   snapshot  → o que o SERVIDOR disse. É fato. Só ele alimenta o portão de
//               autoria (lib/confirmed-patient-statement.ts).
//   fila      → o que o CUIDADOR pediu e ainda não foi aceito. É intenção.
//   rascunho  → texto ainda não enviado. Não é nem uma coisa nem outra.
//
// Salvar localmente NÃO equivale a confirmar pelo paciente. A projeção
// (lib/offline/projection.ts) recusa, por construção, qualquer patch que
// resulte em CONFIRMED — não por uma lista de ações proibidas que alguém
// precise lembrar de atualizar, mas por um guarda que olha o RESULTADO.
//
// O QUE NUNCA ENTRA AQUI: token de sessão (o cookie é HttpOnly e inalcançável
// por JavaScript, e assim deve permanecer), senha, hash, chave de API
// (ElevenLabs e Anthropic só existem no servidor) e conversation token WebRTC.
// `assertPayloadSemSegredo` recusa em tempo de execução.

// ---------- Versão do schema local ----------

/**
 * Versão do schema do banco local. Subir este número em uma mudança
 * incompatível: a abertura seguinte APAGA a área local e recomeça do servidor.
 *
 * Descartar é seguro porque o snapshot é sempre reconstruível a partir do
 * servidor. A fila NÃO é — por isso `db.ts` avisa quando descarta operações
 * pendentes (§8: nunca apagar operações pendentes em silêncio).
 */
export const OFFLINE_SCHEMA_VERSION = 1;

// ---------- Estados de uma operação ----------

export type OfflineOperationStatus =
  /** Na fila, aguardando conexão. */
  | "PENDING"
  /** Em voo para o servidor (Fase 4.9.3). */
  | "SYNCING"
  /** Aceita pelo servidor. Só o SERVIDOR pode colocar uma operação aqui. */
  | "SYNCED"
  /** Recusada: o estado do servidor divergiu. Exige decisão do cuidador. */
  | "CONFLICT"
  /** Falha permanente. Exige decisão do cuidador. */
  | "FAILED";

export const OFFLINE_OPERATION_STATUSES: readonly OfflineOperationStatus[] = [
  "PENDING",
  "SYNCING",
  "SYNCED",
  "CONFLICT",
  "FAILED",
] as const;

/** Operação que ainda espera algo do servidor — nunca pode ser descartada. */
export function isPendingStatus(s: OfflineOperationStatus): boolean {
  return s === "PENDING" || s === "SYNCING";
}

/** Operação que exige uma decisão do cuidador antes de sumir. */
export function requiresCaregiverDecision(s: OfflineOperationStatus): boolean {
  return s === "CONFLICT" || s === "FAILED";
}

/** Só isto pode ser descartado sem perguntar a ninguém. */
export function isDiscardable(s: OfflineOperationStatus): boolean {
  return s === "SYNCED";
}

// ---------- Tipos de operação ----------
// Espelham EXATAMENTE os métodos de escrita de RtqPersistence. Um nome novo
// aqui sem o adaptador correspondente em projection.ts é erro de compilação.

export type OfflineOperationType =
  | "createTurn"
  | "turnAction"
  | "createPath"
  | "pathAction"
  | "createNode"
  | "reviewNode"
  | "nodeAction"
  | "createStatement"
  | "statementAction"
  | "createCaregiverInterpretation"
  | "saveSessionContext"
  | "openPatientControl"
  | "patientControlAction"
  | "sessionAction";

export const OFFLINE_OPERATION_TYPES: readonly OfflineOperationType[] = [
  "createTurn",
  "turnAction",
  "createPath",
  "pathAction",
  "createNode",
  "reviewNode",
  "nodeAction",
  "createStatement",
  "statementAction",
  "createCaregiverInterpretation",
  "saveSessionContext",
  "openPatientControl",
  "patientControlAction",
  "sessionAction",
] as const;

export function isOfflineOperationType(v: unknown): v is OfflineOperationType {
  return (
    typeof v === "string" &&
    (OFFLINE_OPERATION_TYPES as readonly string[]).includes(v)
  );
}

// ---------- A operação ----------

/**
 * Natureza da falha, declarada AQUI e não importada de
 * `realtime-question-client.ts`: aquele módulo é "use client" e carrega React,
 * e este precisa continuar puro o bastante para os testes de domínio rodarem
 * em Node, sem navegador. Os nomes são deliberadamente os mesmos de
 * `RtqErrorKind`, mais `queued` — que só existe offline.
 */
export type OfflineErrorKind =
  | "offline"
  | "unauthorized"
  | "conflict"
  | "notFound"
  | "unknown"
  | "queued";

export interface OfflineOperationError {
  kind: OfflineErrorKind;
  message: string;
  at: string;
}

/**
 * Uma intenção do cuidador, guardada até o servidor aceitá-la.
 *
 * `patientId` é STRING aqui, e não o `number` do domínio, de propósito: este é
 * o valor de CHAVE do armazenamento local, e uma chave numérica convidaria a
 * comparações frouxas (`==`, coerção) exatamente no ponto em que misturar dois
 * pacientes é o pior erro possível. A conversão acontece uma vez só, na
 * fronteira (`patientKey`), e é explícita.
 */
export interface OfflineOperation {
  /** Identidade da operação na fila. Não é a identidade de nenhum registro. */
  id: string;
  /**
   * Chave de idempotência ESTÁVEL. Gerada uma vez, no gesto do cuidador, e
   * preservada por todas as retentativas — é o oposto do hábito atual da
   * interface, que chama `newRequestId` a cada clique. É ela que o servidor
   * usará (4.9.3) para reconhecer um reenvio em vez de gravar duas vezes.
   */
  idempotencyKey: string;

  sessionId: string;
  /** Chave do paciente, em string. Ver a nota acima. */
  patientId: string;

  operationType: OfflineOperationType;
  payload: unknown;

  status: OfflineOperationStatus;
  createdAt: string;
  retryCount: number;

  // ——— Campos técnicos aprovados na auditoria (§4) ———

  /** Ordem causal dentro da sessão. Monotônica, atribuída na inserção. */
  sequence: number;
  /** Versão do schema que gravou esta operação. */
  schemaVersion: number;
  updatedAt: string;
  /** `sequence` das operações que precisam estar SYNCED antes desta. */
  dependsOn: number[];
  /**
   * `updatedAt` da entidade alvo no momento em que o cuidador agiu. É o que
   * permitirá (4.9.3) detectar que o servidor mudou por baixo — sem isso, um
   * conflito seria indistinguível de um sucesso.
   */
  baseVersion: string | null;
  lastError: OfflineOperationError | null;
  nextRetryAt: string | null;

  /**
   * Id do registro que ESTA operação cria, quando ela cria algum. Gerado no
   * cliente e preservado no servidor (§5) — não é um handle temporário, é a
   * identidade definitiva do registro.
   */
  createdEntityId: string | null;

  // ——— Confirmação remota (Fase B) ———
  //
  // Preenchidos SOMENTE depois que o servidor responde com sucesso — nunca
  // otimisticamente, nunca a partir de um palpite local.

  /**
   * O horário que o SERVIDOR devolveu como referência da confirmação (o
   * `updatedAt`/`createdAt` da entidade na resposta). Não é o relógio deste
   * aparelho — é o retrato de quando o servidor disse "aceito".
   */
  remoteConfirmedAt: string | null;
  /**
   * O identificador que o servidor confirmou para o registro afetado.
   * Normalmente é IGUAL a `createdEntityId` — o cliente propõe, o servidor
   * aceita (§3.3 revisto) — e diferir dos dois só aconteceria se o servidor
   * tivesse recusado a proposta, o que já é um erro tratado antes de chegar
   * aqui. Existe como campo próprio porque a confirmação é um FATO do
   * servidor, não uma repetição do que o cliente já sabia.
   */
  remoteEntityId: string | null;

  // ——— Conflito nomeado (Fase C, §10) ———

  /**
   * QUAL das treze linhas da matriz aconteceu, com os fatos que a tela de
   * decisão precisa mostrar. Preenchido só quando `status === "CONFLICT"`.
   *
   * É campo próprio, e não algo derivado de `lastError`, porque `lastError` é
   * uma frase para o humano ler e este é um dado estruturado para a tela
   * consumir. Guardá-lo junto da operação — e não em memória — é o que faz o
   * conflito sobreviver a um refresh: uma decisão clínica pendente não pode
   * depender da aba continuar aberta.
   *
   * O tipo vem de `conflicts.ts` como `unknown` para manter este módulo sem
   * dependência de lá (é `conflicts.ts` que importa daqui, não o contrário);
   * `restoreConflict` valida na leitura.
   */
  conflict: unknown | null;
}

// ---------- Retry e backoff (Fase B, §9 da auditoria) ----------

/** Depois disto, a operação para de tentar sozinha e vira FAILED. */
export const MAX_RETRY = 8;

/**
 * Backoff exponencial com teto e um pouco de ruído — o ruído existe para que
 * várias abas ou vários dispositivos do MESMO cuidador, se caírem juntos, não
 * batam no servidor todos no mesmo milissegundo quando a rede volta.
 *
 * 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s (teto 300s) — a mesma progressão que
 * o algoritmo da auditoria descreve, só com números concretos.
 */
export function backoffMs(retryCount: number): number {
  const base = Math.min(2000 * 2 ** Math.max(0, retryCount - 1), 300_000);
  const ruido = base * 0.2 * Math.random();
  return Math.round(base + ruido);
}

// ---------- Snapshot ----------

export type OfflineSnapshotKind = "sessionDetail" | "pathDetails";

/**
 * A última verdade que o servidor disse. Somente leitura. É o ÚNICO material
 * que pode alimentar `tryToConfirmedPatientStatement`.
 */
export interface OfflineSnapshot<T = unknown> {
  kind: OfflineSnapshotKind;
  sessionId: string;
  patientId: string;
  /** Horário do SERVIDOR na leitura? Não: é o relógio local da leitura. */
  snapshotAt: string;
  schemaVersion: number;
  value: T;
}

// ---------- Rascunhos ----------

/** Texto do cuidador ainda não enviado. Não é intenção nem fato. */
export interface OfflineDraft {
  sessionId: string;
  patientId: string;
  /** Chave da tela que possui o rascunho (nível, compositor, contexto…). */
  key: string;
  value: unknown;
  updatedAt: string;
}

// ---------- Estado visual ----------
//
// Até a Fase A, "Sincronizado" não existia: nada tinha sido confirmado
// remotamente. A Fase B é o dia em que ele nasce — e nasce EXATAMENTE como
// prometido, da confirmação do servidor (`status === "SYNCED"`), nunca da
// ausência de pendências locais. Uma fila vazia porque nada foi digitado
// ainda é "SEM_PENDENCIA"; uma fila vazia porque tudo foi enviado e
// confirmado é "SINCRONIZADO" — são fatos diferentes, e a tela não pode
// confundir um com o outro.

export type OfflineVisualState =
  | "SEM_PENDENCIA"
  | "SALVO_LOCALMENTE"
  | "AGUARDANDO_CONEXAO"
  | "SINCRONIZACAO_PENDENTE"
  /** Uma operação está em voo AGORA — não "vai enviar", está enviando. */
  | "SINCRONIZANDO"
  /** Havia pendência; o servidor confirmou tudo. Estado transitório. */
  | "SINCRONIZADO"
  | "CONFLITO"
  | "FALHA"
  | "AUTENTICACAO_NECESSARIA";

export interface OfflineStatusSummary {
  state: OfflineVisualState;
  /** Operações que ainda esperam o servidor (PENDING ou SYNCING). */
  pending: number;
  /** Só as que estão EM VOO agora, dentro de `pending`. */
  syncing: number;
  conflicts: number;
  failures: number;
  /** Confirmadas pelo servidor e ainda presentes na fila (§ pruneSynced). */
  synced: number;
  online: boolean;
}

// ---------- Expiração ----------

const DIA = 24 * 60 * 60 * 1000;

/** Conteúdo comum: 7 dias. */
export const OFFLINE_TTL_MS = 7 * DIA;
/** Conteúdo marcado como sensível: 24 horas. */
export const OFFLINE_SENSITIVE_TTL_MS = 1 * DIA;

export function isExpired(
  snapshotAt: string,
  now: number,
  sensitive: boolean
): boolean {
  const t = Date.parse(snapshotAt);
  if (Number.isNaN(t)) return true;
  return now - t > (sensitive ? OFFLINE_SENSITIVE_TTL_MS : OFFLINE_TTL_MS);
}

// ---------- Segredos ----------

/**
 * Nomes que NUNCA podem aparecer num payload da fila. A lista é de campo, não
 * de valor: procurar "parece um token" é adivinhação, procurar o NOME do campo
 * é verificável.
 */
const CAMPOS_PROIBIDOS = [
  "token",
  "accesstoken",
  "idtoken",
  "refreshtoken",
  "sessiontoken",
  "conversationtoken",
  "cookie",
  "__session",
  "password",
  "senha",
  "passwordhash",
  "apikey",
  "api_key",
  "secret",
  "authorization",
  "credential",
  "privatekey",
] as const;

export class OfflineSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineSecurityError";
  }
}

/**
 * Recusa um payload que carregue credencial. Roda ANTES de qualquer gravação,
 * e roda em profundidade — um segredo aninhado três níveis abaixo é tão
 * proibido quanto um no topo.
 *
 * Isto não é paranoia decorativa: a fila é o único lugar do produto onde dado
 * de requisição é PERSISTIDO no dispositivo. Um campo a mais no corpo de uma
 * rota, meses adiante, viraria credencial em disco sem que ninguém notasse.
 */
export function assertPayloadSemSegredo(payload: unknown, caminho = "payload"): void {
  if (payload === null || typeof payload !== "object") return;
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertPayloadSemSegredo(item, `${caminho}[${i}]`));
    return;
  }
  for (const [chave, valor] of Object.entries(payload as Record<string, unknown>)) {
    const normalizada = chave.toLowerCase().replace(/[-_\s]/g, "");
    if ((CAMPOS_PROIBIDOS as readonly string[]).includes(normalizada)) {
      throw new OfflineSecurityError(
        `${caminho}.${chave}: credenciais nunca entram no armazenamento local`
      );
    }
    assertPayloadSemSegredo(valor, `${caminho}.${chave}`);
  }
}

// ---------- Escopo ----------

/**
 * Chave de escopo do armazenamento. Usuário E paciente, sempre os dois: é o
 * que impede que a área de um cuidador seja lida por outro na mesma máquina, e
 * que a fila de um paciente encoste na de outro.
 */
export function scopeKey(userId: string, patientId: string): string {
  return `${userId}::${patientId}`;
}

export function patientKey(patientId: number): string {
  if (!Number.isInteger(patientId) || patientId <= 0) {
    throw new OfflineSecurityError("paciente inválido para o armazenamento local");
  }
  return String(patientId);
}
