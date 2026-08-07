"use client";

// ——— Fachada do armazenamento local, por sessão (Fase 4.9.2) ———
//
// Junta as quatro peças — banco cifrado, fila pura, projeção e expiração —
// atrás de um objeto com escopo fixo: um usuário, um paciente, uma sessão.
//
// O escopo é fixado NO CONSTRUTOR e nunca muda. Não existe um método que troque
// de paciente, e isso é deliberado: misturar dois pacientes é o pior erro que
// esta camada poderia cometer, e a forma mais confiável de não cometê-lo é não
// ter como. Trocar de paciente significa construir outra fachada.

import {
  apagarMeta,
  apagarOperacao,
  apagarRascunho,
  apagarSnapshotsDoEscopo,
  estimarArmazenamento,
  gravarOperacao,
  gravarRascunho,
  gravarSnapshot,
  lerMeta,
  lerOperacoes,
  lerRascunhos,
  lerSnapshots,
  limparEscopo,
  META_DESCARTE,
} from "@/lib/offline/db";
import { cifraDisponivel } from "@/lib/offline/crypto";
import type { ConflictCase } from "@/lib/offline/conflicts";
import {
  decidirEnfileiramento,
  ehErroDeCota,
  haPressaoDeCota,
  OfflineStorageFullError,
  TETO_DA_FILA,
  type DecisaoDeEnfileiramento,
} from "@/lib/offline/armazenamento";
import {
  appendOperation,
  markStatus,
  ordenada,
  pruneSynced,
  restoreOperation,
  temPendenciaIrrecuperavel,
  type NovaOperacao,
} from "@/lib/offline/queue";
import {
  isExpired,
  OFFLINE_SCHEMA_VERSION,
  patientKey,
  scopeKey,
  type OfflineOperation,
  type OfflineOperationError,
  type OfflineOperationStatus,
  type OfflineSnapshot,
  type OfflineSnapshotKind,
} from "@/lib/offline/types";

export interface AvisoDeDescarte {
  de: number;
  para: number;
  operacoes: number;
  em: string;
}

/**
 * Um texto ainda não submetido. `sensivel` encurta o prazo: um rascunho sobre
 * assunto sensível não fica sete dias num aparelho compartilhado.
 */
export interface RascunhoLocal {
  chave: string;
  valor: unknown;
  sensivel: boolean;
  atualizadoEm: string;
  sessionId: string;
  patientId: string;
}

export interface CargaLocal {
  fila: OfflineOperation[];
  snapshots: OfflineSnapshot[];
  rascunhos: RascunhoLocal[];
  /** Migração de schema descartou dados. Nunca em silêncio (§8). */
  avisoDeDescarte: AvisoDeDescarte | null;
  /** Snapshots removidos por expiração nesta carga. */
  expirados: number;
}

/** Um conteúdo marcado como sensível em qualquer profundidade encurta o TTL. */
function contemSensivel(valor: unknown): boolean {
  if (valor === null || typeof valor !== "object") return false;
  if (Array.isArray(valor)) return valor.some(contemSensivel);
  const registro = valor as Record<string, unknown>;
  if (registro.isSensitive === true) return true;
  return Object.values(registro).some(contemSensivel);
}

export class OfflineSessionStore {
  readonly escopo: string;
  readonly patientId: string;

  constructor(
    readonly userId: string,
    patientIdNumerico: number,
    readonly sessionId: string
  ) {
    this.patientId = patientKey(patientIdNumerico);
    this.escopo = scopeKey(userId, this.patientId);
  }

  static disponivel(): boolean {
    return cifraDisponivel();
  }

  // ---------- Carga ----------

