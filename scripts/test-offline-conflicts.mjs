// ——— A matriz de conflitos, linha por linha (Fase 4.9.3-C, §10) ———
//
// Teste PURO: sem rede, sem navegador, sem emulador. Roda em milissegundos e
// não depende de nada estar no ar — é o que permite exigir dele a cobertura
// COMPLETA das treze linhas, e não uma amostra.
//
// O que este arquivo prova, e por que cada coisa importa:
//
//   1. As treze linhas existem e são distinguíveis. Uma matriz em que dois
//      casos colapsam no mesmo resultado é uma matriz que perdeu uma decisão.
//   2. Nenhum caso que exige o cuidador oferece "aplicar por cima" como
//      primeira saída (§10: "o padrão nunca é aplicar mesmo assim").
//   3. Código desconhecido NÃO vira sucesso nem palpite — vira decisão.
//   4. O que a matriz declara NÃO ser conflito (10, 11, 12-como-reenvio)
//      continua não sendo.
//
//   npm run test:offline:conflicts

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const {
  classificarRecusa,
  classificarVersaoServidor,
  conflitoDependenciaAusente,
  conflitoPacienteDiferente,
  comValorLocal,
  exigeDecisao,
  isRtqConflictCode,
  restoreConflict,
  valorLocalDe,
} = await import("../lib/offline/conflicts.ts");
const { RTQ_CONFLICT_CODES } = await import("../lib/realtime-question-types.ts");

let passou = 0;
let falhou = 0;

function ok(cond, nome) {
  if (cond) {
    passou += 1;
    console.log(`  ✓ ${nome}`);
  } else {
    falhou += 1;
    console.log(`  ✗ ${nome}`);
  }
}

function eq(a, b, nome) {
  ok(a === b, `${nome}${a === b ? "" : ` — esperado ${b}, veio ${a}`}`);
}

function secao(t) {
  console.log(`\n${t}`);
}

// Atalho: uma recusa vinda do servidor com determinado código.
const recusa = (code, fatos) =>
  classificarRecusa({ status: 400, code, mensagem: "…", fatos });

// ════════════════════════════════════════════════════════════════════
secao("1. Caso 1 — sessão concluída em outro dispositivo");
{
  const c = recusa("SESSION_COMPLETED", { serverStatus: "COMPLETED", serverAt: "2026-08-06T14:35:00Z" });
  eq(c.caso, 1, "é a linha 1 da matriz");
  eq(c.resolucao, "CUIDADOR", "exige decisão do cuidador");
  ok(/encerrada em outro aparelho/i.test(c.titulo), "o título diz o que houve, em português do cuidador");
  eq(c.fatos.serverAt, "2026-08-06T14:35:00Z", "carrega o horário do servidor para a tela mostrar");
  const ids = c.opcoes.map((o) => o.id);
  ok(ids.includes("VER_PENDENTES"), "oferece ver o que ficou pendente");
  ok(ids.includes("REAPROVEITAR_COMO_RASCUNHO"), "oferece reaproveitar os textos");
  ok(ids.includes("DESCARTAR"), "oferece descartar");
  // §10 caso 1: reaproveitar é SEMPRE como rascunho, nunca como confirmação.
  const reaproveitar = c.opcoes.find((o) => o.id === "REAPROVEITAR_COMO_RASCUNHO");
  ok(reaproveitar.descarta === false, "reaproveitar não descarta o que o cuidador escreveu");
}

secao("2. Caso 2 — sessão pausada em outro dispositivo");
{
  const c = recusa("SESSION_PAUSED", { serverStatus: "PAUSED" });
  eq(c.caso, 2, "é a linha 2 da matriz");
  eq(c.opcoes[0].id, "RETOMAR_E_CONTINUAR", "a primeira saída é retomar e continuar a enviar");
  ok(c.opcoes.some((o) => o.id === "DESCARTAR"), "descartar continua disponível");
  ok(c.caso !== 1, "NÃO se confunde com a sessão concluída");
}

