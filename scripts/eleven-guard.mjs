// ——— Nenhuma suíte automatizada sobe um servidor com a chave real ———
//
// O incidente que originou este arquivo: subi um dev server para rodar as
// suítes HTTP e não neutralizei `ELEVENLABS_API_KEY`. O `next dev` carrega o
// `.env`, e o `.env` deste projeto tem a chave de PRODUÇÃO — a mesma do secret
// do App Hosting. A suíte `test-voice-authorization`, que existe justamente
// para provar que uma fala não autorizada é recusada, atravessou a autorização
// nos casos legítimos e sintetizou quatro frases de verdade. Custou pouco e não
// vazou nada, mas o erro é de categoria: um teste automatizado gastou crédito
// e falou com um serviço externo sem ninguém ter pedido.
//
// O que torna isso fácil de repetir é que a chave não vem de quem roda o teste.
// Ela vem de um arquivo que o framework lê sozinho, e nenhum comando de teste a
// menciona. Não dá para lembrar de neutralizar uma coisa que não se vê.
//
// Então a decisão passa a ser tomada em um lugar só, no instante em que um
// servidor de teste é levantado:
//
//     sem opt-in explícito, o servidor sobe SEM provedor.
//
// ——— Por que neutralizar, e não apagar ———
//
// `ELEVENLABS_API_KEY: ""` no ambiente do processo é o mecanismo, e ele
// funciona por um detalhe do carregador do Next: `@next/env` não sobrescreve
// variáveis que JÁ existem em `process.env`, e a string vazia existe. O `.env`
// é lido e ignorado para esta chave. Do lado do produto, `provedorConfigurado()`
// faz `Boolean(process.env.ELEVENLABS_API_KEY)` — vazio é falso, e o caminho
// percorrido é exatamente o de "sem chave", que é o que as suítes esperam.
//
// Apagar do `.env` seria mexer no ambiente do usuário. Não é nosso.
//
// ——— Chaves de teste continuam permitidas ———
//
// O lote `voz-ditado` PRECISA de uma chave para que `ditadoDisponivel()` seja
// verdadeiro; ela é falsa e nunca sai para a rede (o provedor é interceptado).
// Por isso a guarda distingue quem DECLAROU a chave: o que vem herdado do
// ambiente é sempre neutralizado; o que um lote declara explicitamente passa,
// desde que se identifique como de teste. Uma chave real escrita à mão dentro
// de um lote é recusada com o servidor ainda no chão.

export const VARIAVEL_DA_CHAVE = "ELEVENLABS_API_KEY";
export const VARIAVEL_DE_OPT_IN = "HELO_ALLOW_LIVE_ELEVENLABS_TESTS";

/**
 * Uma chave é aceitável num teste quando ela não pode funcionar.
 *
 * Ausente e vazia são os casos normais. As demais precisam se anunciar: um
 * valor que contenha "teste", "fake", "mentira" ou equivalente é uma chave
 * escrita para um teste, e nenhuma chave emitida pela ElevenLabs se parece com
 * isso. A checagem é grosseira de propósito — ela não tenta reconhecer o
 * formato de uma chave real (que muda), e sim exigir que a falsa se declare.
 */
export function chaveEhDeTeste(valor) {
  if (valor === undefined || valor === null || valor === "") return true;
  return /(teste|test|fake|mentira|dummy|invalid|placeholder|xxx)/i.test(String(valor));
}

/** O operador pediu explicitamente para falar com a ElevenLabs de verdade. */
export function provedorRealLiberado(ambiente = process.env) {
  return ambiente[VARIAVEL_DE_OPT_IN] === "true";
}

/**
 * O ambiente com que um servidor de TESTE pode subir.
 *
 * `herdado` é normalmente `process.env`; `declarado` são as variáveis que o
 * lote/suíte define de propósito. Lança antes de qualquer processo nascer
 * quando alguém tenta declarar uma chave que pode ser real.
 */
export function ambienteSemProvedorReal(herdado, declarado = {}, rotulo = "suíte automatizada") {
  if (provedorRealLiberado({ ...herdado, ...declarado })) {
    // Opt-in explícito: o operador sabe o que está fazendo e assumiu o custo.
    console.warn(
      `[GUARDA] ${VARIAVEL_DE_OPT_IN}=true — ${rotulo} pode falar com a ElevenLabs de verdade.`
    );
    return { ...herdado, ...declarado };
  }

  const temDeclarada = Object.prototype.hasOwnProperty.call(declarado, VARIAVEL_DA_CHAVE);
  const declaradaValor = temDeclarada ? declarado[VARIAVEL_DA_CHAVE] : "";
  if (temDeclarada && !chaveEhDeTeste(declaradaValor)) {
    throw new Error(
      `[GUARDA] ${rotulo} declarou uma ${VARIAVEL_DA_CHAVE} que não se identifica como de teste.\n` +
        `Use um valor reconhecível (por exemplo "chave-de-teste-...") ou defina ` +
        `${VARIAVEL_DE_OPT_IN}=true se a intenção for mesmo gastar crédito.`
    );
  }

  // A chave herdada do ambiente (inclusive a que o `.env` traria) morre aqui.
  // A declarada pelo lote sobrevive porque já foi conferida acima.
  return { ...herdado, ...declarado, [VARIAVEL_DA_CHAVE]: declaradaValor ?? "" };
}

/**
 * Para scripts que recebem um servidor já de pé e não o levantam.
 *
 * Não consegue conferir o servidor do outro lado — só o ambiente de quem
 * chama. Serve para o caso em que alguém exporta a chave no shell antes de
 * rodar a suíte, que é o segundo jeito de repetir o incidente.
 */
export function assertSemChaveRealNoShell(rotulo) {
  if (provedorRealLiberado()) return;
  const valor = process.env[VARIAVEL_DA_CHAVE];
  if (chaveEhDeTeste(valor)) return;
  throw new Error(
    `[GUARDA] ${rotulo}: existe uma ${VARIAVEL_DA_CHAVE} real no ambiente.\n` +
      `Rode com ${VARIAVEL_DA_CHAVE}= (vazio) ou defina ${VARIAVEL_DE_OPT_IN}=true.`
  );
}
