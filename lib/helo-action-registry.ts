"use client";

// ——— Registro vivo das ações da interface (Action Registry) ———
// A ponte entre o Agent Helo e os botões reais da tela: cada tela registra,
// enquanto está MONTADA, as ações que o operador vê — com o MESMO handler do
// clique manual (nunca clique simulado por coordenada nem querySelector).
//
// O painel da ElevenLabs conhece apenas as tools genéricas
// (getCurrentHeloActions / interactWithHeloUI); os actionIds pertencem à
// aplicação e são estáveis: itemId real do paciente ou defaultKey do conteúdo
// padrão — nunca o texto visual, que é editável.
//
// Registro em nível de módulo (mesmo padrão de activeStops em useSpeech):
// funciona de qualquer árvore React e o desmonte da tela remove as ações —
// o Agent enxerga exatamente o que está clicável agora.

import { useEffect, useRef } from "react";
import type { Permission } from "@/lib/access-types";

export type HeloUIActionType =
  | "modeItem" // frase/ação de um modo (Rotina, Emergência)
  | "routineQuestion" // card-pergunta da Rotina (abre a tela interna do card)
  | "routineAnswer" // resposta SIM/TALVEZ/NÃO dentro de um card da Rotina
  | "edit" // edição contextual (leva ao painel de gerenciamento)
  | "activity" // sessões de Atividades (iniciar, navegar, responder)
  | "gesture" // gesto do paciente relatado pelo operador (sim/talvez/não)
  | "navigation" // navegação interna da tela (ex.: voltar ao menu do modo)
  | "connect"; // conexão/encerramento da conversa com a Helo

/**
 * O que uma ação SIGNIFICA em termos de quem pode acioná-la. Diferente de
 * `type`, que descreve onde ela vive na interface, esta classificação decide
 * uma questão de autoridade — e é ela que o dispatcher consulta.
 *
 *   navigation      → mudar de tela. Reversível, sem efeito sobre dados.
 *   operational     → operar a plataforma: iniciar uma atividade, abrir um
 *                     card, avançar. O Agent ajuda o cuidador a fazer isso.
 *   sensitive       → concluir/abandonar sessão, entrar em Emergência, editar
 *                     conteúdo, gastar crédito. O Agent pode LEVAR até a ação;
 *                     quem conclui é o humano.
 *   patientResponse → representa a resposta do PACIENTE (SIM/TALVEZ/NÃO) ou a
 *                     vocaliza na voz dele. Inalcançável pelo Agent, sempre.
 */
export type HeloActionClass =
  | "navigation"
  | "operational"
  | "sensitive"
  | "patientResponse";

/** Quem está acionando. Nunca inferido do actionId — sempre declarado. */
export type HeloActionOrigin = "human" | "agent";

export interface HeloUIAction {
  /** Id estável, da aplicação — nunca derivado do texto visual. */
  actionId: string;
  label: string;
  /** Frases curtas que o Agent pode usar para localizar a ação por linguagem natural. */
  aliases?: readonly string[];
  type: HeloUIActionType;
  /**
   * Classe de autoridade. OBRIGATÓRIA: sem ela a ação existe para o clique
   * humano e é invisível/inalcançável para o Agent (fail-closed). Uma ação
   * nova entra protegida por padrão, e só se abre por decisão explícita.
   */
  actionClass?: HeloActionClass;
  enabled: boolean;
  /** Permissão do vínculo exigida; ausente = basta o vínculo ativo. */
  requiredPermission?: Permission;
  /**
   * Retorno técnico enviado ao Agente quando a ação é executada por tool.
   * Substitui a mensagem genérica "executado" — usado pela Emergência para
   * devolver um resultado silencioso ({ silentRegistration, patientPhraseSpoken,
   * ... }) que NÃO induz o Agente a anunciar em voz alta que registrou.
   * Não vai na descoberta (listHeloUIActions) — é só do resultado da execução.
   */
  toolSuccess?: Record<string, unknown>;
  /**
   * O handler REAL — exatamente o mesmo caminho do clique manual. Lança
   * Error com mensagem clara quando o payload é inválido ou a ação falha.
   */
  run: (payload?: Record<string, unknown>) => void | Promise<void>;
}

/** Forma serializável enviada ao Agent (sem o handler). */
export type HeloUIActionSummary = Omit<HeloUIAction, "run"> & {
  /** Presente na descoberta feita pelo Agent: ele pode executar esta ação? */
  agentExecutable?: boolean;
  /** Por que não — texto que o Agent usa para explicar ao cuidador. */
  agentBlockedReason?: string;
};

const groups = new Map<symbol, readonly HeloUIAction[]>();

