"use client";

import { useEffect, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useHelo, type HeloMode } from "@/lib/helo-state";
import { PillLink, TopBar } from "@/components/ui";

const OrbStage = dynamic(() => import("@/components/orb-stage"), { ssr: false });

const PATH_TO_MODE: Record<string, HeloMode> = {
  "/conversa": "conversar",
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

  return (
  <div className="safe-area-pb flex min-h-dvh flex-col">
      {/* A TopBar entrega o padrão global: header original no desktop e
          cabeçalho + menu inferior mobile em toda tela < sm. */}
      <TopBar
        right={
          <>
            <PillLink href="/ajustes">Ajustes</PillLink>
            <PillLink href="/dashboard">Dashboard</PillLink>
          </>
        }
      />

      <div className="relative flex flex-1 flex-col">
        <OrbStage
          variant={variant}
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
          className={`pointer-events-none relative z-10 flex flex-1 flex-col ${
            variant === "aberto"
              ? "*:pointer-events-auto pt-[min(46vh,400px)]"
              : // pb no mobile: o conteúdo rola por inteiro acima do menu
                // inferior fixo — nada fica escondido atrás dele.
                "pb-24 pt-20 sm:pb-0 sm:pt-24"
          }`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
