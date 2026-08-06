// ——— A fila de intenções: teste de domínio (Fase 4.9.2) ———
//
// Puro. Não toca rede, servidor, emulador nem navegador — a fila é um módulo
// de dados, e provar seu comportamento não deveria custar cinquenta segundos
// de dev server.
//
//   npm run test:offline:queue
//
// O que este arquivo existe para impedir, em uma frase cada:
//
//   • que uma operação de um paciente encoste na fila de outro;
//   • que um clique repetido vire dois registros clínicos;
//   • que a ordem em que o cuidador agiu se perca no caminho;
//   • que uma intenção pendente seja apagada sem alguém mandar;
//   • que credencial alguma seja gravada no aparelho.

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const {
  appendOperation,
  markStatus,
  nextSendable,
  pruneSynced,
  restoreOperation,
  resumo,
  temPendenciaIrrecuperavel,
  fingerprint,
  alvoDe,
  ordenada,
  JANELA_CLIQUE_REPETIDO_MS,
  OfflineQueueError,
} = await import("../lib/offline/queue.ts");

const {
  assertPayloadSemSegredo,
  isExpired,
  OfflineSecurityError,
  OFFLINE_SCHEMA_VERSION,
  OFFLINE_SENSITIVE_TTL_MS,
  OFFLINE_TTL_MS,
  patientKey,
  scopeKey,
} = await import("../lib/offline/types.ts");

const { newEntityId, newIdempotencyKey, isValidEntityId, PREFIXO } =
  await import("../lib/offline/ids.ts");

let passed = 0;
let failed = 0;

function check(nome, condicao, detalhe = "") {
  if (condicao) {
    passed++;
    console.log(`  ✓ ${nome}`);
  } else {
    failed++;
    console.error(`  ✗ ${nome} ${detalhe}`);
  }
}

function lanca(nome, fn, trecho = "") {
  try {
    fn();
    failed++;
    console.error(`  ✗ ${nome} — não lançou`);
  } catch (e) {
    const bate = !trecho || String(e.message).includes(trecho);
    if (bate) {
      passed++;
      console.log(`  ✓ ${nome}`);
    } else {
      failed++;
      console.error(`  ✗ ${nome} — mensagem inesperada: ${e.message}`);
    }
  }
}

const PACIENTE = "7";
const SESSAO = "cqs-teste";

function entrada(extra = {}) {
  return {
    operationType: "turnAction",
    sessionId: SESSAO,
    patientId: PACIENTE,
    payload: { sessionId: SESSAO, turnId: "cqt1", action: { kind: "PRESENT" } },
    ...extra,
  };
}

// ---------- 1. Identidade ----------

console.log("\nIdentidade gerada no cliente:");
{
  const a = newEntityId(PREFIXO.node);
  const b = newEntityId(PREFIXO.node);
  check("dois ids do mesmo prefixo nunca coincidem", a !== b);
  check("o id tem o prefixo do domínio", a.startsWith("ocn"));
  check("o formato é aceito pela validação", isValidEntityId(a, PREFIXO.node));
  check(
    "um id com barra é recusado (quebraria o caminho da coleção)",
    !isValidEntityId("ocn/quebra")
  );
  check("id vazio é recusado", !isValidEntityId(""));
  check(
    "id de outro prefixo é recusado quando o prefixo é exigido",
    !isValidEntityId(a, PREFIXO.statement)
  );

  // 2000 ids seguidos: se a aleatoriedade fosse fraca (ou só o timestamp),
  // haveria colisão aqui, porque muitos caem no mesmo milissegundo.
  const vistos = new Set();
  for (let i = 0; i < 2000; i++) vistos.add(newEntityId(PREFIXO.statement));
  check("2000 ids seguidos, nenhuma colisão", vistos.size === 2000);

  const k1 = newIdempotencyKey("createNode");
  const k2 = newIdempotencyKey("createNode");
  check("chaves de idempotência são distintas entre gestos", k1 !== k2);
  check("a chave carrega o tipo da operação", k1.startsWith("createNode-"));
}