/**
 * O gate de origem — a regra central do R-02.
 *
 * O problema que ele resolve não é o Agent "dizer sim": é o Agent CAUSAR o
 * sim. Até aqui, uma tool podia acionar `gesto.confirmar` ou
 * `routine.answer.agua.yes` e o resultado era indistinguível de um toque do
 * paciente — evento de confirmação gravado, voz clonada dele falando.
 *
 * A proteção precisa ser estrutural porque a superfície de ataque é a
 * linguagem: bloquear as palavras "sim", "yes", "positivo" perde para
 * sinônimo, idioma, emoji, alias e para o actionId literal. Aqui a decisão
 * não olha o texto do pedido — olha o que a ação É.
 *
 * `patientResponse` é inalcançável pelo Agent, e uma ação sem classe também:
 * quem esquecer de classificar produz uma ação segura, não uma ação exposta.
 */
export function isActionAllowedFor(
  action: Pick<HeloUIAction, "actionClass">,
  origin: HeloActionOrigin
): boolean {
  if (origin === "human") return true;
  if (!action.actionClass) return false; // fail-closed
  return action.actionClass === "navigation" || action.actionClass === "operational";
}

/**
 * Motivo legível da recusa — vai ao Agent para ele explicar ao cuidador.
 *
 * Sem o RÓTULO da ação, desde a 5.3B. A versão anterior devolvia
 * `"${action.label}" precisa de confirmação…`, e o rótulo de um item de
 * Emergência é texto que o cuidador escreveu ("Estou com dor no peito"). Uma
 * recusa não pode ser a porta pela qual sai o conteúdo que o payload deixou de
 * enviar — o Agent perguntou por uma ação e recebe a política, não a tela.
 */
export function agentDenialReason(action: Pick<HeloUIAction, "actionClass">): string {
  if (action.actionClass === "patientResponse") {
    return "Só o paciente responde por ele. Peça ao acompanhante que registre o gesto na tela.";
  }
  if (action.actionClass === "sensitive") {
    return "Esta ação precisa de confirmação de uma pessoa na tela. Posso abrir o caminho, mas não posso concluir.";
  }
  return "Esta ação não pode ser executada por voz.";
}

/**
 * O que o Agent enxerga. Ações que ele não pode executar continuam VISÍVEIS,
 * com `agentExecutable: false` — esconder criaria um Agent que insiste em
 * ações que não existem, e o cuidador ouviria "não encontrei" quando a resposta
 * honesta é "isso é da pessoa, não minha".
 */
export function listHeloUIActions(origin: HeloActionOrigin = "human"): HeloUIActionSummary[] {
  const all: HeloUIActionSummary[] = [];
  for (const actions of groups.values()) {
    for (const action of actions) all.push(describeForAgent(action, origin));
  }
  return all;
}

/**
 * A forma serializável de UMA ação. Extraída de `listHeloUIActions` para que a
 * suíte possa conduzir esta função sobre um conjunto explícito de ações — o
 * registry só se enche com componentes React montados, e um teste que
 * reconstruísse este mapeamento estaria provando a cópia.
 */
export function describeForAgent(
  action: HeloUIAction,
  origin: HeloActionOrigin = "human"
): HeloUIActionSummary {
  const { actionId, label, aliases, type, enabled, requiredPermission, actionClass } = action;
  const executavel = isActionAllowedFor(action, "agent");
  return {
    actionId,
    label,
    ...(aliases ? { aliases } : {}),
    type,
    enabled,
    ...(actionClass ? { actionClass } : {}),
    ...(requiredPermission ? { requiredPermission } : {}),
    ...(origin === "agent"
      ? {
          agentExecutable: executavel,
          ...(executavel ? {} : { agentBlockedReason: agentDenialReason(action) }),
        }
      : {}),
  };
}

