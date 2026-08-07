"use client";

// ——— Banco local cifrado (Fase 4.9.2) ———
//
// IndexedDB, e não localStorage. Três razões, todas técnicas:
//
//   1. localStorage é SÍNCRONO. Ler e escrever conversa clínica nele
//      bloquearia a thread principal — a mesma que desenha o palco do
//      paciente. Um travamento de 200ms no meio de uma apresentação é uma
//      falha de produto, não de performance;
//   2. localStorage guarda string e tem teto de ~5 MB;
//   3. localStorage NÃO guarda um `CryptoKey` não extraível. Só o texto da
//      chave — que é a pior forma possível de guardar uma chave.
//
// Os espelhos `helo.*` que já existem em localStorage (paciente ativo, lista,
// settings, itens de modo) FICAM ONDE ESTÃO. Movê-los não traria ganho e
// traria risco de regressão num caminho que já funciona. O que muda é que a
// limpeza deles e a deste banco passam a acontecer no MESMO ponto.
//
// ——— O QUE FICA EM CLARO, e por quê ———
//
// O escopo — `${userId}::${patientId}` — é a chave de consulta e NÃO é
// cifrado. Alguém com acesso ao dispositivo consegue saber que este navegador
// foi usado por tal usuário para tal paciente. Não consegue ler uma linha de
// conversa, um nome, uma frase ou um comando: tudo isso está dentro do blob.
//
// Cifrar o escopo também exigiria uma chave para descobrir qual chave usar, e
// esse círculo só se fecha com um segredo em claro em algum lugar. Preferimos
// declarar o vazamento a fingir que ele não existe.

import {
  cifrar,
  cifraDisponivel,
  decifrar,
  gerarChave,
  type BlobCifrado,
} from "@/lib/offline/crypto";
import { OFFLINE_SCHEMA_VERSION } from "@/lib/offline/types";

const NOME_BANCO = "helo-offline";

const COL = {
  chaves: "chaves",
  operacoes: "operacoes",
  snapshots: "snapshots",
  rascunhos: "rascunhos",
  meta: "meta",
} as const;

type Colecao = (typeof COL)[keyof typeof COL];

/** Coleções de conteúdo: apagadas por escopo, cifradas, com índice por escopo. */
const COLECOES_DE_CONTEUDO: Colecao[] = [
  COL.operacoes,
  COL.snapshots,
  COL.rascunhos,
];

interface RegistroCifrado {
  id: string;
  escopo: string;
  iv: Uint8Array<ArrayBuffer>;
  dados: ArrayBuffer;
}

/** Marca deixada quando uma migração descartou dados. Nunca em silêncio (§8). */
export const META_DESCARTE = "descarte-por-migracao";

// ---------- Promessas sobre IndexedDB ----------

function pedido<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("falha no banco local"));
  });
}

/**
 * Quanto o navegador diz que já usamos (R10).
 *
 * Sinal ANTECIPADO, não garantia: a API não existe em todo navegador, é
 * deliberadamente imprecisa (proteção contra fingerprinting) e pode reportar
 * folga no exato instante em que a gravação falha. Quem protege de verdade é
 * o `QuotaExceededError` tratado na escrita.
 */
export async function estimarArmazenamento(): Promise<{
  disponivel: boolean;
  usadoBytes: number | null;
  cotaBytes: number | null;
}> {
  const indisponivel = { disponivel: false, usadoBytes: null, cotaBytes: null };
  if (
    typeof navigator === "undefined" ||
    !navigator.storage ||
    typeof navigator.storage.estimate !== "function"
  ) {
    return indisponivel;
  }
  try {
    const e = await navigator.storage.estimate();
    return {
      disponivel: true,
      usadoBytes: typeof e.usage === "number" ? e.usage : null,
      cotaBytes: typeof e.quota === "number" ? e.quota : null,
    };
  } catch {
    // Uma API que lança é uma API que não temos.
    return indisponivel;
  }
}

function transacaoConcluida(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("transação local abortada"));
    tx.onerror = () => reject(tx.error ?? new Error("transação local falhou"));
  });
}

let bancoAberto: Promise<IDBDatabase> | null = null;

/**
 * Abre o banco, migrando o schema quando a versão sobe.
 *
 * A migração é DESTRUTIVA de propósito: o snapshot é sempre reconstruível a
 * partir do servidor, e tentar traduzir uma fila gravada por um formato
 * anterior é adivinhar o que uma intenção clínica queria dizer. O que NÃO
 * fazemos é descartar calado — a contagem do que se perdeu fica em `meta`, e
 * a interface a mostra na abertura seguinte.
 */