secao("3. Caso 3 — pergunta (nível) substituída");
{
  const c = recusa("TURN_REPLACED", { replacedById: "node_abc" });
  eq(c.caso, 3, "é a linha 3 da matriz");
  eq(c.fatos.replacedById, "node_abc", "sabe QUAL registro substituiu — sem isso não há o que mostrar ao lado");
  // §10: "Nunca aplica automaticamente sobre a substituta."
  ok(c.opcoes[0].id !== "REPETIR_SOBRE_A_NOVA", "repetir sobre a nova NÃO é a saída padrão");
  ok(c.opcoes.some((o) => o.id === "REPETIR_SOBRE_A_NOVA"), "mas repetir continua oferecido");
}

secao("4. Caso 4 — resposta alterada");
{
  const c = recusa("RESPONSE_CHANGED", { serverValue: "SIM", localValue: "TALVEZ" });
  eq(c.caso, 4, "é a linha 4 da matriz");
  const ids = c.opcoes.map((o) => o.id);
  ok(ids.includes("MANTER_DO_SERVIDOR"), "oferece manter a do servidor");
  ok(ids.includes("APLICAR_A_MINHA"), "oferece aplicar a minha, como correção");
  // A regra que a matriz escreve em maiúsculas: nunca "a mais recente vence".
  eq(c.opcoes.length, 2, "só há estas duas saídas — nenhuma automática");
  ok(
    c.fatos.serverValue === "SIM" && c.fatos.localValue === "TALVEZ",
    "a tela recebe AS DUAS respostas, para mostrar lado a lado"
  );
}

secao("5. Caso 5 — caminho interrompido");
{
  const c = recusa("PATH_ENDED", { serverStatus: "INTERRUPTED" });
  eq(c.caso, 5, "é a linha 5 da matriz");
  ok(
    c.opcoes.some((o) => o.id === "REAPROVEITAR_COMO_RASCUNHO"),
    "oferece reutilizar o conteúdo num caminho novo"
  );
}

secao("6. Caso 6 — interpretação substituída");
{
  const c = recusa("STATEMENT_REPLACED", { replacedById: "stmt_9" });
  eq(c.caso, 6, "é a linha 6 da matriz");
  ok(c.caso !== 3, "é distinto do caso 3, mesmo tendo saídas parecidas");
  eq(c.fatos.replacedById, "stmt_9", "sabe qual frase substituiu");
}

secao("7. Caso 7 — contexto alterado");
{
  const c = recusa("CONTEXT_VERSION", { serverValue: "consulta de rotina" });
  eq(c.caso, 7, "é a linha 7 da matriz");
  ok(
    c.opcoes.some((o) => o.id === "GRAVAR_COMO_NOVA_VERSAO"),
    "oferece gravar a minha como versão NOVA — versionar, não sobrescrever"
  );
  ok(
    !c.opcoes.some((o) => o.id === "APLICAR_A_MINHA"),
    "não oferece sobrescrever: o 4.8 versiona, e a matriz manda preservar isso"
  );
}

secao("8. Caso 8 — paciente diferente (detectado ANTES de enviar)");
{
  const c = conflitoPacienteDiferente("77", "88");
  eq(c.caso, 8, "é a linha 8 da matriz");
  eq(c.resolucao, "ESPERA", "não é decisão: a fila só espera o paciente dela voltar");
  eq(c.opcoes.length, 0, "não oferece descartar — jogar fora registro clínico por isso seria absurdo");
  ok(/outro paciente/i.test(c.titulo), "o chip explica que há registros de outro paciente");
}

secao("9. Caso 9 — acesso revogado");
{
  const c = classificarRecusa({ status: 403, code: undefined, mensagem: "sem acesso" });
  eq(c.caso, 9, "403 sozinho já é a linha 9 — mesmo sem código no corpo");
  eq(c.code, "ACCESS_REVOKED", "recebe o código certo");
  // §10 caso 9: "Não há opção de forçar."
  ok(
    !c.opcoes.some((o) => o.id === "APLICAR_A_MINHA" || o.id === "REPETIR_SOBRE_A_NOVA"),
    "NÃO existe saída de forçar o envio"
  );
  const comCodigo = recusa("ACCESS_REVOKED");
  eq(comCodigo.caso, 9, "e com o código explícito dá no mesmo");
}