// Forma canônica para casar identificadores tolerando as variações que o
// agente introduz: acentos, maiúsculas e separadores (ponto/traço/espaço).
// "rotina.item.rotina.banheiro" e "Rotina Banheiro" convergem para o mesmo
// esqueleto de segmentos.
function canonical(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Palavras vazias/ligação que o agente adiciona ao repetir o rótulo de um card
// ("clique NO CARD DA água", "abra A PERGUNTA você QUER tomar água"). Removidas
// dos dois lados antes do casamento por tokens, para o conteúdo real ("agua")
// decidir. Inclui os prefixos comuns das perguntas da Rotina ("voce", "quer",
// "esta") — o que sobra é o núcleo distintivo de cada card.
const LABEL_STOPWORDS = new Set([
  "card", "cards", "botao", "opcao", "opcoes", "acao", "pergunta", "item",
  "abrir", "abra", "clique", "clicar", "toque", "tocar", "selecione",
  "selecionar", "escolha", "escolher", "acione", "acionar", "aperte",
  "o", "a", "os", "as", "de", "da", "do", "das", "dos", "no", "na", "nos",
  "nas", "em", "para", "pra", "com", "e", "ou", "um", "uma", "seu", "sua",
  "meu", "minha", "voce", "vc", "quer", "esta", "estou", "ir", "ao", "que",
]);

const AMBIGUOUS_GESTURE_TOKENS = new Set([
  "sim",
  "yes",
  "positivo",
  "confirmar",
  "confirma",
  "joinha",
  "polegar",
  "talvez",
  "maybe",
  "reformular",
  "nao",
  "no",
  "negativo",
  "recusar",
  "recusa",
  "punho",
]);

function contentTokens(canon: string): string[] {
  return canon.split("-").filter((t) => t.length > 0 && !LABEL_STOPWORDS.has(t));
}

/**
 * Resolve o actionId pedido pelo agente. O LLM raramente copia o id literal
 * da descoberta — costuma remontar um slug de tela+rótulo (ex.: manda
 * "rotina-banheiro" para a ação "Banheiro"), ou repete só parte do rótulo
 * ("tomar água", "card da água") para uma ação cujo rótulo é a pergunta
 * inteira ("Você quer tomar água?"). A busca é, em ordem de confiança:
 *   1. id exato;
 *   2. id normalizado;
 *   3. rótulo normalizado (inteiro ou como sufixo de segmento);
 *   4. sobreposição de tokens de conteúdo (ignorando acentos, caixa,
 *      pontuação e palavras vazias) — todos os tokens do pedido presentes no
 *      rótulo; desempate pelo rótulo mais específico (menos tokens sobrando).
 * O registry só contém as ações da tela montada, então o escopo é pequeno e
 * seguro. Os casamentos por rótulo só entram se nenhum id casar.
 */
export function findHeloUIAction(actionId: string): HeloUIAction | undefined {
  return findHeloUIActionIn(allRegisteredActions(), actionId);
}

/** Todas as ações registradas agora, achatadas. */
function allRegisteredActions(): HeloUIAction[] {
  const all: HeloUIAction[] = [];
  for (const actions of groups.values()) all.push(...actions);
  return all;
}

/**
 * A mesma resolução, sobre um conjunto explícito de ações. Existe para que a
 * cadeia inteira — pedido do Agent → resolução tolerante → classe → gate —
 * possa ser testada sem montar React: é ela que a suíte do R-02 exercita com
 * as formas que um LLM realmente produz (alias, emoji, rótulo, id remontado).
 */
export function findHeloUIActionIn(
  pool: readonly HeloUIAction[],
  actionId: string
): HeloUIAction | undefined {
  const target = canonical(actionId);
  if (!target) return undefined;
  const targetTokens = contentTokens(target);
  let labelMatch: HeloUIAction | undefined;
  // Melhor casamento por sobreposição de tokens (fallback 4).
  let tokenMatch: HeloUIAction | undefined;
  let tokenMatchExtra = Number.POSITIVE_INFINITY;
  {
    const actions = pool;
    for (const action of actions) {
      if (action.actionId === actionId) return action;
      if (canonical(action.actionId) === target) return action;
      const canonLabel = canonical(action.label);
      if (
        !labelMatch &&
        canonLabel.length > 1 &&
        (target === canonLabel || target.endsWith(`-${canonLabel}`))
      ) {
        labelMatch = action;
      }
      for (const alias of action.aliases ?? []) {
        const canonAlias = canonical(alias);
        if (
          !labelMatch &&
          canonAlias.length > 1 &&
          (target === canonAlias || target.endsWith(`-${canonAlias}`))
        ) {
          labelMatch = action;
        }
      }
      // Sobreposição de tokens: todos os tokens de conteúdo do pedido devem
      // estar no rótulo. Sem tokens de conteúdo (pedido só com palavras
      // vazias), não tenta — evita casar qualquer coisa.
      if (targetTokens.length > 0) {
        const gestureOnly =
          targetTokens.length === 1 && AMBIGUOUS_GESTURE_TOKENS.has(targetTokens[0]);
        if (gestureOnly) continue;
        const tokenSources = [canonLabel, ...(action.aliases ?? []).map(canonical)];
        for (const source of tokenSources) {
          const sourceTokens = contentTokens(source);
          if (sourceTokens.length > 0 && targetTokens.every((t) => sourceTokens.includes(t))) {
            const extra = sourceTokens.length - targetTokens.length;
            if (extra < tokenMatchExtra) {
              tokenMatchExtra = extra;
              tokenMatch = action;
            }
          }
        }
      }
    }
  }
  return labelMatch ?? tokenMatch;
}

// ——— Resolução de um pedido do Agent ———
//
// O LLM manda o pedido de muitas formas: o id literal, um id remontado, um
// alias, o rótulo, ou um gesto solto dentro de um campo qualquer do payload.
// As funções abaixo reconstroem os candidatos possíveis — e é justamente por
// serem TÃO tolerantes que o gate não pode depender delas: a decisão de
// autoridade acontece depois, sobre a ação encontrada.

function stringFromFields(
  source: Record<string, unknown> | undefined,
  fields: readonly string[]
): string | undefined {
  if (!source) return undefined;
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function collectRequestStrings(source: Record<string, unknown> | undefined): string[] {
  if (!source) return [];
  const values: string[] = [];
  for (const value of Object.values(source)) {
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  }
  return values;
}

const GESTURE_FIELDS = ["gesto", "gesture", "resposta", "answer", "response", "choice", "value"] as const;
const OPTION_FIELDS = ["opcao", "option", "alternativa", "alternative", "item", "itemLabel", "targetLabel", "label"] as const;

function gestureIntent(value: unknown): "sim" | "talvez" | "nao" | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9👍✋✊]+/g, " ")
    .trim();
  if (!text) return undefined;
  if (text.includes("👍") || /\b(sim|yes|positivo|confirmar|confirma|joinha|polegar)\b/.test(text)) return "sim";
  if (text.includes("✋") || /\b(talvez|maybe|reformular|mao aberta|meio termo)\b/.test(text)) return "talvez";
  if (text.includes("✊") || /\b(nao|no|negativo|recusar|recusa|punho)\b/.test(text)) return "nao";
  return undefined;
}

