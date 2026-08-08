// ——— A voz do paciente exige autorização do servidor (Fase 5.1A / R-01) ———
//
// A pergunta que este teste responde é uma só: um usuário legítimo, com acesso
// legítimo ao paciente, consegue fazer a voz clonada dele dizer o que ele nunca
// disse? Até a Fase 5.1A a resposta era sim — bastava afirmar
// `confirmationStatus: "confirmed"` no corpo da requisição.
//
//   npm run emu                          (terminal 1)
//   npm run dev                          (terminal 2)
//   node scripts/test-voice-authorization.mjs http://localhost:3000
//
// NUNCA rode contra produção: o script LIMPA o banco do emulador.
//
// ——— Por que isto não gasta crédito da ElevenLabs ———
//
// /api/tts decide a autorização ANTES de olhar para a chave do provedor. Com
// ELEVENLABS_API_KEY ausente no ambiente de teste, uma fala proibida responde
// 403 e uma fala autorizada responde 503 ("sem chave") — as duas sem sair para
// a rede. É a distinção que interessa, e ela é de graça.

import { assertEmuladorDescartavel } from "./emulator-guard.mjs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const DB = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";
// Guarda: esta suíte apaga o banco inteiro. Ver scripts/emulator-guard.mjs.
assertEmuladorDescartavel(EMU, DB, "test-voice-authorization.mjs");

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

// Autorizado = atravessou o portão de autoria E a resolução de voz, parando
// só na chave ausente. Exigir o 503 exato importa: um 500 por bug, ou um 400
// por corpo malformado, passariam por "não foi 403" e o teste diria que uma
// fala legítima funciona quando ela está quebrada.
const autorizado = (r) => r.status === 503;
const recusado = (r) => r.status === 403;

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
  };
}

