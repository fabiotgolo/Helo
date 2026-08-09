// ——— Projeção: o snapshot mais a fila (Fase 4.9.2) ———
//
// Módulo PURO. Recebe o que o servidor disse por último (snapshot) e o que o
// cuidador pediu desde então (fila), e devolve o que a tela deve mostrar.
//
// A decisão que define este arquivo: ele NÃO reimplementa o domínio. Ele
// executa as MESMAS máquinas de estados que o servidor executa —
// `applyTurnAction`, `applyNodeAction`, `applyStatementAction`,
// `applySessionAction`, `applyPatientControlAction` —, que por sorte (ou por
// bom desenho anterior) são módulos neutros, sem nada de servidor dentro.
//
// Isso não é economia de código. Uma segunda implementação das transições
// divergiria da primeira, e a divergência apareceria como "offline o Helo
// deixou, online recusou" — na cara do cuidador, no meio de uma conversa. Aqui
// o que ele vê offline é, literalmente, o que o servidor vai computar.
//
// ——— A LINHA QUE ESTE ARQUIVO NÃO CRUZA ———
//
// Uma FRASE nunca chega a CONFIRMED pela projeção.
//
// `toConfirmedPatientStatement` (lib/confirmed-patient-statement.ts) é o portão
// único da autoria, e ele aceita exatamente um tipo:
// `OptionConversationFinalStatement`. Se a projeção pudesse produzir uma frase
// CONFIRMED, bastaria entregá-la ao portão para a interface escrever
// "Confirmada pelo paciente" sobre um SIM que o servidor nunca viu. Salvar
// localmente não é confirmar (§7).
//
// O guarda olha o RESULTADO, não o nome da ação. Uma ação nova que um dia
// resulte em CONFIRMED já nasce barrada, sem ninguém precisar lembrar de
// acrescentá-la a uma lista. `assertNenhumaFalaForjada` prova isso contra o
// portão de verdade, e não contra uma cópia da regra dele.
//
// A intenção de confirmar NÃO se perde: ela fica na fila e a frase entra em
// `confirmacaoPendente`, que a interface mostra como "Confirmação salva neste
// aparelho · aguardando conexão".
//
// ONDE A LINHA NÃO PASSA, e por quê. Um NÍVEL confirmado (`CONFIRM_OPTION`) e
// um turno conferido (`VERIFY_RESPONSE`) continuam acontecendo offline. Eles
// não são a mesma coisa: confirmar uma opção é o assistente atestando que o
// botão corresponde ao gesto que ele observou — a conferência dele, sobre a
// própria leitura —, e nenhum dos dois é aceito pelo portão de autoria em
// hipótese alguma. Barrá-los tornaria impossível aprofundar sem conexão, que é
// metade do que a fase existe para permitir, sem nada ganhar em autoria.
//
// O que o paciente CONFIRMA, e só ele, é a frase. É por isso que a linha está
// exatamente aí.

import {
  applySessionAction,
  applyTurnAction,
  type SessionAction,
  type TurnAction,
} from "@/lib/realtime-question-machine";
import {
  applyNodeAction,
  applyPathAction,
  applyStatementAction,
  type NodeAction,
  type PathAction,
  type StatementAction,
} from "@/lib/option-conversation-machine";
import { applyPatientControlAction } from "@/lib/patient-control-machine";
import type { PatientControlAction } from "@/lib/patient-control-machine";
import {
  assertNodeInvariants,
  assertStatementInvariants,
  MAX_PROMPT_LEN,
  MODO_POR_ORIGEM,
  normalizeOptions,
  RtqDomainError,
  type OptionConversationFinalStatement,
  type OptionConversationNode,
  type OptionConversationOption,
  type OptionConversationPath,
  type PathDetail,
  type StatementOrigin,
} from "@/lib/option-conversation-types";
import {
  assertTurnInvariants,
  type ConversationQuestionSession,
  type ConversationQuestionTurn,
  type SensitiveCategory,
} from "@/lib/realtime-question-types";
import type { PatientControlRequest } from "@/lib/patient-control-types";
import type { SessionContextVersion } from "@/lib/session-context-types";
import { tryToConfirmedPatientStatement } from "@/lib/confirmed-patient-statement";
// Só os prefixos: a projeção NÃO cunha identidade aleatória. Tudo o que ela
// gera é derivado da operação (`geradorDeterministico`), porque ela roda de
// novo a cada renderização e um id novo por quadro trocaria a identidade das
// opções debaixo da seleção que o cuidador acabou de registrar.
import { PREFIXO } from "@/lib/offline/ids";
import { ordenada } from "@/lib/offline/queue";
import type { OfflineOperation } from "@/lib/offline/types";