// ---------- 2. Escopo ----------

console.log("\nEscopo do armazenamento:");
{
  check(
    "o escopo junta usuário E paciente",
    scopeKey("u1", "7") === "u1::7" && scopeKey("u1", "8") !== scopeKey("u1", "7")
  );
  check("paciente vira string", patientKey(7) === "7");
  lanca("paciente inválido é recusado", () => patientKey(0), "inválido");
  lanca("paciente negativo é recusado", () => patientKey(-3), "inválido");
}

// ---------- 3. Segredos ----------

console.log("\nCredenciais nunca entram no aparelho:");
{
  check("payload comum passa", (assertPayloadSemSegredo({ text: "oi" }), true));

  for (const campo of [
    "token",
    "accessToken",
    "session_token",
    "cookie",
    "password",
    "apiKey",
    "API_KEY",
    "authorization",
    "secret",
    "privateKey",
  ]) {
    lanca(
      `campo "${campo}" é recusado`,
      () => assertPayloadSemSegredo({ [campo]: "x" }),
      "credenciais"
    );
  }

  lanca(
    "segredo aninhado três níveis abaixo também é recusado",
    () => assertPayloadSemSegredo({ a: { b: { c: { apiKey: "x" } } } }),
    "credenciais"
  );
  lanca(
    "segredo dentro de um array é recusado",
    () => assertPayloadSemSegredo({ lista: [{ ok: 1 }, { token: "x" }] }),
    "credenciais"
  );
  check(
    "o erro é do tipo de segurança, não um Error genérico",
    (() => {
      try {
        assertPayloadSemSegredo({ token: "x" });
        return false;
      } catch (e) {
        return e instanceof OfflineSecurityError;
      }
    })()
  );
  lanca(
    "a fila recusa a operação inteira quando o payload tem credencial",
    () => appendOperation([], entrada({ payload: { token: "abc" } })),
    "credenciais"
  );
}

// ---------- 4. Inserção e ordem ----------

console.log("\nOrdem causal:");
{
  let fila = [];
  for (const t of ["a", "b", "c"]) {
    const r = appendOperation(
      fila,
      entrada({
        payload: { sessionId: SESSAO, turnId: t, action: { kind: "PRESENT" } },
      })
    );
    fila = r.fila;
  }
  check("três operações, três sequences", fila.length === 3);
  check(
    "sequence é monotônico a partir de 1",
    fila.map((o) => o.sequence).join(",") === "1,2,3"
  );
  check(
    "ordenada() devolve na ordem em que o cuidador agiu",
    ordenada([...fila].reverse())
      .map((o) => o.payload.turnId)
      .join(",") === "a,b,c"
  );
  check(
    "toda operação nasce PENDING",
    fila.every((o) => o.status === "PENDING")
  );
  check(
    "toda operação carrega a versão do schema",
    fila.every((o) => o.schemaVersion === OFFLINE_SCHEMA_VERSION)
  );
  check(
    "toda operação carrega os campos obrigatórios do modelo",
    fila.every(
      (o) =>
        typeof o.id === "string" &&
        typeof o.idempotencyKey === "string" &&
        typeof o.sessionId === "string" &&
        typeof o.patientId === "string" &&
        typeof o.operationType === "string" &&
        typeof o.createdAt === "string" &&
        typeof o.retryCount === "number"
    )
  );
  check("retryCount começa em zero", fila.every((o) => o.retryCount === 0));
  check(
    "nextRetryAt e lastError começam vazios",
    fila.every((o) => o.nextRetryAt === null && o.lastError === null)
  );
}

// ---------- 5. Nunca misturar pacientes ----------

