"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useHelo, type HeloMode } from "@/lib/helo-state";
import { PillLink, TopBar } from "@/components/ui";
import { OrbDock } from "@/components/orb-dock";
import { HeaderActionsSlot } from "@/components/header-actions-slot";
import { FocoToggle } from "@/components/foco-toggle";
import { sairFoco, useFoco } from "@/lib/foco";
import { useFocoFit } from "@/lib/foco-fit";

const OrbStage = dynamic(() => import("@/components/orb-stage"), { ssr: false });

const PATH_TO_MODE: Record<string, HeloMode> = {
  "/conversa": "conversar",
  // Perguntas em tempo real vive sob Conversar: mesmo orbe, mesmo palco.
  "/conversa/perguntas": "conversar",
  "/rotina": "rotina",
  "/emergencia": "emergencia",
  "/atividades": "atividades",
  "/helo": "helo",
};

export default function PalcoLayoutClient({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { setActiveMode } = useHelo();
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

  // Modo foco só existe dentro das experiências: voltar à Home sai dele.
  const { foco } = useFoco();
  // No foco, o bloco principal da página (data-foco-alvo) amplia até quase
  // a tela inteira — ver lib/foco-fit.ts.
  useFocoFit(foco && !isHome);
  useEffect(() => {
    if (isHome) sairFoco();
  }, [isHome]);

  // Altura do cabeçalho acima da área de conteúdo. No imersivo o palco sobe
  // por trás do cabeçalho (transparente) para os orbes recolhidos morarem na
  // linha da marca — o OrbStage compõe o protagonista abaixo desse recuo.
  const contentRef = useRef<HTMLDivElement>(null);
  const [insetTop, setInsetTop] = useState(0);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setInsetTop(el.offsetTop);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.parentElement) observer.observe(el.parentElement);
    return () => observer.disconnect();
  }, []);
  const imersivo = variant === "imersivo";

  return (
  <div className="safe-area-pb flex min-h-[100dvh] w-full max-w-full min-w-0 flex-col overflow-x-hidden">
      {/* A TopBar entrega o padrão global: header original no desktop e
          cabeçalho + menu inferior mobile em toda tela < sm. */}
      <TopBar
        right={
          <>
            <PillLink href="/ajustes">Ajustes</PillLink>
            <PillLink href="/dashboard">Dashboard</PillLink>
          </>
        }
        // Experiências abertas: os orbes recolhidos sobem para a linha da
        // marca, e a barra de ações da página entra logo abaixo do menu.
        center={imersivo ? <OrbDock visible /> : undefined}
        actionsSlot={imersivo ? <HeaderActionsSlot /> : undefined}
      />

      <div ref={contentRef} className="relative flex min-w-0 flex-1 flex-col">
        <OrbStage
          variant={variant}
          insetTop={imersivo ? insetTop : 0}
          style={
            imersivo
              ? { top: -insetTop, height: `calc(100% + ${insetTop}px)` }
              : undefined
          }
          className={`absolute inset-x-0 top-0 z-0 transition-[height] duration-700 ease-out motion-reduce:transition-none ${
            variant === "aberto"
              ? // Mobile: o palco ocupa a altura útil até o menu inferior
                // (~5.5rem) — orbe protagonista + fila de modos, como na
                // referência. Desktop preserva a faixa superior original.
                "h-[calc(100%-5.5rem)] sm:h-[min(44vh,380px)]"
              : "h-full"
          }`}
        />
        {/* O conteúdo flutua SOBRE o orbe: cliques atravessam as áreas
            vazias até os botões do palco, e cada elemento interativo
            religa seus próprios pointer-events, para o palco continuar
            clicável. */}
        <div
          className={`pointer-events-none relative z-10 flex min-w-0 flex-1 flex-col ${
            variant === "aberto"
              ? "*:pointer-events-auto pt-[min(46vh,400px)]"
              : foco
                ? // Foco: sem cabeçalho, sem menu inferior, sem fila de orbes.
                  "pb-4 pt-6"
                : // pb no mobile: o conteúdo rola por inteiro acima do menu
                  // inferior fixo — nada fica escondido atrás dele. No desktop
                  // os orbes moram no cabeçalho: o topo do conteúdo é livre.
                  "pb-24 pt-20 sm:pb-0 sm:pt-2"
          }`}
        >
          {children}
        </div>
        {/* Tela cheia: mostra só a pergunta e as respostas. Fora do foco fica
            no canto superior direito da área de conteúdo (no mobile, acima
            do menu inferior); no foco, fixo no canto como saída. */}
        {imersivo && (
          <FocoToggle
            className={
              foco ? "" : "fixed bottom-24 right-4 sm:absolute sm:bottom-auto sm:right-10 sm:top-2"
            }
          />
        )}
      </div>
    </div>
  );
}
