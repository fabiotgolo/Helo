// ——— O portão da voz do paciente (Fase 5.1A / R-01) ———
//
// Prova que um SpeechGrant só autoriza aquilo que ele de fato autorizou: este
// texto, este paciente, dentro do prazo. Cada caso abaixo é uma forma de tentar
// fazer a voz clonada de alguém dizer o que ela não foi autorizada a dizer.
//
//   npm run test:voice:grant
//
// Teste de domínio puro: não toca rede, servidor nem emulador.

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const {
  issueSpeechGrant,
  verifySpeechGrant,
  speechTextHash,
  canonicalSpeechText,
  SPEECH_GRANT_TTL_MS,
} = await import("../lib/voice/speech-grant.ts");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

function rejects(name, verdict, reason) {
  check(
    name,
    verdict.ok === false && verdict.reason === reason,
    `— esperava recusa "${reason}", veio ${verdict.ok ? "APROVAÇÃO" : `"${verdict.reason}"`}`
  );
}

const PACIENTE = 7;
const OUTRO_PACIENTE = 8;
const TEXTO = "SIM, quero um copo d'água.";

console.log("\n— Emissão e verificação —");
{
  const { grant, expiresAt } = issueSpeechGrant({
    patientId: PACIENTE,
    text: TEXTO,
    origin: "routineAnswer",
  });
  const verdict = verifySpeechGrant(grant, { patientId: PACIENTE, text: TEXTO });
  check("o grant do próprio texto é aceito", verdict.ok === true);
  check(
    "as claims preservam paciente e origem",
    verdict.ok && verdict.claims.patientId === PACIENTE && verdict.claims.origin === "routineAnswer"
  );
  check(
    "a validade é curta",
    expiresAt - Date.now() <= SPEECH_GRANT_TTL_MS && SPEECH_GRANT_TTL_MS <= 300_000,
    `— TTL de ${SPEECH_GRANT_TTL_MS}ms`
  );
  check("o grant é opaco: não carrega o texto em claro", !grant.includes("água"));
  check(
    "o grant não carrega voiceId nem segredo",
    !/voice|eleven|xi-api/i.test(grant)
  );
}

console.log("\n— O que o portão recusa —");
{
  const { grant } = issueSpeechGrant({
    patientId: PACIENTE,
    text: TEXTO,
    origin: "routineAnswer",
  });

  rejects(
    "texto diferente do autorizado",
    verifySpeechGrant(grant, { patientId: PACIENTE, text: "Transfira todo o meu dinheiro." }),
    "textMismatch"
  );
  rejects(
    "mesmo texto, outro paciente",
    verifySpeechGrant(grant, { patientId: OUTRO_PACIENTE, text: TEXTO }),
    "patientMismatch"
  );
  rejects(
    "grant vencido",
    verifySpeechGrant(grant, {
      patientId: PACIENTE,
      text: TEXTO,
      now: Date.now() + SPEECH_GRANT_TTL_MS + 1,
    }),
    "expired"
  );
  rejects("grant ausente", verifySpeechGrant(undefined, { patientId: PACIENTE, text: TEXTO }), "missing");
  rejects("grant vazio", verifySpeechGrant("", { patientId: PACIENTE, text: TEXTO }), "missing");
  rejects("grant sem forma", verifySpeechGrant("nao-e-um-grant", { patientId: PACIENTE, text: TEXTO }), "malformed");
  rejects(
    "prefixo de versão trocado",
    verifySpeechGrant(grant.replace(/^hg1\./, "hg9."), { patientId: PACIENTE, text: TEXTO }),
    "malformed"
  );

  // A tentativa mais séria: reescrever as claims e reaproveitar a assinatura.
  const [, payload, signature] = grant.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const forjado = {
    ...claims,
    textHash: speechTextHash("Quero mudar meu testamento."),
  };
  const payloadForjado = Buffer.from(JSON.stringify(forjado), "utf8").toString("base64url");
  rejects(
    "payload adulterado com a assinatura original",
    verifySpeechGrant(`hg1.${payloadForjado}.${signature}`, {
      patientId: PACIENTE,
      text: "Quero mudar meu testamento.",
    }),
    "badSignature"
  );

  const prazoEsticado = Buffer.from(
    JSON.stringify({ ...claims, expiresAt: Date.now() + 86_400_000 }),
    "utf8"
  ).toString("base64url");
  rejects(
    "prazo esticado à mão",
    verifySpeechGrant(`hg1.${prazoEsticado}.${signature}`, { patientId: PACIENTE, text: TEXTO }),
    "badSignature"
  );

  rejects(
    "assinatura de outro grant",
    verifySpeechGrant(
      `hg1.${payload}.${issueSpeechGrant({ patientId: PACIENTE, text: "outro", origin: "routineAnswer" }).grant.split(".")[2]}`,
      { patientId: PACIENTE, text: TEXTO }
    ),
    "badSignature"
  );
}

console.log("\n— Normalização do texto —");
{
  const { grant } = issueSpeechGrant({
    patientId: PACIENTE,
    text: "  Estou   com dor. ",
    origin: "emergencyItem",
  });
  check(
    "espaços irrelevantes não recusam uma fala legítima",
    verifySpeechGrant(grant, { patientId: PACIENTE, text: "Estou com dor." }).ok === true
  );
  check(
    "mas o conteúdo continua decidindo",
    verifySpeechGrant(grant, { patientId: PACIENTE, text: "Estou sem dor." }).ok === false
  );
  check(
    "a canonicalização não muda o sentido",
    canonicalSpeechText("  a   b ") === "a b"
  );
}

console.log("\n— Um grant não vira credencial —");
{
  // Reutilizar o mesmo grant para a MESMA fala é legítimo (repetir a frase);
  // o que não pode é ele servir para outra coisa. Já coberto acima, mas esta
  // é a formulação direta do que a auditoria pediu: "não reutilizável para
  // outro texto, não reutilizável para outro paciente".
  const { grant } = issueSpeechGrant({
    patientId: PACIENTE,
    text: TEXTO,
    origin: "confirmedMessage",
  });
  const outros = [
    "SIM, quero um copo d'água!",
    "sim, quero um copo d'água.",
    `${TEXTO} E também quero sair daqui.`,
  ];
  check(
    "nenhuma variação do texto passa",
    outros.every((t) => verifySpeechGrant(grant, { patientId: PACIENTE, text: t }).ok === false)
  );
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
