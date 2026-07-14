// ——— Edição contextual: deep links para o painel de gerenciamento ———
// Módulo neutro (sem imports de servidor). Regra do produto: todo conteúdo
// editável pode ser editado A PARTIR do contexto em que aparece — o link
// identifica o item exato e carrega de volta a tela de origem (returnTo).
//
// O link NÃO é autorização: as telas de destino só exibem edição conforme
// as capacidades devolvidas pela API, e as rotas de escrita validam a
// permissão do vínculo no servidor (editActivities, editRoutine, etc.).

import type { HeloItemMode } from "@/lib/types";

export type EditTarget =
  // Atividade personalizada (template) — opcionalmente posicionada num item.
  | { entityType: "activity"; activityId: string; itemId?: string | null }
  // Item de modo (frase de Rotina, ação de Emergência, expressão de Conversa).
  | { entityType: "modeItem"; mode: HeloItemMode; itemId: string };

/**
 * Monta o deep link de edição do item exato. `source` é o caminho interno
 * da tela de origem (com query, se precisar) — vira `returnTo` para o
 * destino oferecer o retorno ao contexto.
 *
 * O paciente NÃO viaja na URL de propósito: o destino opera sempre sobre o
 * paciente ativo (mesmo contrato de Ajustes/Gerenciar), e a autorização por
 * patientId é do servidor — um link colado de outro contexto nunca edita
 * o paciente errado, no máximo cai em "sem permissão".
 */
export function buildEditLink(target: EditTarget, source?: string): string {
  const q = new URLSearchParams();
  if (target.entityType === "activity") {
    q.set("activityId", target.activityId);
    if (target.itemId) q.set("itemId", target.itemId);
    if (source) q.set("returnTo", source);
    return `/atividades/gerenciar?${q.toString()}`;
  }
  q.set("editMode", target.mode);
  q.set("itemId", target.itemId);
  if (source) q.set("returnTo", source);
  return `/ajustes?${q.toString()}`;
}

/**
 * Valida um returnTo vindo da URL: só caminhos INTERNOS absolutos ("/…").
 * "//host" e URLs completas são rejeitados — nada de open redirect.
 */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

/** Query string atual da janela, já decodificada — só para páginas client. */
export function readSearchParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}
