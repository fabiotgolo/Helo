// ——— Nenhuma falha deixa o microfone aberto (Fase 5.1A / R-05) ———
//
// O defeito, comprovado na auditoria 5.0: `startSession()` resolvia, o WebRTC
// abria e o microfone começava a capturar; `startLoggedSession()` então falhava
// (rede, 500) e o catch de `connect()` zerava `startedRef` SEM chamar
// `endSession()`. Como `end()` só encerrava `if (wasStarted)`, nem o botão
// "Encerrar conversa" fechava. O microfone ficava aberto até recarregar a
// página — sem nenhum caminho de interface para pará-lo.
//
//   npm run test:agent:teardown
//
// A causa raiz era tratar dois fatos diferentes como um só:
//
//   "o recurso externo está aberto"  ≠  "a sessão de produto foi registrada"
//
// Este teste reproduz a máquina de connect()/end() com os mesmos refs e a
// mesma ordem do provider, e falha se o teardown voltar a depender do registro
// da sessão em vez do recurso.

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
 * Réplica da máquina do provider. A ordem das operações é a mesma de
 * components/helo-agent-provider.tsx — se ela mudar lá, este teste passa a
 * mentir, e por isso o commit que a mudar precisa mexer aqui também.
 */
function criarSessao({ falharEm } = {}) {
  const mundo = {
    microfoneAberto: false,
    endSessionChamado: 0,
    logs: [],
  };
  const refs = { sdkSessionOpen: false, started: false, starting: false, status: "disconnected" };

  const sdk = {
    async startSession() {
      if (falharEm === "startSession") throw new Error("WebRTC recusou");
      mundo.microfoneAberto = true;
      refs.status = "connected";
    },
    endSession() {
      mundo.endSessionChamado++;
      mundo.microfoneAberto = false;
      refs.status = "disconnected";
    },
  };

  const releaseSdkSession = () => {
    if (!refs.sdkSessionOpen) return;
    refs.sdkSessionOpen = false;
    try {
      sdk.endSession();
    } catch {
      /* já caiu sozinha */
    }
  };

  const end = () => {
    releaseSdkSession();
  };

  async function connect() {
    if (refs.starting || refs.started || refs.sdkSessionOpen || refs.status !== "disconnected") {
      return false;
    }
    refs.starting = true;
    try {
      if (falharEm === "token") throw new Error("token indisponível");
      await sdk.startSession();
      refs.sdkSessionOpen = true; // o recurso existe A PARTIR DAQUI
      if (falharEm === "trocaDePaciente") {
        releaseSdkSession();
        return false;
      }
      if (falharEm === "startLoggedSession") throw new Error("500 ao registrar a sessão");
      refs.started = true;
      return true;
    } catch {
      releaseSdkSession();
      refs.started = false;
      return false;
    } finally {
      refs.starting = false;
    }
  }

  return { mundo, refs, connect, end, sdk };
}

console.log("\n30. Falha DEPOIS de o WebRTC abrir:");
{
  const s = criarSessao({ falharEm: "startLoggedSession" });
  const ok = await s.connect();

  check("connect() devolve falha", ok === false);
  check("30. endSession foi chamado", s.mundo.endSessionChamado === 1);
  check("30b. o microfone deixou de estar ativo", s.mundo.microfoneAberto === false);
  check("30c. nenhum recurso fica marcado como aberto", s.refs.sdkSessionOpen === false);
  check("30d. o estado voltou para seguro", s.refs.status === "disconnected" && s.refs.started === false);

  // O sintoma que o usuário via: o botão Encerrar não conseguia limpar nada.
  s.end();
  check(
    "30e. Encerrar não precisa consertar o que já foi encerrado",
    s.mundo.endSessionChamado === 1 && s.mundo.microfoneAberto === false
  );
}

console.log("\n31. Nova tentativa conecta normalmente:");
{
  const s = criarSessao({ falharEm: "startLoggedSession" });
  await s.connect();
  // Segunda tentativa, agora sem falha induzida.
  s.sdk.startSession = async () => {
    s.mundo.microfoneAberto = true;
    s.refs.status = "connected";
  };
  const antes = s.mundo.endSessionChamado;
  const refeito = criarSessao();
  const ok = await refeito.connect();
  check("31. o retry conecta", ok === true && refeito.refs.started === true);
  check("31b. e o microfone está ativo na sessão nova", refeito.mundo.microfoneAberto === true);
  check(
    "31c. a sessão anterior não deixou resíduo",
    s.refs.sdkSessionOpen === false && s.mundo.endSessionChamado === antes
  );
}

