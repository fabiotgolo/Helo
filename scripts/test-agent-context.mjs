// ——— Autorização antiga não é autorização atual (Fase 5.3C) ———
//
//   npm run test:agent:context
//
// O Agent descobre o que pode fazer e executa depois. Entre as duas coisas
// passa tempo real — a rede até a ElevenLabs, o modelo decidindo, a client
// tool voltando, e dentro do Helo um round-trip de autorização ao servidor.
// Nesse intervalo o cuidador pode trocar de paciente, sair da tela, encerrar a
// sessão ou sair da conta.
//
// Até a 5.3B a única proteção era INCIDENTAL: o registry esvazia no desmonte,
// a ação "some" e o dispatcher devolve NOT_FOUND. Isso cobre a mudança de
// tela, e só. Não cobre a janela em que a ação AINDA está registrada e a
// autoridade já mudou.
//
// Este teste conduz as duas peças REAIS — `lib/helo-agent-context.ts` (a
// geração) e `lib/helo-agent-dispatch.ts` (a sequência) — e não uma cópia
// delas. É por isso que a sequência saiu de dentro do componente: um teste que
// a reescrevesse provaria que a cópia está correta.

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const ctx = await import("../lib/helo-agent-context.ts");
const { despachaAcaoDoAgent } = await import("../lib/helo-agent-dispatch.ts");

const {
  CONTEXTO_EXPIRADO,
  capturaLeaseDoAgent,
  contextoDoAgent,
  encerraContextoDoAgent,
  geracaoDoAgent,
  leaseAindaVale,
  publicaContextoDoProvider,
  publicaSessaoClinica,
  reiniciaContextoParaTeste,
} = ctx;

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

/** O estado de uma tela do produto, em miniatura. */
function tela({ rota = "/rotina", paciente = 1, sessao = null, usuario = "u1" } = {}) {
  reiniciaContextoParaTeste();
  publicaContextoDoProvider({ rota, pacienteId: paciente, usuarioId: usuario });
  if (sessao !== null) publicaSessaoClinica(sessao);
}

function acao(actionId, { enabled = true, run } = {}) {
  const registro = { actionId, enabled, executou: 0, payload: null };
  registro.run = async (p) => {
    registro.executou += 1;
    registro.payload = p;
    if (run) await run(p);
  };
  return registro;
}

/** Um despacho com as dependências reais do produto, menos o servidor. */
function despacha(alvo, { autoriza, permitido = () => true, registryVivo } = {}) {
  const lease = capturaLeaseDoAgent();
  return despachaAcaoDoAgent(
    {
      lease,
      resolve: registryVivo ?? (() => alvo),
      permitido,
      aindaVale: leaseAindaVale,
      autoriza: autoriza ?? (async () => ({ ok: true })),
    },
    {}
  );
}

// ———————————————————————————————————————————————————————————————
console.log("\n— a geração avança com a autoridade, não com o render —");
{
  tela();
  const inicial = geracaoDoAgent();

  // Cem publicações idênticas: nada muda. É a lição da regressão de desempenho
  // da 5.3B escrita como teste — render não é mudança de autoridade.
  for (let i = 0; i < 100; i++) {
    publicaContextoDoProvider({ rota: "/rotina", pacienteId: 1, usuarioId: "u1" });
  }
  checa("cem publicações equivalentes não movem a geração", geracaoDoAgent() === inicial);

  checa(
    "trocar de rota avança",
    publicaContextoDoProvider({ rota: "/conversa", pacienteId: 1, usuarioId: "u1" }) === true
  );
  const depoisDaRota = geracaoDoAgent();
  checa("e a geração é outra", depoisDaRota !== inicial);

  checa(
    "trocar de paciente avança",
    publicaContextoDoProvider({ rota: "/conversa", pacienteId: 2, usuarioId: "u1" }) === true
  );
  checa(
    "trocar de usuário avança",
    publicaContextoDoProvider({ rota: "/conversa", pacienteId: 2, usuarioId: "u2" }) === true
  );
  checa("trocar de sessão clínica avança", publicaSessaoClinica("s-9") === true);
  checa("republicar a mesma sessão não avança", publicaSessaoClinica("s-9") === false);

  const antes = geracaoDoAgent();
  encerraContextoDoAgent();
  checa("encerrar avança e esvazia", geracaoDoAgent() !== antes && contextoDoAgent().rota === "");

  // O contador nunca volta atrás: uma geração reciclada ressuscitaria uma
  // autorização morta, que é exatamente o defeito que isto existe para tornar
  // impossível.
  const vistas = new Set();
  for (let i = 0; i < 50; i++) {
    publicaContextoDoProvider({ rota: `/r${i}`, pacienteId: 1, usuarioId: "u1" });
    vistas.add(geracaoDoAgent());
  }
  checa("nenhuma geração é reemitida", vistas.size === 50);
}