export function abrirBanco(): Promise<IDBDatabase> {
  if (bancoAberto) return bancoAberto;
  if (!cifraDisponivel()) {
    return Promise.reject(
      new Error("armazenamento local indisponível neste navegador")
    );
  }

  bancoAberto = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(NOME_BANCO, OFFLINE_SCHEMA_VERSION);

    req.onupgradeneeded = (evento) => {
      const banco = req.result;
      const anterior = evento.oldVersion;
      const tx = req.transaction!;

      let descartadas = 0;
      if (anterior > 0) {
        // Conta antes de destruir, para poder avisar.
        for (const nome of COLECOES_DE_CONTEUDO) {
          if (!banco.objectStoreNames.contains(nome)) continue;
          const store = tx.objectStore(nome);
          const contagem = store.count();
          contagem.onsuccess = () => {
            if (nome === COL.operacoes) descartadas = contagem.result;
          };
        }
        for (const nome of [...COLECOES_DE_CONTEUDO, COL.chaves]) {
          if (banco.objectStoreNames.contains(nome)) banco.deleteObjectStore(nome);
        }
      }

      for (const nome of COLECOES_DE_CONTEUDO) {
        const store = banco.createObjectStore(nome, { keyPath: "id" });
        store.createIndex("escopo", "escopo", { unique: false });
      }
      if (!banco.objectStoreNames.contains(COL.chaves)) {
        banco.createObjectStore(COL.chaves, { keyPath: "escopo" });
      }
      if (!banco.objectStoreNames.contains(COL.meta)) {
        banco.createObjectStore(COL.meta, { keyPath: "chave" });
      }

      if (anterior > 0) {
        tx.objectStore(COL.meta).put({
          chave: META_DESCARTE,
          de: anterior,
          para: OFFLINE_SCHEMA_VERSION,
          operacoes: descartadas,
          em: new Date().toISOString(),
        });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("não foi possível abrir o banco local"));
    req.onblocked = () =>
      reject(new Error("banco local em uso por outra aba do Helo"));
  });

  bancoAberto = bancoAberto.catch((e) => {
    bancoAberto = null;
    throw e;
  });
  return bancoAberto;
}

// ---------- Chave por escopo ----------

/**
 * Chaves sendo obtidas AGORA, por escopo. Duas gravações simultâneas partilham
 * a mesma promessa em vez de disputarem quem cria a chave.
 */
const chavesEmVoo = new Map<string, Promise<CryptoKey>>();

/**
 * A chave do escopo. Criada na primeira gravação e mantida até logout, troca
 * de paciente ou expiração. Nunca sai daqui em texto — nem tem como.
 *
 * ——— POR QUE ISTO PRECISA SER ATÔMICO ———
 *
 * A primeira versão lia numa transação e gravava em outra. Entre as duas cabia
 * um segundo chamador: os dois liam "não existe", os dois geravam uma chave, e
 * o segundo `put` sobrescrevia o primeiro. Tudo o que tinha sido cifrado com a
 * chave perdida virava lixo ilegível — em silêncio, porque `lerTodos` descarta
 * o que não decifra.
 *
 * Não era hipótese. Ao abrir uma sessão, a tela grava o snapshot da sessão e o
 * dos caminhos no mesmo instante: as duas gravações chamavam isto juntas, uma
 * das chaves morria, e a conversa ficava irrecuperável exatamente no refresh
 * sem rede que a Fase 4.9 existe para atravessar. O sintoma era cruel — o
 * banco cheio, o aparelho "com tudo guardado", e a tela oferecendo só
 * "Iniciar nova sessão".
 *
 * São duas defesas, e as duas são necessárias:
 *
 *   1. `chavesEmVoo` resolve a concorrência DENTRO desta aba, que é a que
 *      causava o problema;
 *   2. o `get` + `put` na MESMA transação `readwrite` resolve a concorrência
 *      entre abas — o IndexedDB serializa transações sobre o mesmo store, e
 *      nenhuma outra se intromete entre as duas operações.
 */
export function obterChave(escopo: string): Promise<CryptoKey> {
  const emVoo = chavesEmVoo.get(escopo);
  if (emVoo) return emVoo;

  const promessa = obterChaveAtomica(escopo).catch((erro) => {
    // Uma falha não pode ficar memorizada: a gravação seguinte tenta de novo.
    chavesEmVoo.delete(escopo);
    throw erro;
  });
  chavesEmVoo.set(escopo, promessa);
  return promessa;
}

