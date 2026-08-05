"use client";

// ——— Limpeza do armazenamento local (Fase 4.9.2) ———
//
// Módulo próprio, e não parte de `store.ts`, por uma razão de peso: quem chama
// a limpeza é `lib/use-auth.ts`, que está em TODA página do produto. Importar
// dali o `store.ts` arrastaria fila, projeção e as três máquinas de estados
// para o bundle da tela de login. Aqui só entram o banco e a cifra.
//
// ——— A POLÍTICA, e por que ela é assim ———
//
// LOGOUT EXPLÍCITO → apaga tudo, mas PERGUNTA antes quando há intenção
// pendente. §8: nunca apagar operações pendentes em silêncio. Se o cuidador
// disser não, o logout é abortado — ele pode reconectar e só então sair.
//
// SESSÃO EXPIRADA (401) → NÃO apaga a área offline.
//
//   Esta é a decisão que mais merece explicação. A auditoria propôs limpar
//   também no 401, pelo mesmo argumento de dispositivo compartilhado. Mudou
//   porque um 401 não é uma decisão de ninguém: é um token de 30 dias vencendo
//   sozinho, possivelmente no meio de uma conversa. Descartar por causa disso o
//   que o cuidador registrou seria exatamente o apagamento silencioso que §8
//   proíbe — e sem ganho real de segurança: a fila é ilegível sem a chave, a
//   chave é escopada por usuário (AAD), e o mesmo cuidador, ao entrar de novo,
//   volta a alcançar as próprias intenções. Um usuário DIFERENTE que entre na
//   mesma máquina não decifra nada, e a área do anterior sai na primeira troca
//   de paciente ou pelo TTL.
//
// TROCA DE PACIENTE → apaga a área do paciente anterior (`limparOutrosEscopos`).
// EXPIRAÇÃO (7 dias / 24h sensível) → o snapshot sai; a fila não expira.

import { cifraDisponivel } from "@/lib/offline/crypto";
import {
  lerOperacoes,
  limparEscopo,
  limparTudo,
  listarEscopos,
} from "@/lib/offline/db";
import { patientKey, scopeKey } from "@/lib/offline/types";

/**
 * Quantas intenções ainda esperam o servidor, em TODOS os escopos deste
 * aparelho. É o número que o logout mostra antes de descartar.
 */
export async function contarPendenciasOffline(): Promise<number> {
  if (!cifraDisponivel()) return 0;
  try {
    const escopos = await listarEscopos();
    let total = 0;
    for (const escopo of escopos) {
      const operacoes = await lerOperacoes<{ status?: string }>(escopo);
      total += operacoes.filter((op) => op?.status && op.status !== "SYNCED").length;
    }
    return total;
  } catch {
    // Banco ilegível: não temos como afirmar que há pendência, e afirmar que
    // não há seria pior. Zero aqui significa "nada a avisar", e o logout segue.
    return 0;
  }
}

/** Apaga o banco inteiro — chave primeiro, para que uma interrupção deixe lixo ilegível. */
export async function limparArmazenamentoOffline(): Promise<void> {
  if (!cifraDisponivel()) return;
  try {
    await limparTudo();
  } catch {
    // Uma limpeza que falha não pode segurar o logout. O redirecionamento
    // acontece, e a abertura seguinte tenta de novo.
  }
}

export interface ResultadoDaFaxina {
  /** Escopos de outros pacientes que saíram do aparelho. */
  removidos: number;
  /**
   * Escopos que NÃO foram removidos porque tinham intenção esperando o
   * servidor. Continuam cifrados e inalcançáveis para o paciente ativo — mas
   * continuam existindo, e o cuidador é avisado.
   */
  preservados: number;
}

/**
 * Troca de paciente: a área do anterior sai do aparelho — MENOS quando ela
 * ainda guarda intenção que ninguém enviou.
 *
 * Esta exceção é o ponto da função, e ela custou uma correção: a primeira
 * versão apagava tudo o que não fosse o paciente ativo. Simples, e errada.
 * Um cuidador que registrasse três respostas sem rede e trocasse de paciente
 * para conferir uma dose perderia as três, sem aviso, sem log e sem chance de
 * recuperar. É exatamente o apagamento silencioso que §8 proíbe.
 *
 * O que fica preservado não vaza para lugar nenhum: o escopo é `usuário ::
 * paciente` e a chave AES é escopada por ele, então a sessão do paciente ativo
 * não decifra uma linha do que sobrou. O que muda é que o cuidador passa a
 * saber que há algo pendente em outro lugar.
 */
export async function limparOutrosEscopos(
  userId: string,
  patientIdNumerico: number | null
): Promise<ResultadoDaFaxina> {
  const vazio = { removidos: 0, preservados: 0 };
  if (!cifraDisponivel()) return vazio;
  try {
    const manter =
      patientIdNumerico == null
        ? null
        : scopeKey(userId, patientKey(patientIdNumerico));
    const escopos = (await listarEscopos()).filter((e) => e !== manter);

    let removidos = 0;
    let preservados = 0;
    for (const escopo of escopos) {
      const operacoes = await lerOperacoes<{ status?: string }>(escopo);
      const pendentes = operacoes.filter(
        (op) => op?.status && op.status !== "SYNCED"
      ).length;
      if (pendentes > 0) {
        preservados++;
        continue;
      }
      await limparEscopo(escopo);
      removidos++;
    }
    return { removidos, preservados };
  } catch {
    /* banco indisponível — nada a limpar */
    return vazio;
  }
}
