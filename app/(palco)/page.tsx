"use client";

// Home = estado "intro" da experiência. O palco dos orbes vem do layout
// persistente; esta página é só o conteúdo abaixo dele.
//
// Fluxo inicial automatizado: ao abrir, a Helo tenta se apresentar por voz
// (respeitando a política de autoplay do navegador — sem hacks). Quando a
// fala termina DE VERDADE (evento de fim, não timer), avança sozinha para a
// identificação. Clique em "Iniciar conversa" avança na hora. A transição é
// idempotente: clique antecipado, fim da fala e eventos duplicados não
// disparam duas navegações.

import { useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { GestureLegend } from "@/components/ui";
import { useHelo, type HeloMode } from "@/lib/helo-state";

export default function Home() {
  const { activeMode, modes, enterMode, playIntro } = useHelo();
  const info = modes[activeMode];

  // Idempotência da transição: o primeiro caminho (clique OU fim da fala)
  // vence; os demais viram no-op.
  const advanced = useRef(false);
  const advance = useCallback(
    (mode: HeloMode, opts?: { silent?: boolean }) => {
      if (advanced.current) return;
      advanced.current = true;
      enterMode(mode, opts);
    },
    [enterMode]
  );

  useEffect(() => {
    let mounted = true;
    void playIntro().then((result) => {
      // Só avança se a apresentação terminou de verdade e o usuário ainda
      // está na home. "bloqueada" (autoplay negado), "erro", "interrompida"
      // e "ignorada" mantêm a home funcional com o CTA à mão.
      if (mounted && result === "concluida") {
        advance("conversar", { silent: true });
      }
    });
    return () => {
      mounted = false;
    };
  }, [playIntro, advance]);

  return (
    <main className="flex flex-1 flex-col items-center justify-between gap-6 px-4 pb-6 pt-12 sm:px-6">
      <div key={activeMode} className="fade-rise flex flex-col items-center gap-4 text-center">
        <p className="max-w-md text-ink-soft">{info.description}</p>
        <button
          type="button"
          onClick={() => advance(activeMode)}
          className="rounded-full bg-ink px-8 py-3.5 font-medium text-white transition-transform hover:scale-[1.02] hover:bg-black"
        >
          {activeMode === "conversar" ? "Iniciar conversa" : `Abrir ${info.title.toLowerCase()}`}
        </button>
      </div>

      <div className="flex flex-col items-center gap-5">
        <div className="text-center">
          <h1 className="text-2xl font-medium tracking-tight sm:text-4xl">
            O elo entre sentir e dizer.
          </h1>
          <p className="mx-auto mt-2 max-w-xl text-ink-soft">
            Comunicação assistiva com respeito, cuidado e consentimento.
            O paciente escolhe — o Helo dá voz.
          </p>
        </div>
        <Link
          href="/mensagem"
          className="rounded-full border border-line bg-card px-5 py-2.5 text-sm font-medium transition-colors hover:border-ink-mute"
        >
          ✉️ Montar mensagem — frase por frase, no ritmo do paciente
        </Link>
        <GestureLegend />
        <p className="max-w-lg text-center text-sm text-ink-mute">
          O Helo nunca fala, deduz ou decide pelo paciente. Toda mensagem é
          confirmada antes de ser comunicada, salva ou compartilhada.
        </p>
      </div>
    </main>
  );
}
