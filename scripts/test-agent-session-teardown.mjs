// ——— Defesa estática do teardown (R-05) ———
//
//   npm run test:agent:teardown
//
// O COMPORTAMENTO é provado em `npm run test:agent:lifecycle`, que roda o
// código de produção (lib/voice/agent-session-lifecycle.ts) com o SDK
// simulado. Até o fechamento da 5.1A este arquivo REPLICAVA a máquina de
// connect() e verificava a réplica — o que prova que a cópia está correta,
// não o produto. A réplica saiu; ficou o que ela não fazia.
//
// O que resta aqui é a defesa estrutural sobre o componente: o provider tem
// caminhos de saída que o teste de comportamento não alcança, porque vivem em
// efeitos do React (sair da página, trocar de paciente, desmontar). Cada um
// deles precisa perguntar pelo RECURSO — "existe um WebRTC aberto?" — e não
// pelo registro da sessão de produto. Confundir os dois foi o R-05:
//
//   "o recurso externo está aberto"  ≠  "a sessão de produto foi registrada"
//
// O microfone pertence ao primeiro fato. Enquanto o teardown perguntava pelo
// segundo, existia uma janela em que a captura seguia viva e NENHUM caminho de
// interface a fechava — nem o botão "Encerrar conversa".

import { readFileSync } from "node:fs";

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

const fonte = readFileSync("components/helo-agent-provider.tsx", "utf8");
// Sem comentários: o código descreve o que ACONTECE, e é só isso que estas
// verificações podem julgar. (Os próprios comentários que explicam o defeito
// citam `if (wasStarted) endSession()` — julgar prosa daria o resultado
// invertido.)
const codigo = fonte
  .split("\n")
  .filter((linha) => !/^\s*(\/\/|\*|\/\*)/.test(linha))
  .join("\n");

console.log("\nO recurso e a sessão de produto seguem separados:");
{
  check(
    "o recurso externo vive num handle próprio, fora do componente",
    /createSdkSessionHandle\(\{/.test(codigo),
    "— o estado do recurso voltou para dentro do React"
  );
  check(
    "…e o registro da sessão de produto continua num ref separado",
    /const startedRef = useRef\(false\)/.test(codigo)
  );
  check(
    "nenhum resquício do ref antigo",
    !/sdkSessionOpenRef/.test(codigo)
  );
  check(
    "o defeito original não voltou em nenhuma forma",
    !/if \(wasStarted\) endSession\(\)/.test(codigo) &&
      !/if \(startedRef\.current\)\s*endSession\(\)/.test(codigo),
    "— o teardown voltou a ser gateado pelo registro"
  );
}

console.log("\nTodo caminho de saída pergunta pelo RECURSO:");
{
  check(
    "Encerrar conversa: end() libera sem condição",
    /const end = useCallback\(\(\) => \{[\s\S]{0,400}?releaseSdkSession\(\);/.test(codigo)
  );
  check(
    "…e releaseSdkSession delega ao handle",
    /const releaseSdkSession = useCallback\(\(\) => \{\s*sdkSession\.release\(\);/.test(codigo)
  );
  check(
    "sair da página com o microfone aberto encerra, mesmo sem sessão registrada",
    /pathname !== "\/helo" && \(startedRef\.current \|\| sdkSession\.isOpen\(\)\)/.test(codigo),
    "— navegar para longe deixaria a captura viva numa tela sem conversa"
  );
  check(
    "trocar de paciente encerra, mesmo sem sessão registrada",
    /if \(!startedRef\.current && !sdkSession\.isOpen\(\)\) return;/.test(codigo),
    "— a sessão do paciente anterior continuaria capturando"
  );
  check(
    "reconectar não abre uma segunda sessão por cima de uma órfã",
    /sdkSession\.isOpen\(\) \|\|/.test(codigo)
  );
}

console.log("\nO SDK caindo sozinho não vira endSession redundante:");
{
  const quedas = codigo.match(/sdkSession\.markClosed\(\)/g) ?? [];
  check(
    "onDisconnect e onError apenas registram a queda",
    quedas.length >= 2,
    `— ${quedas.length} chamada(s) de markClosed; esperava 2 (onDisconnect e onError)`
  );
}

console.log("\nA abertura não foi reescrita dentro do componente:");
{
  check(
    "connect() delega a sequência a openAgentSession",
    /await openAgentSession\(\{/.test(codigo),
    "— a sequência do R-05 voltou a viver só no componente, fora de teste"
  );
  check(
    "…e o resultado de falha zera a sessão de produto",
    /if \(!aberta\.ok\) \{\s*startedRef\.current = false;/.test(codigo)
  );
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
