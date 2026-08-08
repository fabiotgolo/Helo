// ——— Cache de áudio sintetizado, com dono e ponto de liberação ———
//
// Um `URL.createObjectURL` prende o Blob na memória da aba até alguém chamar
// `revokeObjectURL`. Até a Fase 5.1B ninguém chamava: `useSpeech` criava um
// URL por fala, guardava num `Map` sem limite e o `Map` crescia enquanto a aba
// vivesse. Trocar de paciente não removia nada; sair também não.
//
// Este módulo é o dono desses URLs. Ele existe fora do React de propósito —
// assim o comportamento é dirigido por teste de domínio contra o CÓDIGO DE
// PRODUÇÃO (`npm run test:audio:cache`), e não contra uma réplica.
//
// ——— A política, dita inteira ———
//
// **Chave**: a de `audioCacheKey` (lib/voice.ts) — `helo||<texto>` para a voz
//   da plataforma e `patient|<id>|<texto>` para a voz do paciente. Papel e
//   paciente entram na chave: áudio de um paciente nunca responde por outro,
//   nem por uma fala da plataforma com o mesmo texto.
//
// **Limite**: `LIMITE_PADRAO` entradas (abaixo), com despejo LRU. Escolhido
//   sobre o uso real: o maior conjunto pré-aquecido de uma vez é o da
//   Emergência — 5 frases padrão mais as personalizadas do paciente, algo
//   como 15 no pior caso realista. 32 mantém esse conjunto inteiro e ainda
//   deixa margem para as falas da plataforma e da conversa. Em bytes é pouco:
//   uma frase curta em mp3 fica na casa das dezenas de KB.
//
// **Despejo**: no `set`, depois de inserir, enquanto houver excedente —
//   sempre a entrada usada há mais tempo, e NUNCA uma entrada fixada
//   (`pin`), que é a que está tocando agora.
//
// **Revogação**: em quatro momentos, e só neles —
//   1. substituição de uma chave por outro áudio;
//   2. despejo por limite;
//   3. `purgePatient` (troca de paciente) e `purgeAll` (logout, desmontagem);
//   4. nunca enquanto o áudio estiver tocando — daí o `pin`.
//
// **Não persiste.** Blob nenhum vai para IndexedDB ou Cache API: áudio da voz
//   clonada de um paciente não fica gravado no aparelho.
//
// ——— Por que contamos referências ———
//
// Quando o servidor devolve um texto diferente do que a tela pediu (o grant
// manda), a mesma entrada é indexada sob as DUAS chaves. Um `revoke` na
// primeira deixaria a segunda apontando para um URL morto — o áudio existiria
// no cache e não tocaria. Por isso quem é revogado é o URL, quando a última
// chave que o alcança sai.

import type { VoiceSource } from "@/lib/voice";

export interface AudioCacheEntry {
  url: string;
  source: VoiceSource;
}

/** Ver a justificativa acima. Configurável, mas não é para virar botão. */
export const LIMITE_PADRAO = 32;

export interface AudioCacheDeps {
  limite?: number;
  /** Injetável para o teste de domínio observar cada liberação. */
  revoke?: (url: string) => void;
}

function revogaNoNavegador(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Ambiente sem URL.revokeObjectURL (SSR, teste): nada a liberar.
  }
}

export class AudioCache {
  // Map preserva a ordem de inserção: reinserir no `get` é o suficiente para
  // ter LRU sem estrutura auxiliar.
  private readonly entradas = new Map<string, AudioCacheEntry>();
  /** Quantas chaves alcançam cada URL. Zero → o URL é revogado. */
  private readonly referencias = new Map<string, number>();
  /** A chave cujo áudio está tocando agora. Nunca é despejada. */
  private fixada: string | null = null;
  private readonly limite: number;
  private readonly revoke: (url: string) => void;

  constructor(deps: AudioCacheDeps = {}) {
    this.limite = deps.limite ?? LIMITE_PADRAO;
    this.revoke = deps.revoke ?? revogaNoNavegador;
  }

  get tamanho(): number {
    return this.entradas.size;
  }

  /** Só para diagnóstico e teste — a ordem é da mais antiga para a mais nova. */
  get chaves(): string[] {
    return [...this.entradas.keys()];
  }

  get(chave: string): AudioCacheEntry | undefined {
    const entrada = this.entradas.get(chave);
    if (!entrada) return undefined;
    // Acerto conta como uso: vai para o fim da fila de despejo.
    this.entradas.delete(chave);
    this.entradas.set(chave, entrada);
    return entrada;
  }

  set(chave: string, entrada: AudioCacheEntry): void {
    // Substituir a mesma chave por outro áudio libera o anterior — era este o
    // vazamento mais silencioso: o `Map.set` sobrescrevia e o URL antigo
    // continuava vivo, sem nenhuma chave que o alcançasse.
    this.solta(chave);
    this.entradas.set(chave, entrada);
    this.referencias.set(entrada.url, (this.referencias.get(entrada.url) ?? 0) + 1);
    this.despeja();
  }

  /**
   * Marca a chave que está tocando. Enquanto fixada, ela não é despejada por
   * limite — despejar (e revogar) o áudio em reprodução o cortaria no meio.
   * Passar `null` libera.
   */
  fixa(chave: string | null): void {
    this.fixada = chave;
  }

  get chaveFixada(): string | null {
    return this.fixada;
  }

  /** Remove uma chave. Devolve true se ela existia. */
  remove(chave: string): boolean {
    if (!this.entradas.has(chave)) return false;
    this.solta(chave);
    return true;
  }

  /**
   * Tudo o que pertence a um paciente. Chamado na TROCA de paciente: o áudio
   * da voz clonada de quem saiu não fica em memória à espera de um acerto que
   * a validação de contexto recusaria de qualquer forma.
   *
   * Sem argumento, remove o áudio de TODOS os pacientes e preserva o da
   * plataforma (que não é de ninguém em particular).
   */
  purgePatient(patientId?: number | null): number {
    const prefixo = patientId == null ? "patient|" : `patient|${patientId}|`;
    let removidas = 0;
    for (const chave of [...this.entradas.keys()]) {
      if (!chave.startsWith(prefixo)) continue;
      this.solta(chave);
      removidas++;
    }
    return removidas;
  }

  /** Logout e desmontagem: nada sobra. */
  purgeAll(): number {
    const total = this.entradas.size;
    for (const chave of [...this.entradas.keys()]) this.solta(chave);
    this.fixada = null;
    return total;
  }

  /** Baixa a referência de uma chave e revoga o URL se ninguém mais o alcança. */
  private solta(chave: string): void {
    const entrada = this.entradas.get(chave);
    if (!entrada) return;
    this.entradas.delete(chave);
    const restantes = (this.referencias.get(entrada.url) ?? 1) - 1;
    if (restantes > 0) {
      this.referencias.set(entrada.url, restantes);
      return;
    }
    this.referencias.delete(entrada.url);
    this.revoke(entrada.url);
  }

  private despeja(): void {
    if (this.entradas.size <= this.limite) return;
    for (const chave of [...this.entradas.keys()]) {
      if (this.entradas.size <= this.limite) return;
      // A que está tocando é pulada, não adiada: o laço segue para a próxima
      // mais antiga. Ela volta a ser candidata assim que a reprodução soltar.
      if (chave === this.fixada) continue;
      this.solta(chave);
    }
    // Se sobrou acima do limite, só a entrada fixada resta — e ela sai da
    // frente sozinha quando a fala terminar.
  }
}
