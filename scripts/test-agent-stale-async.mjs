// ——— O efeito que chega depois que o mundo mudou (L1, L2, L3 — Fase 5.3C) ———
//
//   npm run test:agent:stale
//
// A 5.3C fechou a janela do DISPATCHER: entre autorizar no servidor e começar
// o efeito, o lease é conferido. A auditoria final das 25 ações executáveis
// mostrou que isso não bastava — três handlers esperam POR DENTRO, e o
// dispatcher já saiu de cena quando eles voltam:
//
//   L1  conversa.comecar    → cria a sessão, e só então grava e fala
//   L2  routine.open.*      → garante a sessão, e só então grava
//   L3  atividades.iniciar.*→ cria a execução, e só então ABRE O PLAYER
//
// O quarto, `activity.goToActivityMenu`, já era protegido: a espera dele é o
// modal de conclusão, tempo humano, e a proteção nasceu com a 5.3C.
//
// Este arquivo prova a peça compartilhada — `guardaDeContexto`, a mesma
// geração capturada no mesmo instrumento — conduzindo o módulo REAL, e conduz
// também o dispatcher real com um handler que espera por dentro. A prova de
// que os três handlers do produto a usam de fato vive em dois lugares: a
// verificação estrutural no fim deste arquivo, e a causal, na tela real, em
// `tests/e2e/agent-async-stale.spec.ts`.

import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const {
  CONTEXTO_EXPIRADO,
  capturaLeaseDoAgent,
  encerraContextoDoAgent,
  guardaDeContexto,
  leaseDoPayload,
  publicaContextoDoProvider,
  publicaSessaoClinica,
  reiniciaContextoParaTeste,
} = await import("../lib/helo-agent-context.ts");
const { despachaAcaoDoAgent } = await import("../lib/helo-agent-dispatch.ts");
const { leaseAindaVale } = await import("../lib/helo-agent-context.ts");

let ok = 0;
let mau = 0;
function checa(nome, condicao, detalhe = "") {
  if (condicao) {
    ok += 1;
    console.log(`  ✓ ${nome}`);
  } else {
    mau += 1;
    console.error(`  ✗ ${nome} ${detalhe}`);
  }
}

/** O contexto de uma tela do produto, em miniatura. */
function tela({ rota = "/atividades", paciente = 1, sessao = null, usuario = "u1" } = {}) {
  reiniciaContextoParaTeste();
  publicaContextoDoProvider({ rota, pacienteId: paciente, usuarioId: usuario });
  if (sessao !== null) publicaSessaoClinica(sessao);
}

// ———————————————————————————————————————————————————————————————
console.log("\n1. a guarda vale enquanto o mundo não muda");
// ———————————————————————————————————————————————————————————————
{
  tela();
  const aindaVale = guardaDeContexto();
  checa("logo depois de capturada, vale", aindaVale());

  // Render não é mudança de autoridade: republicar os MESMOS quatro
  // primitivos cem vezes não move a geração. É a lição da regressão de
  // desempenho da 5.3B, e é o que impede a guarda de recusar por nada.
  for (let i = 0; i < 100; i++) {
    publicaContextoDoProvider({ rota: "/atividades", pacienteId: 1, usuarioId: "u1" });
  }
  checa("cem republicações idênticas depois, continua valendo", aindaVale());

  // Controle positivo: o efeito normal continua acontecendo.
  let efeito = 0;
  await Promise.resolve();
  if (aindaVale()) efeito += 1;
  checa("o efeito tardio acontece quando nada mudou", efeito === 1);
}

