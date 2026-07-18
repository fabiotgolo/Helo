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

export interface HeloUIAction {
  /** Id estável, da aplicação — nunca derivado do texto visual. */
  actionId: string;
  label: string;
  type: HeloUIActionType;
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
export type HeloUIActionSummary = Omit<HeloUIAction, "run">;

const groups = new Map<symbol, readonly HeloUIAction[]>();

export function listHeloUIActions(): HeloUIActionSummary[] {
  const all: HeloUIActionSummary[] = [];
  for (const actions of groups.values()) {
    for (const { actionId, label, type, enabled, requiredPermission } of actions) {
      all.push({
        actionId,
        label,
        type,
        enabled,
        ...(requiredPermission ? { requiredPermission } : {}),
      });
    }
  }
  return all;
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
  const target = canonical(actionId);
  if (!target) return undefined;
  const targetTokens = contentTokens(target);
  let labelMatch: HeloUIAction | undefined;
  // Melhor casamento por sobreposição de tokens (fallback 4).
  let tokenMatch: HeloUIAction | undefined;
  let tokenMatchExtra = Number.POSITIVE_INFINITY;
  for (const actions of groups.values()) {
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
      // Sobreposição de tokens: todos os tokens de conteúdo do pedido devem
      // estar no rótulo. Sem tokens de conteúdo (pedido só com palavras
      // vazias), não tenta — evita casar qualquer coisa.
      if (targetTokens.length > 0) {
        const labelTokens = contentTokens(canonLabel);
        if (labelTokens.length > 0 && targetTokens.every((t) => labelTokens.includes(t))) {
          const extra = labelTokens.length - targetTokens.length;
          if (extra < tokenMatchExtra) {
            tokenMatchExtra = extra;
            tokenMatch = action;
          }
        }
      }
    }
  }
  return labelMatch ?? tokenMatch;
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