// ---------- O que a projeção devolve, além dos dados ----------

export interface ProjecaoMarcas {
  /** Registros que existem SÓ neste aparelho — o servidor ainda não os viu. */
  locais: Set<string>;
  /**
   * Frases cuja CONFIRMAÇÃO está apenas na fila. A interface mostra
   * "Confirmação salva neste aparelho"; nunca "Confirmada pelo paciente".
   */
  confirmacaoPendente: Set<string>;
  /** Operações que a projeção não conseguiu aplicar, e por quê. */
  naoAplicadas: { sequence: number; operationType: string; motivo: string }[];
}

function marcasVazias(): ProjecaoMarcas {
  return {
    locais: new Set(),
    confirmacaoPendente: new Set(),
    naoAplicadas: [],
  };
}

/** Estado da sessão que a tela consome (o mesmo `SessionDetail` do cliente). */
export interface SessionDetailBase {
  session: ConversationQuestionSession;
  turns: ConversationQuestionTurn[];
  context: SessionContextVersion | null;
  controlRequest: PatientControlRequest | null;
}

// ---------- Identidade do autor local ----------

/**
 * Quem está operando. Vem da sessão autenticada que JÁ existia quando a
 * conexão caiu — nunca de um login offline, que esta fase não implementa.
 */
export interface AutorLocal {
  assistantId: string;
  assistantName: string | null;
  patientId: number;
}

// ---------- O guarda de autoria ----------

/**
 * Aplica um patch de frase, a menos que ele resulte em confirmação.
 *
 * Olha o `status` que a máquina PRODUZIU. É a única forma de o guarda
 * continuar valendo quando o domínio crescer: uma lista de ações proibidas
 * envelhece em silêncio; uma checagem do resultado, não.
 */
function aplicarPatchDeFrase(
  frase: OptionConversationFinalStatement,
  resultado: { status: string; patch: Partial<OptionConversationFinalStatement> },
  marcas: ProjecaoMarcas
): OptionConversationFinalStatement {
  if (resultado.status === "CONFIRMED") {
    marcas.confirmacaoPendente.add(frase.id);
    // O patch é DESCARTADO. A intenção continua na fila; a frase, na tela,
    // continua exatamente onde estava.
    return frase;
  }
  return { ...frase, ...resultado.patch };
}

/**
 * Prova, contra o portão de verdade, que a projeção não forjou fala nenhuma.
 *
 * Recebe as frases que o SERVIDOR já tinha confirmado — essas podem passar
 * pelo portão, porque quem as confirmou foi ele. Qualquer outra que passe é
 * fala forjada localmente, e isso é um defeito, não um caso de borda.
 */
export function assertNenhumaFalaForjada(
  frases: readonly OptionConversationFinalStatement[],
  confirmadasPeloServidor: ReadonlySet<string>
): void {
  for (const frase of frases) {
    if (confirmadasPeloServidor.has(frase.id)) continue;
    if (tryToConfirmedPatientStatement(frase) !== null) {
      throw new RtqDomainError(
        `a projeção local produziu fala confirmada sem o servidor: ${frase.id}`
      );
    }
  }
}

/** Ids das frases que o servidor já havia confirmado no snapshot. */
export function confirmadasNoSnapshot(
  base: readonly PathDetail[]
): Set<string> {
  const saida = new Set<string>();
  for (const detalhe of base) {
    for (const s of detalhe.statements) {
      if (tryToConfirmedPatientStatement(s) !== null) saida.add(s.id);
    }
  }
  return saida;
}

// ---------- O que pode ser feito sem conexão ----------

/**
 * Nem toda ação cabe offline, e a recusa precisa acontecer ANTES de virar
 * intenção guardada: enfileirar algo que nunca poderia ser aceito é prometer
 * ao cuidador um registro que não vai existir.
 *
 * Devolve o motivo da recusa, ou `null` quando pode.
 */