/**
 * Encontra a ação que o Agent pediu, sobre um conjunto explícito de ações.
 * NÃO decide se ele pode executá-la — para isso existe `isActionAllowedFor`.
 */
export function resolveRequestedUIActionIn(
  pool: readonly HeloUIAction[],
  actionId: string,
  parameters: Record<string, unknown> = {},
  payload?: Record<string, unknown>
): HeloUIAction | undefined {
  const direct = findHeloUIActionIn(pool, actionId);
  if (direct) return direct;

  const allStrings = [
    actionId,
    ...collectRequestStrings(parameters),
    ...collectRequestStrings(payload),
  ].filter(Boolean);
  const gesture =
    gestureIntent(stringFromFields(payload, GESTURE_FIELDS)) ??
    gestureIntent(stringFromFields(parameters, GESTURE_FIELDS)) ??
    allStrings.map(gestureIntent).find(Boolean);
  const option =
    stringFromFields(payload, OPTION_FIELDS) ?? stringFromFields(parameters, OPTION_FIELDS);

  const candidates = new Set<string>();
  if (gesture) {
    candidates.add(`${actionId}.${gesture}`);
    if (option) {
      candidates.add(`${gesture} de ${option}`);
      candidates.add(`${gesture} em ${option}`);
      candidates.add(`clique em ${gesture} em ${option}`);
      candidates.add(`clique em ${gesture} de ${option}`);
      candidates.add(`${actionId} ${gesture} ${option}`);
    }
  }
  for (const text of allStrings) candidates.add(text);

  for (const candidate of candidates) {
    const action = findHeloUIActionIn(pool, candidate);
    if (action) return action;
  }
  return undefined;
}

/** A mesma resolução, sobre o que está registrado agora. */
export function resolveRequestedUIAction(
  actionId: string,
  parameters: Record<string, unknown> = {},
  payload?: Record<string, unknown>
): HeloUIAction | undefined {
  return resolveRequestedUIActionIn(allRegisteredActions(), actionId, parameters, payload);
}

/**
 * Registra as ações do componente enquanto ele estiver montado. O array deve
 * vir memoizado (useMemo) refletindo o estado atual da tela — habilitado,
 * pendência de confirmação, permissões — para o Agent ver o estado real.
 */
export function useRegisterHeloUIActions(actions: readonly HeloUIAction[]): void {
  const keyRef = useRef<symbol | null>(null);
  if (keyRef.current == null) keyRef.current = Symbol("helo-ui-actions");
  useEffect(() => {
    const key = keyRef.current;
    if (key == null) return;
    groups.set(key, actions);
    return () => {
      groups.delete(key);
    };
  }, [actions]);
}

// Inspeção SOMENTE em desenvolvimento: permite verificar o registry no
// console sem uma sessão real do Agent. Nunca existe em produção.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__heloUIActions = {
    list: listHeloUIActions,
    find: findHeloUIAction,
  };
}