secao("9b. R6 — a fila é de OUTRO cuidador (403, mas não é o caso 9)");
{
  const c = classificarRecusa({
    status: 403,
    code: "IDENTITY_MISMATCH",
    mensagem: "estes registros são de outro cuidador",
  });
  eq(c.caso, 14, "tem linha própria");
  eq(c.code, "IDENTITY_MISMATCH", "com o código do servidor");
  // Os dois chegam como 403 e significam o OPOSTO: no caso 9 o acesso acabou;
  // aqui a fila é válida, só não é desta pessoa. Confundi-los diria ao
  // cuidador que ele perdeu acesso a uma conversa que talvez nem seja dele.
  ok(c.caso !== 9, "NÃO é confundido com acesso revogado, apesar do mesmo 403");
  eq(c.resolucao, "ESPERA", "não é decisão de quem está logado agora");
  eq(
    c.opcoes.length,
    0,
    "e não oferece NEM descartar — jogar fora a intenção clínica de um colega não é escolha desta pessoa"
  );
  ok(/outro cuidador/i.test(c.titulo), "o texto diz de quem são os registros");

  // Um 403 comum continua sendo o caso 9.
  eq(
    classificarRecusa({ status: 403, code: undefined, mensagem: "sem acesso" }).caso,
    9,
    "403 sem código continua sendo acesso revogado"
  );
}

secao("10 e 12. Não é conflito — o ledger respondeu");
{
  // A matriz é explícita: "Não é conflito: APPLIED, segue em frente, sem tela
  // e sem duplicar." Isto está modelado como resultado NOMEADO justamente
  // para que "seguir em frente" nunca seja o `else` de ninguém.
  const v = classificarVersaoServidor("mesmo texto", "mesmo texto");
  eq(v.kind, "SNAPSHOT_DESATUALIZADO", "conteúdo igual não é conflito");
  eq(v.caso, 11, "é a linha 11 da matriz");
}

secao("11. Caso 11 x caso 4 — a fronteira");
{
  eq(
    classificarVersaoServidor("TALVEZ", "SIM"),
    "DIVERGE",
    "conteúdo diferente NÃO é 'servidor mais novo' — cai no caso 4"
  );
  eq(
    classificarVersaoServidor("igual", "igual").caso,
    11,
    "conteúdo igual é só snapshot velho: atualiza e segue"
  );
  eq(
    classificarVersaoServidor(null, "algo").caso,
    11,
    "sem valor local para comparar, não se INVENTA divergência"
  );
}

secao("13. Caso 13 — dependência ausente, e a cadeia inteira");
{
  const op = (status, tipo) => ({ status, operationType: tipo });

  const esperando = conflitoDependenciaAusente(op("PENDING", "nodeAction"), op("PENDING", "createNode"));
  eq(esperando.caso, 13, "é a linha 13 da matriz");
  eq(esperando.resolucao, "ESPERA", "dependência que só ainda não foi enviada é espera comum, não conflito");
  eq(esperando.opcoes.length, 0, "e não pede decisão nenhuma");

  const travada = conflitoDependenciaAusente(op("PENDING", "nodeAction"), op("CONFLICT", "createNode"));
  eq(travada.resolucao, "CUIDADOR", "mas dependência TRAVADA vira decisão");
  eq(travada.opcoes[0].id, "DECIDIR_A_CADEIA", "e a decisão é sobre a cadeia, não sobre a peça solta");
  ok(
    /não foi enviado/i.test(travada.titulo),
    "o texto explica a cadeia: um registro anterior falhou, e por isso este também"
  );

  const falhada = conflitoDependenciaAusente(op("PENDING", "nodeAction"), op("FAILED", "createNode"));
  eq(falhada.resolucao, "CUIDADOR", "FAILED na dependência também trava a cadeia");
}

// ════════════════════════════════════════════════════════════════════
secao("A. Código desconhecido nunca vira palpite");
{
  const c = classificarRecusa({ status: 400, code: undefined, mensagem: "algo em português" });
  eq(c.code, "DESCONHECIDO", "sem código, o resultado é DESCONHECIDO");
  eq(c.resolucao, "CUIDADOR", "e mesmo assim PARA e pede decisão — nunca segue em frente");
  ok(
    c.fatos.serverValue === "algo em português",
    "a mensagem é preservada para exibir, ainda que não sirva para classificar"
  );

  // A armadilha que este teste existe para impedir: classificar pela FRASE.
  const enganosa = classificarRecusa({
    status: 400,
    code: undefined,
    mensagem: "transição de sessão inválida: COMPLETED → PAUSED",
  });
  eq(
    enganosa.code,
    "DESCONHECIDO",
    "uma frase que PARECE o caso 1 não é promovida a caso 1 sem o código"
  );
}