// ———————————————————————————————————————————————————————————————
console.log("\n— o mesmo contexto executa —");
{
  tela();
  const alvo = acao("routine.open.water");
  const r = await despacha(alvo);
  checa("a ação válida executa", r.ok === true && r.result === "SUCCESS");
  checa("uma vez, e uma só", alvo.executou === 1);
  checa("o handler recebe a origem", alvo.payload.__source === "agent");
  checa("e a pergunta do contexto", typeof alvo.payload.__aindaVale === "function");
  checa("que responde verdadeiro enquanto nada mudou", alvo.payload.__aindaVale() === true);
}

// ———————————————————————————————————————————————————————————————
console.log("\n— o contexto que morreu durante a autorização recusa —");
{
  // O cenário obrigatório da fase: a tool está em voo, o cuidador troca de
  // paciente, e a promessa antiga volta. A troca acontece DENTRO do
  // round-trip, que é a janela que a 5.3B não cobria.
  tela({ paciente: 1 });
  const alvo = acao("atividades.iniciar.42");
  const r = await despacha(alvo, {
    autoriza: async () => {
      publicaContextoDoProvider({ rota: "/rotina", pacienteId: 2, usuarioId: "u1" });
      return { ok: true };
    },
  });
  checa("recusa com CONTEXT_EXPIRED", r.ok === false && r.result === CONTEXTO_EXPIRADO);
  checa("ZERO efeito: o handler não foi chamado", alvo.executou === 0);
}

{
  tela({ rota: "/rotina" });
  const alvo = acao("routine.backToMenu");
  const r = await despacha(alvo, {
    autoriza: async () => {
      publicaContextoDoProvider({ rota: "/conversa", pacienteId: 1, usuarioId: "u1" });
      return { ok: true };
    },
  });
  checa("troca de ROTA durante a autorização recusa", r.result === CONTEXTO_EXPIRADO);
  checa("sem efeito", alvo.executou === 0);
}

{
  tela({ rota: "/conversa/perguntas", sessao: "s-1" });
  const alvo = acao("perguntas.pausar");
  const r = await despacha(alvo, {
    autoriza: async () => {
      publicaSessaoClinica("s-2");
      return { ok: true };
    },
  });
  checa("troca de SESSÃO durante a autorização recusa", r.result === CONTEXTO_EXPIRADO);
  checa("sem efeito na sessão nova", alvo.executou === 0);
}

{
  tela();
  const alvo = acao("routine.open.water");
  const r = await despacha(alvo, {
    autoriza: async () => {
      // Logout: o contexto acaba, não vira outro.
      encerraContextoDoAgent();
      return { ok: true };
    },
  });
  checa("LOGOUT durante a autorização recusa", r.result === CONTEXTO_EXPIRADO);
  checa("sem efeito", alvo.executou === 0);
}

