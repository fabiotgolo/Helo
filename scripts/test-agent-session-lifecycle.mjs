// ——— O teardown real, com o SDK simulado (R-05) ———
//
//   npm run test:agent:lifecycle
//
// A suíte irmã (`test:agent:teardown`) reproduz a máquina do provider e lê o
// fonte para impedir regressão estrutural. Isso é defesa, não prova: uma
// réplica correta não diz nada sobre o original.
//
// Aqui roda o CÓDIGO DE PRODUÇÃO — `createSdkSessionHandle` e
// `openAgentSession`, de lib/voice/agent-session-lifecycle.ts, exatamente as
// funções que components/helo-agent-provider.tsx executa. O que é simulado é
// só o que está fora do app: o SDK da ElevenLabs, o token e o registro da
// sessão. O microfone é representado por uma flag que só `endSession` abaixa —
// se ela continuar em pé no fim de um caminho de falha, é porque o microfone
// continuaria capturando.

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { createSdkSessionHandle, openAgentSession } = await import(
  "../lib/voice/agent-session-lifecycle.ts"
);

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

/**
 * O SDK da ElevenLabs, simulado. `microfoneAberto` é o fato que interessa:
 * `startSession` o levanta, e só `endSession` o abaixa.
 */
function criarSdk({ falharEmStartSession = false } = {}) {
  const sdk = {
    microfoneAberto: false,
    webrtcAberto: false,
    startSessionChamado: 0,
    endSessionChamado: 0,
    async startSession() {
      sdk.startSessionChamado++;
      if (falharEmStartSession) {
        // Falha DEPOIS de abrir o transporte — o caso perigoso: o recurso
        // existe e a promessa rejeita.
        sdk.microfoneAberto = true;
        sdk.webrtcAberto = true;
        throw new Error("LiveKit derrubou a sessão");
      }
      sdk.microfoneAberto = true;
      sdk.webrtcAberto = true;
    },
    endSession() {
      sdk.endSessionChamado++;
      sdk.microfoneAberto = false;
      sdk.webrtcAberto = false;
    },
  };
  return sdk;
}

/**
 * Monta as dependências como o provider as monta, e devolve o que for preciso
 * para inspecionar. `pacienteAtual` é uma função porque no provider é um ref:
 * ele pode mudar DURANTE a abertura.
 */
function cenario({
  falharEmStartSession = false,
  falharEmToken = false,
  falharEmRegistro = false,
  registroSemId = false,
  voiceOverrideApplied = false,
  pacienteAtual = () => 7,
} = {}) {
  const sdk = criarSdk({ falharEmStartSession });
  const avisos = [];
  const session = createSdkSessionHandle({
    endSession: () => sdk.endSession(),
    log: (m) => avisos.push(["log", m]),
    warn: (m) => avisos.push(["warn", m]),
  });
  const deps = {
    session,
    requestToken: async () => {
      if (falharEmToken) throw new Error("token indisponível");
      return { conversationToken: "tok", voiceOverrideApplied };
    },
    startConversation: async () => {
      await sdk.startSession();
    },
    requestedPatientId: 7,
    currentPatientId: pacienteAtual,
    startLoggedSession: async () => {
      if (falharEmRegistro) throw new Error("500 ao registrar a sessão");
      return { id: registroSemId ? null : 42 };
    },
  };
  return { sdk, session, deps, avisos };
}

console.log("\n1–6. O WebRTC abre e o registro da sessão falha:");
{
  const c = cenario({ falharEmRegistro: true });
  const resultado = await openAgentSession(c.deps);

  check("1. o SDK/WebRTC chegou a abrir", c.sdk.startSessionChamado === 1);
  check(
    "2–3. a falha do registro cai no caminho de erro real da função",
    resultado.ok === false && resultado.reason === "failed",
    JSON.stringify(resultado)
  );
  check("4. endSession foi chamado no teardown", c.sdk.endSessionChamado === 1);
  check("5. o estado local não indica mais sessão aberta", c.session.isOpen() === false);
  check(
    "6. o microfone e o WebRTC foram liberados",
    c.sdk.microfoneAberto === false && c.sdk.webrtcAberto === false,
    "— o recurso continuaria capturando"
  );
  check(
    "…e o erro original chega a quem chamou, para virar mensagem na tela",
    resultado.ok === false && resultado.error instanceof Error &&
      /registrar a sessão/.test(resultado.error.message)
  );
  check(
    "…e o encerramento foi registrado no log",
    c.avisos.some(([nivel, m]) => nivel === "log" && /microfone liberado/.test(m))
  );
}