async function obterChaveAtomica(escopo: string): Promise<CryptoKey> {
  const banco = await abrirBanco();

  // A chave é gerada ANTES de abrir a transação de escrita. `gerarChave` é uma
  // promessa do WebCrypto, e esperar por algo que não seja um pedido do
  // IndexedDB no meio de uma transação a encerra sozinha.
  const candidata = await gerarChave();

  const tx = banco.transaction(COL.chaves, "readwrite");
  const store = tx.objectStore(COL.chaves);
  // A releitura acontece DENTRO da transação: se outra aba criou a chave nesse
  // intervalo, é a dela que vale, e a candidata é descartada sem ter cifrado
  // nada.
  const existente = await pedido<{ escopo: string; chave: CryptoKey } | undefined>(
    store.get(escopo)
  );
  if (existente?.chave) {
    await transacaoConcluida(tx);
    return existente.chave;
  }

  store.put({ escopo, chave: candidata, criadaEm: new Date().toISOString() });
  await transacaoConcluida(tx);
  return candidata;
}

// ---------- Gravação e leitura de conteúdo ----------

async function gravar(
  colecao: Colecao,
  escopo: string,
  id: string,
  valor: unknown
): Promise<void> {
  const banco = await abrirBanco();
  const chave = await obterChave(escopo);
  const blob: BlobCifrado = await cifrar(chave, valor, escopo, colecao, id);
  const tx = banco.transaction(colecao, "readwrite");
  const registro: RegistroCifrado = {
    id,
    escopo,
    iv: blob.iv,
    dados: blob.dados,
  };
  tx.objectStore(colecao).put(registro);
  await transacaoConcluida(tx);
}

async function lerTodos<T>(colecao: Colecao, escopo: string): Promise<T[]> {
  const banco = await abrirBanco();
  const tx = banco.transaction(colecao, "readonly");
  const indice = tx.objectStore(colecao).index("escopo");
  const registros = await pedido<RegistroCifrado[]>(
    indice.getAll(IDBKeyRange.only(escopo))
  );
  const chave = await obterChave(escopo);

  const saida: T[] = [];
  for (const r of registros) {
    const valor = await decifrar<T>(
      chave,
      { iv: r.iv, dados: r.dados },
      escopo,
      colecao,
      r.id
    );
    // Ilegível = perdido. Não tentamos "recuperar" nada: um registro clínico
    // remendado é pior do que um registro ausente.
    if (valor !== null) saida.push(valor);
  }
  return saida;
}

async function apagar(colecao: Colecao, id: string): Promise<void> {
  const banco = await abrirBanco();
  const tx = banco.transaction(colecao, "readwrite");
  tx.objectStore(colecao).delete(id);
  await transacaoConcluida(tx);
}

// ---------- Operações ----------

export function gravarOperacao(
  escopo: string,
  id: string,
  operacao: unknown
): Promise<void> {
  return gravar(COL.operacoes, escopo, id, operacao);
}

export function lerOperacoes<T>(escopo: string): Promise<T[]> {
  return lerTodos<T>(COL.operacoes, escopo);
}

export function apagarOperacao(id: string): Promise<void> {
  return apagar(COL.operacoes, id);
}

// ---------- Snapshots ----------

export function chaveDeSnapshot(
  escopo: string,
  kind: string,
  sessionId: string
): string {
  return `${escopo}|${kind}|${sessionId}`;
}

/**
 * Apaga TODOS os snapshots de um escopo — a degradação do R10.
 *
 * É a única liberação de espaço que existe, e por isso tem nome próprio em
 * vez de um `apagarPorColecao(colecao)` genérico: um parâmetro aqui seria o
 * caminho por onde, um dia, alguém liberaria espaço apagando `operacoes`.
 *
 * Snapshot é o que o SERVIDOR disse: sempre reconstruível por uma requisição.
 * Fila é intenção que ninguém mais tem. A assimetria é o ponto.
 */
export async function apagarSnapshotsDoEscopo(escopo: string): Promise<number> {
  const banco = await abrirBanco();
  const tx = banco.transaction(COL.snapshots, "readwrite");
  const store = tx.objectStore(COL.snapshots);
  const chaves = await new Promise<IDBValidKey[]>((res) => {
    const r = store.getAllKeys();
    r.onsuccess = () => res(r.result);
    r.onerror = () => res([]);
  });
  let apagados = 0;
  for (const chave of chaves) {
    if (typeof chave === "string" && chave.startsWith(`${escopo}|`)) {
      store.delete(chave);
      apagados += 1;
    }
  }
  await transacaoConcluida(tx);
  return apagados;
}

