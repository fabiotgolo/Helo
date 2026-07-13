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
  const { setActiveMode, engine, activeSpeaker, activeVoiceSource } = useHelo();
  // Transparência da voz: enquanto algo soa, o selo diz QUEM fala e com QUAL
  // voz técnica — um fallback nunca passa por voz da Helo nem do paciente.
  const voiceBadge =
    activeVoiceSource === "heloElevenLabs"
      ? "Helo · ElevenLabs"
      : activeVoiceSource === "patientElevenLabsClone"
        ? "paciente · ElevenLabs"
        : activeVoiceSource === "platformCatalogVoice"
          ? "paciente · voz do catálogo"
          : activeVoiceSource === "approvedFallback"
          ? activeSpeaker === "patient"
            ? "paciente · fallback aprovado"
            : "fallback aprovado"
          : engine === "elevenlabs"
            ? "ElevenLabs"
            : "navegador";
  const routeMode = PATH_TO_MODE[pathname];
  const isHome = !routeMode;
  // Todas as experiências são imersivas (Fases 5, 7 e 8): o orbe do modo
  // segue grande e central, e o conteúdo aparece como camada translúcida
  // sobre ele. Na Emergência o conteúdo entra SEM animação — o acesso às
  // ações nunca espera a transição visual do orbe terminar.
  const variant = isHome ? "aberto" : "imersivo";

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
              voz: {voiceBadge}
            </span>
            <PillLink href="/ajustes">Ajustes</PillLink>
            <PillLink href="/dashboard">Dashboard</PillLink>
          </>
        }
      />

      <div className="relative flex flex-1 flex-col">
        <OrbStage
          variant={variant}
          className={`absolute inset-x-0 top-0 z-0 transition-[height] duration-700 ease-out motion-reduce:transition-none ${
            variant === "aberto" ? "h-[min(44vh,380px)]" : "h-full"
          }`}
        />
        {/* O conteúdo flutua SOBRE o orbe: cliques atravessam as áreas
            vazias até os botões do palco, e cada elemento interativo
            religa seus próprios pointer-events, para o palco continuar
            clicável. */}
        <div
          className={`pointer-events-none relative z-10 flex flex-1 flex-col ${
            variant === "aberto"
              ? "*:pointer-events-auto pt-[min(46vh,400px)]"
              : "pt-20 sm:pt-24"
          }`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