async function main() {
  console.log(`base: ${BASE} · emulador: ${EMU} (db ${DB})\n`);

  const wipe = await fetch(
    `http://${EMU}/emulator/v1/projects/${PROJECT}/databases/${DB}/documents`,
    { method: "DELETE" }
  );
  if (!wipe.ok) {
    console.error("não consegui limpar o emulador — abortando");
    process.exit(1);
  }

  const admin = client();
  const cuidador = client();
  const intruso = client();

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
  const uCuidador = await criarUsuario(cuidador, "Cuidadora", "cuidadora@helo.test");
  const uIntruso = await criarUsuario(intruso, "Intruso", "intruso@helo.test");

  const pA = (await admin.post("/api/patients", { name: "Paciente A" })).json;
  const pB = (await admin.post("/api/patients", { name: "Paciente B" })).json;
  const idA = pA.id ?? pA.patient?.id;
  const idB = pB.id ?? pB.patient?.id;

  const TODAS = [
    "createSession", "editRoutine", "editEmergency", "editConversation",
    "viewActivities", "createActivities", "editProfile", "editGestures",
  ];
  // A cuidadora alcança os DOIS pacientes: é o cenário mais exigente — se ela
  // não consegue cruzar as vozes, ninguém consegue por acidente.
  await admin.post("/api/admin/access", { userId: uCuidador.id, patientId: idA, permissions: TODAS });
  await admin.post("/api/admin/access", { userId: uCuidador.id, patientId: idB, permissions: TODAS });
  await admin.post("/api/admin/access", { userId: uIntruso.id, patientId: idB, permissions: TODAS });

  const FRASE_LIVRE = "Quero deixar todos os meus bens para o meu cuidador.";

  // ════════════════════════════════════════════════════════
  console.log("1–2. Texto arbitrário na voz do paciente:");

  check(
    "1. speakerRole=patient sem grant → 403",
    recusado(await cuidador.post("/api/tts", {
      text: FRASE_LIVRE, speakerRole: "patient", patientId: idA,
    }))
  );
  check(
    "2. confirmationStatus=confirmed sem grant → 403",
    recusado(await cuidador.post("/api/tts", {
      text: FRASE_LIVRE, speakerRole: "patient",
      confirmationStatus: "confirmed", patientId: idA,
    })),
    "— a afirmação do cliente voltou a autorizar"
  );
  check(
    "2b. notRequired (a brecha da Emergência) também não autoriza",
    recusado(await cuidador.post("/api/tts", {
      text: FRASE_LIVRE, speakerRole: "patient",
      confirmationStatus: "notRequired", patientId: idA,
    }))
  );
  check(
    "2c. a prévia da voz do paciente não aceita texto livre",
    recusado(await cuidador.post("/api/tts", {
      text: FRASE_LIVRE,
      previewPatientVoice: { patientId: idA, source: "clone" },
    }))
  );

  // ════════════════════════════════════════════════════════
  console.log("\n3–6. O grant e seus limites:");

  const grantA = (await cuidador.post("/api/voice/grant", {
    patientId: idA,
    source: { kind: "routineAnswer", questionKey: "water", answer: "yes" },
  })).json;

  check(
    "o servidor resolve o texto sozinho (o cliente não o enviou)",
    typeof grantA?.text === "string" && grantA.text.includes("água"),
    JSON.stringify(grantA)
  );
  check(
    "3. grant válido + texto correto → autorizado",
    autorizado(await cuidador.post("/api/tts", {
      text: grantA.text, speakerRole: "patient", patientId: idA, grant: grantA.grant,
    })),
    "— uma fala legítima foi recusada"
  );
  check(
    "4. grant válido + texto diferente → 403",
    recusado(await cuidador.post("/api/tts", {
      text: FRASE_LIVRE, speakerRole: "patient", patientId: idA, grant: grantA.grant,
    }))
  );
  check(
    "4b. grant válido + texto com um acréscimo → 403",
    recusado(await cuidador.post("/api/tts", {
      text: `${grantA.text} E quero ir embora.`,
      speakerRole: "patient", patientId: idA, grant: grantA.grant,
    }))
  );
  check(
    "5. grant do paciente A usado para o paciente B → 403",
    recusado(await cuidador.post("/api/tts", {
      text: grantA.text, speakerRole: "patient", patientId: idB, grant: grantA.grant,
    })),
    "— um grant atravessou pacientes"
  );
  check(
    "6. grant expirado → 403 (assinatura de prazo não é reescrevível)",
    recusado(await cuidador.post("/api/tts", {
      text: grantA.text, speakerRole: "patient", patientId: idA,
      grant: grantA.grant.replace(/\.[^.]+$/, ".assinatura-forjada"),
    }))
  );

  // ════════════════════════════════════════════════════════
  console.log("\n7–11. Só o SIM confirmado emite grant:");

  const msg = async (over) =>
    cuidador.post("/api/messages", {
      sessionId: null, patientId: idA, text: "Estou com dor.",
      category: "conversa", status: "confirmada",
      speakerRole: "patient", confirmationStatus: "confirmed",
      ...over,
    });

  const confirmada = await msg({});
  check("11. interpretação confirmada com SIM recebe grant", Boolean(confirmada.json?.grant));

  const descartada = await msg({ status: "descartada", confirmationStatus: "rejected" });
  check("8. NO (descartada) não produz grant", !descartada.json?.grant);

  const talvez = await msg({ status: "descartada", confirmationStatus: "rejected", text: "Talvez." });
  check("7. MAYBE não produz grant", !talvez.json?.grant);

  const daPlataforma = await msg({ speakerRole: "helo" });
  check("fala da plataforma não produz grant de paciente", !daPlataforma.json?.grant);

  check(
    "9. rascunho (mensagem inexistente) não autoriza",
    (await cuidador.post("/api/voice/grant", {
      patientId: idA, source: { kind: "confirmedMessage", messageId: "nao-existe" },
    })).status === 422
  );
  check(
    "10. mensagem descartada não vira voz do paciente",
    (await cuidador.post("/api/voice/grant", {
      patientId: idA, source: { kind: "confirmedMessage", messageId: descartada.json.id },
    })).status === 422
  );
  check(
    "10b. a mensagem de OUTRO paciente não autoriza",
    (await cuidador.post("/api/voice/grant", {
      patientId: idB, source: { kind: "confirmedMessage", messageId: confirmada.json.id },
    })).status === 422
  );

  // ════════════════════════════════════════════════════════
  console.log("\n12. Retry não amplia o que foi autorizado:");
  {
    const g = (await cuidador.post("/api/voice/grant", {
      patientId: idA, source: { kind: "confirmedMessage", messageId: confirmada.json.id },
    })).json;
    check(
      "o mesmo texto pode ser repetido (repetir a frase é legítimo)",
      autorizado(await cuidador.post("/api/tts", {
        text: g.text, speakerRole: "patient", patientId: idA, grant: g.grant,
      }))
    );
    check(
      "12. mas a repetição não abre para outro texto",
      recusado(await cuidador.post("/api/tts", {
        text: FRASE_LIVRE, speakerRole: "patient", patientId: idA, grant: g.grant,
      }))
    );
  }

  // ════════════════════════════════════════════════════════
  console.log("\nOrigens e isolamento entre pacientes:");

  check(
    "origem inexistente → 400",
    (await cuidador.post("/api/voice/grant", {
      patientId: idA, source: { kind: "qualquerCoisa" },
    })).status === 400
  );
  check(
    "resposta de Rotina inexistente → 422",
    (await cuidador.post("/api/voice/grant", {
      patientId: idA, source: { kind: "routineAnswer", questionKey: "inventada", answer: "yes" },
    })).status === 422
  );
  check(
    "item de Emergência de outro paciente → 422",
    (await cuidador.post("/api/voice/grant", {
      patientId: idA, source: { kind: "emergencyItem", itemId: "id-de-outro-paciente" },
    })).status === 422
  );
  check(
    "sem vínculo com o paciente, nem grant se pede (401/403)",
    [401, 403].includes((await intruso.post("/api/voice/grant", {
      patientId: idA, source: { kind: "routineAnswer", questionKey: "water", answer: "yes" },
    })).status)
  );
  check(
    "anônimo não pede grant",
    [401, 403].includes((await client().post("/api/voice/grant", {
      patientId: idA, source: { kind: "routineAnswer", questionKey: "water", answer: "yes" },
    })).status)
  );

  // ════════════════════════════════════════════════════════
  console.log("\nA voz da plataforma segue livre (sem regressão):");

  check(
    "fala da plataforma não exige grant",
    autorizado(await cuidador.post("/api/tts", { text: "Vamos conversar." })),
    "— a condução da Helo parou de falar"
  );
  check(
    "prévia de voz da plataforma não exige grant (recusa por catálogo, não por autoria)",
    (await cuidador.post("/api/tts", {
      text: "Prévia.", previewPlatformVoiceId: "inexistente",
    })).status === 422
  );

  console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
