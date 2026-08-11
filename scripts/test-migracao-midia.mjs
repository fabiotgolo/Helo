// ——— A migração do legado faz o que promete, e só isso (Fase 5.4B) ———
//
//   npm run emu:test                 (Firestore 8090 + Storage 9199)
//   npm run test:migracao:midia
//
// O script de migração apaga arquivos. Um erro nele não é um teste vermelho —
// é áudio perdido de um paciente. Por isso ele é exercitado aqui contra o
// emulador, com dados semeados, antes de existir qualquer conversa sobre
// rodá-lo em produção.
//
// As perguntas:
//
//   1. o dry-run altera alguma coisa? (não pode)
//   2. o apply cria a cópia privada e aponta o documento para ela?
//   3. o objeto legado — o que a URL pública alcançava — some?
//   4. rodar de novo causa dano ou duplicação? (não pode)
//   5. um documento que aponta para um arquivo inexistente vira o quê?
//   6. um documento já migrado é reconhecido?
//   7. a cópia herda o cacheControl público do original? (não pode)

import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { spawnSync } from "node:child_process";

const EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8090";
const STORAGE = process.env.STORAGE_EMULATOR_HOST ?? "http://127.0.0.1:9199";
const PROJETO = process.env.GCLOUD_PROJECT ?? "helo-app-7fbf8";
const BANCO = process.env.HELO_MIGRACAO_BANCO ?? "suite-migracao";
const BALDE = process.env.FIREBASE_STORAGE_BUCKET ?? "helo-app-7fbf8.firebasestorage.app";

let ok = 0;
let mau = 0;
function checa(nome, condicao, detalhe = "") {
  if (condicao) {
    ok += 1;
    console.log(`  ✓ ${nome}`);
  } else {
    mau += 1;
    console.error(`  ✗ ${nome} ${detalhe}`);
  }
}
function secao(t) {
  console.log(`\n${t}`);
}

// O banco é descartável por construção: um nome próprio, nunca `helo-db`.
if (BANCO === "helo-db") {
  console.error("recusando: esta suíte apaga o banco inteiro. Use um descartável.");
  process.exit(1);
}

async function emuladoresNoAr() {
  try {
    const a = await fetch(`http://${EMU}/`, { signal: AbortSignal.timeout(3000) });
    const b = await fetch(`${STORAGE}/`, { signal: AbortSignal.timeout(3000) });
    return a.status > 0 && b.status > 0;
  } catch {
    return false;
  }
}
if (!(await emuladoresNoAr())) {
  console.error(`\nEmuladores ausentes (Firestore ${EMU}, Storage ${STORAGE}).\n  npm run emu:test\n`);
  process.exit(1);
}

process.env.STORAGE_EMULATOR_HOST = STORAGE;
const app = initializeApp({ projectId: PROJETO, storageBucket: BALDE }, "suite-migracao");
const db = getFirestore(app, BANCO);
const balde = getStorage(app).bucket(BALDE);

await fetch(`http://${EMU}/emulator/v1/projects/${PROJETO}/databases/${BANCO}/documents`, {
  method: "DELETE",
});

const PACIENTE = 4242;
const URL_LEGADA = (caminho) =>
  `https://firebasestorage.googleapis.com/v0/b/${BALDE}/o/${encodeURIComponent(caminho)}?alt=media&token=00000000-0000-4000-8000-000000000000`;

const LEGADO_FRASE = `patients/${PACIENTE}/phrases_audio/frase-um.mp3`;
const LEGADO_MUSICA = "musics/1700000000000-mpb.mp3";
const CONTEUDO_FRASE = Buffer.from("audio-da-frase-legada");
const CONTEUDO_MUSICA = Buffer.from("audio-da-musica-legada");

async function semeia() {
  await balde.file(LEGADO_FRASE).save(CONTEUDO_FRASE, {
    resumable: false,
    metadata: { contentType: "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" },
  });
  await balde.file(LEGADO_MUSICA).save(CONTEUDO_MUSICA, {
    resumable: false,
    metadata: { contentType: "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" },
  });
  const paciente = db.collection("patients").doc(String(PACIENTE));
  await paciente.set({ name: "Paciente da migração", active: 1 });
  await paciente.collection("favoritePhrases").doc("frase-um").set({
    id: "frase-um",
    text: "Uma frase qualquer.",
    createdAt: new Date().toISOString(),
    audioUrl: URL_LEGADA(LEGADO_FRASE),
    storagePath: LEGADO_FRASE,
    usesClonedVoice: true,
  });
  // Um documento que aponta para um arquivo que não existe mais.
  await paciente.collection("favoritePhrases").doc("frase-orfa").set({
    id: "frase-orfa",
    text: "Outra frase.",
    createdAt: new Date().toISOString(),
    audioUrl: URL_LEGADA(`patients/${PACIENTE}/phrases_audio/sumiu.mp3`),
    storagePath: `patients/${PACIENTE}/phrases_audio/sumiu.mp3`,
  });
  // Um documento que já nasceu no modelo novo.
  await paciente.collection("favoritePhrases").doc("frase-nova").set({
    id: "frase-nova",
    text: "Terceira frase.",
    createdAt: new Date().toISOString(),
    audioStoragePath: `patients/${PACIENTE}/phrase-audio/frase-nova/aaaa.mp3`,
  });
  await paciente.collection("playlist").doc("faixa-um").set({
    title: "Faixa",
    prompt: "algo calmo",
    genre: "mpb",
    audioUrl: URL_LEGADA(LEGADO_MUSICA),
    storagePath: LEGADO_MUSICA,
    createdAt: new Date().toISOString(),
    dateKey: "2026-01-01",
    period: "manhã",
  });
}

