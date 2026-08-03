// ——— A invariável de autoria (Passo 0.3) ———
// Prova que SOMENTE uma confirmação válida do paciente produz fala confirmada.
//
// Teste de domínio puro: não toca rede, servidor nem emulador.
//
//   npm run test:authorship
//
// Cada caso abaixo é uma forma de tentar produzir fala do paciente SEM a
// confirmação dele — rascunho, resposta TALVEZ/NÃO, sensível sem reconfirmar,
// texto trocado depois da apresentação, origem indevida, vínculo quebrado.
// Todas precisam ser recusadas.

import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const {
  toConfirmedPatientStatement,
  tryToConfirmedPatientStatement,
  isConfirmedPatientStatement,
} = await import("../lib/confirmed-patient-statement.ts");
const { RtqDomainError } = await import("../lib/option-conversation-types.ts");

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

const T = "2026-08-03T12:00:00.000Z";

/** Uma frase confirmada legítima; cada teste desvia um único aspecto dela. */
function frase(over = {}) {
  return {
    id: "st-1",
    pathId: "path-1",
    sessionId: "sess-1",
    patientId: 7,
    assistantId: "user-1",
    originNodeId: "node-1",
    interactionMode: "FINAL_STATEMENT_CONFIRMATION",
    originalDraft: "Quero água",
    currentText: "Quero água",
    presentedText: "Quero água",
    status: "CONFIRMED",
    provisionalResponse: "YES",
    confirmedResponse: "YES",
    reusedFromStatementId: null,
    replacesStatementId: null,
    replacedByStatementId: null,
    isSensitive: false,
    sensitiveCategory: null,
    editCount: 0,
    correctionCount: 0,
    clientRequestId: null,
    presentedAt: T,
    respondedAt: T,
    reconfirmedAt: null,
    confirmedAt: T,
    rejectedAt: null,
    canceledAt: null,
    replacedAt: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

/** Recusado = lança RtqDomainError E a versão silenciosa devolve null. */
function recusa(nome, over) {
  const entrada = frase(over);
  let lancou = false;
  try {
    toConfirmedPatientStatement(entrada);
  } catch (e) {
    lancou = e instanceof RtqDomainError;
  }
  const silencioso = tryToConfirmedPatientStatement(entrada);
  check(nome, lancou && silencioso === null, lancou ? "" : "(não lançou)");
}

console.log("\nConfirmação válida:");
{
  const fala = toConfirmedPatientStatement(frase());
  check("a confirmação válida produz fala do paciente", isConfirmedPatientStatement(fala));
  check("o texto é o congelado na apresentação", fala.text === "Quero água");
  check("preserva o vínculo com sessão, caminho e paciente",
    fala.sessionId === "sess-1" && fala.pathId === "path-1" && fala.patientId === 7);
  check("registra o horário da confirmação", fala.confirmedAt === T);
}

console.log("\nTexto não confirmado:");
recusa("rascunho (DRAFT) não é fala do paciente", { status: "DRAFT", provisionalResponse: null, confirmedResponse: null, confirmedAt: null });
recusa("frase apenas apresentada, sem resposta", { status: "PRESENTED", provisionalResponse: null, confirmedResponse: null, confirmedAt: null });
recusa("resposta provisória ainda não é confirmação", { status: "PROVISIONAL_RESPONSE", confirmedResponse: null, confirmedAt: null });
recusa("cancelada antes de confirmar", { status: "CANCELED", provisionalResponse: null, confirmedResponse: null, confirmedAt: null });
recusa("confirmada sem horário de confirmação", { confirmedAt: null });
recusa("confirmada sem texto apresentado", { presentedText: "" });

console.log("\nTALVEZ e NÃO nunca confirmam:");
recusa("TALVEZ observado não confirma", { status: "PROVISIONAL_RESPONSE", provisionalResponse: "MAYBE", confirmedResponse: null, confirmedAt: null });
recusa("NÃO observado não confirma", { status: "PROVISIONAL_RESPONSE", provisionalResponse: "NO", confirmedResponse: null, confirmedAt: null });
recusa("frase rejeitada não é comunicação confirmada", { status: "REJECTED", provisionalResponse: "NO", confirmedResponse: null, confirmedAt: null, rejectedAt: T });
recusa("CONFIRMED forjado sobre um TALVEZ observado", { provisionalResponse: "MAYBE" });
recusa("CONFIRMED forjado sobre um NÃO observado", { provisionalResponse: "NO" });
recusa("CONFIRMED sem resposta observada alguma", { provisionalResponse: null });

console.log("\nConfirmação sensível incompleta:");
recusa("sensível confirmada sem reconfirmação", { isSensitive: true, sensitiveCategory: "MEDICAL", reconfirmedAt: null });
recusa("sensível aguardando reconfirmação", { isSensitive: true, sensitiveCategory: "MEDICAL", status: "RECONFIRMATION_PENDING", confirmedResponse: null, confirmedAt: null, reconfirmedAt: null });
{
  const fala = toConfirmedPatientStatement(
    frase({ isSensitive: true, sensitiveCategory: "MEDICAL", reconfirmedAt: T })
  );
  check("sensível COM reconfirmação concluída é aceita", isConfirmedPatientStatement(fala));
  check("a fala sensível carrega a reconfirmação", fala.reconfirmedAt === T);
}

console.log("\nVínculo e origem:");
recusa("frase sem sessão", { sessionId: "" });
recusa("frase sem caminho", { pathId: "" });
recusa("frase sem identificador", { id: "" });
recusa("frase sem assistente", { assistantId: "  " });
recusa("paciente inválido (zero)", { patientId: 0 });
recusa("paciente inválido (negativo)", { patientId: -3 });
recusa("paciente inválido (fracionário)", { patientId: 1.5 });
recusa("origem fora da confirmação de frase final", { interactionMode: "CLOSED_CONFIRMATION" });
recusa("origem de seleção de opções", { interactionMode: "OPTION_SELECTION" });
recusa("frase substituída não é a fala viva", { status: "REPLACED", replacedByStatementId: "st-2", replacedAt: T });

console.log("\nEdição posterior não vira fala do paciente:");
{
  // O assistente edita o texto corrente DEPOIS da confirmação: a fala precisa
  // continuar sendo o que o paciente viu e confirmou.
  const fala = toConfirmedPatientStatement(
    frase({ currentText: "Quero morfina", presentedText: "Quero água" })
  );
  check("a fala ignora currentText editado depois", fala.text === "Quero água");
}

console.log("\nA marca não se forja:");
{
  const forjado = { text: "Quero água", statementId: "st-1", patientId: 7 };
  check("objeto com a mesma forma não passa por fala confirmada", !isConfirmedPatientStatement(forjado));
  check("string solta não passa por fala confirmada", !isConfirmedPatientStatement("Quero água"));
  check("null não passa por fala confirmada", !isConfirmedPatientStatement(null));
  check("a versão silenciosa aceita ausência de frase", tryToConfirmedPatientStatement(null) === null);
}

console.log(`\n${passed} passaram · ${failed} falharam\n`);
process.exit(failed === 0 ? 0 : 1);
