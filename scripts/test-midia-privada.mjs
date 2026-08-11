// ——— A mídia do paciente é privada, e continua privada (Fase 5.4B) ———
//
//   npm run test:midia:privada
//
// Esta suíte roda o CÓDIGO DE PRODUÇÃO de `lib/midia-privada.ts` e lê o texto
// dos arquivos que não podem ser importados de fora do Next (as rotas e a
// Cloud Function). Ela responde a três perguntas, nesta ordem de importância:
//
//   1. o Helo ainda emite alguma URL pública para mídia do paciente?
//   2. a referência guardada leva a algum lugar quando cai em mãos erradas?
//   3. o ciclo de vida deixa órfão, quebra referência ou perde mídia?
//
// A prova de AUTORIZAÇÃO em si — anônimo, sem vínculo, paciente cruzado — é
// HTTP e vive em `test:midia:autorizacao`. Aqui é a fronteira estrutural: o
// que existe no código, e o que não pode voltar a existir.
//
// Todo comentário é removido antes de qualquer busca: este arquivo fala em
// prosa dos mesmos nomes que procura.

import { register } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

register("./alias-loader.mjs", import.meta.url);

const {
  prefixoDeAudioDaFrase,
  caminhoDeAudioDaFrase,
  caminhoDeMusica,
  caminhoDeFraseEhValido,
  caminhoDeMusicaEhValido,
  interpretaRange,
  novoIdDeMidia,
} = await import("../lib/midia-privada.ts");

const { caminhoDaFaixa, caminhoNaUrlLegada, toPlaylistTrack } = await import("../lib/playlist.ts");

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