export function motivoParaRecusarOffline(
  operationType: string,
  payload: unknown,
  session: ConversationQuestionSession
): string | null {
  // §5: nunca operar sobre uma sessão que já terminou.
  if (session.status === "COMPLETED" || session.status === "ABANDONED") {
    return "esta conversa já foi encerrada";
  }

  const p = (payload ?? {}) as Record<string, unknown>;
  const acao = (p.action ?? {}) as Record<string, unknown>;

  // Encerrar e abandonar são declarações do cuidador sobre a conversa inteira.
  // Elas precisam chegar ao servidor no momento em que são feitas — offline,
  // ficariam guardadas em silêncio enquanto a sessão continua aberta para
  // qualquer outro aparelho. §2 permite pausar e retomar; não permite concluir.
  if (operationType === "sessionAction") {
    const valor = typeof p.action === "string" ? p.action : "";
    if (valor === "COMPLETE" || valor === "ABANDON") {
      return "encerrar a conversa exige conexão";
    }
  }
  if (operationType === "pathAction") {
    const kind = typeof acao.kind === "string" ? acao.kind : "";
    if (kind === "COMPLETE") return "concluir o caminho exige conexão";
  }

  return null;
}

// ---------- Construtores locais ----------
// Espelham `buildNode`/`buildStatement` do servidor. Cada um termina numa
// asserção de invariante do PRÓPRIO domínio: um registro local malformado
// falha aqui, na tela do cuidador, e não seis horas depois na sincronização.