export function gravarSnapshot(
  escopo: string,
  kind: string,
  sessionId: string,
  snapshot: unknown
): Promise<void> {
  return gravar(
    COL.snapshots,
    escopo,
    chaveDeSnapshot(escopo, kind, sessionId),
    snapshot
  );
}

export function lerSnapshots<T>(escopo: string): Promise<T[]> {
  return lerTodos<T>(COL.snapshots, escopo);
}

// ---------- Rascunhos ----------
//
// Texto que o cuidador digitou e AINDA NÃO submeteu. Não é intenção (não vai
// para a fila, não vira operação, não gera auditoria) e não é fato (o servidor
// nunca ouviu falar dele). É o terceiro estatuto, e por isso mora numa coleção
// própria em vez de virar um caso especial de uma das outras duas.
//
// A chave carrega escopo E sessão: um rascunho nunca reaparece na conversa de
// outro paciente, nem na sessão seguinte do mesmo.

export function chaveDeRascunho(
  escopo: string,
  sessionId: string,
  chave: string
): string {
  return `${escopo}|${sessionId}|${chave}`;
}

export function gravarRascunho(
  escopo: string,
  sessionId: string,
  chave: string,
  valor: unknown
): Promise<void> {
  return gravar(
    COL.rascunhos,
    escopo,
    chaveDeRascunho(escopo, sessionId, chave),
    valor
  );
}

export function lerRascunhos<T>(escopo: string): Promise<T[]> {
  return lerTodos<T>(COL.rascunhos, escopo);
}

export function apagarRascunho(
  escopo: string,
  sessionId: string,
  chave: string
): Promise<void> {
  return apagar(COL.rascunhos, chaveDeRascunho(escopo, sessionId, chave));
}

// ---------- Limpeza ----------

/**
 * Apaga TUDO de um escopo, chave inclusive — e a chave primeiro.
 *
 * A ordem importa: se a limpeza for interrompida no meio (aba fechada, aparelho
 * desligado), o que sobra são blobs sem chave. Ilegíveis. A ordem inversa
 * deixaria dados legíveis com a chave já removida do caminho de limpeza.
 */
export async function limparEscopo(escopo: string): Promise<void> {
  const banco = await abrirBanco();

  // A chave memorizada sai junto: guardá-la depois de apagar a do banco faria
  // esta aba cifrar com uma chave que a próxima abertura não encontraria.
  chavesEmVoo.delete(escopo);

  const txChave = banco.transaction(COL.chaves, "readwrite");
  txChave.objectStore(COL.chaves).delete(escopo);
  await transacaoConcluida(txChave);

  const tx = banco.transaction(COLECOES_DE_CONTEUDO, "readwrite");
  for (const colecao of COLECOES_DE_CONTEUDO) {
    const store = tx.objectStore(colecao);
    const indice = store.index("escopo");
    const cursor = indice.openKeyCursor(IDBKeyRange.only(escopo));
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      store.delete(c.primaryKey);
      c.continue();
    };
  }
  await transacaoConcluida(tx);
}

/** Apaga o banco inteiro. É o que o logout chama. */
export async function limparTudo(): Promise<void> {
  chavesEmVoo.clear();
  if (bancoAberto) {
    try {
      (await bancoAberto).close();
    } catch {
      /* já fechado */
    }
    bancoAberto = null;
  }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(NOME_BANCO);
    // Resolve nos três desfechos: um logout NUNCA fica preso esperando o
    // banco. O redirecionamento para /login acontece de qualquer forma, e um
    // banco que não apagou agora é apagado na abertura seguinte.
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/** Escopos presentes no banco — usado para limpar o que não é do paciente ativo. */
export async function listarEscopos(): Promise<string[]> {
  const banco = await abrirBanco();
  const tx = banco.transaction(COL.chaves, "readonly");
  const chaves = await pedido<IDBValidKey[]>(
    tx.objectStore(COL.chaves).getAllKeys()
  );
  return chaves.map(String);
}

// ---------- Meta ----------

export async function lerMeta<T>(chave: string): Promise<T | null> {
  const banco = await abrirBanco();
  const tx = banco.transaction(COL.meta, "readonly");
  const v = await pedido<T | undefined>(tx.objectStore(COL.meta).get(chave));
  return v ?? null;
}

export async function apagarMeta(chave: string): Promise<void> {
  const banco = await abrirBanco();
  const tx = banco.transaction(COL.meta, "readwrite");
  tx.objectStore(COL.meta).delete(chave);
  await transacaoConcluida(tx);
}