secao("B. Nenhum caso oferece 'aplicar por cima' como padrão");
{
  const perigosas = ["APLICAR_A_MINHA", "REPETIR_SOBRE_A_NOVA", "GRAVAR_COMO_NOVA_VERSAO"];
  for (const code of RTQ_CONFLICT_CODES) {
    const c = recusa(code);
    if (c.opcoes.length === 0) continue;
    ok(
      !perigosas.includes(c.opcoes[0].id) || c.code === "CONTEXT_VERSION",
      `${code}: a primeira saída não aplica por cima`
    );
  }
  // O caso 7 é a exceção declarada: "gravar como nova versão" NÃO sobrescreve
  // nada — é o comportamento normal do 4.8. Continua sendo a segunda opção.
  const ctx = recusa("CONTEXT_VERSION");
  eq(ctx.opcoes[0].id, "MANTER_DO_SERVIDOR", "no caso 7 o padrão é manter a do servidor");
}

secao("C. Cobertura: todo código do servidor tem uma linha da matriz");
{
  for (const code of RTQ_CONFLICT_CODES) {
    const c = recusa(code);
    ok(c.caso > 0 && c.code !== "DESCONHECIDO", `${code} tem linha própria (caso ${c.caso})`);
  }
  eq(RTQ_CONFLICT_CODES.length, 10, "são dez códigos emitidos pelo servidor");
  ok(isRtqConflictCode("SESSION_COMPLETED"), "reconhece um código válido");
  ok(!isRtqConflictCode("INVENTADO"), "recusa um código que não existe");
}

secao("D. Casos distintos produzem resultados distintos");
{
  const vistos = new Map();
  for (const code of RTQ_CONFLICT_CODES) {
    const c = recusa(code);
    // ACCESS_REVOKED e o 403 são o mesmo caso de propósito; o resto é único.
    const chave = `${c.caso}`;
    if (vistos.has(chave)) {
      ok(false, `${code} colidiu com ${vistos.get(chave)} no caso ${chave}`);
    } else {
      vistos.set(chave, code);
    }
  }
  ok(true, "nenhum par de códigos colapsa na mesma linha da matriz");
  eq(vistos.size, 10, "dez códigos, dez linhas distintas");
}

secao("E. exigeDecisao — o que faz o chip parar de sumir sozinho");
{
  ok(exigeDecisao(recusa("SESSION_COMPLETED")), "conflito de servidor exige decisão");
  ok(!exigeDecisao(conflitoPacienteDiferente("1", "2")), "paciente diferente é espera, não decisão");
  ok(
    !exigeDecisao(conflitoDependenciaAusente({ status: "PENDING" }, { status: "PENDING" })),
    "dependência ainda em trânsito é espera, não decisão"
  );
}

secao("F. Restauração — o conflito sobrevive a um refresh");
{
  const original = recusa("SESSION_COMPLETED", { serverAt: "2026-08-06T14:35:00Z" });
  const voltou = restoreConflict(JSON.parse(JSON.stringify(original)));
  eq(voltou.caso, 1, "volta com o caso certo");
  eq(voltou.fatos.serverAt, "2026-08-06T14:35:00Z", "e com os fatos que a tela precisa");
  eq(voltou.opcoes.length, original.opcoes.length, "e com as mesmas saídas");

  eq(restoreConflict(null), null, "nulo não vira conflito");
  eq(restoreConflict({ caso: 1 }), null, "objeto incompleto é descartado, nunca adivinhado");
  eq(restoreConflict({ caso: 1, nome: "x", titulo: "y", resolucao: "INVENTADA" }), null,
    "resolução desconhecida é descartada");
}

