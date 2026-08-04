"use client";

// ——— O que este aparelho guardou (Fase 4.9.2) ———
//
// Uma faixa discreta, EXCLUSIVA do cuidador. Ela diz três coisas e não diz uma
// quarta.
//
// O que ela diz:
//   • Salvo neste aparelho — a intenção está guardada, cifrada, e sobrevive a
//     um refresh e ao navegador fechado;
//   • Aguardando conexão — está guardada E não há rede;
//   • Sincronização pendente — há rede, e o envio ainda não existe (4.9.3).
//
// O que ela NUNCA diz: "Sincronizado".
//
// Nesta fase nada foi confirmado remotamente. Um selo de "tudo certo" seria a
// única mentira que esta faixa teria como contar, e seria a pior: o cuidador
// pararia de se preocupar com registros que ainda podem se perder. Quando a
// 4.9.3 existir, esse selo nascerá da CONFIRMAÇÃO do servidor — nunca da
// ausência de pendências locais.
//
// Onde ela não aparece: no palco do paciente. Quem responde por essa fronteira
// é `pacienteEstaOlhando`, no ponto de montagem — a mesma função que decide a
// tela do caminho e que já governa a barra de contexto. Duas regras
// divergiriam, e a que divergisse mostraria ao paciente a contabilidade do
// aparelho no lugar da conversa dele.

import type { OfflineStatusSummary } from "@/lib/offline/types";
import type { AvisoDeDescarte } from "@/lib/offline/store";

function plural(n: number, um: string, varios: string): string {
  return n === 1 ? um : varios;
}

const APARENCIA: Record<
  OfflineStatusSummary["state"],
  { fundo: string; borda: string; texto: string; ponto: string } | null
> = {
  SEM_PENDENCIA: null,
  SALVO_LOCALMENTE: {
    fundo: "bg-slate-500/10",
    borda: "border-slate-500/30",
    texto: "text-slate-700 dark:text-slate-200",
    ponto: "bg-slate-500",
  },
  AGUARDANDO_CONEXAO: {
    fundo: "bg-amber-500/10",
    borda: "border-amber-500/30",
    texto: "text-amber-800 dark:text-amber-200",
    ponto: "bg-amber-500",
  },
  SINCRONIZACAO_PENDENTE: {
    fundo: "bg-sky-500/10",
    borda: "border-sky-500/30",
    texto: "text-sky-800 dark:text-sky-200",
    ponto: "bg-sky-500",
  },
  CONFLITO: {
    fundo: "bg-rose-500/10",
    borda: "border-rose-500/30",
    texto: "text-rose-800 dark:text-rose-200",
    ponto: "bg-rose-500",
  },
  FALHA: {
    fundo: "bg-rose-500/10",
    borda: "border-rose-500/30",
    texto: "text-rose-800 dark:text-rose-200",
    ponto: "bg-rose-500",
  },
  AUTENTICACAO_NECESSARIA: {
    fundo: "bg-rose-500/10",
    borda: "border-rose-500/30",
    texto: "text-rose-800 dark:text-rose-200",
    ponto: "bg-rose-500",
  },
};

function frase(status: OfflineStatusSummary): string {
  const n = status.pending;
  switch (status.state) {
    case "AGUARDANDO_CONEXAO":
      return `Aguardando conexão · ${n} ${plural(n, "registro salvo", "registros salvos")} neste aparelho`;
    case "SINCRONIZACAO_PENDENTE":
      return `Sincronização pendente · ${n} ${plural(n, "registro", "registros")} ${plural(n, "aguarda", "aguardam")} envio`;
    case "SALVO_LOCALMENTE":
      return `Salvo neste aparelho · ${n} ${plural(n, "registro", "registros")}`;
    case "CONFLITO":
      return `${status.conflicts} ${plural(status.conflicts, "registro precisa", "registros precisam")} da sua decisão`;
    case "FALHA":
      return `Não conseguimos enviar ${status.failures} ${plural(status.failures, "registro", "registros")}`;
    case "AUTENTICACAO_NECESSARIA":
      return "Entre novamente para enviar o que ficou";
    default:
      return "";
  }
}

export function OfflineChip({
  status,
  aviso,
  onReconhecerAviso,
}: {
  status: OfflineStatusSummary;
  /** Migração de schema descartou dados locais. §8: nunca em silêncio. */
  aviso?: AvisoDeDescarte | null;
  onReconhecerAviso?: () => void;
}) {
  const aparencia = APARENCIA[status.state];
  if (!aparencia && !aviso) return null;

  return (
    <div className="flex flex-col gap-2">
      {aparencia && (
        <div
          // `status` e não `alert`: isto é uma informação de fundo sobre o
          // aparelho, não um aviso que deva interromper quem opera à beira do
          // leito. `polite` espera a leitura em curso terminar.
          role="status"
          aria-live="polite"
          data-testid="offline-chip"
          data-estado={status.state}
          className={`flex items-center gap-2 self-start rounded-full border px-3 py-1.5 text-xs font-medium ${aparencia.fundo} ${aparencia.borda} ${aparencia.texto}`}
        >
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full ${aparencia.ponto}`}
          />
          <span>{frase(status)}</span>
        </div>
      )}

      {aviso && (
        <div
          role="status"
          aria-live="polite"
          data-testid="offline-aviso-descarte"
          className="flex flex-wrap items-center gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
        >
          <span>
            Uma atualização do Helo trocou o formato do armazenamento deste
            aparelho.{" "}
            {aviso.operacoes > 0
              ? `${aviso.operacoes} ${plural(aviso.operacoes, "registro que ainda não tinha sido enviado foi descartado", "registros que ainda não tinham sido enviados foram descartados")}.`
              : "Nenhum registro pendente foi perdido."}
          </span>
          {onReconhecerAviso && (
            <button
              type="button"
              onClick={onReconhecerAviso}
              className="rounded-full border border-amber-500/40 px-3 py-1 font-semibold"
            >
              Entendi
            </button>
          )}
        </div>
      )}
    </div>
  );
}