  /**
   * Lê tudo o que este aparelho guardou para este escopo, já sem o que expirou.
   *
   * A fila NÃO expira por tempo: uma intenção do cuidador só sai daqui quando
   * o servidor a aceitar ou quando ele mesmo mandar descartar. O snapshot
   * expira, porque ele é sempre reconstruível.
   */
  async carregar(agora: number = Date.now()): Promise<CargaLocal> {
    const [brutas, snapshotsBrutos, rascunhosBrutos, aviso] = await Promise.all([
      lerOperacoes<unknown>(this.escopo),
      lerSnapshots<OfflineSnapshot>(this.escopo),
      lerRascunhos<RascunhoLocal>(this.escopo),
      lerMeta<AvisoDeDescarte & { chave: string }>(META_DESCARTE),
    ]);

    const fila = ordenada(
      brutas
        .map(restoreOperation)
        .filter((op): op is OfflineOperation => op !== null)
        // Uma operação de outro paciente neste escopo é impossível por
        // construção — mas se existisse, ela não entraria na fila.
        .filter((op) => op.patientId === this.patientId)
    );

    const vivos: OfflineSnapshot[] = [];
    let expirados = 0;
    for (const s of snapshotsBrutos) {
      if (s.schemaVersion !== OFFLINE_SCHEMA_VERSION) {
        expirados++;
        continue;
      }
      if (isExpired(s.snapshotAt, agora, contemSensivel(s.value))) {
        expirados++;
        continue;
      }
      if (s.patientId !== this.patientId) {
        expirados++;
        continue;
      }
      vivos.push(s);
    }

    // Rascunho é do escopo E da sessão: um texto da conversa anterior não
    // reaparece nesta, e um de outro paciente não existe aqui — a chave da
    // gravação já garante o segundo, e o filtro garante o primeiro.
    const rascunhos = rascunhosBrutos.filter(
      (r) =>
        r &&
        r.patientId === this.patientId &&
        r.sessionId === this.sessionId &&
        !isExpired(r.atualizadoEm, agora, r.sensivel === true)
    );

    return {
      fila,
      snapshots: vivos,
      rascunhos,
      avisoDeDescarte: aviso
        ? {
            de: aviso.de,
            para: aviso.para,
            operacoes: aviso.operacoes,
            em: aviso.em,
          }
        : null,
      expirados,
    };
  }

  /** O aviso de descarte só some depois que o cuidador o viu. */
  reconhecerDescarte(): Promise<void> {
    return apagarMeta(META_DESCARTE);
  }

  // ---------- Fila ----------

  /**
   * Guarda uma intenção. Devolve a fila nova e a operação — que pode ser uma
   * já existente, quando a entrada foi reconhecida como clique repetido.
   */
  async enfileirar(
    fila: readonly OfflineOperation[],
    entrada: Omit<NovaOperacao, "sessionId" | "patientId">
  ): Promise<{
    fila: OfflineOperation[];
    operacao: OfflineOperation;
    deduplicada: boolean;
    /** Como o teto (R13) tratou esta entrada. */
    decisao: DecisaoDeEnfileiramento;
  }> {
    // O teto vale para intenção NOVA. Um clique repetido, que a fila
    // reconhece como a mesma intenção, não pode ser recusado por ela mesma
    // já estar lá — seria recusar o que já foi aceito.
    const decisao = decidirEnfileiramento(fila);
    if (decisao.kind === "RECUSADA") {
      const jaExiste =
        entrada.idempotencyKey &&
        fila.find((op) => op.idempotencyKey === entrada.idempotencyKey);
      if (!jaExiste) {
        // NÃO grava e NÃO devolve uma operação — quem chamou precisa poder
        // dizer à tela que não foi salvo. Devolver algo aqui seria fingir.
        throw new OfflineStorageFullError(decisao.pendentes, decisao.teto);
      }
    }

    const resultado = appendOperation(fila, {
      ...entrada,
      sessionId: this.sessionId,
      patientId: this.patientId,
      // Do ESCOPO, nunca de quem chamou: é o mesmo cuidado que mantém
      // sessionId e patientId fora da entrada. Quem enfileira não escolhe em
      // nome de quem está agindo.
      userId: this.userId,
    });
    if (!resultado.deduplicada) {
      try {
        await gravarOperacao(this.escopo, resultado.operacao.id, resultado.operacao);
      } catch (e) {
        if (!ehErroDeCota(e)) throw e;
        // Última cartada antes de recusar: o snapshot é reconstruível, a
        // operação não. Libera o espaço dele e tenta UMA vez.
        await this.degradarParaFilaSemSnapshot();
        try {
          await gravarOperacao(this.escopo, resultado.operacao.id, resultado.operacao);
        } catch (e2) {
          if (!ehErroDeCota(e2)) throw e2;
          // Nem assim coube. Recusar é a única saída honesta: a alternativa
          // seria devolver a operação como se estivesse guardada, e ela
          // sumiria no próximo refresh sem ninguém saber.
          throw new OfflineStorageFullError(
            decisao.kind === "RECUSADA" ? decisao.pendentes : fila.length,
            TETO_DA_FILA
          );
        }
      }
    }
    return { ...resultado, decisao };
  }

