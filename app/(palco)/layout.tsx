"use client";

// ——— Layout do palco: a camada persistente da experiência Helo ———
// Este layout NUNCA desmonta ao navegar entre home, conversa, rotina e
// emergência (App Router preserva layouts entre rotas filhas). O OrbStage,
// a voz e o estado vivem aqui em cima; as páginas são apenas a camada
// dinâmica de conteúdo, renderizada como overlay sobre o palco.
//
// Home: orbes protagonistas no centro-alto. Experiência aberta: o trio
// encolhe para a faixa superior e o conteúdo sobe por baixo dele.

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { TopBar, PillLink } from "@/components/ui";
import { useHelo, type HeloMode } from "@/lib/helo-state";

const OrbStage = dynamic(() => import("@/components/orb-stage"), { ssr: false });

const PATH_TO_MODE: Record<string, HeloMode> = {
  "/conversa": "conversar",
  "/rotina": "rotina",
  "/emergencia": "emergencia",
};

export default function PalcoLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { setActiveMode, engine } = useHelo();
  const routeMode = PATH_TO_MODE[pathname];
  const isHome = !routeMode;

  // Deep link e botão voltar: a rota é reflexo do estado — aqui o estado
  // acompanha a rota, para o orbe certo assumir o centro em qualquer entrada.
  useEffect(() => {
    if (routeMode) setActiveMode(routeMode);
  }, [routeMode, setActiveMode]);

  return (
    <div className="flex min-h-dvh flex-col pb-[env(safe-area-inset-bottom)]">
      <TopBar
        right={
          <>
            <span className="hidden rounded-full border border-line bg-card px-4 py-1.5 text-xs text-ink-soft sm:inline">
              voz: {engine === "elevenlabs" ? "ElevenLabs" : "navegador"}
            </span>
            <PillLink href="/ajustes">Ajustes</PillLink>
            <PillLink href="/dashboard">Dashboard</PillLink>
          </>
        }
      />

      <div className="relative flex flex-1 flex-col">
        <OrbStage
          compact={!isHome}
          className={`absolute inset-x-0 top-0 z-0 transition-[height] duration-700 ease-out motion-reduce:transition-none ${
            isHome ? "h-[min(44vh,380px)]" : "h-32 sm:h-40"
          }`}
        />
        {/* O conteúdo desliza sob a faixa dos orbes; cliques atravessam as
            áreas vazias até os botões do palco */}
        <div
          className={`pointer-events-none relative z-10 flex flex-1 flex-col *:pointer-events-auto ${
            isHome ? "pt-[min(46vh,400px)]" : "pt-32 sm:pt-40"
          }`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
