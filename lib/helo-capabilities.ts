// ——— O que a ElevenLabs sabe sobre a tela (Fase 5.3B) ———
//
// Até aqui o Helo mandava ao provedor uma FOTOGRAFIA TEXTUAL da página: o
// `textContent` de todo `button` e `a` visível. A auditoria da 5.3A mediu o
// resultado numa conversa por opções real — saíam as opções escritas pelo
// cuidador ("Dor no peito", "Falta de ar à noite") e a pergunta da sessão,
// numa tela onde o Agent não tinha **nenhuma** ação executável. 25 rótulos de
// texto clínico para sustentar zero capacidade. Era o R-09.
//
// A troca é de pergunta, não de tamanho:
//
//   ANTES  "o que está escrito nesta tela?"
//   AGORA  "o que a Helo pode fazer aqui?"
//
// Este módulo é a única fonte da resposta. Ele é PURO de propósito — sem DOM,
// sem React, sem `window` — porque o payload é a fronteira por onde o dado sai
// do produto, e uma fronteira precisa ser exercitável sem navegador. O teste
// conduz esta função, não uma cópia dela.
//
// ——— A regra que ele implementa ———
//
// Uma capability é uma ação que o Agent pode executar AGORA. Ponto. Uma ação
// bloqueada não vira "sugestão", não vira rótulo, não vira dica: ela conta como
// número em `humanOnly` e mais nada. Quem for bloqueado descobre no momento da
// execução, com o motivo — e o motivo não repete o rótulo (ver
// `agentDenialReason`), porque um rótulo de item de Emergência é texto que o
// cuidador escreveu.
//
// ——— Por que a contagem, e não a lista ———
//
// Sem nada, o Agent responderia "não encontrei" a um pedido legítimo, e o
// cuidador tentaria de novo com outras palavras. Com a CONTAGEM ele pode dizer
// a verdade — "há ações aqui que só uma pessoa pode fazer" — sem que uma única
// palavra da tela atravesse a fronteira.

import type { HeloUIActionSummary } from "@/lib/helo-action-registry";

/** De onde a capability vem: a tabela fechada de rotas, ou a tela montada. */
export type HeloCapabilityScope = "global" | "screen";

/**
 * O que o Agent recebe por ação. Note o que NÃO está aqui: nenhum campo de
 * conteúdo, nenhum estado clínico, nenhum texto que não seja necessário para
 * ESCOLHER esta ação em vez de outra.
 */
export interface HeloCapability {
  id: string;
  /** Só as duas classes alcançáveis pelo Agent existem aqui. */
  class: "navigation" | "operational";
  label: string;
  aliases?: readonly string[];
  scope: HeloCapabilityScope;
}

/**
 * Quantas ações desta tela pertencem a uma pessoa, por motivo. Números, nunca
 * rótulos: é o suficiente para o Agent ser honesto e insuficiente para ele
 * revelar o que está escrito na tela.
 */
export interface HeloHumanOnlyCount {
  patientResponse: number;
  sensitive: number;
  /** Sem classe — inalcançável por fail-closed. Deveria ser sempre 0. */
  unclassified: number;
  /** Classificada como executável, porém desabilitada agora. */
  disabled: number;
}

export interface HeloContextPayload {
  ok: true;
  /** O caminho atual. Nunca com query — ela pode carregar dado. */
  route: string;
  /** Nome estrutural da tela (ou sub-tela). Nunca conteúdo. */
  screen: string;
  capabilities: HeloCapability[];
  humanOnly: HeloHumanOnlyCount;
  /**
   * O atalho de diagnóstico, fora do contrato de capacidades porque não é uma:
   * ele prova o round-trip ElevenLabs → client tool sem depender de login,
   * tela ou registry. Continua existindo enquanto o contrato do painel não for
   * conhecido (ver a seção de contrato externo na 5.3B).
   */
  diagnostic: "debug.ping";
}

/** Uma rota global: um destino de uma tabela fechada, sem handler. */
export interface HeloGlobalRoute {
  readonly actionId: string;
  readonly label: string;
  readonly path: string;
}

/**
 * Monta o contexto enviado ao provedor.
 *
 * `registered` deve vir de `listHeloUIActions("agent")` — a lista já traz
 * `agentExecutable`, calculado pelo mesmo gate que decide a execução. Aqui
 * confiamos NELE e em mais nada: não reimplementamos a regra de autoridade,
 * porque duas implementações da mesma regra é como uma delas fica para trás.
 */
export function buildHeloContext(input: {
  route: string;
  screen: string;
  globalRoutes: readonly HeloGlobalRoute[];
  registered: readonly HeloUIActionSummary[];
}): HeloContextPayload {
  const capabilities: HeloCapability[] = input.globalRoutes.map((rota) => ({
    id: rota.actionId,
    class: "navigation",
    label: rota.label,
    scope: "global",
  }));

  const humanOnly: HeloHumanOnlyCount = {
    patientResponse: 0,
    sensitive: 0,
    unclassified: 0,
    disabled: 0,
  };

  for (const acao of input.registered) {
    if (!acao.agentExecutable) {
      if (acao.actionClass === "patientResponse") humanOnly.patientResponse += 1;
      else if (acao.actionClass === "sensitive") humanOnly.sensitive += 1;
      else humanOnly.unclassified += 1;
      continue;
    }
    // Executável pela CLASSE, mas indisponível pelo ESTADO da tela — um botão
    // desabilitado. Anunciá-la faria o Agent tentar e falhar; contá-la deixa
    // ele dizer "ainda não dá".
    if (!acao.enabled) {
      humanOnly.disabled += 1;
      continue;
    }
    // `agentExecutable` só é verdadeiro para navigation e operational; o
    // fallback existe para que um tipo novo não escorregue para cá em silêncio.
    if (acao.actionClass !== "navigation" && acao.actionClass !== "operational") {
      humanOnly.unclassified += 1;
      continue;
    }
    capabilities.push({
      id: acao.actionId,
      class: acao.actionClass,
      label: acao.label,
      ...(acao.aliases && acao.aliases.length > 0 ? { aliases: acao.aliases } : {}),
      scope: "screen",
    });
  }

  return {
    ok: true,
    // Query string fora: `?section=…` é inofensivo, mas a regra "o caminho, e
    // só o caminho" não depende de auditar cada parâmetro que apareça amanhã.
    route: input.route.split("?")[0],
    screen: input.screen,
    capabilities,
    humanOnly,
    diagnostic: "debug.ping",
  };
}
