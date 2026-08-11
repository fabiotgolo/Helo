// ——— A mídia do paciente exige quem-é-você, não posse-de-link (Fase 5.4B) ———
//
//   npm run emu:test                                             (terminal 1)
//   npm run dev:teste                                            (terminal 2)
//   npm run test:midia:autorizacao                               (terminal 3)
//
// Esta é a prova central do R-04, e ela é HTTP de propósito: o defeito não era
// uma função errada, era um MODELO DE ACESSO errado. Um Firebase download URL
// entrega o arquivo a quem tem o link — sem sessão, sem vínculo, sem prazo,
// inclusive depois de o cuidador perder o acesso ao paciente, inclusive fora
// da Helo. Provar que isso acabou exige perguntar ao servidor, não ao código.
//
// As sete perguntas, na ordem em que um ataque as faria:
//
//   1. copiei a URL que o navegador usa. Ela funciona sem sessão?
//   2. estou autenticado, mas não alcanço este paciente. Funciona?
//   3. alcanço o paciente A. Consigo a mídia do B pedindo com o id do A?
//   4. e trocando o patientId na query?
//   5. consigo mandar um caminho de arquivo em vez de um id?
//   6. eu tinha acesso e perdi. A mídia que eu ouvia ontem ainda abre?
//   7. e o cuidador que continua com acesso — para ele ainda funciona?
//
// ——— Sobre não gastar crédito ———
//
// Nada aqui chama a ElevenLabs. A síntese não é exercitada: a suíte cria o
// documento e, quando o emulador de Storage está no ar, grava o objeto pelo
// Admin SDK — que é exatamente o que a Cloud Function faria depois de receber
// o áudio. O que está sob teste é o portão, não o provedor.

import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const BASE = process.argv[2] ?? "http://localhost:3510";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";
const STORAGE = process.env.STORAGE_EMULATOR_HOST ?? "";
const BALDE = process.env.FIREBASE_STORAGE_BUCKET ?? "helo-app-7fbf8.firebasestorage.app";

// Guarda: esta suíte apaga o banco inteiro. Ver scripts/emulator-guard.mjs.
assertEmuladorDescartavel(EMU, DB, "test-midia-autorizacao.mjs");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