// ———————————————————————————————————————————————————————————————
console.log("\n— a ação que saiu do registry não executa —");
{
  tela();
  const alvo = acao("routine.open.water");
  let removida = false;
  const r = await despacha(alvo, {
    registryVivo: () => (removida ? undefined : alvo),
    autoriza: async () => {
      removida = true;
      return { ok: true };
    },
  });
  checa("recusa mesmo com o lease intacto", r.result === CONTEXTO_EXPIRADO);
  checa("sem efeito", alvo.executou === 0);

  // Uma tela que remonta devolve um objeto NOVO, com handlers ligados a outra
  // instância. Mesmo id não é a mesma ação.
  tela();
  const antiga = acao("routine.open.water");
  const nova = acao("routine.open.water");
  let remontou = false;
  const r2 = await despacha(antiga, {
    registryVivo: () => (remontou ? nova : antiga),
    autoriza: async () => {
      remontou = true;
      return { ok: true };
    },
  });
  checa("o mesmo id numa instância nova também recusa", r2.result === CONTEXTO_EXPIRADO);
  checa("nem a antiga nem a nova executam", antiga.executou === 0 && nova.executou === 0);
}

// ———————————————————————————————————————————————————————————————
console.log("\n— a navegação que a própria ação causa é legítima —");
{
  // A fronteira do §13 do plano: validar ANTES do efeito. Depois que a ação
  // válida navega, a rota nova é consequência dela — não motivo para desfazê-la.
  tela({ rota: "/rotina" });
  const alvo = acao("navigate-atividades", {
    run: () => {
      publicaContextoDoProvider({ rota: "/atividades", pacienteId: 1, usuarioId: "u1" });
    },
  });
  const r = await despacha(alvo);
  checa("a ação executa", r.ok === true && alvo.executou === 1);
  checa("e o resultado continua SUCCESS depois de a rota mudar", r.result === "SUCCESS");
  checa("a rota é a nova", contextoDoAgent().rota === "/atividades");
}

// ———————————————————————————————————————————————————————————————
console.log("\n— o commit depois do await do handler —");
{
  // O que o dispatcher não alcança: uma espera DENTRO do handler. Ele recebe
  // `__aindaVale` para perguntar antes de gravar — é o que o modal de conclusão
  // da atividade passou a fazer.
  tela({ paciente: 1 });
  let gravou = 0;
  const alvo = acao("atividades.encerrar", {
    run: async (p) => {
      // A espera humana: alguém decide no modal.
      await Promise.resolve();
      publicaContextoDoProvider({ rota: "/rotina", pacienteId: 2, usuarioId: "u1" });
      await Promise.resolve();
      if (p.__aindaVale()) gravou += 1;
    },
  });
  const r = await despacha(alvo);
  checa("o handler chegou a rodar (o contexto era válido no começo)", alvo.executou === 1);
  checa("mas NÃO gravou depois da troca de paciente", gravou === 0);
  checa("e o resultado é SUCCESS — o efeito foi legitimamente iniciado", r.ok === true);
}

{
  tela({ paciente: 1 });
  let gravou = 0;
  const alvo = acao("atividades.encerrar", {
    run: async (p) => {
      await Promise.resolve();
      if (p.__aindaVale()) gravou += 1;
    },
  });
  await despacha(alvo);
  checa("sem troca no meio, o handler grava normalmente", gravou === 1);
}

