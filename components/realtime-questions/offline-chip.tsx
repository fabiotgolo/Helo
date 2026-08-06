"use client";

// ——— O que este aparelho guardou (Fase 4.9.2) e o que já foi enviado (Fase B) ———
//
// Uma faixa discreta, EXCLUSIVA do cuidador. Estados possíveis:
//
//   • Salvo neste aparelho — a intenção está guardada, cifrada, e sobrevive a
//     um refresh e ao navegador fechado;
//   • Aguardando conexão — está guardada E não há rede;
//   • Sincronização pendente — há rede, o motor ainda não tentou este ciclo;
//   • Sincronizando — uma operação está EM VOO agora, de verdade;
//   • Sincronizado — o servidor confirmou tudo que estava pendente;
//   • Conflito / Falha — exige decisão do cuidador;
//   • Autenticação necessária — 401/403 durante o envio; a fila continua aqui.
//
// "Sincronizado" só aparece quando `status.synced > 0` — nasce da CONFIRMAÇÃO
// do servidor (Fase B), nunca da ausência de pendências locais. Uma fila vazia
// porque nada foi digitado ainda continua sendo "SEM_PENDENCIA", silenciosa.
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
  SINCRONIZANDO: {
    fundo: "bg-sky-500/10",
    borda: "border-sky-500/30",
    texto: "text-sky-800 dark:text-sky-200",
    ponto: "bg-sky-500 animate-pulse",
  },
  SINCRONIZADO: {
    fundo: "bg-emerald-500/10",
    borda: "border-emerald-500/30",
    texto: "text-emerald-800 dark:text-emerald-200",
    ponto: "bg-emerald-500",
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
    case "SINCRONIZANDO":
      return `Sincronizando · ${n} ${plural(n, "registro", "registros")} em envio`;
    case "SINCRONIZADO":
      return `Sincronizado · ${status.synced} ${plural(status.synced, "registro confirmado", "registros confirmados")} pelo Helo`;
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

/**
 * Diz, com todas as letras, o que aquele texto é.
 *
 * "Rascunho salvo neste aparelho" e não "salvo": o cuidador precisa saber que
 * o texto está guardado E que ninguém mais o viu. Um "salvo" sozinho seria
 * lido como "o Helo já tem isso", e não tem — nem o servidor, nem a fila, nem
 * a auditoria. Só existe aqui, e só até ele submeter ou cancelar.
 */
export function RascunhoLocalAviso({ visivel }: { visivel: boolean }) {
  if (!visivel) return null;
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="rascunho-local"
      className="flex items-center gap-2 self-start text-xs text-ink-mute"
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-mute" />
      Rascunho salvo neste aparelho — ainda não enviado ao Helo.
    </p>
  );
}

/**
 * Estados em que reenviar manualmente faz sentido. CONFLITO fica de fora de
 * propósito — aquilo exige uma decisão com o conteúdo dos dois lados na tela
 * (Fase C), nunca um reenvio às cegas. AUTENTICACAO_NECESSARIA fica DENTRO:
 * o cuidador entra de novo (em outra aba ou depois de recarregar) e volta
 * aqui para retomar — é exatamente o que `tentarNovamente` faz (reenfileira
 * o que estava FAILED, inclusive por 401/403, antes de tentar de novo).
 */
const ESTADOS_COM_BOTAO_MANUAL = new Set<OfflineStatusSummary["state"]>([
  "SALVO_LOCALMENTE",
  "AGUARDANDO_CONEXAO",
  "SINCRONIZACAO_PENDENTE",
  "FALHA",
  "AUTENTICACAO_NECESSARIA",
]);

export function OfflineChip({
  status,
  aviso,
  onReconhecerAviso,
  pendenciasDeOutroPaciente = 0,
  onSincronizarAgora,
  onDecidirConflito,
}: {
  status: OfflineStatusSummary;
  /** Migração de schema descartou dados locais. §8: nunca em silêncio. */
  aviso?: AvisoDeDescarte | null;
  onReconhecerAviso?: () => void;
  /** Áreas de outros pacientes que ficaram guardadas por terem pendência. */
  pendenciasDeOutroPaciente?: number;
  /** Disparo manual do cuidador (Fase B). Omitido: o botão não aparece. */
  onSincronizarAgora?: () => void;
  /**
   * Abre a tela de decisão (Fase C.2). É o ÚNICO caminho até ela: §11 diz que
   * a tela de conflito só abre por ação do cuidador, a partir do chip. Nada
   * neste componente abre nada sozinho.
   */
  onDecidirConflito?: () => void;
}) {
  const aparencia = APARENCIA[status.state];
  if (!aparencia && !aviso && pendenciasDeOutroPaciente === 0) return null;

  const mostrarBotao =
    Boolean(onSincronizarAgora) && ESTADOS_COM_BOTAO_MANUAL.has(status.state);
  const mostrarDecidir =
    Boolean(onDecidirConflito) && status.state === "CONFLITO";

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
          className={`flex flex-wrap items-center gap-2 self-start rounded-full border px-3 py-1.5 text-xs font-medium ${aparencia.fundo} ${aparencia.borda} ${aparencia.texto}`}
        >
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full ${aparencia.ponto}`}
          />
          <span>{frase(status)}</span>
          {mostrarBotao && (
            <button
              type="button"
              onClick={onSincronizarAgora}
              data-testid="sincronizar-agora"
              className="ml-1 rounded-full border border-current/30 px-2 py-0.5 font-semibold underline-offset-2 hover:underline"
            >
              Sincronizar agora
            </button>
          )}
          {mostrarDecidir && (
            <button
              type="button"
              onClick={onDecidirConflito}
              data-testid="decidir-conflito"
              className="ml-1 rounded-full border border-current/30 px-2 py-0.5 font-semibold underline-offset-2 hover:underline"
            >
              Ver e decidir
            </button>
          )}
        </div>
      )}

      {pendenciasDeOutroPaciente > 0 && (
        <div
          role="status"
          aria-live="polite"
          data-testid="offline-outro-paciente"
          className="self-start rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
        >
          Há registros de{" "}
          {pendenciasDeOutroPaciente === 1
            ? "outro paciente"
            : `${pendenciasDeOutroPaciente} outros pacientes`}{" "}
          guardados neste aparelho, aguardando conexão. Volte àquela conversa
          para enviá-los.
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
