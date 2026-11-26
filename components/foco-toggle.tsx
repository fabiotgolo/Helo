"use client";

// ——— Botão de tela cheia (modo foco) ———
// Liga: esconde todos os menus e deixa só a pergunta e as respostas.
// Desliga: o mesmo botão, fixo no canto, com o ícone de recolher — quem
// acompanha o paciente sempre tem a saída à vista. Esc também sai.

import { useEffect } from "react";
import { useFoco } from "@/lib/foco";

export function FocoToggle({ className = "" }: { className?: string }) {
  const { foco, alternar, sair } = useFoco();

  // Esc sai do foco mesmo quando o navegador não entrou em tela cheia nativa
  // (iPhone, iframe) — com tela cheia nativa o próprio navegador cuida.
  useEffect(() => {
    if (!foco) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement) sair();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [foco, sair]);

  return (
    <button
      type="button"
      onClick={alternar}
      aria-pressed={foco}
      aria-label={foco ? "Sair da tela cheia e mostrar os menus" : "Tela cheia: mostrar só a pergunta e as respostas"}
      title={foco ? "Sair da tela cheia (Esc)" : "Tela cheia — esconde todos os menus"}
      className={`no-print pointer-events-auto z-40 flex h-12 w-12 items-center justify-center rounded-2xl border border-line/70 bg-card/80 backdrop-blur-md transition-all hover:scale-105 hover:border-ink-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
        foco ? "fixed right-4 top-4 z-[60] opacity-60 hover:opacity-100 focus-visible:opacity-100" : ""
      } ${className}`}
    >
      <FocoIcon recolher={foco} />
    </button>
  );
}

function FocoIcon({ recolher }: { recolher: boolean }) {
  // Cantos com o degradê da marca (coral → âmbar). Recolher = cantos para dentro.
  const d = recolher
    ? ["M9 4v5H4", "M15 4v5h5", "M9 20v-5H4", "M15 20v-5h5"]
    : ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"];
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="helo-foco-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ef476f" />
          <stop offset="1" stopColor="#f6b93b" />
        </linearGradient>
      </defs>
      {d.map((path) => (
        <path key={path} d={path} stroke="url(#helo-foco-grad)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}
