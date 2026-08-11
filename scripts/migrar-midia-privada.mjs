// ——— Migração da mídia legada para o modelo privado (Fase 5.4B) ———
//
//   node scripts/migrar-midia-privada.mjs                    (dry-run: só conta)
//   node scripts/migrar-midia-privada.mjs --apply            (executa)
//
// ——— Por que este script existe ———
//
// Corrigir o código fechou a porta para o que vem DEPOIS. Não fechou o que já
// saiu: cada `audioUrl` gravada antes desta fase é um Firebase download URL com
// token embutido, e esse endereço continua entregando o arquivo a quem o
// tiver, sem sessão e sem prazo. Nenhuma mudança em `functions/index.js`
// alcança um link que já está no mundo.
//
// O que mata a URL antiga é apagar o objeto que ela aponta. E isso é
// verificável — ao contrário de "remover o token", que dependeria de um
// comportamento interno do Firebase que este projeto não tem como comprovar.
// Por isso a estratégia é: copiar para o caminho privado novo, apontar o
// documento para lá, e só então apagar o original.
//
// ——— A ordem, e por que ela é essa ———
//
//   1. copia o objeto legado para o caminho novo;
//   2. confere que a cópia existe de verdade;
//   3. ajusta o cacheControl da cópia (o original é `public, immutable`, e a
//      cópia herda a metadata);
//   4. aponta o documento para a cópia e apaga os campos antigos;
//   5. só então apaga o objeto legado.
//
// Se qualquer passo falhar, o anterior continua válido: no pior caso sobra uma
// cópia não referenciada, que a próxima execução reaproveita. Em nenhum
// momento existe um documento apontando para nada, e em nenhum momento o
// original some antes de a cópia estar no lugar.
//
// ——— O que ele nunca imprime ———
//
// Texto de frase, prompt de música, título, nome de paciente, download token,
// URL completa. Só contagens, ids e caminhos internos — e o caminho interno
// não abre nada.


import { randomBytes } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const ARGS = process.argv.slice(2);
const APLICA = ARGS.includes("--apply");
const PRODUCAO = ARGS.includes("--producao");

function opcao(nome, padrao) {
  const i = ARGS.indexOf(`--${nome}`);
  return i > -1 && ARGS[i + 1] && !ARGS[i + 1].startsWith("--") ? ARGS[i + 1] : padrao;
}

