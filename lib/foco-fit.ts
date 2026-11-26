"use client";

// ——— Modo foco: ampliar o conteúdo até quase a tela toda ———
// Esconder os menus não basta: no foco o conteúdo da experiência precisa
// CRESCER para a leitura. Cada página marca o seu bloco principal com
// `data-foco-alvo`; aqui ele recebe um `zoom` CSS calculado para ocupar
// ~94% da largura e ~90% da altura da janela, sem rolar.
//
// Por que `zoom` e não `transform: scale`: o zoom participa do layout — o
// bloco ampliado ocupa de verdade o espaço, continua centralizado pelos pais
// e os cliques caem onde os olhos veem.
//
// Por que busca binária e não uma regra de três: blocos `w-full max-w-*`
// podem bater na largura do pai antes de atingir o zoom ideal; aí o texto
// quebra em mais linhas e a altura cresce mais que o proporcional. Medir a
// cada passo garante o maior zoom que ainda cabe, em qualquer página.

import { useEffect } from "react";

const ALVO = "[data-foco-alvo]";
const LARGURA = 0.94;
const ALTURA = 0.9;
const ZOOM_MAX = 3;

function cabe(el: HTMLElement, z: number, w: number, h: number): boolean {
  el.style.zoom = String(z);
  const r = el.getBoundingClientRect();
  return r.width <= w + 1 && r.height <= h + 1;
}

function ajustar(el: HTMLElement) {
  const w = window.innerWidth * LARGURA;
  const h = window.innerHeight * ALTURA;
  if (!cabe(el, 1, w, h)) {
    // Já não cabe no tamanho natural: não amplia (nem encolhe a leitura).
    el.style.zoom = "1";
    return;
  }
  let lo = 1;
  let hi = ZOOM_MAX;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (cabe(el, mid, w, h)) lo = mid;
    else hi = mid;
  }
  el.style.zoom = lo.toFixed(3);
}

function limpar() {
  document.querySelectorAll<HTMLElement>(ALVO).forEach((el) => {
    el.style.zoom = "";
  });
}

export function useFocoFit(ativo: boolean) {
  useEffect(() => {
    if (!ativo) {
      limpar();
      return;
    }
    let raf = 0;
    const agendar = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        document.querySelectorAll<HTMLElement>(ALVO).forEach(ajustar);
      });
    };
    agendar();
    // Troca de tela dentro da experiência (pergunta aberta, próximo nó,
    // sessão de atividade): novos nós ou novo texto → reajusta. Atributos
    // ficam de fora — o próprio zoom é um atributo e reabriria o ciclo.
    const mo = new MutationObserver(agendar);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", agendar);
    void document.fonts?.ready.then(agendar);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      window.removeEventListener("resize", agendar);
      limpar();
    };
  }, [ativo]);
}
