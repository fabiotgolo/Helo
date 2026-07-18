"use client";

// ——— Mute da voz da plataforma (topbar/menu, sob os temas) ———
// Um ícone de alto-falante que muta/desmuta a VOZ AUTOMÁTICA da plataforma
// (apresentação, Rotina, Emergência, Atividades, feedbacks e o fallback do
// navegador). É SÓ a voz: navegação, animações, seleção por gesto, execução da
// Emergência e a conversa do Agente Helo continuam funcionando.
//
// Estado e persistência vivem no gerenciador global (useAudioCoordinator) —
// aqui é só o controle. A preferência pertence ao usuário e sobrevive ao
// refresh (localStorage). Espelha o alvo de toque generoso das bolinhas de
// tema, com estado por FORMA (ícone cortado) além de cor, sem depender só de
// cor. Um aviso discreto confirma a troca sem tocar áudio.

import { useEffect, useRef, useState } from "react";
import { useAudioCoordinator } from "@/lib/audio-coordinator";

function SpeakerOnIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z" />
      <path d="M16 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 6a8.5 8.5 0 0 1 0 12" />
    </svg>
  );
}

function SpeakerOffIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z" />
      <path d="M16.5 9.5l4 4" />
      <path d="M20.5 9.5l-4 4" />
    </svg>
  );
}

export function PlatformMuteToggle({
  size = "default",
}: {
  /** "compact": alvo menor para o cabeçalho mobile (espelha os ThemeDots). */
  size?: "default" | "compact";
}) {
  const { platformMuted, setPlatformMuted } = useAudioCoordinator();
  const compact = size === "compact";
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);

  // Limpa o timer do aviso ao desmontar.
  useEffect(
    () => () => {
      if (noticeTimer.current != null) window.clearTimeout(noticeTimer.current);
    },
    []
  );

  // O aviso é setado só no clique — nunca na hidratação do valor salvo, para
  // não anunciar "mutada" sozinho ao carregar/navegar com o mute persistido.
  const toggle = () => {
    const next = !platformMuted;
    setPlatformMuted(next);
    setNotice(next ? "Voz da plataforma mutada" : "Voz da plataforma ativada");
    if (noticeTimer.current != null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2600);
  };

  const label = platformMuted ? "Ativar voz da plataforma" : "Mutar voz da plataforma";

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        aria-pressed={platformMuted}
        aria-label={label}
        title={label}
        onClick={toggle}
        className={`group flex shrink-0 items-center justify-center rounded-full ${
          compact ? "size-7" : "size-8"
        }`}
      >
        <span
          className={`flex items-center justify-center transition-colors ${
            compact ? "size-4" : "size-5"
          } ${platformMuted ? "text-ink-mute" : "text-ink-soft group-hover:text-ink"}`}
        >
          {platformMuted ? (
            <SpeakerOffIcon className="h-full w-full" />
          ) : (
            <SpeakerOnIcon className="h-full w-full" />
          )}
        </span>
      </button>
      {/* Aviso discreto e transitório; o role="status" também anuncia a troca
          a leitores de tela sem tocar nenhum áudio. */}
      <span
        role="status"
        aria-live="polite"
        className={`pointer-events-none absolute left-full ml-2 whitespace-nowrap rounded-full border border-line bg-card px-2.5 py-1 text-xs text-ink-soft shadow-soft transition-opacity ${
          notice ? "opacity-100" : "opacity-0"
        }`}
      >
        {notice}
      </span>
    </div>
  );
}