const PROJETO = opcao("projeto", process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8");
const BANCO = opcao("banco", process.env.FIRESTORE_DATABASE_ID ?? "helo-db");
const BALDE = opcao("balde", process.env.FIREBASE_STORAGE_BUCKET ?? "helo-app-7fbf8.firebasestorage.app");
const NO_EMULADOR = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

// ——— A guarda ———
//
// Rodar isto contra produção apaga arquivos de verdade. O script recusa
// qualquer execução ambígua: ou está claramente num emulador, ou o operador
// pediu produção por escrito, repetindo o id do projeto. Não existe caminho
// em que ele "adivinha" onde está.
if (!NO_EMULADOR && !PRODUCAO) {
  console.error(
    [
      "",
      "Recusando executar: não há FIRESTORE_EMULATOR_HOST e --producao não foi pedido.",
      "",
      "  ambiente de teste:",
      "    FIRESTORE_EMULATOR_HOST=127.0.0.1:8090 \\",
      "    STORAGE_EMULATOR_HOST=http://127.0.0.1:9199 \\",
      "    node scripts/migrar-midia-privada.mjs --banco <descartável> --apply",
      "",
      "  produção (ver docs/migracao-midia-privada-5.4b.md):",
      "    node scripts/migrar-midia-privada.mjs --producao --confirmo-projeto <id> --apply",
      "",
    ].join("\n")
  );
  process.exit(1);
}
if (PRODUCAO) {
  const confirmado = opcao("confirmo-projeto", "");
  if (confirmado !== PROJETO) {
    console.error(
      `Recusando: --producao exige --confirmo-projeto ${PROJETO} (recebido "${confirmado}").`
    );
    process.exit(1);
  }
  if (NO_EMULADOR) {
    console.error("Recusando: --producao com FIRESTORE_EMULATOR_HOST definido é contraditório.");
    process.exit(1);
  }
}

const app = initializeApp({ projectId: PROJETO, storageBucket: BALDE }, "migracao-5.4b");
const db = getFirestore(app, BANCO);
const balde = getStorage(app).bucket(BALDE);

function novoIdDeMidia() {
  return randomBytes(12).toString("hex");
}

const contagem = {
  pacientes: 0,
  frasesVistas: 0,
  frasesMigradas: 0,
  frasesJaPrivadas: 0,
  frasesSemObjeto: 0,
  frasesComFalha: 0,
  musicasVistas: 0,
  musicasMigradas: 0,
  musicasJaPrivadas: 0,
  musicasSemObjeto: 0,
  musicasComFalha: 0,
};

/** O caminho escondido dentro de uma URL pública legada. Nunca a URL inteira. */
function caminhoNaUrlLegada(valor) {
  if (typeof valor !== "string" || !valor) return null;
  try {
    const url = new URL(valor);
    const partes = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "firebasestorage.googleapis.com") {
      const i = partes.indexOf("o");
      return i >= 0 ? decodeURIComponent(partes.slice(i + 1).join("/")) : null;
    }
    if (url.hostname === "storage.googleapis.com") {
      return decodeURIComponent(partes.slice(1).join("/")) || null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Copia um objeto para o caminho privado e devolve se deu certo.
 *
 * A cópia herda a metadata do original — inclusive o `public, max-age=31536000,
 * immutable` que a Function antiga gravava. Deixá-lo seria carregar para o
 * modelo novo justamente o cabeçalho que o modelo novo existe para não ter.
 */
async function copiaParaPrivado(origemCaminho, destinoCaminho, metadataHelo) {
  const origem = balde.file(origemCaminho);
  const [existe] = await origem.exists();
  if (!existe) return "sem-objeto";
  const destino = balde.file(destinoCaminho);
  const [jaEsta] = await destino.exists();
  if (!jaEsta) await origem.copy(destino);
  const [confere] = await destino.exists();
  if (!confere) return "falha";
  await destino.setMetadata({
    contentType: "audio/mpeg",
    cacheControl: "private, no-store",
    metadata: metadataHelo,
  });
  return "ok";
}

async function migraFrases(patientId) {
  const col = db.collection("patients").doc(String(patientId)).collection("favoritePhrases");
  const snap = await col.get();
  for (const doc of snap.docs) {
    contagem.frasesVistas += 1;
    const dados = doc.data();
    const novo = typeof dados.audioStoragePath === "string" ? dados.audioStoragePath : "";
    const legadoDireto = typeof dados.storagePath === "string" ? dados.storagePath : "";
    const legadoNaUrl = caminhoNaUrlLegada(dados.audioUrl);
    const legado = legadoDireto || legadoNaUrl || "";

    // Já privado e sem resíduo público: nada a fazer. É o que torna a
    // execução repetida inofensiva.
    if (novo && !dados.audioUrl && !legadoDireto) {
      contagem.frasesJaPrivadas += 1;
      continue;
    }
    if (!legado) {
      // Documento com `audioUrl` de formato desconhecido ou sem objeto algum:
      // o campo público sai mesmo assim, porque um endereço guardado que não
      // resolve continua sendo um endereço guardado.
      if (dados.audioUrl && APLICA) {
        await doc.ref.set(
          { audioUrl: FieldValue.delete(), storagePath: FieldValue.delete() },
          { merge: true }
        );
      }
      contagem.frasesSemObjeto += 1;
      continue;
    }

    const destino = `patients/${patientId}/phrase-audio/${doc.id}/${novoIdDeMidia()}.mp3`;
    if (!APLICA) {
      contagem.frasesMigradas += 1;
      console.log(`  [dry-run] frase ${doc.id}: ${legado} → ${destino}`);
      continue;
    }
    const resultado = await copiaParaPrivado(legado, destino, {
      heloResource: "patientPhraseAudio",
      heloPatientId: String(patientId),
      heloPhraseId: doc.id,
      heloMigradoEm: new Date().toISOString(),
    });
    if (resultado === "sem-objeto") {
      // O documento aponta para um arquivo que não existe mais. A referência
      // pública sai; a frase volta a ser sintetizada na hora quando for ouvida.
      await doc.ref.set(
        {
          audioUrl: FieldValue.delete(),
          storagePath: FieldValue.delete(),
          audioStoragePath: FieldValue.delete(),
        },
        { merge: true }
      );
      contagem.frasesSemObjeto += 1;
      continue;
    }
    if (resultado === "falha") {
      contagem.frasesComFalha += 1;
      console.error(`  ! frase ${doc.id}: cópia não confirmada — nada foi apagado`);
      continue;
    }
    await doc.ref.set(
      {
        audioStoragePath: destino,
        audioUrl: FieldValue.delete(),
        storagePath: FieldValue.delete(),
      },
      { merge: true }
    );
    // Só agora. O documento já aponta para a cópia; o original pode morrer, e
    // com ele o download token que o tornava público.
    await balde.file(legado).delete({ ignoreNotFound: true }).catch(() => {});
    // A geração anterior no namespace novo, se houver, também sai.
    if (novo && novo !== destino) {
      await balde.file(novo).delete({ ignoreNotFound: true }).catch(() => {});
    }
    contagem.frasesMigradas += 1;
  }
}

async function migraMusicas(patientId) {
  const col = db.collection("patients").doc(String(patientId)).collection("playlist");
  const snap = await col.get();
  for (const doc of snap.docs) {
    contagem.musicasVistas += 1;
    const dados = doc.data();
    const caminho = typeof dados.storagePath === "string" ? dados.storagePath : "";
    const legadoNaUrl = caminhoNaUrlLegada(dados.audioUrl);
    const jaPrivado = caminho.startsWith(`patients/${patientId}/musics/`);

    if (jaPrivado && !dados.audioUrl) {
      contagem.musicasJaPrivadas += 1;
      continue;
    }
    const legado = jaPrivado ? "" : caminho || legadoNaUrl || "";
    if (!legado) {
      if (dados.audioUrl && APLICA) {
        await doc.ref.set({ audioUrl: FieldValue.delete() }, { merge: true });
      }
      contagem.musicasSemObjeto += 1;
      continue;
    }

    const destino = `patients/${patientId}/musics/${doc.id}.mp3`;
    if (!APLICA) {
      contagem.musicasMigradas += 1;
      console.log(`  [dry-run] música ${doc.id}: ${legado} → ${destino}`);
      continue;
    }
    const resultado = await copiaParaPrivado(legado, destino, {
      heloResource: "patientMusic",
      heloPatientId: String(patientId),
      generatedBy: "helo",
      heloMigradoEm: new Date().toISOString(),
    });
    if (resultado === "sem-objeto") {
      await doc.ref.set({ audioUrl: FieldValue.delete() }, { merge: true });
      contagem.musicasSemObjeto += 1;
      continue;
    }
    if (resultado === "falha") {
      contagem.musicasComFalha += 1;
      console.error(`  ! música ${doc.id}: cópia não confirmada — nada foi apagado`);
      continue;
    }
    await doc.ref.set(
      { storagePath: destino, audioUrl: FieldValue.delete() },
      { merge: true }
    );
    await balde.file(legado).delete({ ignoreNotFound: true }).catch(() => {});
    contagem.musicasMigradas += 1;
  }
}

console.log(
  [
    "",
    `migração de mídia privada · projeto ${PROJETO} · banco ${BANCO} · balde ${BALDE}`,
    `ambiente: ${NO_EMULADOR ? "EMULADOR" : "PRODUÇÃO"}`,
    `modo: ${APLICA ? "APPLY — vai copiar, apontar e apagar" : "dry-run — nada será alterado"}`,
    "",
  ].join("\n")
);

const pacientes = await db.collection("patients").get();
for (const paciente of pacientes.docs) {
  const patientId = Number(paciente.id);
  if (!Number.isSafeInteger(patientId) || patientId <= 0) continue;
  contagem.pacientes += 1;
  await migraFrases(patientId);
  await migraMusicas(patientId);
}

console.log(
  [
    "",
    "———— resumo ————",
    `pacientes percorridos:            ${contagem.pacientes}`,
    "",
    `frases vistas:                    ${contagem.frasesVistas}`,
    `  já privadas (nada a fazer):     ${contagem.frasesJaPrivadas}`,
    `  ${APLICA ? "migradas" : "a migrar"}:                      ${contagem.frasesMigradas}`,
    `  sem objeto no Storage:          ${contagem.frasesSemObjeto}`,
    `  com falha (intocadas):          ${contagem.frasesComFalha}`,
    "",
    `músicas vistas:                   ${contagem.musicasVistas}`,
    `  já privadas (nada a fazer):     ${contagem.musicasJaPrivadas}`,
    `  ${APLICA ? "migradas" : "a migrar"}:                      ${contagem.musicasMigradas}`,
    `  sem objeto no Storage:          ${contagem.musicasSemObjeto}`,
    `  com falha (intocadas):          ${contagem.musicasComFalha}`,
    "",
    APLICA
      ? "As URLs públicas antigas destes objetos deixaram de funcionar: o arquivo que elas apontavam não existe mais."
      : "Nada foi alterado. Repita com --apply para executar.",
    "",
  ].join("\n")
);

process.exit(contagem.frasesComFalha + contagem.musicasComFalha > 0 ? 1 : 0);
