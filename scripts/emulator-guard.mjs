// ——— Nenhuma suíte apaga o banco de trabalho ———
//
// As suítes de integração começam limpando o banco do emulador
// (`DELETE /emulator/v1/projects/.../documents`). É correto: sem partir de um
// estado conhecido, os testes contaminam uns aos outros.
//
// O que não é correto é fazer isso no banco em que a pessoa está trabalhando.
// `helo-db` na porta 8080 é o alvo de `npm run emu` + `npm run dev`: os
// pacientes, rotinas e atividades montados à mão para desenvolver. Uma suíte
// rodada ali apaga esse trabalho sem perguntar, e o dano só aparece depois,
// quando a tela volta vazia.
//
// A guarda olha o PAR (porta, banco), não a porta sozinha — é o par que
// identifica o dado. Uma suíte com banco dedicado (`e2e-lotes`,
// `feedback-test`, `fases4x-test`) é inofensiva mesmo na 8080, e continua
// rodando sem cerimônia.
//
// Quando ela recusa:
//
//   npm run emu:test                                          (terminal 1)
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8090 <o comando de novo>
//
// ou, para zerar deliberadamente o banco de trabalho:
//
//   HELO_EMULADOR_DESCARTAVEL=1 <o comando de novo>

/** A porta de `npm run emu` (firebase.json → emulators.firestore.port). */
export const PORTA_DE_TRABALHO = "8080";
/** O banco que o `npm run dev` usa. */
export const BANCO_DE_TRABALHO = "helo-db";

/**
 * Recusa rodar uma suíte destrutiva contra o banco de trabalho.
 * Chame ANTES do primeiro DELETE — a mensagem só serve se chegar antes do dano.
 */
export function assertEmuladorDescartavel(emu, banco, suite = "esta suíte") {
  const porta = String(emu).split(":").pop();
  if (porta !== PORTA_DE_TRABALHO || banco !== BANCO_DE_TRABALHO) return;
  if (process.env.HELO_EMULADOR_DESCARTAVEL === "1") {
    console.warn(`⚠ ${suite} vai APAGAR ${banco} em ${emu} (HELO_EMULADOR_DESCARTAVEL=1).`);
    return;
  }
  console.error(
    `\n✗ ${suite} apaga o banco inteiro, e ${banco} em ${emu} é o banco de\n` +
      "  trabalho — o que o `npm run emu` + `npm run dev` usam.\n\n" +
      "  Suba um emulador isolado e aponte a suíte para ele:\n\n" +
      "    npm run emu:test\n" +
      "    FIRESTORE_EMULATOR_HOST=127.0.0.1:8090 <o comando de novo>\n\n" +
      "  Ou use um banco dedicado no mesmo emulador:\n\n" +
      "    FIRESTORE_DATABASE_ID=suite-test <o comando de novo>\n\n" +
      "  Se a intenção for mesmo zerar o banco de trabalho:\n\n" +
      "    HELO_EMULADOR_DESCARTAVEL=1 <o comando de novo>\n"
  );
  process.exit(1);
}
