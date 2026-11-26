"use client";

// ——— OrbDock: os orbes recolhidos moram no cabeçalho ———
// Nas experiências abertas (desktop), os modos inativos saem do topo do palco
// e sobem para a linha do cabeçalho, ao lado da marca — liberando a altura
// inteira da área de conteúdo para a pergunta e as respostas.
//
// O dock é só GEOMETRIA + interação: cada botão marca seu lugar com
// `data-orb-slot`, e o OrbStage mede esses lugares e leva para lá as esferas
// WebGL (com a mesma coreografia de troca de sempre). O canvas fica por trás
// do cabeçalho transparente; os cliques caem nestes botões reais.

import { HELO_MODES, MODE_ORDER, useHelo } from "@/lib/helo-state";

export const ORB_DOCK_ID = "helo-orb-dock";

export function OrbDock({ visible }: { visible: boolean }) {
  const { activeMode, enterMode } = useHelo();
  if (!visible) return null;
  const inactive = MODE_ORDER.filter((m) => m !== activeMode);
  return (
    <nav
      id={ORB_DOCK_ID}
      aria-label="Trocar de experiência"
      className="foco-oculto hidden items-start gap-6 sm:flex lg:gap-9"
    >
      {inactive.map((mode) => (
        <button
          key={mode}
          type="button"
          data-orb-slot={mode}
          onClick={() => enterMode(mode)}
          aria-label={`Mudar para ${HELO_MODES[mode].title}`}
          className="group relative h-14 w-14 shrink-0 rounded-full focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-4 lg:h-16 lg:w-16"
        >
          <span className="pointer-events-none absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap text-xs font-medium tracking-tight text-ink-mute transition-colors group-hover:text-ink">
            {HELO_MODES[mode].title}
          </span>
        </button>
      ))}
    </nav>
  );
}
