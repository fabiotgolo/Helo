// ——— Atividades: sessões personalizadas por paciente ———
// Módulo neutro (sem imports de servidor): tipos compartilhados entre as
// rotas de API, o modo Atividades (uso), o editor (edição) e o Dashboard.
//
// Dois conceitos que NUNCA se misturam no modelo (regra do produto):
//   - OPÇÕES de resposta (ex.: Pedro / Renato / Gilberto) — as possíveis
//     respostas à PERGUNTA, selecionadas pelo operador conforme observa;
//   - GESTOS (👍 sim / ✋ talvez / ✊ não) — o sinal do paciente, na
//     metodologia da Helo. Os dois são registrados em campos separados.

import type { Gesture } from "@/lib/types";

// Categorias iniciais. Novos tipos entram AQUI (e nos rótulos) sem
// reescrever o sistema — o restante do modelo é agnóstico à categoria.
export type ActivityCategory =
  | "entretenimento"
  | "memorias"
  | "reconhecimento"
  | "treino"
  | "exercicio";

export const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  "entretenimento",
  "memorias",
  "reconhecimento",
  "treino",
  "exercicio",
];

export const ACTIVITY_CATEGORY_LABELS: Record<ActivityCategory, string> = {
  entretenimento: "Entretenimento",
  memorias: "Memórias",
  reconhecimento: "Reconhecimento e associação",
  treino: "Treino",
  exercicio: "Exercícios cognitivos",
};

export const ACTIVITY_CATEGORY_HINTS: Record<ActivityCategory, string> = {
  entretenimento:
    "Conteúdos significativos: fotos, vídeos, histórias. Sem avaliação.",
  memorias: "Recordações e momentos familiares. Sem pontuação.",
  reconhecimento: "Imagem + pergunta + até três opções de resposta.",
  treino: "Perguntas do dia a dia, com resposta esperada quando definida.",
  exercicio: "Exercícios estruturados: associação, memória, orientação.",
};

export type ActivityMediaKind = "imagem" | "youtube";

export interface ActivityMedia {
  kind: ActivityMediaKind;
  /** Mídia da biblioteca interna do paciente — servida por /api/media, sempre com autorização por vínculo. */
  mediaId: string | null;
  /** URL externa (link de YouTube ou imagem pública) — usada quando não há mediaId. */
  url: string | null;
  caption: string | null;
}

export interface ActivityOption {
  id: string;
  label: string;
  /**
   * Falas DO PACIENTE, uma por gesto (👍 sim / ✋ talvez / ✊ não). OPCIONAL:
   * quando presente, escolher um gesto nesta alternativa vocaliza a frase
   * correspondente na voz do paciente (exercício "Pergunta com alternativas +
   * SIM/TALVEZ/NÃO"). Ausente ou vazio → alternativa apenas registra o gesto,
   * como sempre (migração defensiva: itens antigos não têm o campo).
   */
  responses?: Partial<Record<Gesture, string>>;
}

/**
 * Sugestão de respostas faladas a partir do rótulo da alternativa (autofill
 * editável). Número (idade/quantidade) ganha frase específica; qualquer outro
 * rótulo usa um template genérico. O profissional pode reescrever tudo.
 */
export function suggestOptionResponses(label: string): Record<Gesture, string> {
  const t = label.trim();
  if (/^\d{1,3}$/.test(t)) {
    return {
      sim: `SIM, eu tenho ${t} anos.`,
      talvez: `TALVEZ, acho que tenho ${t} anos.`,
      nao: `NÃO, eu não tenho ${t} anos.`,
    };
  }
  return {
    sim: "SIM, é isso.",
    talvez: "TALVEZ, acho que pode ser isso.",
    nao: "NÃO, não é isso.",
  };
}

/** A alternativa "fala" quando tem ao menos uma resposta não-vazia. */
export function optionSpeaks(option: Pick<ActivityOption, "responses">): boolean {
  const r = option.responses;
  return !!r && Object.values(r).some((v) => (v ?? "").trim().length > 0);
}

/** O item é um exercício com respostas faladas quando alguma alternativa fala. */
export function itemHasSpokenResponses(
  item: Pick<ActivityItem, "options">
): boolean {
  return item.options.some(optionSpeaks);
}

// Um item é uma "tela" da sessão, na ordem definida pelo profissional.
// Sem pergunta = conteúdo (uma memória afetiva pode existir sem avaliação
// nem pontuação); com pergunta = registro de opção observada + gesto.
export interface ActivityItem {
  id: string;
  order: number;
  title: string;
  text: string;
  media: ActivityMedia[];
  question: string;
  /** Até 3 opções de resposta à pergunta (≠ gestos). */
  options: ActivityOption[];
  /** Resposta considerada correta, QUANDO definida pelo profissional. */
  correctOptionId: string | null;
  /** Itens com pergunta mantêm a barra de gestos sempre visível. */
  gesturesEnabled: boolean;
}

export type ActivityTemplateStatus = "ativa" | "inativa";