  /**
   * Muda o status de uma operação e persiste. Nesta fase só o cuidador e a
   * restauração mexem aqui — nada é enviado ao servidor ainda.
   */
  async marcar(
    fila: readonly OfflineOperation[],
    operationId: string,
    status: OfflineOperationStatus,
    extra: {
      error?: OfflineOperationError | null;
      nextRetryAt?: string | null;
      incrementRetry?: boolean;
      remoteConfirmedAt?: string | null;
      remoteEntityId?: string | null;
      conflict?: ConflictCase | null;
    } = {}
  ): Promise<OfflineOperation[]> {
    const nova = markStatus(fila, operationId, status, extra);
    const alvo = nova.find((op) => op.id === operationId);
    if (alvo) await gravarOperacao(this.escopo, alvo.id, alvo);
    return nova;
  }

  /**
   * Grava a fila inteira — usada quando uma DECISÃO do cuidador muda várias
   * operações de uma vez (Fase C.2): descarta uma e a cadeia que dependia
   * dela, ou enfileira um RESUME antes do resto.
   *
   * Recebe a lista do que sai porque quem calculou a decisão já sabe disso, e
   * recalcular aqui — comparando duas filas — seria uma segunda regra sobre o
   * que pode ser apagado. A primeira (e única) está em `decisions.ts`, onde é
   * pura e testável.
   */
  async aplicarDecisaoDoCuidador(
    fila: readonly OfflineOperation[],
    removidas: readonly string[]
  ): Promise<void> {
    await Promise.all(removidas.map((id) => apagarOperacao(id)));
    await Promise.all(
      fila.map((op) => gravarOperacao(this.escopo, op.id, op))
    );
  }

  /**
   * Remove da fila SOMENTE o que o servidor confirmou.
   *
   * Nesta fase nada chega a SYNCED, então na prática isto não remove nada. Ele
   * existe porque é o único caminho de remoção que vai existir — e tê-lo
   * escrito assim agora impede que a 4.9.3 invente um mais permissivo.
   */
  async removerConfirmadas(
    fila: readonly OfflineOperation[]
  ): Promise<{ fila: OfflineOperation[]; removidas: number }> {
    const resultado = pruneSynced(fila);
    const restantes = new Set(resultado.fila.map((op) => op.id));
    await Promise.all(
      fila.filter((op) => !restantes.has(op.id)).map((op) => apagarOperacao(op.id))
    );
    return resultado;
  }

  // ---------- Snapshot ----------

  /**
   * O snapshot parou de ser gravado para caber a fila (R10). Uma vez ligado,
   * fica ligado enquanto a aba viver: voltar a gravar snapshot depois de ter
   * faltado espaço só recriaria a pressão, e o cuidador já foi avisado.
   */
  private snapshotDegradado = false;

  degradado(): boolean {
    return this.snapshotDegradado;
  }

