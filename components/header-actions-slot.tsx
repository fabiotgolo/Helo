"use client";

// ——— Slot de ações da página no cabeçalho ———
// A barra de ações de cada experiência (Repetir, Gesto incerto, Pausar…)
// deixa o rodapé e sobe para logo abaixo do menu superior, alinhada à
// direita. A TopBar reserva o lugar (#helo-header-actions); a página entrega
// os botões por portal — continuam dela (estado, handlers, registro do Agent).
//
// No mobile (< sm) o cabeçalho desktop não existe: o hook devolve null e a
// página mantém a barra no próprio fluxo, como antes.

import { useEffect, useState } from "react";

export const HEADER_ACTIONS_ID = "helo-header-actions";

export function HeaderActionsSlot() {
  return (
    <div
      id={HEADER_ACTIONS_ID}
      className="foco-oculto flex flex-wrap items-center justify-end gap-2 empty:hidden"
    />
  );
}

/** Elemento do slot no desktop; null no mobile ou fora do palco. */
export function useHeaderActionsSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const sync = () =>
      setSlot(mq.matches ? document.getElementById(HEADER_ACTIONS_ID) : null);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return slot;
}