console.log("\nNunca misturar pacientes:");
{
  const { fila } = appendOperation([], entrada());
  lanca(
    "operação de outro paciente é recusada pela fila",
    () => appendOperation(fila, entrada({ patientId: "8" })),
    "recusando operação do paciente 8"
  );
  check(
    "a fila original não foi tocada pela tentativa",
    fila.length === 1 && fila[0].patientId === PACIENTE
  );
  lanca(
    "operação sem paciente é recusada",
    () => appendOperation([], entrada({ patientId: "" })),
    "sem paciente"
  );
  lanca(
    "operação sem sessão é recusada",
    () => appendOperation([], entrada({ sessionId: "" })),
    "sem sessão"
  );
}

// ---------- 6. Duplicação local ----------

console.log("\nImpedir duplicação local:");
{
  const chave = newIdempotencyKey("createTurn");
  const r1 = appendOperation([], entrada({ idempotencyKey: chave }));
  const r2 = appendOperation(r1.fila, entrada({ idempotencyKey: chave }));
  check("mesma chave de idempotência não cria segunda operação", r2.fila.length === 1);
  check("e devolve a operação original", r2.operacao.id === r1.operacao.id);
  check("marcada como deduplicada", r2.deduplicada === true);

  // Mesmo conteúdo, sem chave: clique repetido dentro da janela.
  const t0 = Date.parse("2026-08-04T10:00:00.000Z");
  const a = appendOperation([], entrada(), t0);
  const b = appendOperation(a.fila, entrada(), t0 + 500);
  check("clique repetido dentro da janela vira uma operação só", b.fila.length === 1);

  // Fora da janela é OUTRA intenção — e precisa ser, senão o segundo
  // "repetir, por favor" do paciente desapareceria.
  const c = appendOperation(a.fila, entrada(), t0 + JANELA_CLIQUE_REPETIDO_MS + 1);
  check(
    "o mesmo gesto fora da janela é intenção nova",
    c.fila.length === 2 && c.deduplicada === false
  );

  check(
    "a impressão digital ignora a ordem das chaves do payload",
    fingerprint("x", { a: 1, b: 2 }) === fingerprint("x", { b: 2, a: 1 })
  );
  check(
    "mas distingue conteúdos diferentes",
    fingerprint("x", { a: 1 }) !== fingerprint("x", { a: 2 })
  );
  check(
    "e distingue tipos de operação",
    fingerprint("x", { a: 1 }) !== fingerprint("y", { a: 1 })
  );
}

// ---------- 7. Dependências ----------

console.log("\nDependências entre operações:");
{
  const nodeId = newEntityId(PREFIXO.node);
  const pathId = newEntityId(PREFIXO.path);

  let fila = [];
  fila = appendOperation(fila, {
    operationType: "createPath",
    sessionId: SESSAO,
    patientId: PACIENTE,
    createdEntityId: pathId,
    payload: { sessionId: SESSAO, pathId },
  }).fila;
  fila = appendOperation(fila, {
    operationType: "createNode",
    sessionId: SESSAO,
    patientId: PACIENTE,
    createdEntityId: nodeId,
    payload: { sessionId: SESSAO, pathId, nodeId, promptText: "onde dói?" },
  }).fila;
  fila = appendOperation(fila, {
    operationType: "nodeAction",
    sessionId: SESSAO,
    patientId: PACIENTE,
    payload: { sessionId: SESSAO, pathId, nodeId, action: { kind: "PRESENT" } },
  }).fila;

  check(
    "criar o nível depende de criar o caminho",
    fila[1].dependsOn.includes(fila[0].sequence)
  );
  check(
    "apresentar o nível depende de criá-lo",
    fila[2].dependsOn.includes(fila[1].sequence)
  );
  check("a criação do caminho não depende de nada", fila[0].dependsOn.length === 0);

  // Duas ações sobre o MESMO nível preservam a ordem entre si.
  fila = appendOperation(fila, {
    operationType: "nodeAction",
    sessionId: SESSAO,
    patientId: PACIENTE,
    payload: {
      sessionId: SESSAO,
      pathId,
      nodeId,
      action: { kind: "AWAIT_SELECTION" },
    },
  }).fila;
  check(
    "a segunda ação sobre o mesmo nível depende da primeira",
    fila[3].dependsOn.includes(fila[2].sequence)
  );

  check("alvoDe reconhece o nível", alvoDe(fila[2]) === nodeId);
  check("alvoDe de uma criação é nulo", alvoDe(fila[0]) === null);
}

