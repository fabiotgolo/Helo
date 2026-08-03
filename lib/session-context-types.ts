// ——— Contexto da sessão: tipos do domínio (Fase 4.8) ———
// Módulo neutro (sem imports de servidor), irmão de option-conversation-types.ts.
//
// O contexto responde COM QUEM, PARA QUÊ e ONDE a conversa acontece. É uma
// anotação do cuidador sobre a circunstância, e o que ela NÃO é precisa estar
// dito no próprio domínio:
//
//   • não é fala do paciente — nunca é apresentada a ele nem lida em voz alta;
//   • não é confirmação de nada — não substitui nem antecipa um gesto;
//   • não decide nada pelo paciente — não altera opções, frases nem respostas.
//
// Tudo é opcional, inclusive o contexto inteiro: "Começar sem contexto" é uma
// escolha legítima e registrada. Uma conversa urgente não pode esperar por um
// formulário.
//
// IMUTABILIDADE: como no resto do projeto, nada é reescrito. Editar durante a
// sessão cria uma VERSÃO nova ligada à anterior (replaces/replacedBy); a versão
// antiga continua legível exatamente como estava quando valeu.

import { RtqDomainError } from "@/lib/realtime-question-types";

export { RtqDomainError };

// ---------- Limites ----------

export const MAX_CONTEXT_FIELD_LEN = 200;
export const MAX_CONTEXT_NOTES_LEN = 500;

// ---------- Estados ----------

/**
 * De onde veio o interlocutor. A distinção importa: uma pessoa da rede do
 * paciente é um vínculo já cadastrado, e um nome digitado é só um registro
 * desta conversa — que NUNCA vira contato novo (§2).
 */
export type ContextInterlocutorSource = "REGISTERED_PERSON" | "FREE_TEXT";

export const CONTEXT_INTERLOCUTOR_SOURCES: readonly ContextInterlocutorSource[] =
  ["REGISTERED_PERSON", "FREE_TEXT"] as const;

export function isContextInterlocutorSource(
  v: unknown
): v is ContextInterlocutorSource {
  return (
    typeof v === "string" &&
    (CONTEXT_INTERLOCUTOR_SOURCES as readonly string[]).includes(v)
  );
}

export type SessionContextStatus = "ACTIVE" | "REPLACED";

/**
 * Quem preencheu. Hoje só existe preenchimento manual — o campo existe para
 * que a regra "nunca preenchido automaticamente sem indicação visível" seja
 * VERIFICÁVEL no dia em que houver outra origem, e não uma promessa solta.
 */
export type ContextFilledBy = "ASSISTANT_MANUAL";

// ---------- Atalhos ----------
// Sugestões, nunca uma lista fechada: os dois campos aceitam texto livre e o
// atalho só poupa digitação (§3, §4).

export const INTENTION_SHORTCUTS: readonly string[] = [
  "Pedir algo",
  "Responder uma pergunta",
  "Explicar um desconforto",
  "Falar sobre uma memória",
  "Conversar com alguém",
  "Expressar sentimento",
  "Tomar uma decisão",
] as const;

export const ENVIRONMENT_SHORTCUTS: readonly string[] = [
  "Consulta",
  "Casa",
  "Hospital",
  "Visita",
  "Terapia",
  "Reunião familiar",
] as const;

// ---------- Entidade ----------

export interface SessionContextVersion {
  id: string;
  sessionId: string;
  patientId: number;
  assistantId: string;

  /** 1, 2, 3… atribuído no servidor. A versão 1 é a primeira gravação. */
  version: number;
  status: SessionContextStatus;

  interlocutorSource: ContextInterlocutorSource | null;
  /** Snapshot do vínculo — a pessoa cadastrada pode mudar depois. */
  interlocutorPersonId: number | null;
  interlocutorName: string | null;
  interlocutorRelation: string | null;

  intention: string | null;
  environment: string | null;
  initialTopic: string | null;
  notes: string | null;

  /** "Começar sem contexto": decisão registrada, não ausência de registro. */
  skipped: boolean;
  filledBy: ContextFilledBy;

  replacesContextId: string | null;
  replacedByContextId: string | null;

  clientRequestId: string | null;

