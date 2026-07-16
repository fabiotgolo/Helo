"use client";

// ——— Apresentação de boas-vindas da tela de login ———
// Primeiro a PRESENÇA da Helo, depois o acesso: o Orb principal (Conversa)
// aparece sozinho, grande e central. Na primeira interação válida do usuário
// (um toque/clique em qualquer ponto) o MP3 oficial toca uma única vez, o Orb
// reage à voz e o conteúdo de login surge com fade JÁ nesse toque — sem esperar
// o fim da fala. (Antes gatilhávamos no evento `ended`; no Safari iOS, com o
// áudio roteado por Web Audio, esse evento muitas vezes não chega e o usuário
// ficava preso no Orb.)
//
// O Orb NUNCA desmonta nem reinicia — permanece vivo atrás/acima do formulário.
// A revelação é entregue via render-prop `children(revealed)`.

import { useEffect, type ReactNode } from "react";
import { Orb } from "@/components/ui";
import { useWelcomeAudio } from "@/lib/useWelcomeAudio";

export function WelcomeIntro({
  orbClassName = "",
  className = "",
  children,
}: {
  /** Classe do Orb (tamanho/protagonismo). */
  orbClassName?: string;
  /** Classe do contêiner (layout da composição Orb + conteúdo). */
  className?: string;
  /**
   * Recebe `revealed`: true a partir do primeiro toque/clique do usuário (que
   * também dispara o áudio), ou de imediato se a apresentação já ocorreu nesta
   * sessão — a partir daí o formulário de login surge com fade in.
   */
  children: (revealed: boolean) => ReactNode;
}) {
  const { play, getAmplitude, revealReady } = useWelcomeAudio();

  useEffect(() => {
    // Detecção da PRIMEIRA interação válida em qualquer ponto da página:
    //   pointerdown — mouse, caneta e toque em navegadores modernos;
    //   touchstart  — reforço para Safari iOS mais antigo;
    //   keydown     — quem navega por teclado (foco por Tab e digitação).
    // Passivos e em captura: não chamam preventDefault nem atrasam a interação.
    let armed = true;
    const events: (keyof WindowEventMap)[] = ["pointerdown", "touchstart", "keydown"];

    const remove = () => {
      for (const e of events) window.removeEventListener(e, handleFirstUserInteraction, true);
    };

    async function handleFirstUserInteraction(): Promise<void> {
      if (!armed) return; // já tratado — idempotente
      const outcome = await play();
      // started/already: reprodução resolvida nesta sessão → desarma e limpa.
      // busy: outra chamada em curso (mesmo toque disparou 2 eventos) → ignora.
      // error: não tocou → o hook já revelou o formulário (fallback); desarma.
      if (outcome === "started" || outcome === "already" || outcome === "error") {
        armed = false;
        remove();
      }
    }

    for (const e of events) {
      window.addEventListener(e, handleFirstUserInteraction, { passive: true, capture: true });
    }
    return remove;
  }, [play]);

  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      {/* Orb principal (Conversa) — grande, protagonista, nunca remonta */}
      <Orb palette="coral" breathe getAmplitude={getAmplitude} className={orbClassName} />
      {/* Conteúdo de login SOBRE a Orb, centralizado. pointer-events-none deixa
          o clique atravessar para a 1ª interação; o formulário revelado reativa
          os eventos em si mesmo. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
        {children(revealReady)}
      </div>
    </div>
  );
}