console.log("\n7. Depois da falha, uma nova tentativa conecta:");
{
  const c = cenario({ falharEmRegistro: true });
  await openAgentSession(c.deps);

  // Mesmo handle, mesma sessão do provider: é o retry real, não um cenário
  // novo. Se o teardown tivesse deixado o handle "aberto", a guarda de
  // reentrada do provider (`sdkSession.isOpen()`) recusaria esta chamada.
  check("o handle permite reentrar", c.session.isOpen() === false);
  c.deps.startLoggedSession = async () => ({ id: 43 });
  const segunda = await openAgentSession(c.deps);
  check(
    "7. a segunda tentativa abre e registra",
    segunda.ok === true && segunda.loggedSessionId === 43,
    JSON.stringify(segunda)
  );
  check("…com o microfone ativo na sessão nova", c.sdk.microfoneAberto === true);
  check("…e sem endSession a mais", c.sdk.endSessionChamado === 1);
}

console.log("\n8. Logout/unmount enquanto a abertura está em andamento:");
{
  // O provider chama `end()` → `sdkSession.release()` de fora, sem saber em
  // que ponto a abertura está. É o caminho de saída mais perigoso, porque
  // ninguém ali sabe se existe recurso aberto.
  let liberarRegistro;
  const c = cenario();
  c.deps.startLoggedSession = () =>
    new Promise((resolve) => { liberarRegistro = () => resolve({ id: 44 }); });

  const emAndamento = openAgentSession(c.deps);
  await new Promise((r) => setTimeout(r, 0)); // deixa a abertura chegar ao registro
  check("o recurso está aberto neste instante", c.sdk.microfoneAberto === true);

  c.session.release(); // logout
  check("8. o logout libera o microfone imediatamente", c.sdk.microfoneAberto === false);
  check("…e o handle deixa de indicar sessão aberta", c.session.isOpen() === false);

  liberarRegistro();
  await emAndamento;
  check(
    "…e a abertura terminando depois não reabre nada",
    c.sdk.microfoneAberto === false && c.sdk.startSessionChamado === 1
  );
}

console.log("\nOs outros caminhos de falha:");
{
  const antes = cenario({ falharEmToken: true });
  const r1 = await openAgentSession(antes.deps);
  check(
    "falha ANTES de abrir: nada a encerrar, e endSession não é chamado à toa",
    r1.ok === false && antes.sdk.endSessionChamado === 0 && antes.sdk.microfoneAberto === false
  );

  const durante = cenario({ falharEmStartSession: true });
  const r2 = await openAgentSession(durante.deps);
  check(
    "falha DENTRO de startSession, com o transporte já aberto",
    r2.ok === false && durante.sdk.microfoneAberto === false,
    "— startSession rejeitou depois de abrir e ninguém fechou"
  );

  // A troca de paciente no meio da abertura: a sessão pertence a outro
  // contexto e precisa morrer aqui, não virar uma sessão órfã do paciente
  // errado — que é como uma fala acabaria atribuída a quem não a fez.
  let atual = 7;
  const troca = cenario({ pacienteAtual: () => atual });
  troca.deps.startConversation = async () => {
    await troca.sdk.startSession();
    atual = 9; // o cuidador trocou de paciente durante a conexão
  };
  const r3 = await openAgentSession(troca.deps);
  check(
    "troca de paciente durante a abertura: recurso liberado",
    r3.ok === false && r3.reason === "patientChanged" &&
      troca.sdk.endSessionChamado === 1 && troca.sdk.microfoneAberto === false,
    JSON.stringify(r3)
  );
  check(
    "…e a sessão do outro paciente nunca chega a ser registrada",
    r3.ok === false
  );

  // Retry sem override de voz: a primeira tentativa pode ter aberto o
  // transporte antes de falhar, e nesse instante ainda não houve markOpen.
  const retry = cenario({ voiceOverrideApplied: true });
  let tentativas = 0;
  retry.deps.startConversation = async () => {
    tentativas++;
    if (tentativas === 1) {
      retry.sdk.microfoneAberto = true;
      throw new Error("override recusado");
    }
    await retry.sdk.startSession();
  };
  const r4 = await openAgentSession(retry.deps);
  check(
    "retry sem override: a tentativa abortada não deixa recurso para trás",
    r4.ok === true && retry.sdk.endSessionChamado === 1 && tentativas === 2,
    JSON.stringify({ ...r4, endSession: retry.sdk.endSessionChamado, tentativas })
  );
  check("…e a sessão final está viva", retry.sdk.microfoneAberto === true);

  // Sem override aplicado, o erro NÃO é engolido por um retry — comportamento
  // que já existia e continua valendo.
  const semOverride = cenario({ voiceOverrideApplied: false, falharEmStartSession: true });
  const r5 = await openAgentSession(semOverride.deps);
  check(
    "sem override, a falha não vira retry silencioso",
    r5.ok === false && semOverride.sdk.startSessionChamado === 1
  );
}