// ---------- 8. A fila para no primeiro problema ----------

console.log("\nA fila para no primeiro problema:");
{
  let fila = [];
  for (const t of ["a", "b", "c"]) {
    fila = appendOperation(
      fila,
      entrada({
        payload: { sessionId: SESSAO, turnId: t, action: { kind: "PRESENT" } },
      })
    ).fila;
  }

  const primeira = nextSendable(fila);
  check("a próxima a enviar é a primeira da ordem", primeira.kind === "ENVIAR");
  check("e é mesmo a de sequence 1", primeira.operacao.sequence === 1);

  const comConflito = markStatus(fila, fila[0].id, "CONFLICT");
  const bloqueada = nextSendable(comConflito);
  check(
    "um conflito interrompe a fila inteira",
    bloqueada.kind === "BLOQUEADA_POR_DECISAO"
  );
  check(
    "e nada depois dele é oferecido para envio",
    bloqueada.operacao.sequence === 1
  );

  const comFalha = markStatus(fila, fila[1].id, "FAILED");
  const apos = nextSendable(comFalha);
  check(
    "a operação anterior à falha ainda pode ir",
    apos.kind === "ENVIAR" && apos.operacao.sequence === 1
  );

  // Dependência não satisfeita bloqueia sem virar erro.
  const pathId = newEntityId(PREFIXO.path);
  let dep = appendOperation([], {
    operationType: "createPath",
    sessionId: SESSAO,
    patientId: PACIENTE,
    createdEntityId: pathId,
    payload: { sessionId: SESSAO, pathId },
  }).fila;
  dep = appendOperation(dep, {
    operationType: "pathAction",
    sessionId: SESSAO,
    patientId: PACIENTE,
    payload: { sessionId: SESSAO, pathId, action: { kind: "PAUSE" } },
  }).fila;
  const comCriacaoConfirmada = markStatus(
    markStatus(dep, dep[0].id, "SYNCING"),
    dep[0].id,
    "SYNCED"
  );
  const liberada = nextSendable(comCriacaoConfirmada);
  check(
    "com a criação confirmada, a dependente é liberada",
    liberada.kind === "ENVIAR" && liberada.operacao.sequence === 2
  );

  // Backoff respeitado.
  const futuro = new Date(Date.now() + 60_000).toISOString();
  const esperando = markStatus(dep, dep[0].id, "FAILED", {
    nextRetryAt: futuro,
  });
  const retomada = markStatus(esperando, dep[0].id, "PENDING");
  const aguardando = nextSendable(retomada);
  check(
    "o backoff segura a operação até a hora marcada",
    aguardando.kind === "AGUARDANDO_BACKOFF"
  );

  check("fila vazia devolve VAZIA", nextSendable([]).kind === "VAZIA");
}

// ---------- 9. Transições de status ----------

console.log("\nTransições de status da fila:");
{
  const { fila, operacao } = appendOperation([], entrada());

  const enviando = markStatus(fila, operacao.id, "SYNCING");
  check("PENDING → SYNCING é permitido", enviando[0].status === "SYNCING");

  const confirmada = markStatus(enviando, operacao.id, "SYNCED");
  check("SYNCING → SYNCED é permitido", confirmada[0].status === "SYNCED");

  lanca(
    "SYNCED é terminal: nada o desfaz localmente",
    () => markStatus(confirmada, operacao.id, "PENDING"),
    "transição inválida"
  );
  lanca(
    "PENDING não pula direto para SYNCED",
    () => markStatus(fila, operacao.id, "SYNCED"),
    "transição inválida"
  );
  check(
    "um erro é registrado junto com a mudança",
    markStatus(fila, operacao.id, "FAILED", {
      error: { kind: "unknown", message: "x", at: "agora" },
      incrementRetry: true,
    })[0].retryCount === 1
  );
  check(
    "conflito volta a PENDING por decisão do cuidador",
    markStatus(markStatus(fila, operacao.id, "CONFLICT"), operacao.id, "PENDING")[0]
      .status === "PENDING"
  );
  check(
    "o erro do tipo certo é lançado",
    (() => {
      try {
        markStatus(confirmada, operacao.id, "PENDING");
        return false;
      } catch (e) {
        return e instanceof OfflineQueueError;
      }
    })()
  );
}

