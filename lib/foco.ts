"use client";

// ——— Modo foco (tela cheia) das páginas de interatividade ———
// Um único interruptor global: quando ligado, só a pergunta e as respostas
// ficam na tela. Menus, orbes recolhidos, coluna de temas, selo "Supported by"
// e barras de ação da página saem de cena.
//
// Como esconde: o estado vira um atributo no <html> (data-foco). O CSS global
// (globals.css) esconde tudo que estiver marcado com a classe `foco-oculto`,
// e as telas ampliam a tipografia do palco pela mesma chave. Assim nenhum
// componente precisa de prop nova para "sumir" — só da classe.
//
// Tela cheia do navegador: ao ligar, pedimos o Fullscreen API. Se o aparelho
// não suporta (iPhone Safari) ou recusa, o modo foco funciona igual dentro da
// página. Sair da tela cheia pelo Esc do navegador também desliga o foco —
// os dois estados nunca divergem.

import { useCallback, useEffect, useSyncExternalStore } from "react";

let foco = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function apply(next: boolean) {
  if (foco === next) return;
  foco = next;
  if (typeof document !== "undefined") {
    if (next) document.documentElement.dataset.foco = "1";
    else delete document.documentElement.dataset.foco;
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function entrarFoco() {
  apply(true);
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) {
    // Recusa (permissão, iframe, gesto expirado) não desfaz o foco da página.
    el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  }
}

export function sairFoco() {
  apply(false);
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

export function useFoco() {
  const ativo = useSyncExternalStore(
    subscribe,
    () => foco,
    () => false,
  );

  // Esc / gesto do sistema saiu da tela cheia → o foco sai junto.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && foco) apply(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const alternar = useCallback(() => {
    if (foco) sairFoco();
    else entrarFoco();
  }, []);

  return { foco: ativo, alternar, entrar: entrarFoco, sair: sairFoco };
}

/**
 * Sai do modo foco ao desmontar — trocar de rota (ex.: voltar à Home) nunca
 * deixa a interface sem menus.
 */
export function useSairFocoAoDesmontar() {
  useEffect(() => () => sairFoco(), []);
}