function roda(...args) {
  return spawnSync(
    process.execPath,
    ["scripts/migrar-midia-privada.mjs", "--banco", BANCO, "--balde", BALDE, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FIRESTORE_EMULATOR_HOST: EMU,
        STORAGE_EMULATOR_HOST: STORAGE,
        GCLOUD_PROJECT: PROJETO,
      },
    }
  );
}

await semeia();

// ════════════════════════════════════════════════════════════════════
secao("1. dry-run: conta, e não toca em nada");
{
  const r = roda();
  checa("o script termina bem", r.status === 0, `— saiu ${r.status}: ${r.stderr?.slice(0, 200)}`);
  checa("ele anuncia que nada será alterado", /nada será alterado|Nada foi alterado/.test(r.stdout));
  checa("ele diz o que migraria", /a migrar:\s+1/.test(r.stdout), `— saída:\n${r.stdout.slice(-600)}`);
  const doc = await db.collection("patients").doc(String(PACIENTE)).collection("favoritePhrases").doc("frase-um").get();
  checa("o documento continua com o campo legado", Boolean(doc.data().audioUrl));
  const [existe] = await balde.file(LEGADO_FRASE).exists();
  checa("o objeto legado continua lá", existe === true);
}

// ════════════════════════════════════════════════════════════════════
secao("2. dry-run não imprime conteúdo do paciente");
{
  const r = roda();
  checa("não aparece o texto da frase", !r.stdout.includes("Uma frase qualquer"));
  checa("não aparece o prompt da música", !r.stdout.includes("algo calmo"));
  checa("não aparece o título", !r.stdout.includes("Faixa"));
  checa("não aparece o download token", !r.stdout.includes("token="));
  checa("nem a URL pública inteira", !/https:\/\/firebasestorage/.test(r.stdout));
}

// ════════════════════════════════════════════════════════════════════
secao("3. apply: a cópia nasce privada e o documento aponta para ela");
{
  const r = roda("--apply");
  checa("o script termina bem", r.status === 0, `— saiu ${r.status}: ${r.stderr?.slice(0, 300)}`);
  const doc = await db.collection("patients").doc(String(PACIENTE)).collection("favoritePhrases").doc("frase-um").get();
  const dados = doc.data();
  checa("o campo público sumiu do documento", dados.audioUrl === undefined);
  checa("o storagePath legado também", dados.storagePath === undefined);
  checa(
    "e existe uma referência privada, sob o paciente e sob a frase",
    typeof dados.audioStoragePath === "string" &&
      dados.audioStoragePath.startsWith(`patients/${PACIENTE}/phrase-audio/frase-um/`),
    `— ${dados.audioStoragePath}`
  );
  const [copia] = await balde.file(dados.audioStoragePath).download();
  checa("a cópia tem os bytes do original", copia.equals(CONTEUDO_FRASE));
  const [meta] = await balde.file(dados.audioStoragePath).getMetadata();
  checa(
    "e NÃO herdou o cache público do original",
    meta.cacheControl === "private, no-store",
    `— ${meta.cacheControl}`
  );
  checa("a metadata liga o objeto ao paciente", meta.metadata?.heloPatientId === String(PACIENTE));
  checa("e diz o que ele é", meta.metadata?.heloResource === "patientPhraseAudio");
  checa("sem carregar conteúdo nenhum", !JSON.stringify(meta.metadata).includes("Uma frase"));
}

// ════════════════════════════════════════════════════════════════════
secao("4. o objeto que a URL pública alcançava deixou de existir");
{
  const [existe] = await balde.file(LEGADO_FRASE).exists();
  checa("o objeto legado da frase sumiu", existe === false);
  const [musica] = await balde.file(LEGADO_MUSICA).exists();
  checa("o da música também", musica === false);
  // É esta a prova verificável de que a URL antiga morreu: ela apontava para
  // um objeto que não está mais no bucket. Nada aqui depende de acreditar em
  // como o Firebase trata tokens.
  const resposta = await fetch(`${STORAGE}/v0/b/${BALDE}/o/${encodeURIComponent(LEGADO_FRASE)}?alt=media&token=00000000-0000-4000-8000-000000000000`);
  checa("e a URL legada não devolve áudio", resposta.status >= 400, `— recebeu ${resposta.status}`);
}