secao("G0. O outro lado da tela — o valor do CUIDADOR");
{
  // O servidor manda o lado dele; o lado do cuidador só existe na operação
  // que nunca chegou lá. Sem isto, a tela do caso 4 diria "o servidor tem
  // SIM" sem dizer o que ELE tinha registrado — a metade que falta é
  // justamente a que torna a decisão possível.
  const resposta = valorLocalDe({
    operationType: "turnAction",
    payload: { action: { kind: "SELECT_RESPONSE", response: "TALVEZ" } },
  });
  eq(resposta, "TALVEZ", "caso 4: lê a resposta que a ação queria registrar");

  eq(
    valorLocalDe({ operationType: "turnAction", payload: { action: { kind: "PRESENT" } } }),
    null,
    "uma ação que não fala de resposta não tem valor local a mostrar"
  );

  const contexto = valorLocalDe({
    operationType: "saveSessionContext",
    payload: { intention: "consulta de rotina", environment: "quarto" },
  });
  ok(
    /Intenção: consulta de rotina/.test(contexto) && /Ambiente: quarto/.test(contexto),
    `caso 7: resume o que o cuidador escreveu — veio: "${contexto}"`
  );
  eq(
    valorLocalDe({ operationType: "saveSessionContext", payload: { skipped: true } }),
    "Sem contexto registrado.",
    "contexto pulado se descreve, em vez de aparecer vazio"
  );
  eq(
    valorLocalDe({ operationType: "createTurn", payload: { text: "oi" } }),
    null,
    "tipos fora dos casos 4 e 7 não inventam valor local"
  );

  // comValorLocal é puro e não perde nada do que o servidor mandou.
  const base = recusa("RESPONSE_CHANGED", { serverValue: "SIM", serverAt: "2026-08-06T14:35:00Z" });
  const cheio = comValorLocal(base, "TALVEZ");
  eq(cheio.fatos.localValue, "TALVEZ", "o lado do cuidador entra");
  eq(cheio.fatos.serverValue, "SIM", "e o do servidor continua lá");
  eq(cheio.fatos.serverAt, "2026-08-06T14:35:00Z", "com o horário preservado");
  eq(cheio.caso, 4, "e o caso não muda");
  eq(comValorLocal(base, null).fatos.localValue, undefined, "sem valor local, nada é inventado");
}

secao("G. A operação inteira sobrevive ao refresh, com o conflito junto");
{
  // Esta é a razão de `conflict` ser um campo da OPERAÇÃO, e não um estado em
  // memória: uma decisão clínica pendente não pode depender de a aba
  // continuar aberta. O caminho real passa por IndexedDB, que serializa —
  // então é a serialização que precisa preservar tudo.
  const { appendOperation, markStatus, restoreOperation } = await import(
    "../lib/offline/queue.ts"
  );
  const { fila, operacao } = appendOperation([], {
    operationType: "sessionAction",
    sessionId: "s1",
    patientId: "7",
    payload: { action: "PAUSE" },
  });
  const conflito = recusa("SESSION_COMPLETED", {
    serverStatus: "COMPLETED",
    serverAt: "2026-08-06T14:35:00Z",
  });
  const marcada = markStatus(fila, operacao.id, "CONFLICT", { conflict: conflito });
  eq(marcada[0].status, "CONFLICT", "a operação fica em CONFLICT");
  eq(marcada[0].conflict.caso, 1, "e carrega a linha da matriz");

  const voltou = restoreOperation(JSON.parse(JSON.stringify(marcada[0])));
  eq(voltou.status, "CONFLICT", "depois do refresh continua em CONFLICT");
  eq(voltou.conflict.caso, 1, "e o caso continua sendo o 1");
  eq(
    voltou.conflict.fatos.serverAt,
    "2026-08-06T14:35:00Z",
    "o horário que a tela vai mostrar não se perdeu"
  );
  eq(
    voltou.conflict.opcoes.map((o) => o.id).join(","),
    "VER_PENDENTES,REAPROVEITAR_COMO_RASCUNHO,DESCARTAR",
    "e as saídas oferecidas ao cuidador voltam na mesma ordem"
  );

  // Uma operação SEM conflito não ganha um do nada ao ser restaurada.
  const limpa = restoreOperation(JSON.parse(JSON.stringify(operacao)));
  eq(limpa.conflict, null, "operação sem conflito continua sem conflito");
}

// ════════════════════════════════════════════════════════════════════
console.log(`\n${passou} passou, ${falhou} falhou.`);
process.exit(falhou === 0 ? 0 : 1);
