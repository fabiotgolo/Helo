// ——— Isolamento do contexto de auditoria sob concorrência (Fase 4.9.5) ———
//
// A origem da operação viaja do handler HTTP até `writeAudit` por
// `AsyncLocalStorage`. É a escolha certa para 48 pontos de gravação — e é
// também a escolha que, se estivesse errada, erraria em silêncio e do pior
// jeito possível: a operação de um cuidador levando o metadado da operação de
// outro, numa trilha clínica, sem nada na tela indicando isso.
//
// Este arquivo existe para não aceitar "deve funcionar" como resposta.
//
//   npm run emu                        (terminal 1)
//   npm run dev                        (terminal 2)
//   npm run test:audit-concorrencia    (terminal 3)
//
// O que ele prova, em uma frase cada:
//
//   • que requisições SIMULTÂNEAS com origens diferentes não se misturam;
//   • que uma requisição sem origem offline não herda a da vizinha;
//   • que o reenvio concorrente da mesma chave não duplica evento.

import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";
// Guarda: esta suíte apaga o banco inteiro. Ver scripts/emulator-guard.mjs.
assertEmuladorDescartavel(EMU, DB, "test-audit-concorrencia.mjs");

/** Pares simultâneos. Mais que dois, para que o interleaving seja real. */
const PARES = 8;

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

function client() {
  let cookie = "";
  return {
    async req(method, path, body) {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = r.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      let json = null;
      try {
        json = await r.json();
      } catch {}
      return { status: r.status, json };
    },
    get(p) { return this.req("GET", p); },
    post(p, b) { return this.req("POST", p, b); },
    patch(p, b) { return this.req("PATCH", p, b); },
  };
}