function limpar(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function construirTurno(args: {
  id: string;
  sessionId: string;
  autor: AutorLocal;
  sequence: number;
  text: string;
  questionSource?: string;
  originalText?: string | null;
  isSensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;
  reusedFromTurnId: string | null;
  agora: string;
}): ConversationQuestionTurn {
  // Só as origens que o domínio aceita hoje. Um valor desconhecido na fila
  // (schema antigo, gravação truncada) cai para o padrão em vez de reprovar a
  // invariante e travar a sincronização inteira do cuidador.
  const ditada = args.questionSource === "VOICE_TRANSCRIPTION";
  const turno: ConversationQuestionTurn = {
    id: args.id,
    sessionId: args.sessionId,
    patientId: args.autor.patientId,
    assistantId: args.autor.assistantId,
    sequence: args.sequence,
    interactionMode: "CLOSED_CONFIRMATION",
    // A origem vinha fixa em MANUAL_TEXT, e por três fases isso foi verdade —
    // não havia outra. Com o ditado ela deixa de ser: uma pergunta falada com
    // rede e submetida depois que a rede caiu chegaria ao prontuário como
    // digitada, e a procedência se perderia exatamente no caso em que ninguém
    // olharia de novo. O espelho local passa a carregar o que a operação diz.
    questionSource: ditada ? "VOICE_TRANSCRIPTION" : "MANUAL_TEXT",
    originalText: ditada ? limpar(args.originalText, 500) || null : null,
    reviewedText: limpar(args.text, 500),
    presentedText: "",
    status: "DRAFT",
    provisionalResponse: null,
    confirmedResponse: null,
    isSensitive: args.isSensitive,
    sensitiveCategory: args.sensitiveCategory,
    reusedFromTurnId: args.reusedFromTurnId,
    presentedAt: null,
    responseObservedAt: null,
    assistantVerifiedAt: null,
    reconfirmedAt: null,
    confirmedAt: null,
    canceledAt: null,
    responseTimeMs: null,
    correctionCount: 0,
    representCount: 0,
    createdAt: args.agora,
    updatedAt: args.agora,
  };
  assertTurnInvariants(turno);
  return turno;
}

export function construirCaminho(args: {
  id: string;
  sessionId: string;
  autor: AutorLocal;
  kind: "OPTION_TREE" | "CAREGIVER_INTERPRETATION";
  sequence: number;
  /** Ramificação inicial. Vem de fora, e determinístico — ver `geradorDeterministico`. */
  branchId: string;
  agora: string;
}): OptionConversationPath {
  return {
    id: args.id,
    sessionId: args.sessionId,
    patientId: args.autor.patientId,
    assistantId: args.autor.assistantId,
    kind: args.kind,
    status: "ACTIVE",
    rootNodeId: null,
    activeNodeId: null,
    activeBranchId: args.branchId,
    finalStatementId: null,
    sequence: args.sequence,
    restartedFromPathId: null,
    reusedFromPathId: null,
    clientRequestId: null,
    startedAt: args.agora,
    pausedAt: null,
    resumedAt: null,
    completedAt: null,
    interruptedAt: null,
    restartedAt: null,
    createdAt: args.agora,
    updatedAt: args.agora,
  };
}

export function construirNivel(args: {
  id: string;
  sessionId: string;
  pathId: string;
  autor: AutorLocal;
  parentNodeId: string | null;
  branchId: string;
  depth: number;
  sequence: number;
  promptText: string;
  options: OptionConversationOption[];
  isSensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;
  agora: string;
}): OptionConversationNode {
  const nivel: OptionConversationNode = {
    id: args.id,
    pathId: args.pathId,
    sessionId: args.sessionId,
    patientId: args.autor.patientId,
    assistantId: args.autor.assistantId,
    parentNodeId: args.parentNodeId,
    branchId: args.branchId,
    depth: args.depth,
    sequence: args.sequence,
    interactionMode: "OPTION_SELECTION",
    promptText: args.promptText,
    status: "DRAFT",
    options: args.options,
    provisionalOptionId: null,
    confirmedOptionId: null,
    reusedFromNodeId: null,
    replacesNodeId: null,
    replacedByNodeId: null,
    isSensitive: args.isSensitive,
    sensitiveCategory: args.sensitiveCategory,
    correctionCount: 0,
    clientRequestId: null,
    presentedAt: null,
    selectedAt: null,
    confirmedAt: null,
    deactivatedAt: null,
    canceledAt: null,
    replacedAt: null,
    createdAt: args.agora,
    updatedAt: args.agora,
  };
  assertNodeInvariants(nivel);
  return nivel;
}

export function construirFrase(args: {
  id: string;
  sessionId: string;
  pathId: string;
  autor: AutorLocal;
  origin: StatementOrigin;
  originNodeId: string | null;
  text: string;
  isSensitive: boolean;
  sensitiveCategory: SensitiveCategory | null;
  agora: string;
}): OptionConversationFinalStatement {
  const texto = limpar(args.text, 500);
  const frase: OptionConversationFinalStatement = {
    id: args.id,
    pathId: args.pathId,
    sessionId: args.sessionId,
    patientId: args.autor.patientId,
    assistantId: args.autor.assistantId,
    originNodeId: args.originNodeId,
    // A origem é do domínio, não da tela: é ela que dirá, depois, que quem
    // formulou o texto foi o cuidador. Perdê-la offline seria perder a
    // distinção que a Fase 4.2 existe para preservar.
    origin: args.origin,
    interactionMode: MODO_POR_ORIGEM[args.origin],
    originalDraft: texto,
    currentText: texto,
    presentedText: "",
    status: "DRAFT",
    provisionalResponse: null,
    confirmedResponse: null,
    reusedFromStatementId: null,
    replacesStatementId: null,
    replacedByStatementId: null,
    isSensitive: args.isSensitive,
    sensitiveCategory: args.sensitiveCategory,
    editCount: 0,
    correctionCount: 0,
    representCount: 0,
    clientRequestId: null,
    presentedAt: null,
    respondedAt: null,
    reconfirmedAt: null,
    confirmedAt: null,
    rejectedAt: null,
    canceledAt: null,
    replacedAt: null,
    createdAt: args.agora,
    updatedAt: args.agora,
  };
  assertStatementInvariants(frase);
  return frase;
}

export function construirContexto(args: {
  id: string;
  sessionId: string;
  autor: AutorLocal;
  version: number;
  anterior: SessionContextVersion | null;
  entrada: Record<string, unknown>;
  agora: string;
}): SessionContextVersion {
  const pulado = args.entrada.skipped === true;
  const campo = (nome: string, max = 200): string | null => {
    const v = args.entrada[nome];
    if (typeof v !== "string") return null;
    const limpo = v.replace(/\s+/g, " ").trim().slice(0, max);
    return limpo || null;
  };
  const nome = pulado ? null : campo("interlocutorName");
  return {
    id: args.id,
    sessionId: args.sessionId,
    patientId: args.autor.patientId,
    assistantId: args.autor.assistantId,
    version: args.version,
    status: "ACTIVE",
    // Offline não consultamos a rede do paciente, então um interlocutor
    // escolhido da lista não pode ser VALIDADO contra o cadastro. Ele viaja no
    // payload e o servidor decide; localmente ele conta como texto — o que
    // nunca cria contato (§2 da 4.8), que é o comportamento seguro.
    interlocutorSource: pulado ? null : nome ? "FREE_TEXT" : null,
    interlocutorPersonId: null,
    interlocutorName: nome,
    interlocutorRelation: pulado ? null : campo("interlocutorRelation"),
    intention: pulado ? null : campo("intention"),
    environment: pulado ? null : campo("environment"),
    initialTopic: pulado ? null : campo("initialTopic"),
    notes: pulado ? null : campo("notes", 500),
    skipped: pulado,
    filledBy: "ASSISTANT_MANUAL",
    replacesContextId: args.anterior?.id ?? null,
    replacedByContextId: null,
    clientRequestId: null,
    createdAt: args.agora,
    updatedAt: args.agora,
    replacedAt: null,
  };
}

export function construirPedidoDeControle(args: {
  id: string;
  sessionId: string;
  autor: AutorLocal;
  payload: Record<string, unknown>;
  agora: string;
}): PatientControlRequest {
  const texto = (k: string): string | null =>
    typeof args.payload[k] === "string" && args.payload[k]
      ? (args.payload[k] as string)
      : null;
  const alvo = texto("targetType");
  return {
    id: args.id,
    sessionId: args.sessionId,
    patientId: args.autor.patientId,
    assistantId: args.autor.assistantId,
    level: 1,
    interactionMode: "OPTION_SELECTION",
    status: "OPEN",
    provisionalCommand: null,
    confirmedCommand: null,
    endResponse: null,
    targetType:
      alvo === "TURN" || alvo === "NODE" || alvo === "STATEMENT" ? alvo : null,
    targetId: texto("targetId"),
    targetPathId: texto("targetPathId"),
    notUnderstoodAt: null,
    subjectChangedAt: null,
    presentedAt: null,
    selectedAt: null,
    confirmedAt: null,
    executedAt: null,
    canceledAt: null,
    closedAt: null,
    representCount: 0,
    correctionCount: 0,
    clientRequestId: null,
    createdAt: args.agora,
    updatedAt: args.agora,
  };
}

/**
 * Gerador de ids DETERMINÍSTICO, derivado da operação.
 *
 * Isto não é um detalhe: a projeção roda de novo a cada renderização, e ids
 * aleatórios fariam as opções de um nível trocarem de identidade entre um
 * quadro e o seguinte. O `provisionalOptionId` que o cuidador acabou de
 * registrar apontaria para uma opção que já não existe, e a seleção observada
 * do paciente sumiria da tela — sem erro, sem aviso, só sumiria.
 *
 * Derivar da chave de idempotência dá as três propriedades que precisamos:
 * estável entre projeções, estável entre um refresh e o seguinte (a chave está
 * gravada), e distinta entre operações.
 */
function geradorDeterministico(op: OfflineOperation, prefixo: string): () => string {
  const semente = op.idempotencyKey.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const cauda = semente.slice(-14) || op.sequence.toString(36);
  let n = 0;
  return () => `${prefixo}${cauda}${(n++).toString(36)}`;
}

/**
 * A ação REVIEW como o servidor a monta em `reviewNode`: texto aparado, opções
 * normalizadas, e campos ausentes REALMENTE ausentes — mandar
 * `isSensitive: undefined` não é o mesmo que não mandar, porque a máquina
 * distingue "não mexa neste campo" de "coloque este valor".
 */
function revisaoNormalizada(entrada: unknown, op: OfflineOperation): NodeAction {
  const input = (entrada ?? {}) as Record<string, unknown>;
  const promptText =
    input.promptText === undefined
      ? undefined
      : limpar(input.promptText, MAX_PROMPT_LEN).replace(/\s+/g, " ");
  const options =
    input.options === undefined
      ? undefined
      : normalizeOptions(input.options, geradorDeterministico(op, PREFIXO.option));

  return {
    kind: "REVIEW",
    ...(promptText !== undefined ? { promptText } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(input.isSensitive !== undefined
      ? { isSensitive: input.isSensitive === true }
      : {}),
    ...(input.sensitiveCategory !== undefined
      ? {
          sensitiveCategory:
            (input.sensitiveCategory as SensitiveCategory | null) ?? null,
        }
      : {}),
  };
}

// ---------- Projeção da sessão ----------

export function projetarSessao(
  base: SessionDetailBase,
  fila: readonly OfflineOperation[],
  autor: AutorLocal
): { detail: SessionDetailBase; marcas: ProjecaoMarcas } {
  const marcas = marcasVazias();
  let session = { ...base.session };
  let turns = base.turns.map((t) => ({ ...t }));
  let context = base.context ? { ...base.context } : null;
  let controlRequest = base.controlRequest ? { ...base.controlRequest } : null;

  for (const op of ordenada(fila)) {
    if (op.status === "SYNCED") continue;
    if (op.sessionId !== base.session.id) continue;
    const p = (op.payload ?? {}) as Record<string, unknown>;
    const agora = op.createdAt;

    try {
      switch (op.operationType) {
        case "createTurn": {
          const id = op.createdEntityId;
          if (!id) throw new Error("criação sem identidade");
          if (turns.some((t) => t.id === id)) break;
          const turno = construirTurno({
            id,
            sessionId: op.sessionId,
            autor,
            sequence: session.turnCount + 1,
            text: String(p.text ?? ""),
            questionSource:
              typeof p.questionSource === "string" ? p.questionSource : undefined,
            originalText: typeof p.originalText === "string" ? p.originalText : null,
            isSensitive: p.isSensitive === true,
            sensitiveCategory:
              (p.sensitiveCategory as SensitiveCategory) ?? null,
            reusedFromTurnId:
              typeof p.reusedFromTurnId === "string" ? p.reusedFromTurnId : null,
            agora,
          });
          turns = [...turns, turno];
          session = { ...session, turnCount: turno.sequence, updatedAt: agora };
          marcas.locais.add(id);
          break;
        }

        case "turnAction": {
          const turnId = String(p.turnId ?? "");
          const alvo = turns.find((t) => t.id === turnId);
          if (!alvo) throw new Error("pergunta não encontrada localmente");
          const change = applyTurnAction(alvo, p.action as TurnAction, agora);
          turns = turns.map((t) =>
            t.id === turnId ? { ...t, ...change.patch } : t
          );
          break;
        }

        case "sessionAction": {
          const change = applySessionAction(
            session.status,
            p.action as SessionAction,
            agora
          );
          session = { ...session, ...change.patch };
          break;
        }

        case "saveSessionContext": {
          const id = op.createdEntityId;
          if (!id) throw new Error("contexto sem identidade");
          if (context?.id === id) break;
          const novo = construirContexto({
            id,
            sessionId: op.sessionId,
            autor,
            version: (context?.version ?? 0) + 1,
            anterior: context,
            entrada: p,
            agora,
          });
          // Versionar, nunca sobrescrever: `replacesContextId` já aponta para
          // a anterior (construirContexto). A versão substituída não fica
          // nesta estrutura — `SessionDetail.context` carrega só a vigente, e
          // o histórico de versões é uma leitura própria, que exige conexão.
          context = novo;
          marcas.locais.add(id);
          break;
        }

        case "openPatientControl": {
          const id = op.createdEntityId;
          if (!id) throw new Error("pedido sem identidade");
          if (controlRequest && controlRequest.status !== "CLOSED") break;
          controlRequest = construirPedidoDeControle({
            id,
            sessionId: op.sessionId,
            autor,
            payload: p,
            agora,
          });
          marcas.locais.add(id);
          break;
        }

        case "patientControlAction": {
          if (!controlRequest) throw new Error("nenhum painel aberto localmente");
          const change = applyPatientControlAction(
            controlRequest,
            p.action as PatientControlAction,
            agora
          );
          controlRequest = { ...controlRequest, ...change.patch };
          break;
        }

        default:
          // Operações de caminho vivem em `projetarCaminhos`.
          break;
      }
    } catch (e) {
      marcas.naoAplicadas.push({
        sequence: op.sequence,
        operationType: op.operationType,
        motivo: (e as Error).message,
      });
    }
  }

  return {
    detail: { session, turns, context, controlRequest },
    marcas,
  };
}

// ---------- Projeção dos caminhos ----------

export function projetarCaminhos(
  base: readonly PathDetail[],
  fila: readonly OfflineOperation[],
  autor: AutorLocal,
  sessionId: string
): { details: PathDetail[]; marcas: ProjecaoMarcas } {
  const marcas = marcasVazias();
  const confirmadas = confirmadasNoSnapshot(base);

  let details: PathDetail[] = base.map((d) => ({
    path: { ...d.path },
    nodes: d.nodes.map((n) => ({ ...n })),
    statements: d.statements.map((s) => ({ ...s })),
  }));

  const acharDetalhe = (pathId: string) =>
    details.find((d) => d.path.id === pathId) ?? null;

  const trocarDetalhe = (novo: PathDetail) => {
    details = details.map((d) => (d.path.id === novo.path.id ? novo : d));
  };

  for (const op of ordenada(fila)) {
    if (op.status === "SYNCED") continue;
    if (op.sessionId !== sessionId) continue;
    const p = (op.payload ?? {}) as Record<string, unknown>;
    const agora = op.createdAt;
    const pathId = String(p.pathId ?? "");

    try {
      switch (op.operationType) {
        case "createPath": {
          const id = op.createdEntityId;
          if (!id) throw new Error("caminho sem identidade");
          if (acharDetalhe(id)) break;
          details = [
            ...details,
            {
              path: construirCaminho({
                id,
                sessionId,
                autor,
                kind: "OPTION_TREE",
                sequence: details.length + 1,
                branchId: geradorDeterministico(op, PREFIXO.branch)(),
                agora,
              }),
              nodes: [],
              statements: [],
            },
          ];
          marcas.locais.add(id);
          break;
        }

        case "createCaregiverInterpretation": {
          const id = op.createdEntityId;
          const fraseId =
            typeof p.statementId === "string" ? p.statementId : null;
          if (!id || !fraseId) throw new Error("interpretação sem identidade");
          if (acharDetalhe(id)) break;
          const caminho = construirCaminho({
            id,
            sessionId,
            autor,
            kind: "CAREGIVER_INTERPRETATION",
            sequence: details.length + 1,
            branchId: geradorDeterministico(op, PREFIXO.branch)(),
            agora,
          });
          const frase = construirFrase({
            id: fraseId,
            sessionId,
            pathId: id,
            autor,
            // A autoria do TEXTO fica registrada desde o nascimento. Uma
            // interpretação que perdesse a origem viraria, no histórico, uma
            // frase escolhida pelo paciente — que é a confusão exata que a
            // Fase 4.2 foi feita para impedir.
            origin: "CAREGIVER_INTERPRETATION",
            originNodeId: null,
            text: String(p.text ?? ""),
            isSensitive: p.isSensitive === true,
            sensitiveCategory: (p.sensitiveCategory as SensitiveCategory) ?? null,
            agora,
          });
          details = [
            ...details,
            {
              path: { ...caminho, finalStatementId: frase.id },
              nodes: [],
              statements: [frase],
            },
          ];
          marcas.locais.add(id);
          marcas.locais.add(fraseId);
          break;
        }

        case "pathAction": {
          const detalhe = acharDetalhe(pathId);
          if (!detalhe) throw new Error("caminho não encontrado localmente");
          const change = applyPathAction(
            detalhe.path.status,
            p.action as PathAction,
            agora
          );
          trocarDetalhe({ ...detalhe, path: { ...detalhe.path, ...change.patch } });
          break;
        }

        case "createNode": {
          const id = op.createdEntityId;
          const detalhe = acharDetalhe(pathId);
          if (!id) throw new Error("nível sem identidade");
          if (!detalhe) throw new Error("caminho não encontrado localmente");
          if (detalhe.nodes.some((n) => n.id === id)) break;

          const parentNodeId =
            typeof p.parentNodeId === "string" && p.parentNodeId
              ? p.parentNodeId
              : null;
          const pai = parentNodeId
            ? (detalhe.nodes.find((n) => n.id === parentNodeId) ?? null)
            : null;
          if (parentNodeId && !pai) {
            throw new Error("nível anterior não encontrado localmente");
          }
          if (pai && pai.status !== "CONFIRMED") {
            throw new Error(
              "o nível anterior precisa ter uma opção confirmada antes de aprofundar"
            );
          }

          const nivel = construirNivel({
            id,
            sessionId,
            pathId,
            autor,
            parentNodeId,
            branchId:
              pai?.branchId ??
              detalhe.path.activeBranchId ??
              geradorDeterministico(op, PREFIXO.branch)(),
            depth: pai ? pai.depth + 1 : 0,
            sequence: detalhe.nodes.length + 1,
            promptText: limpar(p.promptText, 300).replace(/\s+/g, " "),
            options: normalizeOptions(
              p.options,
              geradorDeterministico(op, PREFIXO.option)
            ),
            isSensitive: p.isSensitive === true,
            sensitiveCategory: (p.sensitiveCategory as SensitiveCategory) ?? null,
            agora,
          });

          // O vínculo entre níveis é gravado na criação do filho e nunca
          // reescrito — igual ao servidor.
          const nodes = detalhe.nodes.map((n) =>
            pai && n.id === pai.id
              ? {
                  ...n,
                  options: n.options.map((o) =>
                    o.id === pai.confirmedOptionId ? { ...o, nextNodeId: id } : o
                  ),
                }
              : n
          );

          trocarDetalhe({
            ...detalhe,
            path: {
              ...detalhe.path,
              activeNodeId: id,
              rootNodeId: detalhe.path.rootNodeId ?? id,
              updatedAt: agora,
            },
            nodes: [...nodes, nivel],
          });
          marcas.locais.add(id);
          break;
        }

        case "reviewNode":
        case "nodeAction": {
          const detalhe = acharDetalhe(pathId);
          if (!detalhe) throw new Error("caminho não encontrado localmente");
          const nodeId = String(p.nodeId ?? "");
          const alvo = detalhe.nodes.find((n) => n.id === nodeId);
          if (!alvo) throw new Error("nível não encontrado localmente");

          // REVIEW não chega pronto à máquina de estados: o servidor normaliza
          // texto e opções ANTES de aplicá-la (limite de três, sem lacunas,
          // posições atribuídas, ids novos). Repetimos a mesma normalização —
          // não como cópia da regra, mas chamando a MESMA `normalizeOptions` do
          // domínio. Sem isto, o que a fila guarda são rótulos crus, e a
          // máquina os recusa por "posição de opção inválida".
          const acao =
            op.operationType === "reviewNode"
              ? revisaoNormalizada(p.input, op)
              : (p.action as NodeAction);
          const change = applyNodeAction(alvo, acao, agora);

          const kind = acao.kind;
          const ativa =
            kind === "PRESENT" || kind === "AWAIT_SELECTION" || kind === "REPRESENT";

          trocarDetalhe({
            ...detalhe,
            path: {
              ...detalhe.path,
              ...(ativa ? { activeNodeId: nodeId } : {}),
              updatedAt: agora,
            },
            nodes: detalhe.nodes.map((n) =>
              n.id === nodeId ? { ...n, ...change.patch } : n
            ),
          });
          break;
        }

        case "createStatement": {
          const id = op.createdEntityId;
          const detalhe = acharDetalhe(pathId);
          if (!id) throw new Error("frase sem identidade");
          if (!detalhe) throw new Error("caminho não encontrado localmente");
          if (detalhe.statements.some((s) => s.id === id)) break;

          const frase = construirFrase({
            id,
            sessionId,
            pathId,
            autor,
            origin: "OPTION_PATH",
            originNodeId:
              typeof p.originNodeId === "string" ? p.originNodeId : null,
            text: String(p.text ?? ""),
            isSensitive: p.isSensitive === true,
            sensitiveCategory: (p.sensitiveCategory as SensitiveCategory) ?? null,
            agora,
          });
          trocarDetalhe({
            ...detalhe,
            path: { ...detalhe.path, finalStatementId: id, updatedAt: agora },
            statements: [...detalhe.statements, frase],
          });
          marcas.locais.add(id);
          break;
        }

        case "statementAction": {
          const detalhe = acharDetalhe(pathId);
          if (!detalhe) throw new Error("caminho não encontrado localmente");
          const statementId = String(p.statementId ?? "");
          const alvo = detalhe.statements.find((s) => s.id === statementId);
          if (!alvo) throw new Error("frase não encontrada localmente");

          const acao = p.action as StatementAction;
          // REJECT tem função própria no domínio e não passa por
          // applyStatementAction. Offline ela fica só na fila: recusar uma
          // frase é uma decisão que merece chegar ao servidor inteira.
          if ((acao as { kind?: string }).kind === "REJECT") {
            throw new Error("recusar a frase exige conexão");
          }
          const change = applyStatementAction(alvo, acao, agora);
          const depois = aplicarPatchDeFrase(alvo, change, marcas);

          trocarDetalhe({
            ...detalhe,
            statements: detalhe.statements.map((s) =>
              s.id === statementId ? depois : s
            ),
          });
          break;
        }

        default:
          break;
      }
    } catch (e) {
      marcas.naoAplicadas.push({
        sequence: op.sequence,
        operationType: op.operationType,
        motivo: (e as Error).message,
      });
    }
  }

  // O portão de verdade confere o resultado. Se isto lançar, a projeção
  // produziu fala que o paciente nunca confirmou — e é melhor a tela quebrar
  // do que exibir isso.
  assertNenhumaFalaForjada(
    details.flatMap((d) => d.statements),
    confirmadas
  );

  return { details, marcas };
}