// ---------- 10. Nunca apagar pendência em silêncio ----------

console.log("\nNunca apagar operação pendente:");
{
  let fila = [];
  for (const t of ["a", "b", "c", "d"]) {
    fila = appendOperation(
      fila,
      entrada({
        payload: { sessionId: SESSAO, turnId: t, action: { kind: "PRESENT" } },
      })
    ).fila;
  }
  fila = markStatus(markStatus(fila, fila[0].id, "SYNCING"), fila[0].id, "SYNCED");
  fila = markStatus(fila, fila[1].id, "CONFLICT");
  fila = markStatus(fila, fila[2].id, "FAILED");

  const { fila: podada, removidas } = pruneSynced(fila);
  check("só a confirmada sai", removidas === 1 && podada.length === 3);
  check(
    "a que está em conflito fica",
    podada.some((o) => o.status === "CONFLICT")
  );
  check(
    "a que falhou fica",
    podada.some((o) => o.status === "FAILED")
  );
  check(
    "a que ainda espera fica",
    podada.some((o) => o.status === "PENDING")
  );
  check(
    "temPendenciaIrrecuperavel avisa que há o que perder",
    temPendenciaIrrecuperavel(podada) === true
  );
  check(
    "e não avisa quando tudo foi confirmado",
    temPendenciaIrrecuperavel([{ status: "SYNCED" }]) === false
  );
}

// ---------- 11. Restauração após refresh ----------

console.log("\nRestauração após refresh:");
{
  const { operacao } = appendOperation([], entrada());
  const voltou = restoreOperation(JSON.parse(JSON.stringify(operacao)));
  check("uma operação íntegra volta inteira", voltou !== null);
  check("com a MESMA chave de idempotência", voltou.idempotencyKey === operacao.idempotencyKey);
  check("com o mesmo sequence", voltou.sequence === operacao.sequence);
  check("com o mesmo payload", JSON.stringify(voltou.payload) === JSON.stringify(operacao.payload));
  check("e com o mesmo paciente", voltou.patientId === operacao.patientId);

  const emVoo = restoreOperation({ ...operacao, status: "SYNCING" });
  check(
    "SYNCING volta como PENDING — ninguém está mais em voo depois de um refresh",
    emVoo.status === "PENDING"
  );

  check("linha sem id é descartada", restoreOperation({ ...operacao, id: "" }) === null);
  check(
    "linha sem chave de idempotência é descartada",
    restoreOperation({ ...operacao, idempotencyKey: "" }) === null
  );
  check(
    "linha com status desconhecido é descartada",
    restoreOperation({ ...operacao, status: "TALVEZ" }) === null
  );
  check(
    "linha de outra versão de schema é descartada",
    restoreOperation({ ...operacao, schemaVersion: 999 }) === null
  );
  check(
    "linha com data inválida é descartada",
    restoreOperation({ ...operacao, createdAt: "ontem" }) === null
  );
  check("null é descartado", restoreOperation(null) === null);
  check(
    "uma operação confirmada volta confirmada",
    restoreOperation({ ...operacao, status: "SYNCED" }).status === "SYNCED"
  );
}

// ---------- 12. Estado visual ----------