async function main() {
  console.log(`base: ${BASE} · emulador: ${EMU} (db ${DB})`);
  const wipe = await fetch(
    `http://${EMU}/emulator/v1/projects/${PROJECT}/databases/${DB}/documents`,
    { method: "DELETE" }
  );
  if (!wipe.ok) {
    console.error("não consegui limpar o emulador — abortando");
    process.exit(1);
  }
  console.log("emulador limpo.\n");

  const admin = client();
  const claudia = client();
  await admin.post("/api/auth/bootstrap", {
    name: "Admin", email: "admin@helo.test", password: "senha-admin-123",
  });
  const rClaudia = await admin.post("/api/admin/users", {
    name: "Claudia", email: "claudia@helo.test", password: "senha-teste-123",
    role: "profissional", professionalType: "fonoaudiologo",
  });
  await claudia.post("/api/auth/login", {
    email: "claudia@helo.test", password: "senha-teste-123",
  });
  const pFabio = (await admin.post("/api/patients", { name: "Dr. Fábio" })).json.patient.id;
  await admin.post("/api/admin/access", {
    userId: rClaudia.json.user.id, patientId: pFabio,
    permissions: ["viewSessions", "createSession"],
  });

  const eventos = async (sessionId) => {
    const r = await claudia.get(
      `/api/realtime-questions/events?patientId=${pFabio}&sessionId=${sessionId}`
    );
    return r.json?.events ?? [];
  };

  // ════ 1. Criações SIMULTÂNEAS, origens diferentes ════
  //
  // A criação de sessão já grava evento. Disparar as duas metades juntas, sem
  // await entre elas, é o que coloca dois contextos vivos ao mesmo tempo
  // dentro do mesmo processo do servidor.
  console.log(`\n1. ${PARES * 2} sessões simultâneas — metade offline, metade online:`);
  {
    const intencaoDe = (i) =>
      new Date(Date.parse("2026-08-07T12:00:00.000Z") + i * 60_000).toISOString();

    const pedidos = [];
    for (let i = 0; i < PARES; i++) {
      // Offline, com um intendedAt DISTINTO por par — assim um vazamento não
      // se esconde atrás de dois valores iguais.
      pedidos.push(
        claudia
          .post("/api/realtime-questions/sessions", {
            patientId: pFabio,
            offlineQueued: true,
            intendedAt: intencaoDe(i),
          })
          .then((r) => ({ tipo: "offline", i, r }))
      );
      // Online, sem nenhum campo de origem no corpo.
      pedidos.push(
        claudia
          .post("/api/realtime-questions/sessions", { patientId: pFabio })
          .then((r) => ({ tipo: "online", i, r }))
      );
    }

    const respostas = await Promise.all(pedidos);
    check(
      "todas as criações passaram",
      respostas.every((x) => x.r.status === 200),
      JSON.stringify(respostas.filter((x) => x.r.status !== 200).map((x) => x.r.json))
    );

    const conferidas = await Promise.all(
      respostas.map(async (x) => ({
        ...x,
        evs: await eventos(x.r.json.session.id),
      }))
    );

    const offline = conferidas.filter((x) => x.tipo === "offline");
    const online = conferidas.filter((x) => x.tipo === "online");

    check(
      "cada sessão offline recebeu offlineQueued=true",
      offline.every((x) => x.evs.every((e) => e.metadata?.offlineQueued === true)),
      JSON.stringify(offline.filter((x) => !x.evs.every((e) => e.metadata?.offlineQueued === true)).map((x) => x.evs.map((e) => e.metadata)))
    );
    check(
      "e cada uma com o SEU intendedAt — nenhum trocado com o do vizinho",
      offline.every((x) => x.evs.every((e) => e.metadata?.intendedAt === intencaoDe(x.i))),
      JSON.stringify(
        offline
          .filter((x) => !x.evs.every((e) => e.metadata?.intendedAt === intencaoDe(x.i)))
          .map((x) => ({ esperado: intencaoDe(x.i), veio: x.evs.map((e) => e.metadata?.intendedAt) }))
      )
    );
    check(
      "nenhuma sessão ONLINE herdou a origem da vizinha simultânea",
      online.every((x) => x.evs.every((e) => e.metadata?.offlineQueued === false)),
      JSON.stringify(online.map((x) => x.evs.map((e) => e.metadata)))
    );
    check(
      "e nenhuma ganhou um intendedAt emprestado",
      online.every((x) => x.evs.every((e) => !e.metadata?.intendedAt)),
      JSON.stringify(online.map((x) => x.evs.map((e) => e.metadata)))
    );

    // Os intendedAt vistos, como conjunto, têm de ser exatamente os enviados.
    const vistos = new Set(
      offline.flatMap((x) => x.evs.map((e) => e.metadata?.intendedAt))
    );
    const enviados = new Set(Array.from({ length: PARES }, (_, i) => intencaoDe(i)));
    check(
      "o conjunto de horários gravados é exatamente o conjunto enviado",
      vistos.size === enviados.size &&
        [...vistos].every((v) => enviados.has(v)),
      `gravados: ${[...vistos].join(", ")}`
    );
  }

  // ════ 2. Uma operação no MEIO do fogo cruzado ════
  //
  // Uma sessão só, criada enquanto oito operações offline estão em voo. Ela
  // não manda campo de origem nenhum. Se o contexto vazasse, é aqui que ele
  // apareceria.
  console.log("\n2. Operação sem origem, disparada no meio das offline:");
  {
    const barulho = Array.from({ length: PARES }, (_, i) =>
      claudia.post("/api/realtime-questions/sessions", {
        patientId: pFabio,
        offlineQueued: true,
        intendedAt: new Date(Date.parse("2026-08-07T09:00:00.000Z") + i * 1000).toISOString(),
      })
    );
    const limpa = claudia.post("/api/realtime-questions/sessions", { patientId: pFabio });
    const [rLimpa] = await Promise.all([limpa, ...barulho]);

    check("a operação limpa passou", rLimpa.status === 200, JSON.stringify(rLimpa.json));
    const evs = await eventos(rLimpa.json.session.id);
    check("ela gravou evento", evs.length > 0);
    check(
      "com offlineQueued=false",
      evs.every((e) => e.metadata?.offlineQueued === false),
      JSON.stringify(evs.map((e) => e.metadata))
    );
    check(
      "e SEM intendedAt — nada vazou das oito vizinhas",
      evs.every((e) => !e.metadata?.intendedAt),
      JSON.stringify(evs.map((e) => e.metadata))
    );
  }

  // ════ 3. Turnos simultâneos na MESMA sessão ════
  //
  // O caso mais apertado: mesmo documento, mesma coleção de eventos, origens
  // diferentes. Aqui um vazamento não teria nem a separação por sessão para
  // disfarçar.
  console.log("\n3. Turnos simultâneos na mesma sessão, origens diferentes:");
  let sessaoComum;
  {
    sessaoComum = (
      await claudia.post("/api/realtime-questions/sessions", { patientId: pFabio })
    ).json.session.id;

    const INTENCAO = "2026-08-07T10:15:00.000Z";
    const pedidos = [];
    for (let i = 0; i < PARES; i++) {
      pedidos.push(
        claudia
          .post("/api/realtime-questions/turns", {
            patientId: pFabio,
            sessionId: sessaoComum,
            text: `offline ${i}`,
            questionSource: "MANUAL_TEXT",
            clientRequestId: `conc-off-${i}`,
            offlineQueued: true,
            intendedAt: INTENCAO,
          })
          .then((r) => ({ tipo: "offline", r }))
      );
      pedidos.push(
        claudia
          .post("/api/realtime-questions/turns", {
            patientId: pFabio,
            sessionId: sessaoComum,
            text: `online ${i}`,
            questionSource: "MANUAL_TEXT",
            clientRequestId: `conc-on-${i}`,
          })
          .then((r) => ({ tipo: "online", r }))
      );
    }
    const respostas = await Promise.all(pedidos);
    check(
      "todos os turnos passaram",
      respostas.every((x) => x.r.status === 200),
      JSON.stringify(respostas.filter((x) => x.r.status !== 200).map((x) => x.r.json))
    );

    const porTurno = new Map();
    for (const x of respostas) porTurno.set(x.r.json.turn.id, x.tipo);

    const evs = await eventos(sessaoComum);
    const doTurno = evs.filter((e) => e.turnId && porTurno.has(e.turnId));
    check(
      "há evento para os turnos criados",
      doTurno.length >= PARES * 2,
      `${doTurno.length} eventos para ${PARES * 2} turnos`
    );

    const errados = doTurno.filter((e) => {
      const tipo = porTurno.get(e.turnId);
      return tipo === "offline"
        ? e.metadata?.offlineQueued !== true || e.metadata?.intendedAt !== INTENCAO
        : e.metadata?.offlineQueued !== false || Boolean(e.metadata?.intendedAt);
    });
    check(
      "CADA evento levou exclusivamente a origem da SUA requisição",
      errados.length === 0,
      JSON.stringify(errados.map((e) => ({ turnId: e.turnId, tipo: porTurno.get(e.turnId), metadata: e.metadata })))
    );
  }

  // ════ 4. Reenvio concorrente da mesma chave ════
  console.log("\n4. Reenvio concorrente da MESMA chave de idempotência:");
  {
    const antes = (await eventos(sessaoComum)).length;
    const mesmoPedido = () =>
      claudia.post("/api/realtime-questions/turns", {
        patientId: pFabio,
        sessionId: sessaoComum,
        text: "reenvio concorrente",
        questionSource: "MANUAL_TEXT",
        clientRequestId: "conc-reenvio",
        offlineQueued: true,
        intendedAt: "2026-08-07T10:30:00.000Z",
      });

    const respostas = await Promise.all([
      mesmoPedido(), mesmoPedido(), mesmoPedido(), mesmoPedido(),
    ]);
    check(
      "as quatro respostas voltaram bem",
      respostas.every((r) => r.status === 200),
      JSON.stringify(respostas.filter((r) => r.status !== 200).map((r) => r.json))
    );
    const ids = new Set(respostas.map((r) => r.json.turn.id));
    check("as quatro descrevem o MESMO turno", ids.size === 1, [...ids].join(", "));

    const depois = await eventos(sessaoComum);
    const novos = depois.length - antes;
    check(
      "UM evento novo, não quatro",
      novos === 1,
      `${novos} eventos novos`
    );
    const doReenvio = depois.filter((e) => e.turnId === [...ids][0]);
    check(
      "e ele carrega a origem enviada",
      doReenvio.every(
        (e) =>
          e.metadata?.offlineQueued === true &&
          e.metadata?.intendedAt === "2026-08-07T10:30:00.000Z"
      ),
      JSON.stringify(doReenvio.map((e) => e.metadata))
    );
  }

  console.log(`\n${passed} passou, ${failed} falhou.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
