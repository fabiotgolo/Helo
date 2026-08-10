// ——— Autorização antiga não é autorização atual (Fase 5.3C) ———
//
// O Agent descobre o que pode fazer, e executa depois. Entre as duas coisas
// passa tempo real: a rede até a ElevenLabs, o modelo decidindo, a client tool
// voltando, e — dentro do próprio Helo — um round-trip de autorização ao
// servidor. Nesse intervalo o cuidador pode ter trocado de paciente, saído da
// tela, encerrado a sessão ou saído da conta.
//
// Até a 5.3B a única proteção contra isso era INCIDENTAL: o registry esvazia
// no desmonte, então a ação "some" e o dispatcher devolve NOT_FOUND. Funciona
// para a mudança de tela, e só. Não cobre o intervalo em que a ação AINDA está
// registrada e a autoridade já mudou — que é exatamente a janela do
// `authorizeTool`, centenas de milissegundos de rede.
//
// ——— O que este módulo é, e o que ele deliberadamente não é ———
//
// É um contador. A cada mudança REAL de autoridade — rota, paciente, sessão
// clínica, autenticação — a geração avança. Quem vai executar captura a
// geração no começo e a confere no último instante antes do efeito. Diferente
// significa: o mundo mudou, recuse.
//
// NÃO é criptográfico: não protege contra um atacante, protege contra o tempo.
// NÃO viaja até a ElevenLabs: nada no contrato externo precisa mudar, e a
// segurança não depende de o modelo devolver corretamente um valor que
// mandamos para ele. A vinculação é uma closure local — o dispatcher captura,
// o dispatcher confere.
//
// ——— A regra que evita o defeito da 5.3B ———
//
// A 5.3B teve uma regressão de desempenho porque um `useMemo` dependia de
// callbacks que mudam de identidade a cada render. Aqui a lição está no
// código: a geração só avança quando um valor PRIMITIVO muda. Render não
// invalida. Array equivalente recriado não invalida. Callback com referência
// nova não invalida. Só muda o que muda de verdade.

/** Os campos que definem QUEM pode executar O QUÊ, agora. Todos primitivos. */
export interface ContextoDoAgent {
  /** Caminho atual, sem query. */
  readonly rota: string;
  /** Paciente ativo, ou null quando nenhum foi escolhido. */
  readonly pacienteId: number | null;
  /** Sessão clínica aberta, quando a tela tem uma. */
  readonly sessaoId: string | null;
  /** Id do usuário autenticado. Null = ninguém. */
  readonly usuarioId: string | null;
}

export interface EstadoDoContexto extends ContextoDoAgent {
  /**
   * Monotônica e nunca reemitida. Uma geração descartada não volta a valer —
   * é o mesmo princípio da concessão do microfone (lib/voice/mic-ownership.ts),
   * e pela mesma razão: um identificador reciclado ressuscitaria uma
   * autorização que já tinha morrido.
   */
  readonly geracao: number;
}

const VAZIO: ContextoDoAgent = {
  rota: "",
  pacienteId: null,
  sessaoId: null,
  usuarioId: null,
};

let atual: EstadoDoContexto = { ...VAZIO, geracao: 1 };
let proximaGeracao = 2;

const ouvintes = new Set<() => void>();

function avisa(): void {
  for (const ouvinte of ouvintes) ouvinte();
}

/** Assina mudanças de geração. A interface não precisa; os testes sim. */
export function assinaContextoDoAgent(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte);
  return () => {
    ouvintes.delete(ouvinte);
  };
}

export function contextoDoAgent(): EstadoDoContexto {
  return atual;
}

/** A geração de agora — o que quem vai executar captura. */
export function geracaoDoAgent(): number {
  return atual.geracao;
}

function iguais(a: ContextoDoAgent, b: ContextoDoAgent): boolean {
  return (
    a.rota === b.rota &&
    a.pacienteId === b.pacienteId &&
    a.sessaoId === b.sessaoId &&
    a.usuarioId === b.usuarioId
  );
}

