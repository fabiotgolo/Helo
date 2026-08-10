// ——— A sequência que decide se o efeito acontece (Fase 5.3C) ———
//
// Este módulo existe pelo mesmo motivo que `lib/voice/agent-session-lifecycle.ts`
// existiu na 5.1A: o defeito mora numa SEQUÊNCIA, e enquanto a sequência viver
// dentro do componente React a única forma de testá-la é reescrevê-la no teste
// — e um teste que reescreve o código prova que a cópia está correta.
//
// O que está aqui é exatamente o que o dispatcher passa a executar, com as
// dependências injetadas. O teste roda esta função.
//
// ——— A ordem é a garantia ———
//
//   1. resolver a ação no registry VIVO
//   2. gate de classe (R-02) — patientResponse e sensitive param aqui
//   3. a ação está habilitada?
//   4. autorizar no servidor        ← round-trip de rede, centenas de ms
//   5. o LEASE ainda vale?          ← a correção da 5.3C
//   6. a ação AINDA está registrada e é a mesma?
//   7. só então: o efeito
//
// O passo 5 é o que faltava. Até a 5.3B a validação acontecia antes do passo 4
// e nada mais era conferido depois dele. Nessa janela o cuidador podia trocar
// de paciente: a ação continuava registrada, o gate continuava dizendo sim, e
// o handler executava no mundo errado.
//
// O passo 6 não é redundante com o 5. A geração cobre rota, paciente, sessão e
// usuário; ela não cobre uma tela que desmontou por outro motivo — um modal
// que fechou, uma lista que recarregou. Resolver de novo pergunta ao registry
// o que só ele sabe.

import { CONTEXTO_EXPIRADO } from "@/lib/helo-agent-context";

/** O mínimo que a sequência precisa saber de uma ação. */
export interface AcaoDespachavel {
  actionId: string;
  enabled: boolean;
  run: (payload?: Record<string, unknown>) => void | Promise<void>;
}

export type ResultadoDoDespacho =
  | { ok: true; result: "SUCCESS"; actionId: string }
  | { ok: false; result: "NOT_FOUND" }
  | { ok: false; result: "FORBIDDEN_BY_POLICY"; actionId: string }
  | { ok: false; result: "UNAVAILABLE"; actionId: string }
  | { ok: false; result: "FORBIDDEN"; error: string }
  | { ok: false; result: typeof CONTEXTO_EXPIRADO; actionId?: string }
  | { ok: false; result: "FAILED"; actionId: string };

export interface DespachoDeps<A extends AcaoDespachavel> {
  /** O lease capturado quando o pedido chegou. */
  lease: number;
  /** Resolve o pedido sobre o registry VIVO. Chamado duas vezes, de propósito. */
  resolve: () => A | undefined;
  /** O gate de origem (R-02). Decide pela classe, nunca pelo texto. */
  permitido: (acao: A) => boolean;
  /** O lease ainda vale? Consultado no último instante antes do efeito. */
  aindaVale: (lease: number) => boolean;
  /** Autoriza no servidor. É aqui que passa o tempo. */
  autoriza: (acao: A) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Diagnóstico. Nunca recebe rótulo de tela nem conteúdo. */
  registra?: (evento: string, detalhe: Record<string, unknown>) => void;
}

/**
 * Decide e executa. Nunca lança: todo caminho de saída devolve um código.
 *
 * O `payload` recebe `__aindaVale` — a mesma pergunta do passo 5, disponível
 * para o handler que tenha uma espera longa por dentro. O dispatcher cobre até
 * o começo do efeito; o que acontece depois de um `await` interno só o handler
 * alcança, e este é o instrumento que ele usa.
 */
export async function despachaAcaoDoAgent<A extends AcaoDespachavel>(
  deps: DespachoDeps<A>,
  payload?: Record<string, unknown>
): Promise<ResultadoDoDespacho> {
  const { lease } = deps;

  const acao = deps.resolve();
  if (!acao) return { ok: false, result: "NOT_FOUND" };

  if (!deps.permitido(acao)) {
    return { ok: false, result: "FORBIDDEN_BY_POLICY", actionId: acao.actionId };
  }
  if (!acao.enabled) {
    return { ok: false, result: "UNAVAILABLE", actionId: acao.actionId };
  }

  const acesso = await deps.autoriza(acao);
  if (!acesso.ok) return { ok: false, result: "FORBIDDEN", error: acesso.error };

  if (!deps.aindaVale(lease)) {
    deps.registra?.("contexto expirou antes do efeito", { actionId: acao.actionId });
    return { ok: false, result: CONTEXTO_EXPIRADO, actionId: acao.actionId };
  }

  // A MESMA ação, não apenas uma com o mesmo id: um remount devolveria um
  // objeto novo, com handlers ligados a outra instância de tela.
  const aindaRegistrada = deps.resolve();
  if (aindaRegistrada !== acao) {
    deps.registra?.("ação saiu do registry antes do efeito", { actionId: acao.actionId });
    return { ok: false, result: CONTEXTO_EXPIRADO, actionId: acao.actionId };
  }

  try {
    await acao.run({
      ...(payload ?? {}),
      __source: "agent",
      __aindaVale: () => deps.aindaVale(lease),
    });
    return { ok: true, result: "SUCCESS", actionId: acao.actionId };
  } catch (caught) {
    // A mensagem do handler é escrita para o cuidador e pode citar a tela. Ela
    // fica no diagnóstico local; ao provedor vai só o código.
    deps.registra?.("handler falhou", { actionId: acao.actionId, erro: String(caught) });
    return { ok: false, result: "FAILED", actionId: acao.actionId };
  }
}