  /**
   * Guarda o que o servidor disse. É a ÚNICA gravação que pode desistir em
   * silêncio — snapshot é reconstruível por uma requisição, e insistir nele
   * sob pressão de cota é exatamente o que tiraria espaço da fila.
   *
   * Três camadas, nesta ordem:
   *   1. já degradado → nem tenta;
   *   2. pressão prevista por `estimate()` → degrada ANTES de falhar;
   *   3. `QuotaExceededError` na gravação → degrada, apaga os snapshots deste
   *      escopo e segue. É esta que vale, porque (2) pode não ver nada.
   */
  async salvarSnapshot(kind: OfflineSnapshotKind, value: unknown): Promise<void> {
    if (this.snapshotDegradado) return;

    if (haPressaoDeCota(await estimarArmazenamento())) {
      await this.degradarParaFilaSemSnapshot();
      return;
    }

    const snapshot: OfflineSnapshot = {
      kind,
      sessionId: this.sessionId,
      patientId: this.patientId,
      snapshotAt: new Date().toISOString(),
      schemaVersion: OFFLINE_SCHEMA_VERSION,
      value,
    };
    try {
      await gravarSnapshot(this.escopo, kind, this.sessionId, snapshot);
    } catch (e) {
      if (!ehErroDeCota(e)) throw e;
      await this.degradarParaFilaSemSnapshot();
    }
  }

  /**
   * "Fila sem snapshot" — a única degradação que existe.
   *
   * Apaga SOMENTE os snapshots DESTE escopo. Não toca operações (nem
   * pendentes, nem em conflito — com suas chaves de idempotência e
   * dependências intactas), não toca rascunhos, e não alcança o escopo de
   * outro paciente ou de outro usuário.
   */
  private async degradarParaFilaSemSnapshot(): Promise<void> {
    this.snapshotDegradado = true;
    try {
      await apagarSnapshotsDoEscopo(this.escopo);
    } catch {
      // Não conseguir apagar não desfaz a decisão de parar de gravar — que é
      // o que realmente protege a fila daqui para a frente.
    }
  }

  async lerSnapshot<T>(
    kind: OfflineSnapshotKind,
    agora: number = Date.now()
  ): Promise<T | null> {
    const carga = await this.carregar(agora);
    const achado = carga.snapshots.find(
      (s) => s.kind === kind && s.sessionId === this.sessionId
    );
    return achado ? (achado.value as T) : null;
  }

  // ---------- Rascunhos ----------

  salvarRascunho(
    chave: string,
    valor: unknown,
    sensivel = false
  ): Promise<void> {
    const rascunho: RascunhoLocal = {
      chave,
      valor,
      sensivel,
      atualizadoEm: new Date().toISOString(),
      sessionId: this.sessionId,
      patientId: this.patientId,
    };
    return gravarRascunho(this.escopo, this.sessionId, chave, rascunho);
  }

  descartarRascunho(chave: string): Promise<void> {
    return apagarRascunho(this.escopo, this.sessionId, chave);
  }

  // ---------- Limpeza ----------

  /**
   * Apaga a área deste escopo. Recusa quando há intenção pendente, a menos que
   * o cuidador tenha dito explicitamente para descartar (§8: nunca em
   * silêncio).
   */
  async limpar(
    fila: readonly OfflineOperation[],
    opcoes: { descartarPendentes?: boolean } = {}
  ): Promise<{ limpou: boolean; pendentes: number }> {
    const pendentes = fila.filter((op) => op.status !== "SYNCED").length;
    if (pendentes > 0 && !opcoes.descartarPendentes) {
      return { limpou: false, pendentes };
    }
    await limparEscopo(this.escopo);
    return { limpou: true, pendentes };
  }

  static temPendencia(fila: readonly OfflineOperation[]): boolean {
    return temPendenciaIrrecuperavel(fila);
  }
}

// As limpezas globais vivem em lib/offline/limpeza.ts: quem as chama é
// `use-auth.ts`, presente em toda página, e ele não pode arrastar fila e
// projeção para o bundle da tela de login.
export {
  contarPendenciasOffline,
  limparArmazenamentoOffline,
  limparOutrosEscopos,
} from "@/lib/offline/limpeza";