// ———————————————————————————————————————————————————————————————
console.log("\n2. cada mudança real de autoridade derruba a guarda");
// ———————————————————————————————————————————————————————————————
{
  const casos = [
    {
      nome: "troca de paciente",
      muda: () => publicaContextoDoProvider({ rota: "/atividades", pacienteId: 2, usuarioId: "u1" }),
    },
    {
      nome: "troca de rota",
      muda: () => publicaContextoDoProvider({ rota: "/rotina", pacienteId: 1, usuarioId: "u1" }),
    },
    {
      nome: "troca de sessão clínica",
      muda: () => publicaSessaoClinica("s2"),
    },
    {
      nome: "logout (o usuário desaparece)",
      muda: () => publicaContextoDoProvider({ rota: "/atividades", pacienteId: 1, usuarioId: null }),
    },
    {
      nome: "encerramento do contexto",
      muda: () => encerraContextoDoAgent(),
    },
  ];
  for (const caso of casos) {
    tela({ sessao: "s1" });
    const aindaVale = guardaDeContexto();
    checa(`antes de «${caso.nome}», vale`, aindaVale());
    caso.muda();
    checa(`depois de «${caso.nome}», não vale mais`, !aindaVale());
  }
}

// ———————————————————————————————————————————————————————————————
console.log("\n3. a guarda não se recupera, e não confunde gerações");
// ———————————————————————————————————————————————————————————————
{
  tela({ paciente: 1 });
  const emA = guardaDeContexto();
  publicaContextoDoProvider({ rota: "/atividades", pacienteId: 2, usuarioId: "u1" });
  checa("em B, a guarda de A não vale", !emA());

  // Voltar ao paciente A NÃO ressuscita a autorização de A: a geração é
  // monotônica e nunca é reemitida — o mesmo princípio da concessão do
  // microfone. Sem isso, um vaivém rápido reabriria uma janela já fechada.
  publicaContextoDoProvider({ rota: "/atividades", pacienteId: 1, usuarioId: "u1" });
  checa("voltar ao paciente A não ressuscita a guarda de A", !emA());

  const deVolta = guardaDeContexto();
  checa("uma guarda nova, capturada agora, vale", deVolta());
}

// ———————————————————————————————————————————————————————————————
console.log("\n4. quando quem pediu foi o Agent, a guarda é a DELE");
// ———————————————————————————————————————————————————————————————
{
  // O dispatcher captura o lease quando a tool CHEGA — antes do round-trip de
  // autorização. Se o handler capturasse um lease novo, perderia justamente o
  // intervalo que o dispatcher cobria, e a proteção teria um buraco no meio.
  tela({ paciente: 1 });
  const leaseDoDispatcher = capturaLeaseDoAgent();
  const payload = { __source: "agent", __aindaVale: () => leaseAindaVale(leaseDoDispatcher) };

  publicaContextoDoProvider({ rota: "/atividades", pacienteId: 2, usuarioId: "u1" });

  const doAgent = guardaDeContexto(payload);
  const local = guardaDeContexto();
  checa("a guarda do payload já nasce vencida (o mundo mudou antes dela)", !doAgent());
  checa("uma guarda capturada agora, ali, valeria — e é por isso que ela não serve", local());

  checa("o payload do Agent é reaproveitado, não recapturado", doAgent !== local);
}

// ———————————————————————————————————————————————————————————————
console.log("\n5. o que NÃO é uma guarda do dispatcher");
// ———————————————————————————————————————————————————————————————
{
  tela();
  checa("sem payload", leaseDoPayload(undefined) === undefined);
  checa("payload vazio", leaseDoPayload({}) === undefined);
  checa("campo com outro tipo", leaseDoPayload({ __aindaVale: true }) === undefined);
  checa("campo com string", leaseDoPayload({ __aindaVale: "sim" }) === undefined);
  // O clique humano chega com um objeto de evento do React, que não é payload.
  // Ele precisa cair no caminho seguro — capturar o lease de agora — e nunca
  // ser lido como uma autorização que alguém concedeu.
  const evento = { type: "click", target: {}, nativeEvent: {} };
  checa("objeto de evento do React", leaseDoPayload(evento) === undefined);
  const guarda = guardaDeContexto(evento);
  checa("e a guarda resultante é uma guarda de verdade", guarda() === true);
  publicaContextoDoProvider({ rota: "/rotina", pacienteId: 1, usuarioId: "u1" });
  checa("que também vence", guarda() === false);
}

