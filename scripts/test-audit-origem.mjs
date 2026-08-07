// ——— A trilha distingue offline de online (Fase 4.9.5) ———
//
// Contra o servidor de verdade. Prova a §3.5 e o item 7 da §7 da auditoria,
// que a Fase E descobriu prometidos e nunca implementados: a trilha não
// distinguia uma operação nascida sem rede de uma nascida com rede, e uma
// conversa inteira conduzida offline aparecia como se tivesse acontecido no
// minuto em que a conexão voltou.
//
//   npm run emu                     (terminal 1)
//   npm run dev                     (terminal 2)
//   npm run test:audit-origem       (terminal 3)
//
// O que este arquivo existe para impedir, em uma frase cada:
//
//   • que uma operação offline chegue à trilha indistinguível de uma online;
//   • que `intendedAt` seja gravado como se fosse horário do servidor;
//   • que `createdAt` deixe de ser cunhado pelo servidor;
//   • que um relógio adiantado empurre um "amanhã" para dentro do prontuário;
//   • que um reenvio duplique o evento — ou troque a origem já registrada.

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";

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

  // ════ 1. Nasceu OFFLINE: a trilha diz isso, e diz quando ════
  console.log("\n1. Operação nascida offline, sincronizada depois:");
  let sessaoOffline;
  const INTENCAO = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  {
    const r = await claudia.post("/api/realtime-questions/sessions", {
      patientId: pFabio,
      offlineQueued: true,
      intendedAt: INTENCAO,
    });
    check("a sessão é criada", r.status === 200, JSON.stringify(r.json));
    sessaoOffline = r.json.session.id;

    const evs = await eventos(sessaoOffline);
    const inicio = evs[0];
    check("a trilha registrou o evento", inicio !== undefined);
    check(
      "metadata.offlineQueued = true",
      inicio?.metadata?.offlineQueued === true,
      JSON.stringify(inicio?.metadata)
    );
    check(
      "metadata.intendedAt é o horário do APARELHO",
      inicio?.metadata?.intendedAt === INTENCAO,
      `esperava ${INTENCAO}, veio ${inicio?.metadata?.intendedAt}`
    );
    check(
      "createdAt continua sendo do SERVIDOR — e é BEM depois da intenção",
      Date.parse(inicio.createdAt) - Date.parse(INTENCAO) > 10 * 60 * 1000,
      `createdAt=${inicio.createdAt} intendedAt=${INTENCAO}`
    );
    check(
      "createdAt NÃO foi substituído pelo relógio do aparelho",
      inicio.createdAt !== INTENCAO
    );
  }

  // ════ 2. Nasceu ONLINE: nada de classificação indevida ════
  console.log("\n2. Operação nascida online:");
  let sessaoOnline;
  {
    const r = await claudia.post("/api/realtime-questions/sessions", {
      patientId: pFabio,
    });
    sessaoOnline = r.json.session.id;
    const evs = await eventos(sessaoOnline);
    const inicio = evs[0];
    check(
      "metadata.offlineQueued = false",
      inicio?.metadata?.offlineQueued === false,
      JSON.stringify(inicio?.metadata)
    );
    check(
      "sem intendedAt — o servidor não inventa um horário que ninguém informou",
      inicio?.metadata?.intendedAt === undefined ||
        inicio?.metadata?.intendedAt === null,
      JSON.stringify(inicio?.metadata)
    );
  }

  // ════ 3. Toda a conversa offline, não só a primeira operação ════
  console.log("\n3. A marcação acompanha a conversa inteira:");
  let turnoId;
  {
    const criar = await claudia.post("/api/realtime-questions/turns", {
      patientId: pFabio,
      sessionId: sessaoOffline,
      text: "está com dor?",
      questionSource: "MANUAL_TEXT",
      clientRequestId: "req-turno-offline-1",
      offlineQueued: true,
      intendedAt: INTENCAO,
    });
    check("o turno é criado", criar.status === 200, JSON.stringify(criar.json));
    turnoId = criar.json.turn.id;

    const revisar = await claudia.patch("/api/realtime-questions/turns", {
      patientId: pFabio,
      sessionId: sessaoOffline,
      turnId: turnoId,
      action: { kind: "REVIEW", reviewedText: "você está com dor?" },
      clientRequestId: "req-turno-offline-2",
      offlineQueued: true,
      intendedAt: INTENCAO,
    });
    check("a revisão passa", revisar.status === 200, JSON.stringify(revisar.json));

    const evs = await eventos(sessaoOffline);
    const marcados = evs.filter((e) => e.metadata?.offlineQueued === true);
    check(
      "TODOS os eventos da conversa offline estão marcados",
      marcados.length === evs.length && evs.length >= 3,
      `${marcados.length} de ${evs.length}`
    );
    check(
      "e todos com o MESMO intendedAt",
      evs.every((e) => e.metadata?.intendedAt === INTENCAO)
    );
    check(
      "os createdAt do servidor são distintos entre si — cada um no seu instante",
      new Set(evs.map((e) => e.createdAt)).size > 1
    );
  }

  // ════ 4. Reenvio: mesma chave, um evento só, origem intacta ════
  console.log("\n4. Reenvio da MESMA operação (idempotência):");
  {
    const antes = await eventos(sessaoOffline);
    const r = await claudia.patch("/api/realtime-questions/turns", {
      patientId: pFabio,
      sessionId: sessaoOffline,
      turnId: turnoId,
      action: { kind: "REVIEW", reviewedText: "você está com dor?" },
      clientRequestId: "req-turno-offline-2", // a MESMA de antes
      offlineQueued: true,
      intendedAt: INTENCAO,
    });
    check("o reenvio é aceito", r.status === 200, JSON.stringify(r.json));
    const depois = await eventos(sessaoOffline);
    check(
      "NENHUM evento novo — o ledger devolveu o resultado já aplicado",
      depois.length === antes.length,
      `antes ${antes.length}, depois ${depois.length}`
    );
    check(
      "e a origem registrada não mudou",
      depois.every((e) => e.metadata?.offlineQueued === true)
    );
    check(
      "nem o intendedAt",
      depois.every((e) => e.metadata?.intendedAt === INTENCAO)
    );
  }

  // ════ 5. Reenvio com origem DIFERENTE não reescreve a trilha ════
  console.log("\n5. Reenvio mentindo a origem não reescreve o que já está gravado:");
  {
    const antes = await eventos(sessaoOffline);
    const r = await claudia.patch("/api/realtime-questions/turns", {
      patientId: pFabio,
      sessionId: sessaoOffline,
      turnId: turnoId,
      action: { kind: "REVIEW", reviewedText: "você está com dor?" },
      clientRequestId: "req-turno-offline-2",
      offlineQueued: false, // agora diz que foi online
      intendedAt: new Date().toISOString(),
    });
    check("aceito (é o mesmo pedido de sempre)", r.status === 200);
    const depois = await eventos(sessaoOffline);
    check("nenhum evento novo", depois.length === antes.length);
    check(
      "a trilha continua dizendo offline — evento gravado não se reescreve",
      depois.every((e) => e.metadata?.offlineQueued === true)
    );
    check(
      "e continua com o intendedAt original",
      depois.every((e) => e.metadata?.intendedAt === INTENCAO)
    );
  }

  // ════ 6. Relógio local inválido não contamina ════
  console.log("\n6. Relógio local mentiroso:");
  {
    const futuro = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const r = await claudia.post("/api/realtime-questions/turns", {
      patientId: pFabio,
      sessionId: sessaoOffline,
      text: "quer água?",
      questionSource: "MANUAL_TEXT",
      clientRequestId: "req-relogio-quebrado",
      offlineQueued: true,
      intendedAt: futuro,
    });
    check("a operação acontece assim mesmo", r.status === 200, JSON.stringify(r.json));

    const evs = await eventos(sessaoOffline);
    const doTurnoNovo = evs.filter((e) => e.turnId === r.json.turn.id);
    check("o evento existe", doTurnoNovo.length > 0);
    check(
      "o horário impossível NÃO entrou na trilha",
      doTurnoNovo.every((e) => e.metadata?.intendedAt === undefined ||
        e.metadata?.intendedAt === null),
      JSON.stringify(doTurnoNovo[0]?.metadata)
    );
    check(
      "mas a ORIGEM offline continua registrada — é o que se sabe de verdade",
      doTurnoNovo.every((e) => e.metadata?.offlineQueued === true)
    );
    check(
      "createdAt do servidor não foi para o futuro",
      doTurnoNovo.every((e) => Date.parse(e.createdAt) < Date.now() + 60_000)
    );

    const texto = await claudia.post("/api/realtime-questions/turns", {
      patientId: pFabio,
      sessionId: sessaoOffline,
      text: "quer suco?",
      questionSource: "MANUAL_TEXT",
      clientRequestId: "req-relogio-texto",
      offlineQueued: true,
      intendedAt: "ontem de manhã",
    });
    check("texto livre como horário não derruba a operação", texto.status === 200);
    const evs2 = await eventos(sessaoOffline);
    const doTexto = evs2.filter((e) => e.turnId === texto.json.turn.id);
    check(
      "e não vira horário nenhum na trilha",
      doTexto.every((e) => !e.metadata?.intendedAt)
    );
  }

  // ════ 7. O metadata de domínio não foi atropelado ════
  //
  // Turno e sessão gravam eventos sem metadata próprio. Quem tem metadata de
  // domínio é a conversa por opções — reiniciar um caminho grava
  // `restartedIntoPathId`. É lá que a convivência precisa ser provada: se a
  // origem chegasse SUBSTITUINDO em vez de somando, o campo antigo sumiria.
  console.log("\n7. O metadata de domínio convive com a origem:");
  {
    const criarCaminho = await claudia.post("/api/realtime-questions/paths", {
      patientId: pFabio,
      sessionId: sessaoOffline,
      clientRequestId: "req-caminho-1",
      offlineQueued: true,
      intendedAt: INTENCAO,
    });
    check("o caminho é criado", criarCaminho.status === 200, JSON.stringify(criarCaminho.json));
    const pathId = criarCaminho.json.path.id;

    const reiniciar = await claudia.patch("/api/realtime-questions/paths", {
      patientId: pFabio,
      sessionId: sessaoOffline,
      pathId,
      action: { kind: "RESTART" },
      clientRequestId: "req-caminho-restart",
      offlineQueued: true,
      intendedAt: INTENCAO,
    });
    check("o reinício passa", reiniciar.status === 200, JSON.stringify(reiniciar.json));

    const evs = await eventos(sessaoOffline);
    const comDominio = evs.filter(
      (e) =>
        e.metadata &&
        Object.keys(e.metadata).some(
          (k) => k !== "offlineQueued" && k !== "intendedAt"
        )
    );
    check(
      "existe evento com metadata de domínio",
      comDominio.length > 0,
      "sem isso, esta seção não prova nada"
    );
    check(
      "e ele carrega os DOIS campos de origem junto",
      comDominio.every(
        (e) => e.metadata.offlineQueued === true && e.metadata.intendedAt === INTENCAO
      ),
      JSON.stringify(comDominio.map((e) => e.metadata))
    );
    check(
      "o campo de domínio continua legível — a origem SOMOU, não substituiu",
      comDominio.some((e) => e.metadata.restartedIntoPathId || e.metadata.restart === true),
      JSON.stringify(comDominio.map((e) => e.metadata))
    );
  }

  console.log(`\n${passed} passou, ${failed} falhou.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