console.log("\nO que o cuidador vê:");
{
  let fila = [];
  check(
    "fila vazia e online: nada a mostrar",
    resumo(fila, true).state === "SEM_PENDENCIA"
  );

  fila = appendOperation(fila, entrada()).fila;
  check(
    "com pendência e sem rede: Aguardando conexão",
    resumo(fila, false).state === "AGUARDANDO_CONEXAO"
  );
  check(
    "com pendência e com rede: Sincronização pendente",
    resumo(fila, true).state === "SINCRONIZACAO_PENDENTE"
  );
  check("a contagem de pendentes é exata", resumo(fila, false).pending === 1);

  const comConflito = markStatus(fila, fila[0].id, "CONFLICT");
  check(
    "conflito domina os outros estados",
    resumo(comConflito, true).state === "CONFLITO"
  );

  const comFalha = markStatus(fila, fila[0].id, "FAILED");
  check("falha aparece como falha", resumo(comFalha, true).state === "FALHA");

  // Até aqui, nenhum caminho testado passou pelo servidor — e nenhum produz
  // "Sincronizado". A partir da Fase B isso deixa de ser universal: existe
  // um caminho real que leva lá, e é ele que os testes abaixo percorrem.
  const semServidorAinda = new Set(
    [
      resumo([], true),
      resumo([], false),
      resumo(fila, true),
      resumo(fila, false),
      resumo(comConflito, true),
      resumo(comFalha, true),
    ].map((r) => r.state)
  );
  check(
    "nenhum destes caminhos produz 'Sincronizado' — nenhum passou por confirmação",
    ![...semServidorAinda].some((e) => String(e).includes("SINCRONIZADO"))
  );

  // Fase B: "Sincronizado" nasce EXATAMENTE da confirmação — SYNCED de
  // verdade na fila — nunca da ausência de pendência sozinha.
  const emVoo = markStatus(fila, fila[0].id, "SYNCING");
  check(
    "uma operação em voo mostra 'Sincronizando', não 'pendente'",
    resumo(emVoo, true).state === "SINCRONIZANDO"
  );
  const confirmada = markStatus(emVoo, fila[0].id, "SYNCED");
  check(
    "confirmada pelo servidor: 'Sincronizado', com a contagem exata",
    resumo(confirmada, true).state === "SINCRONIZADO" &&
      resumo(confirmada, true).synced === 1 &&
      resumo(confirmada, true).pending === 0
  );

  // 401/403 (Fase B, §9): a fila fica FAILED, mas o texto certo é "entre de
  // novo" — não "não conseguimos enviar", que sugere um problema de rede.
  const semAutorizacao = markStatus(fila, fila[0].id, "FAILED", {
    error: { kind: "unauthorized", message: "sessão expirada", at: new Date().toISOString() },
  });
  check(
    "401/403 mostra 'Autenticação necessária', não 'Falha' genérica",
    resumo(semAutorizacao, true).state === "AUTENTICACAO_NECESSARIA"
  );
}

// ---------- 13. Expiração ----------

console.log("\nExpiração local:");
{
  const agora = Date.parse("2026-08-04T12:00:00.000Z");
  const iso = (ms) => new Date(agora - ms).toISOString();

  check("recém-gravado não expira", !isExpired(iso(1000), agora, false));
  check(
    "conteúdo comum sobrevive a 6 dias",
    !isExpired(iso(6 * 24 * 3600_000), agora, false)
  );
  check(
    "conteúdo comum expira depois de 7 dias",
    isExpired(iso(OFFLINE_TTL_MS + 1000), agora, false)
  );
  check(
    "conteúdo sensível sobrevive a 23 horas",
    !isExpired(iso(23 * 3600_000), agora, true)
  );
  check(
    "conteúdo sensível expira depois de 24 horas",
    isExpired(iso(OFFLINE_SENSITIVE_TTL_MS + 1000), agora, true)
  );
  check(
    "o prazo do sensível é mais curto que o comum",
    OFFLINE_SENSITIVE_TTL_MS < OFFLINE_TTL_MS
  );
  check("data ilegível conta como expirada", isExpired("qualquer coisa", agora, false));
}

// ---------- Resultado ----------

console.log(`\n${passed} passaram · ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