// ———————————————————————————————————————————————————————————————
console.log("\n— o gate de classe não depende da geração —");
{
  tela();
  const gesto = acao("gesto.confirmar");
  const r = await despacha(gesto, { permitido: () => false });
  checa("patientResponse recusada", r.result === "FORBIDDEN_BY_POLICY");
  checa("sem efeito", gesto.executou === 0);

  // E continua recusada em qualquer geração, inclusive numa recém-criada.
  publicaContextoDoProvider({ rota: "/helo", pacienteId: 9, usuarioId: "u9" });
  const gesto2 = acao("gesto.confirmar");
  const r2 = await despacha(gesto2, { permitido: () => false });
  checa("e numa geração nova continua recusada", r2.result === "FORBIDDEN_BY_POLICY");
  checa("sem efeito", gesto2.executou === 0);

  // A ordem importa: o gate vem ANTES do round-trip, para que uma ação
  // proibida não gaste uma ida ao servidor nem chegue perto do efeito.
  tela();
  let autorizou = 0;
  const bloqueada = acao("emergencia.item.dor");
  await despacha(bloqueada, {
    permitido: () => false,
    autoriza: async () => {
      autorizou += 1;
      return { ok: true };
    },
  });
  checa("a ação proibida nem chega a pedir autorização", autorizou === 0);
}

// ———————————————————————————————————————————————————————————————
console.log("\n— desabilitada e recusada pelo servidor —");
{
  tela();
  const alvo = acao("atividades.proxima", { enabled: false });
  const r = await despacha(alvo);
  checa("ação desabilitada recusa com UNAVAILABLE", r.result === "UNAVAILABLE");
  checa("sem efeito", alvo.executou === 0);

  tela();
  const outra = acao("atividades.iniciar.1");
  const r2 = await despacha(outra, {
    autoriza: async () => ({ ok: false, error: "Acesso negado" }),
  });
  checa("recusa do servidor vira FORBIDDEN", r2.result === "FORBIDDEN");
  checa("sem efeito", outra.executou === 0);
}

// ———————————————————————————————————————————————————————————————
console.log("\n— a falha do handler não vaza o que ele disse —");
{
  tela();
  const alvo = acao("atividades.iniciar.1", {
    run: () => {
      throw new Error('Informe payload.gesto: "sim", "talvez" ou "nao".');
    },
  });
  const r = await despacha(alvo);
  checa("resultado é FAILED", r.result === "FAILED");
  checa(
    "e a mensagem do handler não está no resultado",
    !JSON.stringify(r).includes("payload.gesto")
  );
}

// ———————————————————————————————————————————————————————————————
console.log("\n— nenhum resultado carrega conteúdo de tela —");
{
  tela();
  const proibidos = ["água", "Dor no peito", "paciente", "patientId", "Fisioterapia"];
  const casos = [
    await despacha(acao("x"), { permitido: () => false }),
    await despacha(acao("y", { enabled: false })),
    await despacha(acao("z"), { registryVivo: () => undefined }),
    await despacha(acao("w"), {
      autoriza: async () => {
        encerraContextoDoAgent();
        return { ok: true };
      },
    }),
  ];
  checa(
    "nenhum código de resultado traz rótulo, paciente ou texto clínico",
    casos.every((c) => proibidos.every((p) => !JSON.stringify(c).includes(p))),
    JSON.stringify(casos)
  );
  checa(
    "e todos trazem um código estável",
    casos.every((c) => typeof c.result === "string" && c.result.length > 0)
  );
}

// ———————————————————————————————————————————————————————————————
console.log("\n— o lease é local: nada dele viaja ao provedor —");
{
  const contrato = (await import("node:fs")).readFileSync(
    new URL("../lib/helo-agent-context.ts", import.meta.url),
    "utf8"
  );
  checa("o módulo do contexto não fala com a rede", !/fetch\(|XMLHttpRequest/.test(contrato));
  checa(
    "e não é criptográfico — é um contador contra o tempo, não contra um atacante",
    !/crypto|randomUUID|createHash/.test(contrato)
  );
  const despacho = (await import("node:fs")).readFileSync(
    new URL("../lib/helo-agent-dispatch.ts", import.meta.url),
    "utf8"
  );
  checa(
    "a sequência não pede ao provedor que devolva a geração",
    !/parameters\.(lease|generation|contextVersion)/.test(despacho)
  );
}

console.log(`\n${mau === 0 ? "✓" : "✗"} ${ok} passaram, ${mau} falharam`);
process.exit(mau === 0 ? 0 : 1);