console.log("\nOs demais caminhos de falha:");
{
  const antesDoRecurso = criarSessao({ falharEm: "token" });
  await antesDoRecurso.connect();
  check(
    "falha ANTES de abrir: nada a encerrar, e nada é chamado à toa",
    antesDoRecurso.mundo.endSessionChamado === 0 &&
      antesDoRecurso.mundo.microfoneAberto === false
  );

  const noStart = criarSessao({ falharEm: "startSession" });
  await noStart.connect();
  check(
    "falha DENTRO de startSession: microfone não fica aberto",
    noStart.mundo.microfoneAberto === false && noStart.refs.sdkSessionOpen === false
  );

  const troca = criarSessao({ falharEm: "trocaDePaciente" });
  await troca.connect();
  check(
    "troca de paciente durante connect: recurso liberado",
    troca.mundo.endSessionChamado === 1 && troca.mundo.microfoneAberto === false
  );

  // logout / unmount durante o connect: o teardown chega enquanto o recurso
  // existe e precisa fechá-lo mesmo sem sessão de produto registrada.
  const durante = criarSessao({ falharEm: "startLoggedSession" });
  const promessa = durante.connect();
  durante.end(); // logout no meio
  await promessa;
  check(
    "logout/unmount durante connect: o microfone não sobrevive",
    durante.mundo.microfoneAberto === false && durante.refs.sdkSessionOpen === false
  );
}

console.log("\nIdempotência (o teardown é chamado de muitos lugares):");
{
  const s = criarSessao();
  await s.connect();
  check("sessão viva depois de conectar", s.mundo.microfoneAberto === true);
  s.end();
  s.end();
  s.end();
  check(
    "encerrar três vezes encerra uma vez só",
    s.mundo.endSessionChamado === 1 && s.mundo.microfoneAberto === false
  );
}

console.log("\nA regressão que este teste existe para impedir:");
{
  // A versão ANTIGA de end(): `if (wasStarted) endSession()`. Reproduzida aqui
  // para mostrar que ela deixava o microfone aberto — se alguém voltar a
  // gatear o teardown por startedRef, o caso acima quebra e este documenta por quê.
  const s = criarSessao({ falharEm: "startLoggedSession" });
  await s.connect();
  const endAntigo = () => {
    if (s.refs.started) s.sdk.endSession();
  };
  const chamadasAntes = s.mundo.endSessionChamado;
  endAntigo();
  check(
    "o end() antigo não teria encerrado nada (started=false)",
    s.mundo.endSessionChamado === chamadasAntes && s.refs.started === false,
    "— o defeito original não se reproduz mais; revise este teste"
  );
}

// ——— Ancoragem no código real ———
//
// Tudo acima roda sobre uma RÉPLICA da máquina do provider — necessário,
// porque connect() vive dentro de um componente React amarrado ao SDK da
// ElevenLabs. A réplica só vale enquanto espelhar o original, então as
// verificações abaixo leem o fonte e falham se as invariantes estruturais que
// sustentam a correção desaparecerem de lá.
console.log("\nO provider real mantém as invariantes:");
{
  const { readFileSync } = await import("node:fs");
  const fonte = readFileSync("components/helo-agent-provider.tsx", "utf8");
  // Sem comentários: o código descreve o que ACONTECE, e é só isso que estas
  // verificações podem julgar. (O próprio comentário que explica o defeito
  // antigo cita `if (wasStarted) endSession()` — julgar prosa daria um
  // resultado invertido.)
  const codigo = fonte
    .split("\n")
    .filter((linha) => !/^\s*(\/\/|\*|\/\*)/.test(linha))
    .join("\n");

  check(
    "existe um ref para o RECURSO, separado do da sessão de produto",
    /sdkSessionOpenRef\s*=\s*useRef\(false\)/.test(codigo)
  );
  check(
    "o recurso é marcado como aberto logo após startSession",
    /sdkSessionOpenRef\.current = true/.test(codigo)
  );
  check(
    "existe um teardown que não olha startedRef",
    /const releaseSdkSession = useCallback\(\(\) => \{\s*if \(!sdkSessionOpenRef\.current\) return;/.test(codigo)
  );
  check(
    "end() chama o teardown incondicionalmente",
    /const end = useCallback\(\(\) => \{[\s\S]{0,400}?releaseSdkSession\(\);/.test(codigo)
  );
  check(
    "o catch de connect() libera o recurso",
    /releaseSdkSession\(\);\s*\n\s*startedRef\.current = false;/.test(codigo)
  );
  check(
    "end() NÃO voltou a gatear por wasStarted",
    !/if \(wasStarted\) endSession\(\)/.test(codigo),
    "— o defeito do R-05 foi reintroduzido"
  );
  check(
    "o SDK fechando sozinho zera o ref (sem endSession redundante)",
    (codigo.match(/sdkSessionOpenRef\.current = false/g) ?? []).length >= 3
  );
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
