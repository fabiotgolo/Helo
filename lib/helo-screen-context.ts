"use client";

// ——— Contexto de tela reportado ao Agent (Screen Context) ———
// getCurrentHeloActions reporta, por padrão, o nome de tela derivado da rota
// (SCREEN_BY_PATH). Algumas telas têm SUB-estados que o Agent precisa enxergar
// — ex.: a Rotina tem o menu de perguntas (routine_menu) e a tela de UMA
// pergunta aberta (routine_question, com a pergunta atual). Este módulo deixa a
// tela montada PUBLICAR esse contexto extra, sem que o provider do Agent
// conheça os detalhes de cada modo.
//
// Registro em nível de módulo (mesmo padrão do Action Registry): funciona de
// qualquer árvore React e o desmonte da tela limpa o contexto — o Agent nunca
// vê um sub-estado de uma tela que já saiu.

import { useEffect, useRef } from "react";

export interface HeloScreenContext {
  /** Nome de tela específico (sobrepõe o derivado da rota). */
  screen?: string;
  /** Campos extras mesclados na resposta de getCurrentHeloActions. */
  extra?: Record<string, unknown>;
}

let current: HeloScreenContext | null = null;

/** Lido por getCurrentHeloActions; null = usar o padrão derivado da rota. */
export function getHeloScreenContext(): HeloScreenContext | null {
  return current;
}

/**
 * Publica o contexto da tela montada enquanto ela viver. Passe null (ou não
 * chame) quando não houver sub-estado — o provider volta ao nome derivado da
 * rota. O objeto deve vir memoizado, refletindo o estado atual.
 */
export function useHeloScreenContext(context: HeloScreenContext | null): void {
  const ref = useRef<HeloScreenContext | null>(null);
  useEffect(() => {
    ref.current = context;
    current = context;
    return () => {
      // Só limpa se ninguém publicou por cima depois desta tela.
      if (current === ref.current) current = null;
    };
  }, [context]);
}
