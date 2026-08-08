// ——— O ciclo de vida da sessão WebRTC do Agent (R-05) ———
//
// Este módulo existe por um motivo específico: o defeito do R-05 mora numa
// SEQUÊNCIA — abrir o recurso externo, registrar a sessão de produto, e o que
// acontece quando o segundo passo falha depois do primeiro. Enquanto essa
// sequência vivia inteira dentro do componente React, amarrada ao hook do SDK
// da ElevenLabs, a única forma de testá-la era reescrevê-la no teste. E um
// teste que reescreve o código prova que a CÓPIA está correta.
//
// O que está aqui é exatamente o que o provider passa a executar, com as
// dependências injetadas. O teste roda esta função.
//
// ——— A distinção que originou o defeito ———
//
//   "o recurso externo está aberto"  ≠  "a sessão de produto foi registrada"
//
// O microfone pertence ao primeiro fato. Encerrá-lo pelo segundo — que era o
// que `if (wasStarted) endSession()` fazia — deixava uma janela em que o
// WebRTC estava aberto, o microfone capturando, e nenhum caminho de interface
// conseguia fechá-lo: nem o botão "Encerrar conversa", porque ele também
// perguntava pelo registro em vez de perguntar pelo recurso.

/**
 * O recurso externo, e só ele. Não sabe nada sobre sessão de produto, log,
 * paciente ou estado de tela — é essa ignorância que torna o teardown
 * confiável.
 */
export interface SdkSessionHandle {
  /** O recurso externo existe agora? */
  isOpen(): boolean;
  /**
   * O recurso passou a existir. Chamado imediatamente depois de `startSession`
   * resolver — antes de qualquer outra coisa que possa falhar.
   */
  markOpen(): void;
  /**
   * O SDK fechou por conta própria (onDisconnect/onError). Zera o registro sem
   * chamar `endSession` de novo: insistir em encerrar o que já caiu só produz
   * ruído no log.
   */
  markClosed(): void;
  /**
   * Fecha o recurso, se estiver aberto. Idempotente e seguro de chamar em
   * qualquer caminho de saída — inclusive nos que não sabem em que ponto a
   * falha ocorreu, que são justamente os que importam.
   *
   * `force` ignora o registro e encerra assim mesmo. Existe para um caso real:
   * quando `startSession` REJEITA, pode ter aberto o transporte antes de
   * falhar, e nesse instante ainda não houve `markOpen`. Fechar à toa custa um
   * `endSession` inócuo; não fechar custa um microfone aberto.
   */
  release(options?: { force?: boolean }): void;
  /**
   * Aponta o handle para o `endSession` atual do SDK.
   *
   * Existe porque o handle é criado uma vez e `endSession` vem de um hook, que
   * devolve uma função nova a cada render. Ligar depois é seguro por
   * construção: o handle só precisa de `endSession` depois de `markOpen`, e
   * `markOpen` só acontece dentro de uma abertura iniciada por uma pessoa —
   * muito depois do primeiro render.
   */
  bindEndSession(endSession: () => void): void;
}

export interface SdkSessionHandleDeps {
  /** `endSession` do SDK. Pode lançar se a sessão já caiu — é tratado aqui. */
  endSession?: () => void;
  log?: (message: string, detail?: unknown) => void;
  warn?: (message: string, detail?: unknown) => void;
}

export function createSdkSessionHandle(deps: SdkSessionHandleDeps = {}): SdkSessionHandle {
  let open = false;
  let endSession =
    deps.endSession ??
    (() => {
      // Só alcançável se algo tentar encerrar antes de o SDK existir. Não é
      // silencioso: um recurso que ninguém sabe fechar é o defeito do R-05.
      deps.warn?.("[HELO AUDIO] teardown sem SDK ligado ao handle");
    });
  return {
    bindEndSession: (fn) => {
      endSession = fn;
    },
    isOpen: () => open,
    markOpen: () => {
      open = true;
    },
    markClosed: () => {
      open = false;
    },
    release: (options) => {
      if (!open && !options?.force) return;
      open = false;
      try {
        endSession();
        deps.log?.("[HELO AUDIO] sessão do SDK encerrada (microfone liberado)");
      } catch (caught) {
        // A sessão pode já ter caído sozinha; o estado local segue limpo.
        deps.warn?.("[HELO AUDIO] endSession falhou no teardown", caught);
      }
    },
  };
}

