// ——— Da autorização ao áudio: buscar, cancelar, guardar ———
//
// Este módulo é o que `useSpeech` executa entre "quero falar isto" e "tenho um
// áudio para tocar": consultar o cache, pedir o SpeechGrant quando a fala é do
// paciente, chamar /api/tts, e guardar o resultado com dono.
//
// Ele vive fora do React por dois motivos. O primeiro é que nada aqui precisa
// de React. O segundo é o que importa: os riscos que a Fase 5.1B fecha —
// ObjectURL órfão, resposta atrasada tocando por cima da fala nova, uma 503
// desligando a voz para sempre — são todos comportamentos de sequência, e
// sequência se prova com teste. `npm run test:voice:cancel` roda ESTA função,
// não uma equivalente.
//
// ——— O que "cancelar" significa aqui ———
//
// Duas coisas ao mesmo tempo, e as duas são necessárias:
//
//   1. **Abortar** (AbortSignal) — a requisição em curso é derrubada. Sem
//      isso, o servidor termina de sintetizar um áudio que ninguém vai ouvir,
//      e a resposta ainda chega para ser descartada.
//   2. **Invalidar** (`aindaVale`) — a fala tem uma geração, e uma geração
//      antiga nunca vence a nova. O abort é uma corrida contra a rede; a
//      invalidação é uma decisão local, e ela não pode perder.
//
// Depois de CADA await o resultado é reconferido. É repetitivo de propósito:
// cada await é um ponto onde o mundo pode ter mudado, e a fala antiga que
// atravessasse um deles tocaria por cima da nova.
//
// Uma resposta que chega depois do cancelamento ainda entra no cache — o áudio
// é legítimo, foi autorizado para aquele paciente e aquele texto, e guardá-lo
// é o que impede o ObjectURL de ficar órfão. O que ela não faz é tocar.

import { audioCacheKey, type SpeechSourceRef } from "@/lib/voice";
import type { AudioCache, AudioCacheEntry } from "@/lib/voice/audio-cache";
import type { DisponibilidadeElevenLabs } from "@/lib/voice/eleven-availability";
import type { ConfirmationStatus, SpeakerRole } from "@/lib/types";
import type { VoiceSource } from "@/lib/voice";

export interface FonteDeAudioDeps {
  cache: AudioCache;
  disponibilidade: DisponibilidadeElevenLabs;
  /** Injetáveis para o teste de domínio; em produção são os do navegador. */
  fetchImpl?: typeof fetch;
  criaObjectURL?: (blob: Blob) => string;
  log?: (mensagem: string, detalhe?: unknown) => void;
}

export interface PedidoDeAudio {
  text: string;
  speakerRole: SpeakerRole;
  confirmationStatus: ConfirmationStatus;
  patientId: number | null;
  source?: SpeechSourceRef;
  /** Grant já emitido por quem chamou (ex.: devolvido por /api/messages). */
  grant?: string;
  /** Derrubado por stop(): aborta grant e TTS em curso. */
  signal?: AbortSignal;
  /**
   * Esta fala ainda é a mais recente? Consultado depois de cada await. Uma
   * fala que deixou de valer não toca, aconteça o que acontecer com a rede.
   */
  aindaVale: () => boolean;
}

export type MotivoSemAudio =
  /** stop(), troca de fala ou abort — não é falha de nada. */
  | "cancelada"
  /** Sem grant, sem origem, ou o servidor recusou a autorização. */
  | "semAutorizacao"
  /** Prazo de indisponibilidade em curso — nem tentamos. */
  | "indisponivel"
  /** A síntese não veio (rede, 5xx, resposta inválida). */
  | "falhou";

export type ResultadoDeAudio =
  | { ok: true; entrada: AudioCacheEntry; doCache: boolean }
  | { ok: false; motivo: MotivoSemAudio };

function ehAbort(erro: unknown): boolean {
  return erro instanceof DOMException
    ? erro.name === "AbortError"
    : (erro as { name?: string } | null)?.name === "AbortError";
}

/**
 * Pede ao servidor a autorização para uma fala do paciente. A tela nomeia um
 * RECURSO; o servidor responde com o texto daquele recurso e o grant que o
 * autoriza. O texto devolvido é o que será sintetizado — se divergir do que a
 * tela tinha em mãos, quem manda é o servidor.
 *
 * Uma recusa aqui NUNCA marca a ElevenLabs como indisponível: um grant negado
 * diz que o pedido não vale, não que o provedor caiu.
 */
async function pedeAutorizacao(
  patientId: number,
  source: SpeechSourceRef,
  deps: Required<Pick<FonteDeAudioDeps, "fetchImpl" | "log">>,
  signal?: AbortSignal
): Promise<{ grant: string; text: string } | null> {
  try {
    const res = await deps.fetchImpl("/api/voice/grant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId, source }),
      signal,
    });
    if (!res.ok) {
      deps.log("[VOZ] autorização de fala do paciente negada:", res.status);
      return null;
    }
    const data = (await res.json()) as { grant?: string; text?: string };
    return data.grant && data.text ? { grant: data.grant, text: data.text } : null;
  } catch (erro) {
    if (ehAbort(erro)) return null;
    deps.log("[VOZ] falha ao pedir autorização de fala:", (erro as Error)?.message ?? erro);
    return null;
  }
}

