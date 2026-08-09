"use client";

// ——— O botão de ditar, e o pouco que ele pode fazer ———
//
// Ele abre o microfone, fecha o microfone e põe texto num campo. Não submete,
// não apresenta, não confirma, não salva. O botão que faz o fluxo andar
// continua sendo o mesmo de antes, ao lado, e este aqui nunca o aciona.
//
// Quando o ditado não está disponível — recurso desligado no servidor, sem
// conexão, navegador sem gravação — o componente não renderiza nada. Não há
// botão apagado, não há cadeado, não há explicação sobre plano ou configuração.
// O cuidador vê o campo de sempre e digita, que é exatamente o que ele fazia
// antes desta fase.

import { useId } from "react";
import type { Ditado } from "@/lib/voice/use-dictation";

export function DictationButton({
  ditado,
  rotuloDoCampo,
}: {
  ditado: Ditado;
  /** "a pergunta", "a interpretação" — entra no rótulo acessível. */
  rotuloDoCampo: string;
}) {
  const avisoId = useId();
  // Indisponível E sem nada a dizer: some por completo, como sempre. Mas quando
  // a indisponibilidade é a própria notícia — a rede caiu no meio da gravação e
  // o botão sumiu junto —, a frase fica. Sem ela a captura terminaria em
  // silêncio e o cuidador ficaria esperando um texto que não vem.
  if (!ditado.disponivel && !ditado.aviso) return null;

  const ouvindo = ditado.estado === "LISTENING";
  const pedindo = ditado.estado === "REQUESTING_PERMISSION";
  const processando = ditado.estado === "PROCESSING";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {ditado.disponivel && (
      <button
        type="button"
        onClick={ouvindo ? ditado.para : ditado.inicia}
        disabled={pedindo || processando}
        aria-describedby={ditado.aviso ? avisoId : undefined}
        aria-label={
          ouvindo ? `Parar de ditar ${rotuloDoCampo}` : `Ditar ${rotuloDoCampo} por voz`
        }
        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-card px-4 py-2 text-sm font-medium text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60"
      >
        {/* O indicador de microfone aberto é visual E textual: um ponto
            pulsando não chega a quem usa leitor de tela, e saber que o
            microfone está ligado não é um detalhe estético. */}
        <span aria-hidden="true">{ouvindo ? "⏺" : "🎙"}</span>
        {/* O rótulo do botão diz o que ele FAZ. Quem diz o que está
            acontecendo é a região viva ao lado — se os dois dissessem
            "Transcrevendo…", o leitor de tela leria duas vezes e o nome
            acessível do controle mudaria para um estado, que ele não é. */}
        {ouvindo ? "Parar" : "Ditar"}
      </button>
      )}

      {/* Uma região viva só, com o estado atual dentro. Duas regiões — uma para
          gravar, outra para transcrever — fariam o leitor de tela anunciar a
          troca duas vezes, e a mensagem some e volta a cada render. */}
      {(ouvindo || pedindo || processando) && (
        <span
          aria-live="polite"
          className={ouvindo ? "text-sm font-medium text-ink" : "text-sm text-ink-soft"}
        >
          {ouvindo
            ? "Microfone aberto — gravando."
            : pedindo
              ? "Aguardando a liberação do microfone."
              : "Transcrevendo…"}
        </span>
      )}

      {/* Descartar existe enquanto houver o que descartar — inclusive durante a
          transcrição, que é quando a espera incomoda e a pessoa quer sair dela.
          Aqui ele aborta a requisição: nada volta para o campo. */}
      {(ouvindo || pedindo || processando) && (
        <button
          type="button"
          onClick={ditado.cancela}
          className="min-h-11 rounded-xl px-3 py-2 text-sm text-ink-soft underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Descartar
        </button>
      )}

      {ditado.aviso && (
        <p id={avisoId} role="status" className="w-full text-sm text-ink-soft">
          {ditado.aviso}
        </p>
      )}
    </div>
  );
}
