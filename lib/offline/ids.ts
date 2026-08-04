// ——— Identidade gerada no cliente (Fase 4.9.2) ———
//
// A auditoria propôs handles locais temporários, trocados pelo id do servidor
// na sincronização. A decisão de produto foi outra, e é melhor: o CLIENTE gera
// o id definitivo, e o servidor o preserva (§5). Uma identidade só, do
// nascimento ao banco — sem reescrever a fila, sem uma janela em que o mesmo
// registro tem dois nomes, e sem um mapa handle→id que precise sobreviver a um
// refresh para a fila fazer sentido.
//
// O formato é EXATAMENTE o de `newId` em lib/realtime-question-store.ts:
//
//     prefixo + base36(agora) + sufixo aleatório
//
// Não por estética. Um id de outra forma seria reconhecível como "veio do
// cliente", e isso é justamente o que não se quer: o registro não é de segunda
// classe por ter nascido offline.
//
// A diferença é a fonte da aleatoriedade. O servidor usa `Math.random()`, o
// que é aceitável quando um único processo cunha os ids. Aqui podem existir
// dois aparelhos offline cunhando ao mesmo tempo, sem ninguém para arbitrar —
// então usamos `crypto.getRandomValues` e um sufixo mais longo. Colisão aqui
// não daria um erro: daria dois registros clínicos diferentes com o mesmo
// nome, e o segundo sobrescrevendo o primeiro na sincronização.

/** Comprimento do sufixo aleatório. 12 chars base36 ≈ 62 bits. */
const SUFIXO_LEN = 12;

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

function aleatorioForte(tamanho: number): string {
  const cripto = globalThis.crypto;
  if (cripto?.getRandomValues) {
    const bytes = new Uint8Array(tamanho);
    cripto.getRandomValues(bytes);
    let saida = "";
    for (const b of bytes) saida += BASE36[b % 36];
    return saida;
  }
  // Sem Web Crypto não geramos identidade: um id fraco cunhado em dois
  // aparelhos ao mesmo tempo é pior do que não poder trabalhar offline.
  throw new Error(
    "este navegador não oferece geração segura de identificadores; o modo sem conexão fica indisponível"
  );
}

/** Prefixos do domínio. Iguais aos do servidor, e é isso que os torna válidos. */
export const PREFIXO = {
  turn: "cqt",
  path: "ocp",
  node: "ocn",
  branch: "br",
  statement: "ocs",
  option: "opt",
  context: "ctx",
  control: "pcr",
  operation: "op",
} as const;

export type PrefixoEntidade = (typeof PREFIXO)[keyof typeof PREFIXO];

/**
 * Cunha um id de registro. O servidor o preservará — este é o nome definitivo,
 * não um provisório.
 */
export function newEntityId(prefixo: PrefixoEntidade): string {
  return `${prefixo}${Date.now().toString(36)}${aleatorioForte(SUFIXO_LEN)}`;
}

/**
 * Formato mínimo aceitável para um id vindo do cliente. Não prova origem
 * (nada prova), mas recusa o que é claramente lixo antes de virar chave de
 * documento no Firestore — inclusive `/`, que quebraria o caminho da coleção.
 */
export function isValidEntityId(v: unknown, prefixo?: PrefixoEntidade): boolean {
  if (typeof v !== "string") return false;
  if (v.length < 8 || v.length > 80) return false;
  if (!/^[a-z0-9]+$/.test(v)) return false;
  return prefixo ? v.startsWith(prefixo) : true;
}

/**
 * Chave de idempotência de um gesto do cuidador.
 *
 * Gerada UMA vez, quando ele age, e preservada por toda retentativa. É o
 * oposto do hábito de hoje: a interface chama `newRequestId` a cada clique, o
 * que faz do segundo clique uma intenção nova. Offline, "a mesma intenção
 * reenviada" é a regra, não a exceção — e é por isso que a estabilidade desta
 * chave é o que separa um registro de dois.
 */
export function newIdempotencyKey(operationType: string): string {
  return `${operationType}-${Date.now().toString(36)}-${aleatorioForte(10)}`;
}

/** Id da própria operação na fila. Não é a identidade de nenhum registro. */
export function newOperationId(): string {
  return `${PREFIXO.operation}${Date.now().toString(36)}${aleatorioForte(10)}`;
}