// ════════════════════════════════════════════════════════════════════
secao("5. música: migrada para o namespace do paciente");
{
  const doc = await db.collection("patients").doc(String(PACIENTE)).collection("playlist").doc("faixa-um").get();
  const dados = doc.data();
  checa("o campo público sumiu", dados.audioUrl === undefined);
  checa(
    "o caminho é o do paciente",
    dados.storagePath === `patients/${PACIENTE}/musics/faixa-um.mp3`,
    `— ${dados.storagePath}`
  );
  const [copia] = await balde.file(dados.storagePath).download();
  checa("com os bytes do original", copia.equals(CONTEUDO_MUSICA));
}

// ════════════════════════════════════════════════════════════════════
secao("6. documento apontando para arquivo inexistente");
{
  const doc = await db.collection("patients").doc(String(PACIENTE)).collection("favoritePhrases").doc("frase-orfa").get();
  const dados = doc.data();
  checa("a referência pública sai mesmo assim", dados.audioUrl === undefined);
  checa("e não fica uma referência privada quebrada", dados.audioStoragePath === undefined);
  checa("a frase em si continua intacta", dados.text === "Outra frase.");
}

// ════════════════════════════════════════════════════════════════════
secao("7. documento já migrado é reconhecido e deixado em paz");
{
  const doc = await db.collection("patients").doc(String(PACIENTE)).collection("favoritePhrases").doc("frase-nova").get();
  checa(
    "a referência privada continua a mesma",
    doc.data().audioStoragePath === `patients/${PACIENTE}/phrase-audio/frase-nova/aaaa.mp3`
  );
  const r = roda();
  checa("e o dry-run a conta como já privada", /já privadas \(nada a fazer\):\s+2/.test(r.stdout), `— ${r.stdout.slice(-500)}`);
}

// ════════════════════════════════════════════════════════════════════
secao("8. idempotência: a segunda execução não causa dano");
{
  const antes = await db.collection("patients").doc(String(PACIENTE)).collection("favoritePhrases").doc("frase-um").get();
  const caminhoAntes = antes.data().audioStoragePath;
  const r = roda("--apply");
  checa("termina bem", r.status === 0, `— saiu ${r.status}`);
  const depois = await db.collection("patients").doc(String(PACIENTE)).collection("favoritePhrases").doc("frase-um").get();
  checa("a referência não mudou", depois.data().audioStoragePath === caminhoAntes);
  const [existe] = await balde.file(caminhoAntes).exists();
  checa("a mídia continua no lugar", existe === true);
  const [arquivos] = await balde.getFiles({ prefix: `patients/${PACIENTE}/phrase-audio/frase-um/` });
  // O emulador pode não suportar listagem; quando suportar, não pode haver
  // duplicata.
  checa(
    "não nasceu uma segunda cópia",
    arquivos.length <= 1,
    `— ${arquivos.length} objetos: ${arquivos.map((a) => a.name).join(", ")}`
  );
  checa("nenhuma falha reportada", /com falha \(intocadas\):\s+0/.test(r.stdout));
}

// ════════════════════════════════════════════════════════════════════
secao("9. a guarda recusa execução ambígua");
{
  const semEmulador = spawnSync(process.execPath, ["scripts/migrar-midia-privada.mjs", "--apply"], {
    encoding: "utf8",
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: "", STORAGE_EMULATOR_HOST: "" },
  });
  checa("sem emulador e sem --producao, recusa", semEmulador.status === 1);
  checa("e explica os dois caminhos", /--producao/.test(semEmulador.stderr));
  const producaoSemConfirmar = spawnSync(
    process.execPath,
    ["scripts/migrar-midia-privada.mjs", "--producao", "--apply"],
    { encoding: "utf8", env: { ...process.env, FIRESTORE_EMULATOR_HOST: "", STORAGE_EMULATOR_HOST: "" } }
  );
  checa("produção sem confirmar o projeto, recusa", producaoSemConfirmar.status === 1);
  checa("e diz exatamente o que falta", /--confirmo-projeto/.test(producaoSemConfirmar.stderr));
  const contraditorio = spawnSync(
    process.execPath,
    ["scripts/migrar-midia-privada.mjs", "--producao", "--confirmo-projeto", PROJETO, "--apply"],
    { encoding: "utf8", env: { ...process.env, FIRESTORE_EMULATOR_HOST: EMU } }
  );
  checa("--producao com emulador definido é contradição e recusa", contraditorio.status === 1);
}

// Limpeza.
for (const caminho of [LEGADO_FRASE, LEGADO_MUSICA]) {
  await balde.file(caminho).delete({ ignoreNotFound: true }).catch(() => {});
}
const [restos] = await balde.getFiles({ prefix: `patients/${PACIENTE}/` });
for (const arquivo of restos) await arquivo.delete({ ignoreNotFound: true }).catch(() => {});
await deleteApp(app);

console.log(`\n${mau === 0 ? "✓" : "✗"} ${ok} passaram, ${mau} falharam`);
process.exit(mau === 0 ? 0 : 1);