function client() {
  let cookie = "";
  return {
    async req(method, path, body, extra) {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(cookie ? { cookie } : {}),
          ...(extra ?? {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = r.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      return r;
    },
    async json(method, path, body) {
      const r = await this.req(method, path, body);
      let dados = null;
      try {
        dados = await r.json();
      } catch {}
      return { status: r.status, json: dados };
    },
    get(p, extra) { return this.req("GET", p, undefined, extra); },
    post(p, b) { return this.json("POST", p, b); },
    getJson(p) { return this.json("GET", p); },
  };
}

async function main() {
  console.log(`base: ${BASE} · emulador: ${EMU} (db ${DB}) · storage: ${STORAGE || "ausente"}\n`);

  const wipe = await fetch(
    `http://${EMU}/emulator/v1/projects/${PROJECT}/databases/${DB}/documents`,
    { method: "DELETE" }
  );
  if (!wipe.ok) {
    console.error("não consegui limpar o emulador — abortando");
    process.exit(1);
  }

  const admin = client();
  const cuidadora = client();
  const estranho = client();
  const anonimo = client();

  await admin.post("/api/auth/bootstrap", {
    name: "Admin",
    email: "admin@helo.test",
    password: "senha-admin-123",
  });

  async function criarUsuario(c, name, email) {
    const r = await admin.post("/api/admin/users", {
      name, email, password: "senha-teste-123", role: "profissional",
      professionalType: "fonoaudiologo",
    });
    await c.post("/api/auth/login", { email, password: "senha-teste-123" });
    return r.json.user;
  }
  const uCuidadora = await criarUsuario(cuidadora, "Cuidadora", "cuidadora@helo.test");
  await criarUsuario(estranho, "Estranho", "estranho@helo.test");

  const pA = (await admin.post("/api/patients", { name: "Paciente A" })).json;
  const pB = (await admin.post("/api/patients", { name: "Paciente B" })).json;
  const idA = pA.id ?? pA.patient?.id;
  const idB = pB.id ?? pB.patient?.id;

  const TODAS = [
    "createSession", "editRoutine", "editEmergency", "editConversation",
    "viewActivities", "createActivities", "editActivities", "deleteActivities",
    "editProfile", "editGestures", "viewMetrics",
  ];
  await admin.post("/api/admin/access", { userId: uCuidadora.id, patientId: idA, permissions: TODAS });

  // Uma frase para cada paciente. O texto é banal de propósito: nada do que
  // esta suíte cria precisa ser conteúdo clínico para provar o que prova.
  const fraseA = (await admin.post("/api/favorite-phrases", {
    patientId: idA, text: "Bom dia.",
  })).json.phrase;
  const fraseB = (await admin.post("/api/favorite-phrases", {
    patientId: idB, text: "Boa noite.",
  })).json.phrase;

  const urlDaFrase = (pid, fid) =>
    `/api/favorite-phrases/audio?patientId=${pid}&phraseId=${encodeURIComponent(fid)}`;

  // ════════════════════════════════════════════════════════════════════
  console.log("1. A frase nasce sem endereço nenhum:");
  {
    const lista = await cuidadora.getJson(`/api/favorite-phrases?patientId=${idA}`);
    const bruto = JSON.stringify(lista.json);
    check("a listagem não devolve audioUrl", !bruto.includes("audioUrl"));
    check("nem storagePath", !bruto.includes("storagePath"));
    check("nem endereço nenhum", !/https?:\/\//.test(bruto));
    check("ela devolve hasAudio", bruto.includes("hasAudio"));
    check(
      "e a frase recém-criada não tem áudio",
      lista.json.phrases?.[0]?.hasAudio === false
    );
  }

  // ════════════════════════════════════════════════════════════════════
  console.log("\n2. Anônimo — a URL copiada do navegador não abre nada:");
  {
    const r = await anonimo.get(urlDaFrase(idA, fraseA.id));
    check("sem sessão, a rota da frase recusa", r.status === 401, `— recebeu ${r.status}`);
    check(
      "e não devolve áudio",
      (r.headers.get("content-type") ?? "").includes("json"),
      `— content-type ${r.headers.get("content-type")}`
    );
    const m = await anonimo.get(`/api/patients/${idA}/playlist/audio?id=qualquer`);
    check("sem sessão, a rota da música recusa", m.status === 401, `— recebeu ${m.status}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log("\n3. Autenticado, mas sem vínculo com o paciente:");
  {
    const r = await estranho.get(urlDaFrase(idA, fraseA.id));
    check("recusa com 403", r.status === 403, `— recebeu ${r.status}`);
    const m = await estranho.get(`/api/patients/${idA}/playlist/audio?id=qualquer`);
    check("na música também", m.status === 403, `— recebeu ${m.status}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log("\n4. Paciente cruzado — a cuidadora alcança A, e só A:");
  {
    // A frase é do B; o id do paciente informado é o A (o que ela alcança).
    const r = await cuidadora.get(urlDaFrase(idA, fraseB.id));
    check(
      "a frase do B pedida sob o paciente A não existe",
      r.status === 404,
      `— recebeu ${r.status}`
    );
    // Agora o contrário: o id do paciente é o B (que ela NÃO alcança).
    const r2 = await cuidadora.get(urlDaFrase(idB, fraseB.id));
    check("e sob o paciente B ela não tem vínculo", r2.status === 403, `— recebeu ${r2.status}`);
    check(
      "em nenhum dos dois casos vem áudio",
      !(r.headers.get("content-type") ?? "").includes("audio") &&
        !(r2.headers.get("content-type") ?? "").includes("audio")
    );
  }

  // ════════════════════════════════════════════════════════════════════
  console.log("\n5. Caminho de arquivo não é uma pergunta que a rota aceite:");
  {
    const tentativas = [
      ["travessia no phraseId", urlDaFrase(idA, "../../8/phrase-audio/x")],
      ["caminho completo no phraseId", urlDaFrase(idA, "patients/8/phrase-audio/f/a.mp3")],
      ["phraseId vazio", urlDaFrase(idA, "")],
      ["parâmetro path extra", `${urlDaFrase(idA, fraseA.id)}&path=patients/8/phrase-audio/f/a.mp3`],
      ["patientId não numérico", `/api/favorite-phrases/audio?patientId=abc&phraseId=${fraseA.id}`],
    ];
    for (const [nome, caminho] of tentativas) {
      const r = await cuidadora.get(caminho);
      check(
        `${nome} → recusado sem áudio`,
        r.status >= 400 && !(r.headers.get("content-type") ?? "").includes("audio"),
        `— recebeu ${r.status} ${r.headers.get("content-type")}`
      );
    }
  }

  // ════════════════════════════════════════════════════════════════════
  console.log("\n6. Frase sem áudio pré-sintetizado responde 404, não um endereço:");
  {
    const r = await cuidadora.get(urlDaFrase(idA, fraseA.id));
    check("404 quando não há mídia", r.status === 404, `— recebeu ${r.status}`);
  }

  // ════════════════════════════════════════════════════════════════════
  // Daqui para baixo é preciso um objeto de verdade no Storage. Sem o
  // emulador, a suíte DIZ o que não exercitou em vez de fingir que passou.
  let objetoNoAr = false;
  let balde = null;
  if (STORAGE) {
    const { initializeApp } = await import("firebase-admin/app");
    const { getStorage } = await import("firebase-admin/storage");
    process.env.STORAGE_EMULATOR_HOST = STORAGE;
    const app = initializeApp({ projectId: PROJECT, storageBucket: BALDE }, "midia-autorizacao");
    balde = getStorage(app).bucket(BALDE);
    objetoNoAr = true;
  }

  console.log("\n7. Com a mídia realmente gravada:");
  if (!objetoNoAr) {
    console.log("  ⚠ STORAGE_EMULATOR_HOST ausente — os itens 7 a 9 não foram exercitados.");
    console.log("    (npm run emu:test sobe o Storage em 9199; ver firebase.test.json)");
  } else {
    // É isto que a Cloud Function faz depois de receber o áudio da ElevenLabs:
    // grava o objeto e aponta o documento para ele. Sem URL, sem token.
    const caminho = `patients/${idA}/phrase-audio/${fraseA.id}/abc123def456.mp3`;
    const CONTEUDO = Buffer.from("um mp3 de mentira, com trinta e dois bytes.");
    await balde.file(caminho).save(CONTEUDO, {
      resumable: false,
      metadata: { contentType: "audio/mpeg", cacheControl: "private, no-store" },
    });
    // `Bearer owner` é como o emulador reconhece um cliente privilegiado —
    // sem ele, a REST API aplica `firestore.rules`, que nega tudo, e o PATCH
    // volta 403 em silêncio. (Foi o que aconteceu na primeira execução desta
    // suíte: o documento nunca recebia o caminho, a rota respondia 404 com
    // razão, e o teste acusava o produto pelo defeito do próprio teste.)
    const gravado = await fetch(
      `http://${EMU}/v1/projects/${PROJECT}/databases/${DB}/documents/patients/${idA}/favoritePhrases/${fraseA.id}?updateMask.fieldPaths=audioStoragePath`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
        body: JSON.stringify({ fields: { audioStoragePath: { stringValue: caminho } } }),
      }
    );
    check("a referência privada foi gravada no documento", gravado.ok, `— ${gravado.status}`);

    const r = await cuidadora.get(urlDaFrase(idA, fraseA.id));
    check("a cuidadora com vínculo recebe o áudio", r.status === 200, `— recebeu ${r.status}`);
    check(
      "com Content-Type de áudio",
      (r.headers.get("content-type") ?? "") === "audio/mpeg",
      `— ${r.headers.get("content-type")}`
    );
    check(
      "com no-store — a voz clonada não fica guardada em lugar nenhum",
      (r.headers.get("cache-control") ?? "").includes("no-store"),
      `— ${r.headers.get("cache-control")}`
    );
    check("e sem sniffing", r.headers.get("x-content-type-options") === "nosniff");
    check("aceitando Range", r.headers.get("accept-ranges") === "bytes");
    const bytes = Buffer.from(await r.arrayBuffer());
    check("os bytes são os do objeto", bytes.equals(CONTEUDO), `— ${bytes.length} bytes`);

    // O Range é o que mantém a barra de progresso funcionando.
    const parcial = await cuidadora.get(urlDaFrase(idA, fraseA.id), { Range: "bytes=3-9" });
    check("um Range devolve 206", parcial.status === 206, `— recebeu ${parcial.status}`);
    check(
      "com o Content-Range certo",
      parcial.headers.get("content-range") === `bytes 3-9/${CONTEUDO.length}`,
      `— ${parcial.headers.get("content-range")}`
    );
    const pedaco = Buffer.from(await parcial.arrayBuffer());
    check("e o pedaço certo", pedaco.equals(CONTEUDO.subarray(3, 10)), `— "${pedaco}"`);

    const fora = await cuidadora.get(urlDaFrase(idA, fraseA.id), { Range: "bytes=9999-" });
    check("um Range fora do arquivo é 416", fora.status === 416, `— recebeu ${fora.status}`);

    // ══════════════════════════════════════════════════════════════════
    console.log("\n8. E o anônimo continua sem entrar, agora que a mídia existe:");
    {
      const r2 = await anonimo.get(urlDaFrase(idA, fraseA.id));
      check("401, com o objeto no bucket", r2.status === 401, `— recebeu ${r2.status}`);
      const corpo = Buffer.from(await r2.arrayBuffer());
      check("e nenhum byte do áudio", !corpo.equals(CONTEUDO));
    }

    // ══════════════════════════════════════════════════════════════════
    console.log("\n9. Perder o vínculo corta o acesso — sem apagar a mídia de ninguém:");
    {
      const antes = await cuidadora.get(urlDaFrase(idA, fraseA.id));
      check("antes da revogação, ela ouve", antes.status === 200, `— recebeu ${antes.status}`);

      await admin.post("/api/admin/access", {
        userId: uCuidadora.id, patientId: idA, permissions: [], status: "revoked",
      });

      const depois = await cuidadora.get(urlDaFrase(idA, fraseA.id));
      check(
        "depois da revogação, não ouve mais",
        depois.status === 403 || depois.status === 404,
        `— recebeu ${depois.status}`
      );
      const [aindaExiste] = await balde.file(caminho).exists();
      check(
        "e o arquivo continua existindo — o recurso é do paciente, não do vínculo",
        aindaExiste === true
      );
    }

    await balde.file(caminho).delete({ ignoreNotFound: true }).catch(() => {});
  }

  console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
