"use client";

// ——— Contexto de tela reportado ao Agent (Screen Context) ———
// getCurrentHeloActions reporta, por padrão, o nome de tela derivado da rota
// (SCREEN_BY_PATH). Algumas telas têm SUB-estados que mudam o que está
// disponível — ex.: a Rotina tem o menu de perguntas (routine_menu) e a tela de
// UMA pergunta aberta (routine_question). Este módulo deixa a tela montada
// PUBLICAR esse nome, sem que o provider do Agent conheça os detalhes de cada
// modo.
//
// ——— Só o NOME da sub-tela, desde a 5.3B ———
//
// Até a 5.3A existia aqui um campo `extra`, mesclado inteiro no payload
// enviado à ElevenLabs. Ele carregava exatamente o que o R-09 descreve: a
// pergunta clínica do card aberto (`currentQuestion`) e os rótulos das opções
// escritos pelo cuidador (`currentOptions`). Nenhum dos dois sustentava
// capacidade nenhuma — as ações correspondentes são `patientResponse`, que o
// Agent não executa. Era conteúdo saindo do produto para ajudar o modelo a
// entender uma tela em que ele não pode agir.
//
// O que sobrou é estrutura: "routine_question" diz ao Agent ONDE ele está.
// "Você quer tomar água?" dizia o que o paciente está sendo perguntado, e isso
// não é assunto do provedor.
//
// Registro em nível de módulo (mesmo padrão do Action Registry): funciona de
// qualquer árvore React e o desmonte da tela limpa o contexto — o Agent nunca
// vê um sub-estado de uma tela que já saiu.

import { useEffect, useRef } from "react";

export interface HeloScreenContext {
  /**
   * Nome de tela específico (sobrepõe o derivado da rota). Deve ser um
   * IDENTIFICADOR estrutural — nunca texto da interface, nunca conteúdo.
   */
  screen?: string;
}

let current: HeloScreenContext | null = null;

/** Lido por getCurrentHeloActions; null = usar o padrão derivado da rota. */
export function getHeloScreenContext(): HeloScreenContext | null {
  return current;
}

/**
 * Publica o nome da sub-tela montada enquanto ela viver. Passe null (ou não
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