// ———————————————————————————————————————————————————————————————
console.log("\n6. a sequência real, com um handler que espera POR DENTRO");
// ———————————————————————————————————————————————————————————————
{
  // Este é o cenário exato de L1, L2 e L3, conduzido pelo dispatcher REAL. A
  // promessa é controlada: o handler começa, fica pendente, o contexto muda, a
  // promessa é liberada. Nada depende de ganhar uma corrida na sorte.
  async function cenario({ trocaDurante }) {
    tela({ paciente: 1 });
    let liberar;
    const presa = new Promise((r) => { liberar = r; });
    const gravado = [];
    let entrou = false;

    const acao = {
      actionId: "atividades.iniciar.t1",
      enabled: true,
      run: async (payload) => {
        entrou = true;
        const aindaVale = guardaDeContexto(payload);
        await presa; // ← a rede: criar a execução no servidor
        if (!aindaVale()) return; // ← a correção de L1/L2/L3
        gravado.push("efeito");
      },
    };

    const pedido = despachaAcaoDoAgent({
      lease: capturaLeaseDoAgent(),
      resolve: () => acao,
      permitido: () => true,
      aindaVale: leaseAindaVale,
      autoriza: async () => ({ ok: true }),
    });

    // Espera o handler entrar de verdade antes de mexer no mundo.
    while (!entrou) await new Promise((r) => setTimeout(r, 1));
    if (trocaDurante) {
      publicaContextoDoProvider({ rota: "/atividades", pacienteId: 2, usuarioId: "u1" });
    }
    liberar();
    const resultado = await pedido;
    return { gravado, resultado };
  }

  const comTroca = await cenario({ trocaDurante: true });
  checa("com a troca no meio, nenhum efeito tardio acontece", comTroca.gravado.length === 0);
  // O despacho em si teve sucesso: ele autorizou e chamou o handler num
  // momento em que tudo valia. Quem recusou foi o handler, no ponto que só ele
  // alcança — e essa distinção é honesta, não cosmética.
  checa("e o despacho não mente sobre o que fez", comTroca.resultado.result === "SUCCESS");

  const semTroca = await cenario({ trocaDurante: false });
  checa("sem troca, o efeito acontece normalmente", semTroca.gravado.length === 1);
  checa("controle positivo: a correção não matou a funcionalidade", semTroca.resultado.result === "SUCCESS");
}

// ———————————————————————————————————————————————————————————————
console.log("\n7. o dispatcher continua recusando ANTES do handler");
// ———————————————————————————————————————————————————————————————
{
  // A guarda do handler é a SEGUNDA linha. A primeira continua sendo a do
  // dispatcher — se o mundo mudar durante a autorização no servidor, o handler
  // nem chega a ser chamado, e nenhum efeito começa.
  tela({ paciente: 1 });
  let chamou = 0;
  const acao = { actionId: "x", enabled: true, run: () => { chamou += 1; } };
  const r = await despachaAcaoDoAgent({
    lease: capturaLeaseDoAgent(),
    resolve: () => acao,
    permitido: () => true,
    aindaVale: leaseAindaVale,
    autoriza: async () => {
      publicaContextoDoProvider({ rota: "/atividades", pacienteId: 2, usuarioId: "u1" });
      return { ok: true };
    },
  });
  checa("o handler não é chamado", chamou === 0);
  checa("e a recusa é a de contexto vencido", r.result === CONTEXTO_EXPIRADO);
}

