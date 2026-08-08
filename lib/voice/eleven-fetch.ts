// ——— Nenhuma chamada à ElevenLabs fica pendurada (R-10) ———
//
// Até a Fase 5.1B, `/api/tts` e o token do Agent chamavam `fetch` sem prazo
// nenhum. Um provedor que aceita a conexão e nunca responde prende o handler
// até o limite da plataforma — e enquanto isso a instância (App Hosting roda
// com `maxInstances: 1`) fica ocupada. Uma lentidão da ElevenLabs virava
// indisponibilidade do Helo inteiro, inclusive da Emergência.
//
// ——— Duas formas, porque o TTS transmite ———
//
// `AbortSignal.timeout(ms)` derruba a requisição INTEIRA, corpo incluído. Para
// o token, que é um JSON curto, é o que se quer. Para o TTS não: a resposta é
// o áudio, repassado ao navegador enquanto chega. Um prazo total cortaria a
// voz do paciente no meio de uma frase — trocaríamos uma espera por uma fala
// truncada, que é pior, porque parece que a pessoa disse outra coisa.
//
// Então:
//
//   `chamaElevenLabsJson`   → prazo TOTAL (cabeçalhos + corpo). O corpo é
//                             pequeno e lido aqui dentro.
//   `chamaElevenLabsStream` → prazo até os CABEÇALHOS. Assim que a resposta
//                             começa, o relógio para e o áudio flui inteiro.
//
// O que o segundo deliberadamente NÃO cobre é um corpo que trava no meio da
// transmissão. É uma limitação conhecida e assumida: cobri-la exigiria um
// watchdog por chunk, e o preço de errar esse watchdog é cortar a fala de
// alguém. Está registrado em docs/robustez-da-voz.md.
//
// ——— Sobre logs ———
//
// Uma falha aqui rende STATUS e CATEGORIA. Nunca o corpo devolvido pelo
// provedor (que ecoa o texto enviado — e o texto de uma fala do paciente é
// conteúdo clínico), nunca o voiceId, nunca a chave.

/** Prazos por chamada. Explícitos, e cada um justificado no ponto de uso. */
export const PRAZOS_ELEVENLABS = {
  /** Síntese de fala: até os cabeçalhos. Frases curtas; 15s já é generoso. */
  tts: 15_000,
  /** Token da conversa: JSON pequeno; se demora, a sessão não vai abrir bem. */
  conversationToken: 10_000,
  /** Consulta de voz no cadastro pelo Admin: interativo, tem que ser rápido. */
  voiceLookup: 8_000,
} as const;

export type FalhaElevenLabs =
  /** Estourou o prazo — a requisição foi abortada por nós. */
  | "timeout"
  /** O fetch nem completou: DNS, conexão recusada, TLS. */
  | "network"
  /** 401/403 — credencial. NUNCA confundir com timeout. */
  | "unauthorized"
  /** 429 — cota/limite de taxa. */
  | "rateLimited"
  /** 5xx do provedor. */
  | "serverError"
  /** Demais 4xx: o pedido é que não vale (voz inexistente, parâmetro ruim). */
  | "rejected"
  /** Respondeu 2xx com um corpo que não serve. */
  | "badResponse";

export type ChamadaElevenLabs<T> =
  | { ok: true; dados: T }
  | { ok: false; falha: FalhaElevenLabs; status: number | null };

export type ChamadaElevenLabsStream =
  | { ok: true; resposta: Response }
  | { ok: false; falha: FalhaElevenLabs; status: number | null };

/** Classificação de uma resposta que chegou — só pelo status, nunca pelo corpo. */
export function classificaStatus(status: number): FalhaElevenLabs {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rateLimited";
  if (status >= 500) return "serverError";
  return "rejected";
}

function ehAbort(erro: unknown): boolean {
  const nome = (erro as { name?: string } | null)?.name;
  return nome === "AbortError" || nome === "TimeoutError";
}

/**
 * Uma linha de log com o suficiente para diagnosticar e nada além disso.
 * Existe para que o formato seja um só e ninguém acrescente o corpo "só desta
 * vez".
 */
