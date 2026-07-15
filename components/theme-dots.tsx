"use client";

// ——— Atalho rápido de temas (topbar/menu) ———
// Uma fileira de bolinhas que (1) indica o tema ativo e (2) troca de tema na
// hora. É SÓ um atalho + indicador — o painel completo (com tamanho de fonte)
// continua em Ajustes (AppearanceSettings). A troca usa o MESMO setTheme do
// painel: puramente visual, persiste pela arquitetura de temas e NÃO toca em
// orbe, voz, sessão, paciente ou atividade em andamento.
//
// A lista de temas vem de useTheme().themes (fonte única — não duplicamos a
// definição de temas aqui). Cada bolinha mostra o par bg + accent do tema, e a
// ativa ganha destaque por FORMA além de cor (maior + anel), para não depender
// só de cor. Semântica de radiogroup: operável por teclado e leitores de tela.

import { useTheme } from "@/lib/theme";

export function ThemeDots({ className = "" }: { className?: string }) {
  const { theme, setTheme, themes } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Trocar tema"
      className={`flex items-center gap-0.5 ${className}`}
    >
      {themes.map((meta) => {
        const selected = theme === meta.id;
        const s = meta.swatches;
        return (
          <button
            key={meta.id}
            type="button"
            role="radio"
            aria-checked={selected}
            // Rótulo textual para leitores de tela (tooltip para quem enxerga).
            aria-label={`Tema ${meta.label}${selected ? " — ativo" : ""}`}
            title={meta.label}
            onClick={() => setTheme(meta.id)}
            // Alvo de toque generoso (32px) com a bolinha visível menor e
            // discreta no centro — o clique é fácil sem ocupar a topbar.
            className="group flex size-8 shrink-0 items-center justify-center rounded-full"
          >
            <span
              aria-hidden="true"
              className={`block rounded-full transition-all duration-200 motion-reduce:transition-none ${
                selected
                  ? "size-5 ring-2 ring-accent ring-offset-2 ring-offset-cream"
                  : "size-4 border border-black/15 group-hover:scale-110"
              }`}
              // Duas metades: fundo + destaque do tema — mostra tom claro/escuro
              // e a cor de acento de relance. Espelha as amostras do painel.
              style={{
                background: `linear-gradient(135deg, ${s.bg} 0 50%, ${s.accent} 50% 100%)`,
              }}
            />
          </button>
        );
      })}
    </div>
  );
}
