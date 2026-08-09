// ——— Quem é o dono do microfone, agora, sem empate possível ———
//
// A Fase 5.2A deixou a arbitragem em dois booleans independentes: um dizia se
// o Agente estava conversando, outro se o ditado estava capturando. Cada lado
// consultava o do outro antes de abrir o dispositivo. Funcionava enquanto as
// duas perguntas e as duas respostas fossem instantâneas — e nenhuma das duas
// é:
//
//   O Agente consulta "o ditado está ativo?" no começo de `connect()`, e só
//   marca a própria ocupação quando o WebRTC termina de abrir, uns segundos
//   depois. No meio disso o ditado pergunta "o Agente está ativo?", ouve não,
//   e abre o microfone. Os dois donos, os dois legítimos, cada um tendo
//   consultado o estado antes de agir.
//
// A correção não é consultar melhor: é parar de consultar. Aqui a posse é
// TOMADA, não verificada — uma operação síncrona que ou devolve uma concessão
// ou devolve nada, e que ninguém consegue observar pela metade. Um lado só
// descobre que perdeu porque `adquire` devolveu `null`.
//
// ——— A concessão tem identidade, e é isso que resolve o release atrasado ———
//
// O outro defeito da 5.2A era simétrico e mais silencioso: `setDictationActive
// (false)` era global. Uma captura que terminava tarde — resposta de rede que
// chegou depois, `onstop` de um gravador já esquecido, efeito de desmontagem
// de um campo que o cuidador deixou para trás — soltava o dono ATUAL, que
// podia ser outra pessoa. O microfone ficava marcado como livre com o Agente
// falando dentro dele.
//
// Por isso a concessão carrega um `id` que nunca se repete. Liberar exige
// apresentá-lo, e um `id` vencido não libera coisa nenhuma: a chamada é
// aceita, não faz nada e devolve `false`. Quem chegou depois continua dono.
//
// ——— Fora do React e fora do DOM, de propósito ———
//
// Sem `window`, sem `useState`, sem `MediaStream`. A arbitragem é a parte que
// mais precisa de teste determinístico — corridas, callbacks fora de ordem,
// cem ciclos seguidos — e a parte que menos precisa de navegador para ser
// exercitada. As suítes `.mjs` conduzem exatamente este código, não uma cópia
// dele.
//
// Este módulo arbitra o DISPOSITIVO. Não vê transcript, não vê paciente, não
// vê grant, não vê autoria. A fronteira da Fase 5.1 passa longe daqui.

/**
 * Os estados de posse que o produto sabe distinguir.
 *
 * `DICTATION_PROCESSING` merece a explicação: nesse estado o microfone já foi
 * fechado — as trilhas pararam quando a gravação terminou. A posse continua
 * mesmo assim porque existe uma transcrição em voo que ainda pode voltar e
 * escrever num campo. Deixar o Agente entrar aí produziria a cena em que o
 * cuidador está conversando com a Helo e um texto aparece sozinho na tela,
 * vindo de um áudio que ele gravou antes. A posse acompanha a INTERAÇÃO
 * pendente, não só o dispositivo aberto.
 */
export type DonoDoMicrofone =
  | "NONE"
  | "DICTATION_REQUESTING"
  | "DICTATION_LISTENING"
  | "DICTATION_PROCESSING"
  | "AGENT_CONNECTING"
  | "AGENT_ACTIVE";

/** A que lado do produto um estado de posse pertence. */
export type FamiliaDoMicrofone = "DICTATION" | "AGENT";

export interface ConcessaoDoMicrofone {
  /** Único e crescente. Uma concessão liberada nunca é reemitida. */
  readonly id: number;
  readonly familia: FamiliaDoMicrofone;
}

interface Posse {
  id: number;
  familia: FamiliaDoMicrofone;
  dono: DonoDoMicrofone;
}

const FAMILIA_DE: Record<Exclude<DonoDoMicrofone, "NONE">, FamiliaDoMicrofone> = {
  DICTATION_REQUESTING: "DICTATION",
  DICTATION_LISTENING: "DICTATION",
  DICTATION_PROCESSING: "DICTATION",
  AGENT_CONNECTING: "AGENT",
  AGENT_ACTIVE: "AGENT",
};