// ———————————————————————————————————————————————————————————————
console.log("\n8. os três handlers do produto usam a guarda — e ANTES do efeito");
// ———————————————————————————————————————————————————————————————
{
  // Verificação estrutural, não contagem de `await`. A pergunta é concreta:
  // dentro do corpo do handler, a guarda é capturada e consultada antes da
  // linha que comete? Se alguém reordenar, isto falha.
  const semProsa = (caminho) =>
    readFileSync(caminho, "utf8")
      .split("\n")
      .filter((linha) => !/^\s*(\/\/|\*|\/\*)/.test(linha))
      .join("\n");

  /** O trecho entre o começo do handler e o fim do arquivo, sem comentários. */
  const corpo = (fonte, marcador) => {
    const i = fonte.indexOf(marcador);
    return i < 0 ? "" : fonte.slice(i);
  };

  const alvos = [
    {
      lacuna: "L1 conversa.comecar",
      arquivo: "app/(palco)/conversa/page.tsx",
      handler: "const begin = useCallback",
      efeito: "setSessionId(id)",
      registro: /run: \(payload\) => void begin\(payload\)/,
    },
    {
      lacuna: "L2 routine.open.*",
      arquivo: "app/(palco)/rotina/page.tsx",
      handler: "const openQuestionByKey = useCallback",
      efeito: "logEvent({",
      registro: /run: \(payload\) => openQuestionByKey\(q\.key, payload\)/,
    },
    {
      lacuna: "L3 atividades.iniciar.*",
      arquivo: "app/(palco)/atividades/page.tsx",
      handler: "const start = useCallback",
      efeito: 'setView({ kind: "sessao"',
      registro: /run: \(payload\) => void start\(t, null, payload\)/,
    },
  ];

  for (const alvo of alvos) {
    const fonte = semProsa(alvo.arquivo);
    const trecho = corpo(fonte, alvo.handler);
    const captura = trecho.indexOf("guardaDeContexto(payload)");
    const conferencia = trecho.indexOf("if (!aindaVale())");
    const efeito = trecho.indexOf(alvo.efeito);

    checa(`${alvo.lacuna}: o handler captura a guarda`, captura >= 0);
    checa(`${alvo.lacuna}: e a confere`, conferencia >= 0);
    checa(
      `${alvo.lacuna}: a captura vem antes da conferência`,
      captura >= 0 && conferencia > captura
    );
    checa(
      `${alvo.lacuna}: a conferência vem antes do efeito (${alvo.efeito})`,
      conferencia >= 0 && efeito > conferencia,
      "— o efeito passou para antes da guarda"
    );
    checa(
      `${alvo.lacuna}: a ação do registry repassa o payload do dispatcher`,
      alvo.registro.test(fonte),
      "— sem o payload, o handler capturaria um lease mais novo que o do dispatcher"
    );
  }

  // O quarto caminho, o de espera humana, continua onde estava.
  const player = semProsa("components/activity-player.tsx");
  checa(
    "activity.goToActivityMenu segue conferindo antes de gravar",
    /if \(aindaVale && !aindaVale\(\)\) \{[\s\S]{0,200}?return;[\s\S]{0,80}?\}\s*endRun\(/.test(player),
    "— a proteção do modal de conclusão saiu do lugar"
  );
  checa(
    "e usa o MESMO leitor de payload, sem reimplementá-lo",
    /leaseDoPayload/.test(player) && !/payload\?\.__aindaVale === "function"/.test(player)
  );

  // E ninguém lê `__aindaVale` na mão: quem precisa da guarda pede ao módulo.
  for (const arquivo of alvos.map((a) => a.arquivo)) {
    checa(
      `${arquivo} não reimplementa a leitura do lease`,
      !/__aindaVale/.test(semProsa(arquivo)),
      "— a lógica da guarda foi duplicada"
    );
  }

  // A rotina esquece a sessão do paciente anterior. Este é o defeito IRMÃO
  // encontrado ao preparar o teste causal de L2: não é uma janela pós-await,
  // é uma referência que atravessava a troca de paciente — com o contexto já
  // válido em B, `ensureSession()` devolvia a sessão de A.
  const rotina = semProsa("app/(palco)/rotina/page.tsx");
  checa(
    "a Rotina esquece a sessão ao trocar de paciente",
    /sessionRef\.current = null;\s*sessionPending\.current = null;\s*\}, \[patientId\]\)/.test(rotina),
    "— a sessão de um paciente voltaria a atravessar para o outro"
  );
}

console.log(`\n${ok} aprovados, ${mau} falhos`);
process.exit(mau === 0 ? 0 : 1);