console.log("\nIdempotência e limites do teardown:");
{
  const c = cenario();
  await openAgentSession(c.deps);
  check("a sessão bem-sucedida deixa o recurso aberto", c.sdk.microfoneAberto === true);
  c.session.release();
  c.session.release();
  c.session.release();
  check(
    "encerrar três vezes encerra uma vez só",
    c.sdk.endSessionChamado === 1 && c.sdk.microfoneAberto === false
  );

  // O SDK caindo sozinho (onDisconnect/onError): o recurso já não existe, e
  // insistir em fechá-lo só produziria ruído.
  const caiu = cenario();
  await openAgentSession(caiu.deps);
  caiu.session.markClosed();
  caiu.session.release();
  check(
    "SDK que caiu sozinho não recebe endSession redundante",
    caiu.sdk.endSessionChamado === 0 && caiu.session.isOpen() === false
  );

  // endSession que lança (a sessão já caiu do outro lado) não pode derrubar o
  // teardown: o estado local precisa ficar limpo de qualquer forma.
  const explode = cenario();
  await openAgentSession(explode.deps);
  explode.sdk.endSession = () => { throw new Error("já estava fechada"); };
  explode.session.release();
  check(
    "endSession que lança não impede o estado local de ficar limpo",
    explode.session.isOpen() === false &&
      explode.avisos.some(([nivel]) => nivel === "warn")
  );
}

console.log("\nO registro sem id não é tratado como falha (comportamento existente):");
{
  // `startLoggedSession` do app NÃO lança: devolve `{ id: null }` quando o
  // /api/sessions falha. A sessão então segue aberta e sem registro. Este teste
  // não aprova nem corrige isso — documenta que o comportamento é o mesmo de
  // antes da extração, para que uma mudança futura apareça como mudança.
  const c = cenario({ registroSemId: true });
  const r = await openAgentSession(c.deps);
  check(
    "sessão sem id de registro continua aberta, como antes",
    r.ok === true && r.loggedSessionId === null && c.sdk.microfoneAberto === true,
    JSON.stringify(r)
  );
}

console.log("\nO provider usa este módulo (e não uma cópia dele):");
{
  const { readFileSync } = await import("node:fs");
  const fonte = readFileSync("components/helo-agent-provider.tsx", "utf8");
  const codigo = fonte
    .split("\n")
    .filter((linha) => !/^\s*(\/\/|\*|\/\*)/.test(linha))
    .join("\n");

  check(
    "importa o ciclo de vida de lib/voice/agent-session-lifecycle",
    /from "@\/lib\/voice\/agent-session-lifecycle"/.test(codigo)
  );
  check(
    "connect() abre a sessão por openAgentSession",
    /const aberta = await openAgentSession\(\{[\s\S]{0,400}?session: sdkSession,/.test(codigo),
    "— a sequência voltou a ser escrita à mão no componente"
  );
  check(
    "o handle é criado uma vez e é ele quem guarda o recurso",
    /createSdkSessionHandle\(\{/.test(codigo) && !/sdkSessionOpenRef/.test(codigo)
  );
  check(
    "o teardown do provider delega ao handle",
    /const releaseSdkSession = useCallback\(\(\) => \{\s*sdkSession\.release\(\);/.test(codigo)
  );
  check(
    "end() chama o teardown sem perguntar por startedRef",
    /const end = useCallback\(\(\) => \{[\s\S]{0,400}?releaseSdkSession\(\);/.test(codigo) &&
      !/if \(wasStarted\) endSession\(\)/.test(codigo)
  );
  check(
    "a guarda de reentrada olha o recurso, não só a sessão de produto",
    /sdkSession\.isOpen\(\) \|\|\s*\n?\s*statusRef\.current !== "disconnected"/.test(codigo)
  );
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