let posse: Posse | null = null;
let proximoId = 1;

const ouvintes = new Set<() => void>();

function avisa(): void {
  for (const ouvinte of ouvintes) ouvinte();
}

/** Assina mudanças de posse. Usado pela interface para refletir o estado. */
export function assinaMicrofone(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte);
  return () => {
    ouvintes.delete(ouvinte);
  };
}

export function donoDoMicrofone(): DonoDoMicrofone {
  return posse?.dono ?? "NONE";
}

/** O `id` da concessão vigente, ou `null`. Só para diagnóstico e teste. */
export function concessaoVigente(): number | null {
  return posse?.id ?? null;
}

export function microfoneLivre(): boolean {
  return posse === null;
}

/** O microfone está com a outra família — quem pergunta não pode assumir. */
export function microfoneOcupadoPorOutro(familia: FamiliaDoMicrofone): boolean {
  return posse !== null && posse.familia !== familia;
}

/** Alguma etapa do ditado detém o microfone (inclusive a transcrição em voo). */
export function ditadoDetemMicrofone(): boolean {
  return posse?.familia === "DICTATION";
}

/** O Agente detém o microfone — conectando ou já em conversa. */
export function agenteDetemMicrofone(): boolean {
  return posse?.familia === "AGENT";
}

/**
 * Toma o microfone, ou não toma.
 *
 * Síncrona e indivisível: entre o teste e a atribuição não existe `await`,
 * `then` nem evento. Duas chamadas no mesmo instante — dois cliques, um
 * `onClick` disparado duas vezes, o Agente e o ditado ao mesmo tempo — são
 * necessariamente sequenciais, e a segunda encontra o microfone tomado.
 *
 * Não existe "adquirir de novo" nem reentrância: quem já tem uma concessão e
 * chama isto outra vez recebe `null`, porque a segunda captura seria uma
 * captura nova por cima de uma que ninguém encerrou.
 */
export function adquireMicrofone(dono: Exclude<DonoDoMicrofone, "NONE">): ConcessaoDoMicrofone | null {
  if (posse !== null) return null;
  const familia = FAMILIA_DE[dono];
  posse = { id: proximoId++, familia, dono };
  avisa();
  return { id: posse.id, familia };
}

/**
 * Avança o estado da MESMA concessão — pedindo permissão → gravando →
 * transcrevendo, conectando → conversando.
 *
 * Uma concessão vencida não move nada e devolve `false`. É o caminho pelo qual
 * um `onstop` atrasado tentaria empurrar o dono novo para `PROCESSING`.
 */
export function avancaMicrofone(
  concessao: ConcessaoDoMicrofone,
  dono: Exclude<DonoDoMicrofone, "NONE">
): boolean {
  if (posse === null || posse.id !== concessao.id) return false;
  // Trocar de família dentro da mesma concessão seria o ditado virar Agente no
  // meio do caminho. Não existe transição assim, e aceitá-la aqui esconderia o
  // erro de quem a escrevesse.
  if (FAMILIA_DE[dono] !== posse.familia) return false;
  if (posse.dono === dono) return true;
  posse.dono = dono;
  avisa();
  return true;
}

/**
 * Devolve o microfone — se ainda for seu.
 *
 * Idempotente por construção: a segunda chamada com a mesma concessão já não
 * encontra a posse e devolve `false` sem efeito. É o que permite chamar isto
 * em todo caminho de saída (parar, cancelar, falhar, desmontar, trocar de
 * paciente, sair da conta) sem contar quantas vezes ele será percorrido.
 */
export function liberaMicrofone(concessao: ConcessaoDoMicrofone): boolean {
  if (posse === null || posse.id !== concessao.id) return false;
  posse = null;
  avisa();
  return true;
}

/**
 * Só para os testes: zera a posse entre cenários.
 *
 * O contador de `id` NÃO volta atrás. Um `id` reemitido faria uma concessão
 * antiga voltar a valer, que é precisamente o defeito que este módulo existe
 * para tornar impossível — e um teste que o reintroduzisse passaria enquanto o
 * produto quebrava.
 */
export function reiniciaMicrofoneParaTeste(): void {
  posse = null;
  avisa();
}