/**
 * Publica o contexto vivo. Devolve `true` quando a geração AVANÇOU.
 *
 * Chamado de um efeito, a cada render em que os campos possam ter mudado. A
 * comparação é por valor: chamar isto cem vezes com os mesmos quatro
 * primitivos não move nada — nenhum ouvinte é avisado, nenhuma autorização em
 * voo morre. É o que separa "a tela renderizou" de "a autoridade mudou".
 */
export function defineContextoDoAgent(proximo: ContextoDoAgent): boolean {
  if (iguais(atual, proximo)) return false;
  atual = { ...proximo, geracao: proximaGeracao++ };
  avisa();
  return true;
}

// ——— Dois publicadores, um contexto ———
//
// O provider sabe a rota, o paciente e o usuário; ele vive no layout raiz e
// não conhece as telas. A sessão clínica só existe DENTRO da tela de perguntas
// em tempo real, e ela não conhece o provider. Cada um escreve a sua parte, e
// o contexto é recomposto — sem que nenhum dos dois precise do outro, e sem
// que a ordem em que eles montam importe.

let parteDoProvider: Omit<ContextoDoAgent, "sessaoId"> = {
  rota: "",
  pacienteId: null,
  usuarioId: null,
};
let parteDaSessao: string | null = null;

function recompoe(): boolean {
  return defineContextoDoAgent({ ...parteDoProvider, sessaoId: parteDaSessao });
}

/** Rota, paciente e usuário — publicados pelo provider do Agent. */
export function publicaContextoDoProvider(
  parte: Omit<ContextoDoAgent, "sessaoId">
): boolean {
  parteDoProvider = parte;
  return recompoe();
}

/**
 * A sessão clínica aberta agora, ou null. Publicada pela tela que a possui.
 *
 * Trocar de sessão com o MESMO paciente é uma fronteira própria: uma ação que
 * nasceu na sessão A não pode alterar a sessão B, mesmo sendo a mesma pessoa
 * na mesma tela.
 */
export function publicaSessaoClinica(sessaoId: string | null): boolean {
  parteDaSessao = sessaoId;
  return recompoe();
}

/** A sessão clínica publicada agora — lida pelo provider ao recompor. */
export function sessaoClinicaDoAgent(): string | null {
  return parteDaSessao;
}

/**
 * Mata a geração atual sem descrever um contexto novo.
 *
 * Existe para os fins que não são "mudou para outra coisa" e sim "acabou":
 * logout, encerramento da conversa, desmontagem do provider. Depois disto
 * qualquer lease anterior está vencido, e o contexto fica vazio até alguém
 * publicar um novo — o que só acontece com uma tela montada e um usuário.
 */
export function encerraContextoDoAgent(): void {
  parteDoProvider = { rota: "", pacienteId: null, usuarioId: null };
  parteDaSessao = null;
  atual = { ...VAZIO, geracao: proximaGeracao++ };
  avisa();
}

/**
 * Captura a autorização do instante. Guarde o valor; confira depois.
 *
 * O nome é literal: é um arrendamento, não uma posse. Ele vale enquanto o
 * mundo não mudar, e quem o detém não é avisado quando ele vence — precisa
 * perguntar.
 */
export function capturaLeaseDoAgent(): number {
  return atual.geracao;
}

/** O lease ainda vale? Falso significa: recuse, não execute, não comite. */
export function leaseAindaVale(lease: number): boolean {
  return lease === atual.geracao;
}

/**
 * O código de recusa por contexto vencido. Um só, para que o Agent e os testes
 * distingam "não existe" de "existia e não vale mais" — são coisas diferentes
 * para quem opera: a primeira é um engano, a segunda é o mundo ter andado.
 */
export const CONTEXTO_EXPIRADO = "CONTEXT_EXPIRED" as const;

/** Só para os testes: zera entre cenários. A geração NUNCA volta atrás. */
export function reiniciaContextoParaTeste(): void {
  encerraContextoDoAgent();
  ouvintes.clear();
}
