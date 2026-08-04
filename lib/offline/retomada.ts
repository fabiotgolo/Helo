"use client";

// ——— Voltar para a conversa depois de um refresh sem rede (Fase 4.9.2) ———
//
// Sem este módulo, todo o resto da fase seria inútil na hora que mais importa.
//
// A tela de Perguntas em tempo real começa perguntando ao servidor QUAIS
// sessões existem (`listSessions`), e só depois abre a que o cuidador escolher.
// Sem rede, essa primeira chamada falha — e a sessão nunca é montada, então o
// hook que sabe ler o armazenamento local nunca chega a rodar. O aparelho teria
// a conversa inteira guardada e cifrada, e mostraria uma tela de erro.
//
// Aqui a página descobre, sem servidor, que existe uma conversa em curso NESTE
// aparelho — e com que estado ela parou.
//
// O que este módulo NÃO faz, e não pode fazer: autorizar. Ele não decide que o
// cuidador pode ver este paciente. Quem decide é o servidor, a cada requisição,
// contra o vínculo — e continua decidindo assim. O que existe aqui é o
// resultado de uma autorização que o servidor JÁ concedeu, guardado sob uma
// chave que só existe neste aparelho e só decifra para este usuário e este
// paciente. Uma sessão nova, um paciente novo ou um login novo não encontram
// nada.

import { lerSnapshots, listarEscopos } from "@/lib/offline/db";
import { cifraDisponivel } from "@/lib/offline/crypto";
import {
  isExpired,
  OFFLINE_SCHEMA_VERSION,
  patientKey,
  scopeKey,
  type OfflineSnapshot,
} from "@/lib/offline/types";
import type { ConversationQuestionSession } from "@/lib/realtime-question-types";
import type { SessionDetailBase } from "@/lib/offline/projection";

/**
 * A conversa que este aparelho tem guardada para (usuário, paciente), se
 * houver e se ainda não expirou.
 *
 * Devolve `null` — e nunca lança — em todos os casos de ausência: sem Web
 * Crypto, sem banco, sem escopo, sem snapshot, snapshot vencido, sessão já
 * encerrada. A tela trata "não tenho" e "não sei" da mesma forma: pede rede.
 */
export async function sessaoLocalEmCurso(
  userId: string | null,
  patientIdNumerico: number | null,
  agora: number = Date.now()
): Promise<{
  session: ConversationQuestionSession;
  detail: SessionDetailBase;
} | null> {
  if (!cifraDisponivel() || !userId || patientIdNumerico == null) return null;

  try {
    const paciente = patientKey(patientIdNumerico);
    const escopo = scopeKey(userId, paciente);

    // Confere a existência do escopo ANTES de pedir a chave: `obterChave` cria
    // uma quando não encontra, e uma sondagem de leitura não pode deixar
    // rastro no aparelho de quem nunca usou o modo sem conexão.
    const escopos = await listarEscopos();
    if (!escopos.includes(escopo)) return null;

    const snapshots = await lerSnapshots<OfflineSnapshot>(escopo);
    const candidatos = snapshots
      .filter(
        (s) =>
          s.kind === "sessionDetail" &&
          s.schemaVersion === OFFLINE_SCHEMA_VERSION &&
          s.patientId === paciente &&
          !isExpired(s.snapshotAt, agora, true)
      )
      .sort((a, b) => b.snapshotAt.localeCompare(a.snapshotAt));

    for (const candidato of candidatos) {
      const detail = candidato.value as SessionDetailBase | null;
      if (!detail) continue;
      const session = detail.session;
      if (!session?.id) continue;
      // §2: só continua o que estava ATIVO ou PAUSADO. Uma conversa encerrada
      // não volta — nem aqui, nem no servidor.
      if (session.status !== "ACTIVE" && session.status !== "PAUSED") continue;
      // §5: a área é escopada, mas conferimos o paciente do próprio documento.
      // Um snapshot que não bata simplesmente não é usado.
      if (String(session.patientId) !== paciente) continue;
      return { session, detail };
    }
    return null;
  } catch {
    return null;
  }
}
