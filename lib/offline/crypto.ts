"use client";

// ——— Cifra do armazenamento local (Fase 4.9.2) ———
//
// AES-GCM 256, chave NÃO EXTRAÍVEL, guardada como `CryptoKey` no IndexedDB.
//
// Por que não extraível: o navegador consegue serializar um `CryptoKey` por
// structured clone sem nunca expor os bytes ao JavaScript. Guardar a chave em
// texto — no localStorage, num campo do IndexedDB, onde for — seria guardar a
// fechadura junto da porta.
//
// Por que AES-GCM e não AES-CBC: GCM autentica. Um blob adulterado falha ao
// decifrar em vez de decifrar em lixo, e lixo silencioso num prontuário é pior
// do que um erro.
//
// IV NOVO A CADA GRAVAÇÃO, 12 bytes de `getRandomValues`. Reutilizar IV em GCM
// quebra a confidencialidade — é o erro clássico do modo, e por isso o IV é
// gerado dentro de `cifrar`, onde ninguém tem como passar um por fora.
//
// AAD (dados adicionais autenticados): escopo + coleção + id do registro. Um
// blob movido para outro paciente, outro usuário ou outra coleção NÃO decifra.
// Não é uma checagem que alguém possa esquecer de fazer: é a matemática da
// cifra que recusa.
//
// ——— O QUE ISTO NÃO FAZ ———
//
// Está no documento de auditoria (§8.5) e repetido aqui porque é onde alguém
// vai ler:
//
//   • não protege contra XSS — código injetado pede à Web Crypto que decifre, e
//     a chave ser não extraível impede o roubo DA CHAVE, não o USO dela;
//   • não protege contra extensão do navegador com permissão no domínio;
//   • não protege contra dispositivo desbloqueado com sessão viva;
//   • não é chave derivada de senha do usuário — ela mora no mesmo aparelho
//     que os dados;
//   • não garante apagamento físico: IndexedDB não promete sobrescrita.
//     Apagar a CHAVE é a mitigação, e é por isso que o logout apaga a chave
//     antes de qualquer outra coisa.
//
// Isto é higiene, não confidencialidade. Não deve ser apresentado como
// confidencialidade a ninguém.

const ALGORITMO = "AES-GCM";
const TAMANHO_CHAVE = 256;
const TAMANHO_IV = 12;

/**
 * `Uint8Array<ArrayBuffer>` e não `Uint8Array`: a lib do TypeScript passou a
 * distinguir buffer comum de `SharedArrayBuffer`, e a Web Crypto só aceita o
 * primeiro. Sem o parâmetro explícito, o valor que sai daqui não entra em
 * `crypto.subtle`.
 */
export interface BlobCifrado {
  iv: Uint8Array<ArrayBuffer>;
  dados: ArrayBuffer;
}

/**
 * A Web Crypto só existe em contexto seguro (https ou localhost). Num acesso
 * por IP da rede local sobre http — que é como o Helo é testado em tablet —
 * `crypto.subtle` é `undefined`.
 *
 * Nesse caso o modo sem conexão fica INDISPONÍVEL, e a interface diz isso. A
 * alternativa seria guardar conversa clínica em texto puro, e essa não é uma
 * alternativa.
 */
export function cifraDisponivel(): boolean {
  return (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.subtle !== "undefined" &&
    typeof globalThis.indexedDB !== "undefined"
  );
}

export async function gerarChave(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: ALGORITMO, length: TAMANHO_CHAVE },
    // false = não extraível. Este argumento é o ponto inteiro do módulo.
    false,
    ["encrypt", "decrypt"]
  );
}

function aad(
  escopo: string,
  colecao: string,
  id: string
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `${escopo}|${colecao}|${id}`
  ) as Uint8Array<ArrayBuffer>;
}

export async function cifrar(
  chave: CryptoKey,
  valor: unknown,
  escopo: string,
  colecao: string,
  id: string
): Promise<BlobCifrado> {
  const iv = crypto.getRandomValues(
    new Uint8Array(TAMANHO_IV)
  ) as Uint8Array<ArrayBuffer>;
  const texto = new TextEncoder().encode(
    JSON.stringify(valor ?? null)
  ) as Uint8Array<ArrayBuffer>;
  const dados = await crypto.subtle.encrypt(
    {
      name: ALGORITMO,
      iv,
      additionalData: aad(escopo, colecao, id),
    },
    chave,
    texto
  );
  return { iv, dados };
}

/**
 * Decifra. Devolve `null` quando o blob não pertence a este escopo/coleção/id,
 * quando a chave é outra, ou quando o conteúdo foi adulterado.
 *
 * `null` e não uma exceção: um registro ilegível é um registro perdido, e a
 * camada acima precisa poder descartá-lo e seguir — o que ela não pode é
 * fingir que decifrou.
 */
export async function decifrar<T>(
  chave: CryptoKey,
  blob: BlobCifrado,
  escopo: string,
  colecao: string,
  id: string
): Promise<T | null> {
  try {
    const aberto = await crypto.subtle.decrypt(
      {
        name: ALGORITMO,
        iv: blob.iv,
        additionalData: aad(escopo, colecao, id),
      },
      chave,
      blob.dados
    );
    return JSON.parse(new TextDecoder().decode(aberto)) as T;
  } catch {
    return null;
  }
}
