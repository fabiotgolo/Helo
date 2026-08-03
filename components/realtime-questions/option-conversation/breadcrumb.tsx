"use client";

// ——— Breadcrumb do caminho ativo (§13, §14) ———
//
// Mostra SÓ o caminho ativo. Ele navega dentro da conversa atual e nada mais —
// consultar o passado e criar conteúdo a partir dele é trabalho do histórico
// (§31). Por isso este componente não conhece caminhos encerrados.
//
// Cada degrau anterior é clicável e volta àquele nível; o atual é destacado e
// NÃO é clicável (voltar para onde já se está não é uma ação).

import { Control } from "@/components/realtime-questions/ui";
import {
  confirmedLabel,
  type OptionConversationNode,
} from "@/lib/option-conversation-types";

export interface Crumb {
  /**
   * Identidade do degrau na lista. NÃO é o nodeId: o título do primeiro nível
   * e a escolha feita nele apontam para o mesmo nó enquanto essa escolha ainda
   * não abriu o próximo — dois degraus, um alvo só.
   */
  key: string;
  /** Nível que este degrau reabre. */
  nodeId: string;
  /** Texto curto do degrau: a opção confirmada, ou o título quando é o atual. */
  label: string;
  /** Texto completo para tecnologias assistivas, sem truncamento. */
  fullLabel: string;
  isCurrent: boolean;
}

/**
 * Monta os degraus a partir da trilha ativa: o título do primeiro nível,
 * seguido de cada opção confirmada.
 *
 *   Assunto › Saúde › Dor › Perna
 *
 * O ALVO de cada degrau é o nível que aquela escolha ABRIU, não o nível que a
 * continha. É o que §14 pede: clicar em "Saúde" reapresenta DOR, MEDICAÇÃO e
 * CONSULTA — as opções do nível aberto por ter escolhido Saúde.
 */
export function buildCrumbs(trail: OptionConversationNode[]): Crumb[] {
  if (trail.length === 0) return [];

  const crumbs: Omit<Crumb, "isCurrent">[] = [
    {
      key: `titulo:${trail[0].id}`,
      nodeId: trail[0].id,
      label: trail[0].promptText,
      fullLabel: trail[0].promptText,
    },
  ];

  trail.forEach((node, i) => {
    const chosen = confirmedLabel(node);
    if (!chosen) return;
    // O nível seguinte da trilha é o que esta escolha abriu. Numa opção
    // terminal ele não existe: o degrau então representa a própria escolha.
    const opened = trail[i + 1];
    crumbs.push({
      key: `escolha:${node.id}`,
      nodeId: opened?.id ?? node.id,
      label: chosen,
      fullLabel: `${node.promptText}: ${chosen}`,
    });
  });

  return crumbs.map((crumb, i) => ({
    ...crumb,
    isCurrent: i === crumbs.length - 1,
  }));
}

export function Breadcrumb({
  crumbs,
  busy = false,
  canGoBack,
  canRestart,
  onNavigate,
  onBack,
  onRestart,
}: {
  crumbs: Crumb[];
  busy?: boolean;
  canGoBack: boolean;
  canRestart: boolean;
  /** Voltar a um nível anterior do caminho ativo. */
  onNavigate: (nodeId: string) => void;
  onBack: () => void;
  onRestart: () => void;
}) {
  if (crumbs.length === 0 && !canRestart) return null;
  return (
    <nav
      aria-label="Caminho da conversa"
      className="no-print flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2"
    >
      <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1 text-sm">
        {crumbs.map((crumb, i) => (
          <li key={crumb.key} className="flex min-w-0 items-center gap-1">
            {i > 0 && (
              <span aria-hidden="true" className="text-ink-mute">
                ›
              </span>
            )}
            {crumb.isCurrent ? (
              // O degrau atual é destaque e não é botão: nem visualmente nem
              // para o teclado ele se oferece como destino.
              <span
                aria-current="step"
                className="max-w-[16ch] truncate font-semibold text-ink sm:max-w-[24ch]"
                title={crumb.fullLabel}
              >
                {crumb.label}
                <span className="sr-only"> — nível atual</span>
              </span>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => onNavigate(crumb.nodeId)}
                // O rótulo acessível carrega o texto COMPLETO, mesmo quando o
                // visual está truncado.
                aria-label={`Voltar para ${crumb.fullLabel}`}
                title={crumb.fullLabel}
                className="max-w-[12ch] truncate rounded-full px-2 py-1 text-ink-soft underline underline-offset-4 transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40 sm:max-w-[20ch]"
              >
                {crumb.label}
              </button>
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
        {canGoBack && (
          <Control onClick={onBack} disabled={busy}>
            ← Voltar um nível
          </Control>
        )}
        {canRestart && (
          <Control onClick={onRestart} disabled={busy}>
            Reiniciar conversa
          </Control>
        )}
      </div>
    </nav>
  );
}