export function registraFalhaElevenLabs(
  rotulo: string,
  falha: FalhaElevenLabs,
  status: number | null
): void {
  console.error("[ELEVENLABS] chamada falhou", { rotulo, falha, status });
}

interface OpcoesChamada {
  prazoMs: number;
  /** Aparece no log. Nome do ponto de uso, nunca conteúdo. */
  rotulo: string;
}

function relogio(prazoMs: number): { signal: AbortSignal; encerra: () => void; estourou: () => boolean } {
  const controle = new AbortController();
  let disparou = false;
  const id = setTimeout(() => {
    disparou = true;
    controle.abort();
  }, prazoMs);
  // Num runtime Node, um timer pendente atrasa o encerramento do processo.
  (id as unknown as { unref?: () => void }).unref?.();
  return {
    signal: controle.signal,
    encerra: () => clearTimeout(id),
    estourou: () => disparou,
  };
}

/**
 * Chamada com corpo JSON pequeno — prazo cobrindo cabeçalhos E leitura.
 */
export async function chamaElevenLabsJson<T>(
  url: string,
  init: RequestInit,
  opcoes: OpcoesChamada
): Promise<ChamadaElevenLabs<T>> {
  const prazo = relogio(opcoes.prazoMs);
  try {
    const resposta = await fetch(url, { ...init, signal: prazo.signal });
    if (!resposta.ok) {
      const falha = classificaStatus(resposta.status);
      registraFalhaElevenLabs(opcoes.rotulo, falha, resposta.status);
      return { ok: false, falha, status: resposta.status };
    }
    const dados = (await resposta.json()) as T;
    return { ok: true, dados };
  } catch (erro) {
    const falha: FalhaElevenLabs = prazo.estourou() || ehAbort(erro) ? "timeout" : "network";
    registraFalhaElevenLabs(opcoes.rotulo, falha, null);
    return { ok: false, falha, status: null };
  } finally {
    prazo.encerra();
  }
}

/**
 * Chamada cuja resposta é repassada adiante — prazo até os CABEÇALHOS.
 *
 * O relógio para quando o `fetch` resolve, que é exatamente o instante em que
 * os cabeçalhos chegaram. O corpo segue transmitindo sem prazo, de propósito:
 * ver o cabeçalho deste arquivo.
 */
export async function chamaElevenLabsStream(
  url: string,
  init: RequestInit,
  opcoes: OpcoesChamada
): Promise<ChamadaElevenLabsStream> {
  const prazo = relogio(opcoes.prazoMs);
  try {
    const resposta = await fetch(url, { ...init, signal: prazo.signal });
    if (!resposta.ok) {
      const falha = classificaStatus(resposta.status);
      registraFalhaElevenLabs(opcoes.rotulo, falha, resposta.status);
      return { ok: false, falha, status: resposta.status };
    }
    return { ok: true, resposta };
  } catch (erro) {
    const falha: FalhaElevenLabs = prazo.estourou() || ehAbort(erro) ? "timeout" : "network";
    registraFalhaElevenLabs(opcoes.rotulo, falha, null);
    return { ok: false, falha, status: null };
  } finally {
    // Os cabeçalhos chegaram (ou a chamada morreu): o corpo não tem prazo.
    prazo.encerra();
  }
}

/**
 * Status HTTP que o Helo devolve ao cliente para cada categoria.
 *
 * `timeout`, `serverError`, `rateLimited` e `network` viram 503: são estados
 * transitórios, e é o 503 que o cliente reconhece como "tente de novo mais
 * tarde" (ver lib/voice/eleven-availability.ts). `unauthorized` e `rejected`
 * viram 502: o provedor está no ar e recusou — insistir não adianta, e marcar
 * a ElevenLabs como indisponível por causa disso seria um diagnóstico falso.
 */
export function statusParaCliente(falha: FalhaElevenLabs): number {
  switch (falha) {
    case "timeout":
    case "serverError":
    case "rateLimited":
    case "network":
      return 503;
    default:
      return 502;
  }
}