export interface ActivityTemplate {
  id: string;
  patientId: number;
  title: string;
  description: string;
  category: ActivityCategory;
  status: ActivityTemplateStatus;
  /** Sobe a cada edição de conteúdo — execuções antigas guardam snapshot próprio. */
  version: number;
  items: ActivityItem[];
  // Autoria (rastreabilidade sem dados sensíveis desnecessários).
  createdByUserId: string | null;
  createdByName: string | null;
  updatedByUserId: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ActivityRunStatus = "em_andamento" | "concluida" | "abandonada";

export const RUN_STATUS_LABELS: Record<ActivityRunStatus, string> = {
  em_andamento: "Em andamento",
  concluida: "Concluída",
  abandonada: "Abandonada",
};

export interface ActivityRun {
  id: string;
  patientId: number;
  templateId: string;
  templateVersion: number;
  templateTitle: string;
  category: ActivityCategory;
  /** Identidade REAL de quem conduziu — sempre o userId autenticado. */
  operatorId: string | null;
  /** Snapshot do nome para leitura do histórico; nunca fonte de identidade. */
  operatorName: string | null;
  startedAt: string;
  endedAt: string | null;
  status: ActivityRunStatus;
  /** Snapshot IMUTÁVEL dos itens exibidos — editar o template não o altera. */
  items: ActivityItem[];
}

export type Correctness =
  | "correta"
  | "incorreta"
  | "incerta"
  | "nao_respondida";

export const CORRECTNESS_LABELS: Record<Correctness, string> = {
  correta: "Correta",
  incorreta: "Incorreta",
  incerta: "Incerta",
  nao_respondida: "Não respondida",
};

/**
 * O sinal do paciente para UMA alternativa. Cada opção da pergunta é uma
 * proposição de sim/talvez/não — porque o paciente da Helo só comunica pelos
 * três gestos, nunca "seleciona" uma opção. Opção e gesto continuam sendo
 * conceitos distintos: aqui o gesto é registrado POR alternativa.
 */
export interface OptionGesture {
  optionId: string;
  gesture: Gesture;
}

/** optionId reservado para uma pergunta SEM alternativas (gesto único sobre a própria pergunta). */
export const BARE_QUESTION_OPTION_ID = "__question__";

export interface ActivityResponse {
  id: string;
  runId: string;
  patientId: number;
  templateId: string;
  itemId: string;
  /** Gesto observado do paciente para CADA alternativa (sim/talvez/não). */
  optionGestures: OptionGesture[];
  /**
   * Alternativa afirmada com 👍 — derivada de optionGestures (a única com
   * "sim"; null se nenhuma ou mais de uma). Preserva o contrato "resposta
   * observada" separada do gesto, para leitura e compatibilidade.
   */
  selectedOptionId: string | null;
  selectedOptionLabel: string | null;
  /** Resultado observacional — nunca diagnóstico. */
  correctness: Correctness | null;
  responseTimeMs: number | null;
  operatorId: string | null;
  ts: string;
  /** Sobe a cada regravação (correção explícita) — nunca silenciosa. */
  revision: number;
}

/**
 * A alternativa afirmada com 👍 — a única com "sim". Se nenhuma ou mais de
 * uma recebeu "sim", não há afirmação única (null).
 */
export function affirmedOptionId(gestures: OptionGesture[]): string | null {
  const sims = gestures.filter((g) => g.gesture === "sim");
  return sims.length === 1 ? sims[0].optionId : null;
}

/**
 * Resultado observacional, calculado NO SERVIDOR a partir do padrão de
 * gestos por alternativa. Regra explícita (nunca gera certo/errado na tela;
 * "talvez" nunca é erro automático):
 *   - sem resposta correta definida → null (não há certo/errado);
 *   - nenhum "sim" e nenhum "talvez" (só recusas/sem registro) → não respondida;
 *   - exatamente um "sim" e nenhum "talvez" → correta/incorreta pela alternativa;
 *   - qualquer "talvez", ou mais de um "sim" (ambiguidade) → incerta.
 */
export function computeCorrectness(
  item: Pick<ActivityItem, "correctOptionId">,
  gestures: OptionGesture[]
): Correctness | null {
  if (!item.correctOptionId) return null;
  const sims = gestures.filter((g) => g.gesture === "sim");
  const talvezes = gestures.filter((g) => g.gesture === "talvez");
  if (sims.length === 0 && talvezes.length === 0) return "nao_respondida";
  if (sims.length === 1 && talvezes.length === 0) {
    return sims[0].optionId === item.correctOptionId ? "correta" : "incorreta";
  }
  return "incerta";
}

export function isQuestionItem(
  item: Pick<ActivityItem, "question">
): boolean {
  return item.question.trim().length > 0;
}

/** Extrai o id de um link do YouTube e devolve a URL de embed (domínio de privacidade reforçada). */
export function youtubeEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
    let id = "";
    if (host === "youtu.be") {
      id = u.pathname.slice(1).split("/")[0] ?? "";
    } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (u.pathname === "/watch") id = u.searchParams.get("v") ?? "";
      else {
        const m = u.pathname.match(/^\/(embed|shorts|live)\/([\w-]{6,})/);
        if (m) id = m[2];
      }
    }
    return /^[\w-]{6,20}$/.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}`
      : null;
  } catch {
    return null;
  }
}

// ——— Mídia interna do paciente ———

export interface PatientMediaMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdByUserId: string | null;
  createdAt: string;
}

/** Formatos e teto de upload — validados no servidor, espelhados na UI. */
export const MEDIA_ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];
export const MEDIA_MAX_BYTES = 2_500_000;

/**
 * Capacidades do usuário autenticado sobre as Atividades de UM paciente —
 * derivadas do vínculo NO SERVIDOR e devolvidas junto com a listagem. A UI
 * usa isso só para decidir o que exibir; a autorização real é das rotas.
 */
export interface ActivityCaps {
  view: boolean;
  run: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewResults: boolean;
}
