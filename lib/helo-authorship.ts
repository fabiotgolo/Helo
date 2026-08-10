// ——— A role do provedor não é a autoria do Helo (Fase 5.3C / R-08) ———
//
// A auditoria da 5.3A encontrou QUATRO origens humanas diferentes chegando à
// ElevenLabs com a mesma role `user`, separadas apenas por um prefixo em
// português dentro do texto:
//
//   voz do cuidador no microfone da sessão
//   texto digitado no campo "Mensagem para a Helo"
//   gesto do paciente, tocado na tela pelo cuidador
//   instrução interna pedindo que a Helo leia uma pergunta em voz alta
//
// Um comentário do código chegava a chamar a primeira de "patient speech", o
// que é factualmente errado: quem fala ao microfone daquela sessão é o
// cuidador. Nenhum caminho transformava essa confusão em fala ou consentimento
// do paciente — isso é barrado pelo gate de classe, não pela role — mas a
// nomenclatura era uma armadilha para quem fosse mexer aqui depois.
//
// ——— A correção, e o que ela conscientemente NÃO faz ———
//
// O SDK da ElevenLabs oferece duas roles: `user` e `agent`. Não vamos inventar
// roles que ele não tem, nem sobrescrever o dado externo para fingir uma
// distinção que o provedor não faz. `providerRole` continua sendo o que o
// provedor disse.
//
// O que passa a existir é uma camada LOCAL: `HeloSource`, derivada de onde o
// turno realmente nasceu dentro do Helo. As duas convivem lado a lado, e é a
// segunda que responde perguntas de autoria.
//
//   providerRole  o que a ElevenLabs vê
//   source        o que aconteceu no Helo
//
// ——— Autoria não é autoridade ———
//
// Nenhuma origem desta lista concede ao Agent o direito de executar coisa
// alguma. A decisão de autoridade continua sendo só do gate, sobre a CLASSE da
// ação (lib/helo-action-registry.ts). Este módulo existe para que o Helo saiba
// dizer QUEM falou — não para que alguém use isso como permissão.
//
// ——— Compatibilidade externa ———
//
// Os prefixos em português continuam saindo no texto: o system prompt do
// painel da ElevenLabs não foi auditado, e pode depender deles para não
// confundir uma observação do acompanhante com uma fala do paciente. Eles
// ficam AQUI, isolados, e a semântica interna não depende mais deles: quem
// pergunta a origem lê `source`, nunca o texto.

/** O que o provedor diz. Duas roles, porque é o que o SDK oferece. */
export type HeloProviderRole = "user" | "agent";

/**
 * De onde o turno nasceu, dentro do Helo.
 *
 * `patientGestureReport` é o nome mais importante da lista, e o mais delicado:
 * é o cuidador RELATANDO ao Agent um gesto que o paciente fez na tela. Não é o
 * paciente falando — é uma observação sobre ele, feita por outra pessoa. Ela
 * não vira consentimento, não vira `ConfirmedPatientStatement` e não abre
 * nenhuma ação: as ações de gesto são `patientResponse` e continuam recusadas
 * ao Agent, venha o pedido de onde vier.
 */
export type HeloSource =
  | "caregiverVoice"
  | "caregiverText"
  | "patientGestureReport"
  | "systemInstruction"
  | "agent";

export interface HeloTurnOrigin {
  readonly providerRole: HeloProviderRole;
  readonly source: HeloSource;
}

/**
 * A role que a ElevenLabs recebe para cada origem. Todas as origens humanas
 * são `user` porque é o único canal de entrada que o SDK tem — e é exatamente
 * por isso que a role não serve para dizer quem falou.
 */
const ROLE_DE: Record<HeloSource, HeloProviderRole> = {
  caregiverVoice: "user",
  caregiverText: "user",
  patientGestureReport: "user",
  systemInstruction: "user",
  agent: "agent",
};

export function origemDoTurno(source: HeloSource): HeloTurnOrigin {
  return { providerRole: ROLE_DE[source], source };
}

/**
 * Classifica um evento RECEBIDO do provedor.
 *
 * `user` significa uma coisa só: entrou pelo microfone da sessão do Agent. E o
 * microfone daquela sessão é o do cuidador — a sessão é aberta por ele, na
 * tela dele, com o dispositivo que ele escolheu em "Microfone". Chamar isso de
 * fala do paciente era o erro do R-08.
 *
 * Turnos que o próprio Helo injeta não passam por aqui: eles já nascem com a
 * origem declarada em `origemDoTurno`.
 */
export function origemRecebida(providerRole: string): HeloTurnOrigin {
  return providerRole === "agent"
    ? { providerRole: "agent", source: "agent" }
    : { providerRole: "user", source: "caregiverVoice" };
}

/** Quem, no mundo real, produziu este turno. Nunca o paciente. */
export function ehDoCuidador(source: HeloSource): boolean {
  return (
    source === "caregiverVoice" ||
    source === "caregiverText" ||
    source === "patientGestureReport"
  );
}

/**
 * Alguma origem representa FALA DO PACIENTE?
 *
 * Não. Nenhuma. A função existe para que a resposta seja uma linha de código
 * verificável por teste, e não uma afirmação num comentário — foi um
 * comentário errado que originou o R-08.
 *
 * A fala do paciente tem um caminho próprio e muito mais estreito: um
 * `SpeechGrant` emitido pelo servidor (Fase 5.1A), a partir de um toque humano
 * na tela. Ela nunca nasce de um turno de conversa.
 */
export function ehFalaDoPaciente(source: HeloSource): boolean {
  // Escrito como uma varredura do conjunto inteiro, e não como `return false`,
  // para que acrescentar uma origem nova exija passar por esta linha.
  return ([] as HeloSource[]).includes(source);
}

// ——— Os prefixos, isolados ———
//
// Só o texto que sai muda com eles. `source` não. Se o painel da ElevenLabs
// vier a não precisar mais deles, apagar daqui não altera semântica nenhuma
// dentro do Helo — que é justamente o critério de fechamento do R-08.

export function textoParaOProvedor(source: HeloSource, conteudo: string): string {
  switch (source) {
    case "caregiverText":
      return `Mensagem escrita pelo acompanhante: "${conteudo}". Responda diretamente ao acompanhante em voz, de forma breve e adequada ao contexto atual.`;
    case "systemInstruction":
      return `Leia agora para o paciente, com a voz da Helo, exatamente esta pergunta e nada mais: "${conteudo}"`;
    case "patientGestureReport":
    case "caregiverVoice":
    case "agent":
      return conteudo;
  }
}

export function contextoParaOProvedor(source: HeloSource, conteudo: string): string {
  switch (source) {
    case "caregiverText":
      return `Observação do acompanhante em tempo real: ${conteudo}`;
    case "systemInstruction":
      return `Pergunta atual dirigida ao paciente: "${conteudo}". A próxima fala deve ser a Helo lendo essa pergunta para o paciente, sem explicar nem responder por ele.`;
    default:
      return conteudo;
  }
}