/**
 * Resolve a autoria e busca (ou reaproveita) o áudio ElevenLabs da fala.
 * Nunca devolve áudio de outro paciente: a chave de cache inclui papel e
 * paciente, e quem chama já validou o patientId contra o paciente ativo.
 *
 * Para a voz do paciente, o grant é obtido AQUI e só no MISS de cache: um
 * acerto já foi autorizado quando o áudio entrou, e a Emergência não pode
 * pagar um round-trip a cada toque.
 */
export async function buscaAudioDaFala(
  pedido: PedidoDeAudio,
  deps: FonteDeAudioDeps
): Promise<ResultadoDeAudio> {
  // `fetch` PRECISA do bind. Guardado numa variável e chamado como
  // `fetchImpl(...)`, o `this` deixa de ser a `window` e o navegador recusa
  // com "Illegal invocation" — toda fala do paciente morria antes de sair.
  // O Node não se importa com o `this`, então a suíte de domínio passava
  // verde; quem pegou isto foi o teste de navegador (tests/e2e/voz-robustez).
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  const criaObjectURL = deps.criaObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const log = deps.log ?? (() => {});
  const { cache, disponibilidade } = deps;
  const { text, speakerRole, confirmationStatus, patientId, signal } = pedido;

  const chave = audioCacheKey(speakerRole, patientId, text);
  const emCache = cache.get(chave);
  if (emCache) return { ok: true, entrada: emCache, doCache: true };

  // Prazo de indisponibilidade em curso: nem tentamos. Isto NÃO é o estado
  // permanente que a 5.1B removeu — ver lib/voice/eleven-availability.ts.
  if (!disponibilidade.podeTentar()) return { ok: false, motivo: "indisponivel" };

  // Autorização da fala do paciente. Sem ela nem tentamos sintetizar — o
  // servidor recusaria de qualquer forma, e falhar aqui deixa o motivo legível
  // no lugar certo.
  let speechText = text;
  let grant = pedido.grant;
  if (speakerRole === "patient" && !grant) {
    if (!pedido.source || patientId == null) {
      log("[VOZ] fala do paciente sem origem nem grant — bloqueada");
      return { ok: false, motivo: "semAutorizacao" };
    }
    const autorizada = await pedeAutorizacao(
      patientId,
      pedido.source,
      { fetchImpl, log },
      signal
    );
    // Interrompida durante a autorização: nenhuma síntese é pedida. Este é o
    // ponto em que o cancelamento economiza a chamada paga inteira.
    if (!pedido.aindaVale()) return { ok: false, motivo: "cancelada" };
    if (!autorizada) return { ok: false, motivo: "semAutorizacao" };
    grant = autorizada.grant;
    speechText = autorizada.text;
  }

  let res: Response;
  try {
    res = await fetchImpl("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: speechText,
        speakerRole,
        confirmationStatus,
        patientId: speakerRole === "patient" ? patientId : undefined,
        grant,
      }),
      signal,
    });
  } catch (erro) {
    // Abortar é o cancelamento funcionando, não o provedor caindo: um stop()
    // não pode marcar a ElevenLabs como degradada.
    if (ehAbort(erro) || !pedido.aindaVale()) return { ok: false, motivo: "cancelada" };
    disponibilidade.registraFalha(null);
    log("[VOZ] falha de rede no TTS:", (erro as Error)?.message ?? erro);
    return { ok: false, motivo: "falhou" };
  }

  if (!res.ok) {
    // 502/503/504 abrem prazo; 400/401/403/422 não — são sobre o PEDIDO.
    const degradou = disponibilidade.registraFalha(res.status);
    log("[VOZ] TTS recusou:", { status: res.status, degradou });
    return { ok: false, motivo: degradou ? "indisponivel" : "falhou" };
  }

  disponibilidade.registraSucesso();

  const source =
    (res.headers.get("X-Voice-Source") as VoiceSource | null) ??
    (speakerRole === "patient" ? "patientElevenLabsClone" : "heloElevenLabs");
  const entrada: AudioCacheEntry = { url: criaObjectURL(await res.blob()), source };

  // Guardado sob o texto que REALMENTE soou. Quando o servidor devolveu um
  // texto diferente do que a tela tinha, é o dele que vale — e é ele que
  // precisa ser encontrado no próximo acerto. As duas chaves apontam para o
  // mesmo URL; o cache conta as referências e só revoga quando a última sai.
  cache.set(chave, entrada);
  if (speechText !== text) {
    cache.set(audioCacheKey(speakerRole, patientId, speechText), entrada);
  }

  // A resposta chegou depois do cancelamento. O áudio fica no cache — tem
  // dono, será revogado na hora certa e serve à próxima fala igual —, mas não
  // toca: a fala nova já ganhou.
  if (!pedido.aindaVale()) return { ok: false, motivo: "cancelada" };

  return { ok: true, entrada, doCache: false };
}
