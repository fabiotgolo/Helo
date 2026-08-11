// ——— O cliente não entra no bucket (Fase 5.4B) ———
//
//   npm run emu:test          (terminal 1 — sobe Firestore + Storage)
//   npm run test:storage:rules
//
// A auditoria da 5.4A registrou as Storage Rules como CONFIGURAÇÃO EXTERNA NÃO
// VERIFICADA: elas não estavam no repositório, e não havia como revisar o que
// não existe no Git. Agora estão em `storage.rules`, e esta suíte prova que
// elas fazem o que dizem — contra o emulador de verdade, não contra uma
// leitura do arquivo.
//
// ——— O que esta suíte NÃO prova ———
//
// Ela não prova que o R-04 está fechado, e a distinção é o ponto inteiro da
// fase. Um Firebase download URL funciona por posse do token e **passa por
// cima destas regras**; nenhuma regra jamais o teria bloqueado. O R-04 foi
// fechado parando de emitir o token, e quem prova isso é
// `test:midia:privada` (na estrutura) e `test:midia:autorizacao` (no HTTP).
//
// Aqui provamos a outra metade: com o token fora de cena, sobra o acesso
// DIRETO ao bucket — e ele está fechado.
//
// ——— Por que negar tudo não quebra nada ———
//
// Verificado, não presumido: o Helo não tem o SDK cliente do Firebase. Só
// `firebase-admin`, que roda no servidor e **não passa pelas regras**. Esta
// suíte confere as duas pontas: o cliente recusado e o servidor operando.

