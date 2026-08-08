// ——— Indisponibilidade da ElevenLabs é temporária, não terminal (R-11) ———
//
// O defeito: `elevenAvailable.current = false` numa 503 e nunca mais nada.
// Uma indisponibilidade de dez segundos — um deploy do provedor, um pico —
// desligava a voz da Helo e a voz do paciente pelo resto da vida da aba. Só
// recarregar a página trazia de volta, e ninguém sabia que era isso.
//
// A correção é pequena de propósito: a falha passa a ter PRAZO.
//
//   disponivel  ──falha transitória──►  degradado (até agora + COOLDOWN)
//        ▲                                     │
//        └──────── sucesso ◄───── tentativa permitida após o prazo
//
// **Não há polling.** Nada tenta sozinho. Passado o prazo, a PRÓXIMA fala que
// alguém pedir passa; se ela funcionar, volta tudo ao normal; se falhar de
// novo, começa um novo prazo. O custo de sondar a recuperação é pago por uma
// ação que já ia acontecer.
//
// ——— O que conta como indisponibilidade, e o que não conta ———
//
// Conta: 502, 503, 504 e erro de rede (o fetch nem completou). São respostas
// sobre o SERVIÇO.
//
// Não conta, e é o ponto: 400, 401, 403, 422. Essas falam sobre o PEDIDO — um
// grant ausente, vencido ou de outro paciente, uma voz não aprovada, um
// SpeechGrant mal configurado no servidor. Tratá-las como "ElevenLabs fora do
// ar" desligaria a voz da aba inteira por causa de uma autorização recusada, o
// que é exatamente o contrário do que a recusa quer dizer: ali o provedor está
// perfeitamente disponível, e o sistema está funcionando como projetado.

/** Quanto tempo uma falha transitória bloqueia novas tentativas automáticas. */
export const COOLDOWN_MS = 30_000;

export type EstadoDisponibilidade = "desconhecido" | "disponivel" | "degradado";

export interface DisponibilidadeDeps {
  cooldownMs?: number;
  /** Injetável para o teste de domínio controlar o tempo sem esperar. */
  agora?: () => number;
}

/**
 * Classifica uma resposta HTTP de /api/tts. `null` = o fetch falhou antes de
 * haver resposta (rede).
 */
export function ehFalhaTransitoria(status: number | null): boolean {
  if (status === null) return true; // rede: não chegou a haver resposta
  return status === 502 || status === 503 || status === 504;
}

export class DisponibilidadeElevenLabs {
  private estadoAtual: EstadoDisponibilidade = "desconhecido";
  private liberadoEm = 0;
  private readonly cooldownMs: number;
  private readonly agora: () => number;

  constructor(deps: DisponibilidadeDeps = {}) {
    this.cooldownMs = deps.cooldownMs ?? COOLDOWN_MS;
    this.agora = deps.agora ?? (() => Date.now());
  }

  get estado(): EstadoDisponibilidade {
    return this.estadoAtual;
  }

  /** Quanto falta do prazo, em ms. Zero quando não há bloqueio. */
  get esperaRestanteMs(): number {
    if (this.estadoAtual !== "degradado") return 0;
    return Math.max(0, this.liberadoEm - this.agora());
  }

  /**
   * Vale a pena tentar agora? Falso apenas DENTRO do prazo de um degradado —
   * "desconhecido" e "disponivel" sempre passam.
   */
  podeTentar(): boolean {
    if (this.estadoAtual !== "degradado") return true;
    return this.agora() >= this.liberadoEm;
  }

  /** A chamada funcionou: a indisponibilidade acabou, seja qual for o prazo. */
  registraSucesso(): void {
    this.estadoAtual = "disponivel";
    this.liberadoEm = 0;
  }

  /**
   * A chamada falhou. Só as falhas transitórias abrem prazo; as demais não
   * mexem no estado — uma autorização recusada não é o provedor fora do ar.
   * Devolve true se o estado virou (ou renovou) "degradado".
   */
  registraFalha(status: number | null): boolean {
    if (!ehFalhaTransitoria(status)) return false;
    this.estadoAtual = "degradado";
    this.liberadoEm = this.agora() + this.cooldownMs;
    return true;
  }

  /** Volta ao ponto de partida — usado no logout e na desmontagem. */
  reinicia(): void {
    this.estadoAtual = "desconhecido";
    this.liberadoEm = 0;
  }
}
