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
  speechGrantConfigStatus,
  SpeechGrantConfigError,
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

// ——— A chave de assinatura (checkpoint 1 do fechamento da 5.1A) ———
//
// A versão anterior caía numa chave aleatória por processo TAMBÉM em
// produção, apoiada em `maxInstances: 1`. Isso fazia uma garantia de autoria
// depender de um parâmetro de escala: subir para duas instâncias — decisão de
// custo, tomada longe deste arquivo — daria a cada uma sua própria chave.
// Aqui a regra passa a ser explícita, e estes casos existem para que ela não
// possa ser afrouxada em silêncio.
console.log("\n— Configuração da chave em produção —");
{
  const NODE_ENV_ORIGINAL = process.env.NODE_ENV;
  const SECRET_ORIGINAL = process.env.HELO_SPEECH_GRANT_SECRET;
  const SEGREDO_A = "s".repeat(48);
  const SEGREDO_B = "z".repeat(48);

  const ambiente = (env, segredo) => {
    if (env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env;
    if (segredo === undefined) delete process.env.HELO_SPEECH_GRANT_SECRET;
    else process.env.HELO_SPEECH_GRANT_SECRET = segredo;
  };

  const emitir = () => {
    try {
      return { ok: true, ...issueSpeechGrant({ patientId: PACIENTE, text: TEXTO, origin: "routineAnswer" }) };
    } catch (caught) {
      return { ok: false, erro: caught };
    }
  };

  // 1. Produção SEM segredo: nada é emitido.
  ambiente("production", undefined);
  const semSegredo = emitir();
  check(
    "produção sem segredo não emite grant",
    semSegredo.ok === false && semSegredo.erro instanceof SpeechGrantConfigError,
    `— veio ${semSegredo.ok ? "um grant" : semSegredo.erro?.name}`
  );
  check(
    "…e o diagnóstico diz o que fazer",
    speechGrantConfigStatus().ok === false &&
      /HELO_SPEECH_GRANT_SECRET/.test(speechGrantConfigStatus().error)
  );
  // Fail-closed dos dois lados: sem chave, verificar também é impossível.
  ambiente(undefined, SEGREDO_A);
  const { grant: grantValido } = issueSpeechGrant({
    patientId: PACIENTE,
    text: TEXTO,
    origin: "routineAnswer",
  });
  ambiente("production", undefined);
  rejects(
    "produção sem segredo também não ACEITA um grant",
    verifySpeechGrant(grantValido, { patientId: PACIENTE, text: TEXTO }),
    "misconfigured"
  );

  // 2. Produção COM segredo: emite e verifica normalmente.
  ambiente("production", SEGREDO_A);
  const comSegredo = emitir();
  check("produção com segredo emite", comSegredo.ok === true);
  check(
    "…e o grant emitido é aceito",
    comSegredo.ok &&
      verifySpeechGrant(comSegredo.grant, { patientId: PACIENTE, text: TEXTO }).ok === true
  );
  check(
    "…e a fonte da chave é o ambiente, não uma efêmera",
    speechGrantConfigStatus().ok === true && speechGrantConfigStatus().source === "environment"
  );

  // 3. Chave trocada: o grant antigo morre. É o que garante que dois processos
  //    com chaves diferentes NÃO se aceitam mutuamente — o cenário que a
  //    versão anterior deixava passar silenciosamente ao escalar.
  ambiente("production", SEGREDO_B);
  rejects(
    "grant assinado por outro segredo é recusado",
    verifySpeechGrant(comSegredo.ok ? comSegredo.grant : "", { patientId: PACIENTE, text: TEXTO }),
    "badSignature"
  );

  // 4. Segredo curto demais é tratado como ausente, não como aceitável.
  ambiente("production", "curto");
  const curto = emitir();
  check(
    "segredo curto não passa por segredo",
    curto.ok === false && curto.erro instanceof SpeechGrantConfigError
  );

  // 5. Reinício com configuração válida mantém o contrato: mesma chave, mesmo
  //    grant. Um SpeechGrant é stateless de propósito, e é isto que faz um
  //    deploy no meio de uma fala não derrubá-la.
  ambiente("production", SEGREDO_A);
  const antes = issueSpeechGrant({ patientId: PACIENTE, text: TEXTO, origin: "routineAnswer", now: 1_000 });
  const depois = issueSpeechGrant({ patientId: PACIENTE, text: TEXTO, origin: "routineAnswer", now: 1_000 });
  check("mesma chave e mesmas claims produzem o mesmo grant", antes.grant === depois.grant);
  check(
    "e um grant emitido antes continua válido depois",
    verifySpeechGrant(antes.grant, { patientId: PACIENTE, text: TEXTO, now: 1_000 }).ok === true
  );

  // 6. O segredo não vaza — nem em mensagem de erro, nem no grant, nem no
  //    diagnóstico. Tudo isso vai parar em log de servidor.
  ambiente("production", undefined);
  const vazamento = emitir();
  const textos = [
    vazamento.ok ? "" : String(vazamento.erro?.message ?? ""),
    speechGrantConfigStatus().ok ? "" : speechGrantConfigStatus().error,
    comSegredo.ok ? comSegredo.grant : "",
    antes.grant,
  ].join(" | ");
  check(
    "nenhuma mensagem, diagnóstico ou grant contém o segredo",
    !textos.includes(SEGREDO_A) && !textos.includes(SEGREDO_B),
    "— o valor da chave apareceu em texto exposto"
  );

  // 7. Fora de produção a chave efêmera continua existindo — é o que permite
  //    rodar `next dev` sem configurar nada.
  ambiente("development", undefined);
  const dev = emitir();
  check("desenvolvimento sem segredo continua funcionando", dev.ok === true);
  check(
    "…com chave efêmera, declarada como tal",
    speechGrantConfigStatus().ok === true && speechGrantConfigStatus().source === "ephemeral"
  );

  ambiente(NODE_ENV_ORIGINAL, SECRET_ORIGINAL);
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passaram, ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