/** O mínimo que a abertura precisa saber do token — o resto é do provider. */
export interface AgentSessionToken {
  voiceOverrideApplied?: boolean;
}

export interface OpenAgentSessionDeps<TToken extends AgentSessionToken> {
  session: SdkSessionHandle;
  /** Pede o conversation token ao servidor. */
  requestToken: (disableVoiceOverride: boolean) => Promise<TToken>;
  /** Abre a sessão WebRTC com o SDK. */
  startConversation: (token: TToken) => Promise<void>;
  /** O paciente para quem esta sessão foi pedida. */
  requestedPatientId: number;
  /** O paciente ativo AGORA — pode ter mudado durante a abertura. */
  currentPatientId: () => number | null;
  /**
   * Registra a sessão de produto — o passo depois do qual o recurso já existe.
   *
   * `id: null` significa "não consegui registrar": hoje a sessão SEGUE aberta
   * nesse caso, com o microfone vivo e sem registro. É o comportamento que já
   * existia e não muda aqui; mudá-lo seria decidir, de passagem, que uma
   * conversa sem log deve ser interrompida — uma decisão de produto, não de
   * teardown. Está anotado para não passar por descuido.
   */
  startLoggedSession: (patientId: number) => Promise<{ id: number | null }>;
}

export type OpenAgentSessionResult =
  | { ok: true; loggedSessionId: number | null }
  | { ok: false; reason: "patientChanged" }
  | { ok: false; reason: "failed"; error: unknown };

/**
 * Abre a sessão do Agent. Nunca lança: todo caminho de saída passa pelo
 * teardown antes de devolver, e é isso que o chamador ganha ao delegar.
 *
 * A ordem é a garantia. `markOpen()` acontece assim que `startSession`
 * resolve, ANTES de qualquer passo que possa falhar — porque a partir dali o
 * microfone está capturando, e o teardown não pode depender de nada que venha
 * depois.
 */
export async function openAgentSession<TToken extends AgentSessionToken>(
  deps: OpenAgentSessionDeps<TToken>
): Promise<OpenAgentSessionResult> {
  const { session } = deps;
  // Houve alguma TENTATIVA de abrir o transporte? É diferente de "o recurso
  // está aberto": entre uma coisa e outra existe a janela em que
  // `startConversation` rejeita DEPOIS de o microfone já estar capturando, e
  // nela `markOpen` ainda não aconteceu. Só o encerramento forçado alcança
  // essa janela — e forçar sem ter tentado nada chamaria `endSession` à toa.
  let tentouAbrir = false;
  try {
    // O LiveKit aceita a sessão, mas derruba o socket poucos segundos depois
    // quando recebe o override de voz remoto. A voz oficial configurada no
    // próprio Agent continua sendo usada; não enviamos override por sessão.
    let token = await deps.requestToken(true);
    try {
      tentouAbrir = true;
      await deps.startConversation(token);
    } catch (caught) {
      if (!token.voiceOverrideApplied) throw caught;
      session.release({ force: true });
      token = await deps.requestToken(true);
      tentouAbrir = true;
      await deps.startConversation(token);
    }
    // A PARTIR DAQUI o recurso externo existe: WebRTC aberto, microfone
    // capturando. Marcar neste ponto exato é a correção do R-05.
    session.markOpen();

    if (deps.currentPatientId() !== deps.requestedPatientId) {
      // O paciente trocou durante a abertura: a sessão que abriu pertence a
      // outro contexto e precisa morrer aqui, não virar uma sessão órfã.
      session.release();
      return { ok: false, reason: "patientChanged" };
    }

    const logged = await deps.startLoggedSession(deps.requestedPatientId);
    return { ok: true, loggedSessionId: logged.id };
  } catch (error) {
    // O caminho que existia antes: startSession resolvia, o WebRTC abria e o
    // microfone começava a capturar; startLoggedSession então falhava (rede,
    // 500) e caíamos aqui — `startedRef` era zerado e `endSession()` nunca era
    // chamado. Agora quem decide o teardown é o FATO de o recurso estar
    // aberto, não o registro da sessão de produto.
    //
    // O `force` cobre a variante que sobrou depois da 5.1A: `startConversation`
    // rejeitando com o microfone já capturando. Ali o recurso existe e o
    // registro não, então o teardown baseado no registro não o alcançava — a
    // mesma confusão do R-05, um passo antes.
    session.release({ force: tentouAbrir });
    return { ok: false, reason: "failed", error };
  }
}