import { initializeApp, deleteApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

const HOST = process.env.STORAGE_EMULATOR_HOST || "http://127.0.0.1:9199";
const PROJETO = process.env.GCLOUD_PROJECT || "helo-app-7fbf8";
const BALDE = process.env.FIREBASE_STORAGE_BUCKET || "helo-app-7fbf8.firebasestorage.app";

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

function secao(titulo) {
  console.log(`\n${titulo}`);
}

/** O emulador está no ar? Sem ele a suíte não tem o que exercitar. */
async function emuladorNoAr() {
  try {
    const r = await fetch(`${HOST}/`, { signal: AbortSignal.timeout(3000) });
    return r.status > 0;
  } catch {
    return false;
  }
}

if (!(await emuladorNoAr())) {
  console.error(
    [
      "",
      `Emulador de Storage não responde em ${HOST}.`,
      "",
      "  npm run emu:test        (Firestore 8090 + Storage 9199)",
      "",
      "Esta suíte precisa do emulador porque ela testa COMPORTAMENTO das",
      "regras, não o texto delas. Ler o arquivo não prova nada.",
      "",
    ].join("\n")
  );
  process.exit(1);
}

// O ambiente do Admin SDK aponta para o emulador. Ele passa por cima das
// regras de propósito — é o servidor, e é isso que faz o produto funcionar
// com o bucket fechado.
process.env.STORAGE_EMULATOR_HOST = HOST;
const app = initializeApp({ projectId: PROJETO, storageBucket: BALDE }, "storage-rules-suite");
const balde = getStorage(app).bucket(BALDE);

// Um objeto de cada caminho que importa. O conteúdo é irrelevante e
// deliberadamente não é áudio de ninguém: são quatro bytes.
const OBJETOS = {
  fraseNova: "patients/7/phrase-audio/frase-teste/abc123.mp3",
  fraseLegada: "patients/7/phrases_audio/frase-teste.mp3",
  musicaNova: "patients/7/musics/faixa-teste.mp3",
  musicaLegada: "musics/1700000000000-rock.mp3",
  qualquerOutro: "algum/caminho/qualquer.bin",
};

secao("0. preparação — o servidor grava, porque o Admin SDK não passa pelas regras");
for (const [nome, caminho] of Object.entries(OBJETOS)) {
  try {
    await balde.file(caminho).save(Buffer.from("teste"), {
      resumable: false,
      metadata: { contentType: "application/octet-stream" },
    });
    checa(`o servidor gravou ${nome}`, true);
  } catch (erro) {
    checa(`o servidor gravou ${nome}`, false, `— ${erro?.message ?? erro}`);
  }
}

/**
 * Uma leitura como o CLIENTE faria: pelo endpoint Firebase do Storage, sem
 * credencial nenhuma. É a forma que o SDK do navegador usa, e é exatamente
 * contra ela que as regras são avaliadas.
 */
async function leituraDeCliente(caminho) {
  const url = `${HOST}/v0/b/${BALDE}/o/${encodeURIComponent(caminho)}?alt=media`;
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return r.status;
}

/** Uma escrita como o cliente faria. */
async function escritaDeCliente(caminho) {
  const url = `${HOST}/v0/b/${BALDE}/o?name=${encodeURIComponent(caminho)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from("invasao"),
    signal: AbortSignal.timeout(5000),
  });
  return r.status;
}

secao("1. o cliente anônimo não lê o áudio da voz clonada do paciente");
{
  const status = await leituraDeCliente(OBJETOS.fraseNova);
  checa("leitura direta do caminho novo é recusada", status === 403, `— recebeu ${status}`);
  const legado = await leituraDeCliente(OBJETOS.fraseLegada);
  checa("…e o caminho legado também", legado === 403, `— recebeu ${legado}`);
}

secao("2. nem a música do paciente");
{
  const nova = await leituraDeCliente(OBJETOS.musicaNova);
  checa("leitura direta da música sob o paciente é recusada", nova === 403, `— recebeu ${nova}`);
  const legada = await leituraDeCliente(OBJETOS.musicaLegada);
  checa("…e do namespace global legado também", legada === 403, `— recebeu ${legada}`);
}

secao("3. nem qualquer outro caminho do bucket");
{
  const status = await leituraDeCliente(OBJETOS.qualquerOutro);
  checa("a regra geral fecha o resto", status === 403, `— recebeu ${status}`);
  const inexistente = await leituraDeCliente("patients/7/phrase-audio/nao-existe/x.mp3");
  // Recusa ANTES de existir ou não: o cliente não descobre o que há no bucket
  // pela diferença entre 403 e 404.
  checa(
    "um caminho inexistente recebe a mesma recusa, não um 404 revelador",
    inexistente === 403,
    `— recebeu ${inexistente}`
  );
}

secao("4. o paciente errado não é uma pergunta que o bucket responda");
{
  // Não existe "paciente certo" para o cliente: a regra não distingue, porque
  // o cliente nunca é autorizado. Quem faz essa distinção é a rota do Next,
  // com o vínculo do usuário — e é lá que `test:midia:autorizacao` a prova.
  const outroPaciente = await leituraDeCliente("patients/8/phrase-audio/frase-teste/abc123.mp3");
  checa("o caminho de outro paciente também é recusado", outroPaciente === 403, `— recebeu ${outroPaciente}`);
}

secao("5. o cliente não escreve áudio nenhum");
{
  const frase = await escritaDeCliente("patients/7/phrase-audio/forjada/x.mp3");
  checa("escrita no caminho de frase é recusada", frase === 403, `— recebeu ${frase}`);
  const musica = await escritaDeCliente("patients/7/musics/forjada.mp3");
  checa("escrita no caminho de música é recusada", musica === 403, `— recebeu ${musica}`);
  const qualquer = await escritaDeCliente("qualquer/coisa.bin");
  checa("escrita em qualquer outro caminho é recusada", qualquer === 403, `— recebeu ${qualquer}`);
}

secao("6. e o servidor continua trabalhando");
{
  // A prova de que fechar as regras não quebrou o produto: o Admin SDK — que é
  // quem o Helo usa para gravar, ler e apagar — não é afetado por elas.
  const [conteudo] = await balde.file(OBJETOS.fraseNova).download();
  checa("o Admin SDK lê o objeto que o cliente não alcança", conteudo.toString() === "teste");
  await balde.file(OBJETOS.fraseNova).delete({ ignoreNotFound: true });
  const [existe] = await balde.file(OBJETOS.fraseNova).exists();
  checa("…e apaga", existe === false);
}

// Limpeza do que esta suíte semeou.
for (const caminho of Object.values(OBJETOS)) {
  await balde.file(caminho).delete({ ignoreNotFound: true }).catch(() => {});
}
await deleteApp(app);

console.log(`\n${mau === 0 ? "✓" : "✗"} ${ok} passaram, ${mau} falharam`);
process.exit(mau === 0 ? 0 : 1);