function codigoDe(caminho) {
  return readFileSync(resolve(RAIZ, caminho), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

/**
 * Os ARGUMENTOS de cada `console.*`, e só eles.
 *
 * Por contagem de parênteses, não por expressão regular: uma regex que tenta
 * achar o fim da chamada engole a instrução seguinte, e aí qualquer arquivo
 * "vaza" tudo o que vem depois de um log. Isso já produziu três falsos
 * positivos nesta suíte antes de virar esta função.
 */
function chamadasDeConsole(fonte) {
  const encontradas = [];
  const inicio = /console\.(log|warn|error|info|debug)\(/g;
  let m;
  while ((m = inicio.exec(fonte)) != null) {
    let profundidade = 1;
    let i = m.index + m[0].length;
    while (i < fonte.length && profundidade > 0) {
      if (fonte[i] === "(") profundidade += 1;
      else if (fonte[i] === ")") profundidade -= 1;
      i += 1;
    }
    encontradas.push(fonte.slice(m.index, i));
  }
  return encontradas;
}

function fontesDoProduto() {
  const achados = [];
  const ignorar = new Set(["node_modules", ".next", ".git"]);
  const anda = (dir) => {
    for (const entrada of readdirSync(resolve(RAIZ, dir))) {
      if (ignorar.has(entrada)) continue;
      const completo = join(dir, entrada);
      if (statSync(resolve(RAIZ, completo)).isDirectory()) anda(completo);
      else if (/\.(tsx?|js)$/.test(entrada)) achados.push(completo);
    }
  };
  for (const raiz of ["app", "components", "lib"]) anda(raiz);
  achados.push("functions/index.js");
  return achados;
}

const FONTES = fontesDoProduto();
const FUNCAO = codigoDe("functions/index.js");

// ═════════════════════════════════════════════════════════════════════════
secao("1. nenhuma URL pública é emitida — em lugar nenhum");
{
  const emitem = FONTES.filter((f) =>
    /getDownloadURL|getSignedUrl|makePublic\(|firebaseStorageDownloadTokens/.test(codigoDe(f))
  );
  checa(
    "getDownloadURL / signed URL / makePublic não existem no produto",
    emitem.length === 0,
    `— em ${emitem.join(", ")}`
  );
  checa(
    "a Function de frase devolve confirmação, não endereço",
    /return res\.status\(200\)\.json\(\{ ok: true \}\)/.test(FUNCAO)
  );
  checa(
    "a Function de música devolve o id da faixa, não endereço",
    /trackId: trackRef\.id/.test(FUNCAO) && !/audioUrl,/.test(FUNCAO)
  );
}

// ═════════════════════════════════════════════════════════════════════════
secao("2. o caminho carrega o paciente, e não carrega conteúdo");
{
  checa(
    "a frase vive sob o paciente, sob a frase, com id opaco",
    caminhoDeAudioDaFrase(7, "frase1", "abc") === "patients/7/phrase-audio/frase1/abc.mp3"
  );
  checa(
    "a música vive sob o paciente",
    caminhoDeMusica(7, "faixa1") === "patients/7/musics/faixa1.mp3"
  );
  checa(
    "o prefixo da frase é o que a varredura usa",
    prefixoDeAudioDaFrase(7, "frase1") === "patients/7/phrase-audio/frase1/"
  );
  const id = novoIdDeMidia();
  checa("o id da mídia é opaco e hexadecimal", /^[0-9a-f]{24}$/.test(id));
  checa("…e não se repete", novoIdDeMidia() !== id);
  // A-12: nada do que foi pedido aparece no nome do arquivo.
  checa(
    "o construtor de música não deriva o nome de relógio nem de gênero",
    !/Date\.now\(\)/.test(caminhoDeMusica.toString()) &&
      !/genre/.test(caminhoDeMusica.toString())
  );
}

// ═════════════════════════════════════════════════════════════════════════
secao("3. um caminho estragado não vira leitura de outro lugar");
{
  checa("o caminho legítimo passa", caminhoDeFraseEhValido("patients/7/phrase-audio/f/a.mp3", 7));
  checa("o caminho legado passa", caminhoDeFraseEhValido("patients/7/phrases_audio/f.mp3", 7));
  checa(
    "o caminho de OUTRO paciente não passa",
    !caminhoDeFraseEhValido("patients/8/phrase-audio/f/a.mp3", 7)
  );
  checa(
    "travessia não passa",
    !caminhoDeFraseEhValido("patients/7/phrase-audio/../../8/phrase-audio/a.mp3", 7)
  );
  checa("caminho absoluto não passa", !caminhoDeFraseEhValido("/patients/7/phrase-audio/a.mp3", 7));
  checa("barra dupla não passa", !caminhoDeFraseEhValido("patients/7//phrase-audio/a.mp3", 7));
  checa("vazio não passa", !caminhoDeFraseEhValido("", 7));
  checa(
    "um prefixo parecido não passa",
    !caminhoDeFraseEhValido("patients/70/phrase-audio/f/a.mp3", 7)
  );
  checa("a música legítima passa", caminhoDeMusicaEhValido("patients/7/musics/x.mp3", 7));
  checa("a música legada global passa", caminhoDeMusicaEhValido("musics/123.mp3", 7));
  checa(
    "a música de outro paciente não passa",
    !caminhoDeMusicaEhValido("patients/8/musics/x.mp3", 7)
  );
  checa(
    "o áudio de frase não passa pela porta da música",
    !caminhoDeMusicaEhValido("patients/7/phrase-audio/f/a.mp3", 7)
  );
}

// ═════════════════════════════════════════════════════════════════════════
secao("4. nenhuma rota aceita caminho vindo do navegador");
{
  const frase = codigoDe("app/api/favorite-phrases/audio/route.ts");
  const musica = codigoDe("app/api/patients/[patientId]/playlist/audio/route.ts");
  for (const [nome, fonte] of [["frase", frase], ["música", musica]]) {
    checa(
      `a rota de ${nome} não lê nada chamado path/caminho/storagePath da query`,
      !/searchParams\.get\("(path|caminho|storagePath|file)"\)/.test(fonte)
    );
    checa(
      `a rota de ${nome} exige vínculo com o paciente antes de resolver`,
      fonte.indexOf("requirePatientAccess") < fonte.indexOf("entregaMidia")
    );
  }
  checa(
    "a rota de frase resolve o caminho pelo id, no servidor",
    /resolveFavoritePhraseAudio\(patientId, phraseId\)/.test(frase)
  );
  checa(
    "a rota de música resolve o caminho pelo documento, no servidor",
    /caminhoDaFaixa\(patientId, doc\.data\(\)/.test(musica)
  );
  checa(
    "os dois ids são conferidos contra um formato antes de virar consulta",
    /\[A-Za-z0-9_-\]\{1,150\}/.test(frase) && /\[A-Za-z0-9_-\]\{1,150\}/.test(musica)
  );
}

// ═════════════════════════════════════════════════════════════════════════
secao("5. a política de cache é a da sensibilidade, não a da conveniência");
{
  const frase = codigoDe("app/api/favorite-phrases/audio/route.ts");
  const musica = codigoDe("app/api/patients/[patientId]/playlist/audio/route.ts");
  checa("a voz clonada é private, no-store", /"private, no-store"/.test(frase));
  checa("a música é private e revalidada", /"private, max-age=0, must-revalidate"/.test(musica));
  checa("nenhuma das duas é public", !/public/.test(frase) && !/public/.test(musica));
  checa(
    "o objeto no Storage também não nasce com cache público",
    !/cacheControl: "public/.test(FUNCAO)
  );
}

// ═════════════════════════════════════════════════════════════════════════
secao("6. Range: a barra de progresso continua funcionando");
{
  checa("sem Range, entrega inteira", interpretaRange(null, 1000) === null);
  checa("cabeçalho estranho é ignorado", interpretaRange("bananas=0-1", 1000) === null);
  const inicio = interpretaRange("bytes=0-99", 1000);
  checa("intervalo comum", inicio.inicio === 0 && inicio.fim === 99);
  const aberto = interpretaRange("bytes=500-", 1000);
  checa("intervalo aberto vai até o fim", aberto.inicio === 500 && aberto.fim === 999);
  const sufixo = interpretaRange("bytes=-200", 1000);
  checa("sufixo pega os últimos bytes", sufixo.inicio === 800 && sufixo.fim === 999);
  const estoura = interpretaRange("bytes=0-99999", 1000);
  checa("fim além do arquivo é cortado, não recusado", estoura.fim === 999);
  checa("início além do arquivo é 416", interpretaRange("bytes=5000-", 1000) === "invalido");
  checa("intervalo invertido é 416", interpretaRange("bytes=900-100", 1000) === "invalido");
  checa("bytes=- é 416", interpretaRange("bytes=-", 1000) === "invalido");
  checa("sufixo zero é 416", interpretaRange("bytes=-0", 1000) === "invalido");
}

// ═════════════════════════════════════════════════════════════════════════
secao("7. R-04b: a ordem que impede o órfão");
{
  const bloco = FUNCAO.slice(
    FUNCAO.indexOf("async function synthesizePhraseAudioHandler"),
    FUNCAO.indexOf("function textParameter")
  );
  const posSave = bloco.indexOf("await file.save(");
  const posSet = bloco.indexOf("await phraseRef.set(");
  const posVarre = bloco.indexOf("await varrePrefixoDaFrase(");
  checa("o objeto novo nasce antes de a referência trocar", posSave > 0 && posSave < posSet);
  checa("a varredura só acontece depois da troca", posSet < posVarre);
  checa(
    "se a troca falhar, o objeto novo é removido na hora",
    /catch \(falhaNoDocumento\)[\s\S]{0,200}?file\.delete\(\{ ignoreNotFound: true \}\)/.test(bloco)
  );
  checa(
    "a varredura preserva a geração atual",
    /varrePrefixoDaFrase\(patientId, phraseId, storagePath\)/.test(bloco)
  );
  checa(
    "a geração anterior fora do prefixo também é removida",
    /anterior[\s\S]{0,300}?\.delete\(\{ ignoreNotFound: true \}\)/.test(bloco)
  );
  checa(
    "a varredura nunca derruba a síntese que deu certo",
    /async function varrePrefixoDaFrase[\s\S]*?catch \{/.test(FUNCAO)
  );
}

// ═════════════════════════════════════════════════════════════════════════
secao("8. edição, exclusão e troca de voz tratam a mídia");
{
  const frases = codigoDe("lib/favorite-phrases.ts");
  checa(
    "editar o texto apaga a referência E o objeto",
    /updateFavoritePhrase[\s\S]*?audioStoragePath: FieldValue\.delete\(\)[\s\S]*?descartaMidiaDaFrase/.test(
      frases
    )
  );
  checa(
    "excluir a frase apaga a mídia ANTES do documento",
    frases.indexOf("await descartaMidiaDaFrase(patientId, phraseId, existing.data());\n  await ref.delete();") > 0
  );
  checa(
    "a limpeza alcança todas as gerações e o caminho legado",
    /descartaMidiaDaFrase[\s\S]*?apagaPrefixo\(prefixoDeAudioDaFrase[\s\S]*?apagaObjeto\(legado\)/.test(
      frases
    )
  );
  checa(
    "trocar o clone invalida o áudio pré-sintetizado",
    /invalidateFavoritePhraseAudio/.test(codigoDe("app/api/admin/patient-voice/route.ts"))
  );
  checa(
    "…e remover o clone também",
    (codigoDe("app/api/admin/patient-voice/route.ts").match(/invalidateFavoritePhraseAudio\(/g) ?? [])
      .length === 2
  );
  checa(
    "…e trocar a FONTE da voz também",
    /invalidateFavoritePhraseAudio/.test(codigoDe("app/api/patient-voice-source/route.ts"))
  );
  checa(
    "a invalidação devolve contagem, nunca texto",
    /Promise<number>/.test(frases)
  );
}

// ═════════════════════════════════════════════════════════════════════════
secao("9. o cliente nunca vê um endereço de mídia");
{
  const frases = codigoDe("lib/favorite-phrases.ts");
  checa("o tipo da frase expõe um booleano", /hasAudio: boolean/.test(frases));
  // Só o TIPO EXPORTADO importa aqui: é ele que atravessa para o navegador.
  // As ocorrências de `audioUrl` no corpo do módulo são `FieldValue.delete()`
  // — o oposto de exposição.
  const tipoDaFrase = frases.slice(
    frases.indexOf("export type FavoritePhrase"),
    frases.indexOf("const phrases =")
  );
  checa(
    "…e o tipo não carrega caminho nem URL",
    !/audioUrl|audioStoragePath|storagePath/.test(tipoDaFrase)
  );
  const modal = codigoDe("components/phrases-to-listen-modal.tsx");
  checa(
    "o modal monta o endereço interno a partir do id",
    /\/api\/favorite-phrases\/audio\?patientId=/.test(modal)
  );
  const widget = codigoDe("components/patient-playlist-widget.tsx");
  checa(
    "o widget da playlist também",
    /\/api\/patients\/\$\{patientId\}\/playlist\/audio\?id=/.test(widget)
  );
  // O tipo da faixa perdeu o campo: nem o widget, nem o Agent, nem ninguém.
  checa(
    "a faixa devolvida pela playlist não tem campo de endereço",
    !/audioUrl/.test(
      codigoDe("lib/playlist.ts").slice(
        codigoDe("lib/playlist.ts").indexOf("export type PatientPlaylistTrack"),
        codigoDe("lib/playlist.ts").indexOf("function readString")
      )
    )
  );
  checa(
    "toPlaylistTrack não devolve endereço",
    (() => {
      const faixa = toPlaylistTrack("t1", {
        title: "T",
        prompt: "P",
        genre: "G",
        storagePath: "patients/7/musics/t1.mp3",
        createdAt: "2026-01-01T10:00:00.000Z",
        dateKey: "2026-01-01",
        period: "manhã",
        audioUrl: "https://firebasestorage.googleapis.com/v0/b/b/o/x?token=t",
      });
      return faixa != null && !("audioUrl" in faixa) && !JSON.stringify(faixa).includes("http");
    })()
  );
}

// ═════════════════════════════════════════════════════════════════════════
secao("10. o legado continua tocando pela porta certa");
{
  checa(
    "uma faixa antiga resolve pelo storagePath global",
    caminhoDaFaixa(7, { storagePath: "musics/1700000000000-rock.mp3" }) ===
      "musics/1700000000000-rock.mp3"
  );
  checa(
    "uma faixa ainda mais antiga resolve pelo caminho dentro da URL",
    caminhoDaFaixa(7, {
      audioUrl:
        "https://firebasestorage.googleapis.com/v0/b/helo.appspot.com/o/musics%2F123.mp3?alt=media&token=abc",
    }) === "musics/123.mp3"
  );
  checa(
    "uma URL apontando para fora do namespace de música é recusada",
    caminhoDaFaixa(7, {
      audioUrl:
        "https://firebasestorage.googleapis.com/v0/b/helo.appspot.com/o/patients%2F8%2Fphrase-audio%2Ff%2Fa.mp3?alt=media&token=abc",
    }) === null
  );
  checa("uma URL de outro domínio é recusada", caminhoNaUrlLegada("https://exemplo.com/x.mp3") === null);
  checa("texto que não é URL é recusado", caminhoNaUrlLegada("nada disso") === null);
}

// ═════════════════════════════════════════════════════════════════════════
secao("11. R-07: nem o pedido do cuidador, nem o corpo do provedor");
{
  // O VALOR do prompt não pode entrar em log nenhum. `prompt.length` pode: é
  // uma medida, e uma medida não conta o que foi pedido. A distinção é o
  // ponto — a correção do R-07a não é "tirar a palavra prompt do arquivo", é
  // parar de registrar o conteúdo.
  const chamadasDeLog = chamadasDeConsole(FUNCAO);
  //
  // As duas únicas formas permitidas são nomeadas aqui: `prompt.length` (um
  // número) e `Boolean(genre)` (houve gênero, sim ou não). Qualquer outra
  // menção ao pedido do cuidador dentro de um log é vazamento.
  const MEDIDAS_PERMITIDAS = [/prompt\.length/g, /Boolean\(genre\)/g, /genre\.length/g];
  const vazam = chamadasDeLog.filter((chamada) => {
    let sobra = chamada;
    for (const medida of MEDIDAS_PERMITIDAS) sobra = sobra.replace(medida, "");
    return /\b(prompt|compositionPrompt|genre|requestedText|text)\b/.test(sobra);
  });
  checa(
    "nenhum log carrega o valor do que o cuidador pediu",
    vazam.length === 0,
    `— ${vazam.length} chamada(s): ${vazam.map((c) => c.slice(0, 70)).join(" | ")}`
  );
  checa(
    "o que sobra no log é medida, não conteúdo",
    /caracteresNoPrompt: prompt\.length/.test(FUNCAO) && /generoInformado: Boolean\(genre\)/.test(FUNCAO)
  );
  checa(
    "o corpo da recusa do provedor não é sequer lido",
    !/elevenLabsResponse\.text\(\)/.test(FUNCAO)
  );
  checa(
    "a recusa vira provedor + operação + status + código",
    /provider: "elevenlabs"[\s\S]{0,200}?errorCode: "MUSIC_PROVIDER_REJECTED"/.test(FUNCAO)
  );
  checa(
    "o erro inesperado não despeja o objeto de erro",
    !/console\.error\("\[HELO MUSIC\] falha inesperada na geração", error\)/.test(FUNCAO)
  );
  checa(
    "a síntese de frase também não despeja o erro",
    !/console\.error\("\[HELO PHRASES\] Falha na síntese", error\)/.test(FUNCAO)
  );
}

// ═════════════════════════════════════════════════════════════════════════
secao("12. R-14: o Agent recebe resultado, não acesso");
{
  const provider = codigoDe("components/helo-agent-provider.tsx");
  const geraMusica = provider.slice(
    provider.indexOf("const generateMusicClientTool"),
    provider.indexOf("const playExistingMusicClientTool")
  );
  checa("a função inteira não menciona audioUrl", !/audioUrl/.test(geraMusica));
  checa("nem storagePath", !/storagePath/.test(geraMusica));
  // O retorno de SUCESSO é o objeto que vai à ElevenLabs. Nem o id da faixa
  // entra nele: o Agent não tem o que fazer com um identificador de arquivo, e
  // o que não é enviado não precisa ser protegido do outro lado.
  const retornoDeSucesso = geraMusica.slice(
    geraMusica.lastIndexOf("return {", geraMusica.indexOf("} catch (caught)")),
    geraMusica.indexOf("} catch (caught)")
  );
  checa("o retorno de sucesso existe e é o que vai ao provedor", /outcome,/.test(retornoDeSucesso));
  checa(
    "…e ele não carrega trackId, caminho nem endereço",
    !/trackId|storagePath|audioUrl|http/.test(retornoDeSucesso),
    `— ${retornoDeSucesso.slice(0, 120)}`
  );
  checa(
    "o player recebe id + paciente e monta o endereço interno",
    /\/api\/patients\/\$\{track\.patientId\}\/playlist\/audio\?id=/.test(provider)
  );
  checa(
    "o log de reprodução não imprime endereço",
    /console\.log\("\[HELO MUSIC\] playback started", \{ source: track\.source \}\)/.test(provider)
  );
  checa(
    "a mensagem de falha narrada ao Agent é escrita pela Helo",
    /heloMusic: true/.test(provider)
  );
}

// ═════════════════════════════════════════════════════════════════════════
secao("13. as regras do Storage existem e estão ligadas");
{
  const regras = readFileSync(resolve(RAIZ, "storage.rules"), "utf8");
  checa("o bucket nega tudo por padrão", /match \/\{allPaths=\*\*\} \{[\s\S]{0,80}?allow read, write: if false;/.test(regras));
  checa("o áudio da frase é nomeado explicitamente", /phrase-audio/.test(regras));
  checa("o caminho legado também", /phrases_audio/.test(regras));
  checa("as músicas também", /musics/.test(regras));
  const firebaseJson = readFileSync(resolve(RAIZ, "firebase.json"), "utf8");
  const testJson = readFileSync(resolve(RAIZ, "firebase.test.json"), "utf8");
  checa('firebase.json aponta para storage.rules', /"storage":\s*\{\s*"rules":\s*"storage\.rules"/.test(firebaseJson));
  checa("firebase.test.json também", /"storage":\s*\{\s*"rules":\s*"storage\.rules"/.test(testJson));
  checa("e o emulador de Storage tem porta declarada", /"storage":\s*\{\s*"port":\s*9199/.test(testJson));
}

// ═════════════════════════════════════════════════════════════════════════
secao("14. o que a 5.4B não podia tocar");
{
  const tts = codigoDe("app/api/tts/route.ts");
  checa("o SpeechGrant continua obrigatório para a voz do paciente", /verifySpeechGrant\(body\.grant/.test(tts));
  checa("…e a prévia continua passando pelo mesmo portão", /const isPatientVoice =/.test(tts));
  const modal = codigoDe("components/phrases-to-listen-modal.tsx");
  checa(
    "a frase sem áudio pronto continua pedindo grant antes de sintetizar",
    modal.indexOf("/api/voice/grant") < modal.indexOf("/api/tts")
  );
  checa(
    "o ditado continua desligado por omissão",
    /HELO_VOICE_DICTATION_ENABLED === "true"/.test(codigoDe("lib/voice/dictation-server.ts"))
  );
  checa(
    "nenhum limitador de taxa foi introduzido (é da 5.4C)",
    !FONTES.some((f) => /\b(rateLimit|rateLimiter|throttle|limitaTaxa)\b/i.test(codigoDe(f)))
  );
}

console.log(`\n${mau === 0 ? "✓" : "✗"} ${ok} passaram, ${mau} falharam`);
process.exit(mau === 0 ? 0 : 1);