  createdAt: string;
  updatedAt: string;
  replacedAt: string | null;
}

/** Só os campos de conteúdo — o que "pular o contexto" precisa deixar vazio. */
const CONTENT_FIELDS = [
  "interlocutorPersonId",
  "interlocutorName",
  "interlocutorRelation",
  "intention",
  "environment",
  "initialTopic",
  "notes",
] as const;

export function assertSessionContextInvariants(
  context: SessionContextVersion
): void {
  const bad = (msg: string): never => {
    throw new RtqDomainError(msg);
  };

  if (!context.sessionId) bad("o contexto precisa pertencer a uma sessão");
  if (!Number.isInteger(context.patientId) || context.patientId <= 0) {
    bad("contexto sem paciente válido");
  }
  if (!context.assistantId) bad("contexto sem assistente");
  if (!Number.isInteger(context.version) || context.version < 1) {
    bad("versão de contexto inválida");
  }

  if (context.status === "ACTIVE") {
    if (context.replacedByContextId) {
      bad("um contexto ativo não pode apontar para uma versão que o substitui");
    }
    if (context.replacedAt) bad("um contexto ativo não tem horário de substituição");
  }
  if (context.status === "REPLACED") {
    // A versão anterior continua legível, mas precisa dizer quem a sucedeu —
    // é o que mantém a trilha de versões navegável nos dois sentidos.
    if (!context.replacedByContextId) {
      bad("um contexto substituído precisa apontar para a versão que o substitui");
    }
    if (!context.replacedAt) {
      bad("um contexto substituído precisa registrar o horário da substituição");
    }
  }
  if (context.replacesContextId && context.replacesContextId === context.id) {
    bad("um contexto não pode substituir a si mesmo");
  }
  if (context.version === 1 && context.replacesContextId) {
    bad("a primeira versão do contexto não substitui nenhuma outra");
  }
  if (context.version > 1 && !context.replacesContextId) {
    bad("uma versão posterior precisa apontar para a versão que substitui");
  }

  if (context.skipped) {
    // Pular é pular: um contexto "sem contexto" que carregasse conteúdo seria
    // exatamente o preenchimento silencioso que o modo proíbe.
    for (const field of CONTENT_FIELDS) {
      if (context[field] !== null) {
        bad("um contexto pulado não registra nenhum campo de conteúdo");
      }
    }
    if (context.interlocutorSource !== null) {
      bad("um contexto pulado não registra origem de interlocutor");
    }
  }

  if (context.interlocutorSource === "REGISTERED_PERSON") {
    if (
      !Number.isInteger(context.interlocutorPersonId) ||
      (context.interlocutorPersonId ?? 0) <= 0
    ) {
      bad("interlocutor cadastrado exige a pessoa da rede do paciente");
    }
    if (!context.interlocutorName?.trim()) {
      bad("interlocutor cadastrado exige o nome copiado no momento do registro");
    }
  }
  if (context.interlocutorSource === "FREE_TEXT") {
    if (!context.interlocutorName?.trim()) {
      bad("interlocutor informado à mão exige um nome ou função");
    }
    // Texto livre NÃO cria contato: sem pessoa cadastrada, não há id.
    if (context.interlocutorPersonId !== null) {
      bad("interlocutor informado à mão não aponta para uma pessoa cadastrada");
    }
  }
  if (context.interlocutorSource === null && context.interlocutorPersonId !== null) {
    bad("pessoa cadastrada sem origem de interlocutor declarada");
  }

  if (context.filledBy !== "ASSISTANT_MANUAL") {
    bad("nesta fase o contexto só é preenchido à mão pelo assistente");
  }
}

/** Resumo de uma linha para a barra de contexto — nunca lido em voz alta. */
export function contextSummary(context: SessionContextVersion): string {
  if (context.skipped) return "Sem contexto registrado";
  const partes = [
    context.interlocutorName
      ? context.interlocutorRelation
        ? `${context.interlocutorName} (${context.interlocutorRelation})`
        : context.interlocutorName
      : null,
    context.intention,
    context.environment,
    context.initialTopic,
  ].filter((p): p is string => !!p?.trim());
  return partes.length > 0 ? partes.join(" · ") : "Contexto sem detalhes";
}
