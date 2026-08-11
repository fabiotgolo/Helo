const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { randomBytes } = require("node:crypto");

if (!admin.apps.length) {
  admin.initializeApp();
}

// ——— Mídia privada (Fase 5.4B) ———
//
// `getDownloadURL` SAIU deste arquivo, e essa é a mudança central da fase.
// Ele produzia um Firebase download URL — um endereço com token embutido que
// funciona sem sessão, sem vínculo com o paciente e sem prazo, porque o token
// existe justamente para passar por cima das Storage Rules. Para a voz clonada
// de um paciente isso era o R-04: o áudio ficava público por posse do link,
// contornando inteiro o portão de SpeechGrant erguido na 5.1A.
//
// Agora a Function grava o objeto e guarda só o CAMINHO. Quem entrega os bytes
// é uma rota autenticada do app Next, que confere sessão e vínculo antes de
// ler. Um caminho, sozinho, não abre nada.
//
// Os construtores abaixo repetem o que vive em `lib/midia-privada.ts`. É a
// mesma razão pela qual `patientAccess` é reimplementado aqui: as Functions não
// compartilham código com o app Next. Os dois lados precisam concordar, e o
// teste `test:midia:privada` confere que concordam.

/** Identificador opaco de objeto — não deriva de texto, nome nem relógio. */
function novoIdDeMidia() {
  return randomBytes(12).toString("hex");
}

/**
 * O bucket, nomeado — e nomeado do MESMO jeito que `lib/midia-privada.ts`.
 *
 * Antes desta fase o lado da Function usava `admin.storage().bucket()` (o
 * padrão do ambiente) e o lado do app Next usava um nome explícito, porque o
 * App Hosting nem sempre configura um padrão. Enquanto ninguém LIA o objeto
 * pelo servidor, a divergência não aparecia: a Function escrevia e o navegador
 * buscava pela URL pública.
 *
 * Agora quem lê é o Next. Se os dois lados resolverem buckets diferentes, a
 * Function grava num lugar e a rota procura noutro — e o sintoma seria um 404
 * em áudio que "acabou de ser gerado". Um nome só, dos dois lados.
 */
function baldeDaHelo() {
  return admin
    .storage()
    .bucket(process.env.FIREBASE_STORAGE_BUCKET || "helo-app-7fbf8.firebasestorage.app");
}

function prefixoDeAudioDaFrase(patientId, phraseId) {
  return `patients/${patientId}/phrase-audio/${phraseId}/`;
}

function caminhoDeAudioDaFrase(patientId, phraseId, audioId) {
  return `${prefixoDeAudioDaFrase(patientId, phraseId)}${audioId}.mp3`;
}

function caminhoDeMusica(patientId, musicId) {
  return `patients/${patientId}/musics/${musicId}.mp3`;
}

/**
 * Remove as gerações anteriores de uma frase, preservando a atual.
 *
 * BEST-EFFORT, e a palavra tem peso: uma falha aqui não pode derrubar a
 * síntese que acabou de dar certo. O resíduo não precisa de fila nem de job —
 * o caminho de cada frase é um prefixo, e toda síntese varre o prefixo dela.
 * O que escapou hoje sai na próxima. A limpeza se conserta sozinha.
 */
async function varrePrefixoDaFrase(patientId, phraseId, preservar) {
  try {
    const [arquivos] = await baldeDaHelo().getFiles({
      prefix: prefixoDeAudioDaFrase(patientId, phraseId),
    });
    await Promise.all(
      arquivos
        .filter((a) => a.name !== preservar)
        .map((a) => a.delete({ ignoreNotFound: true }).catch(() => {}))
    );
  } catch {
    // Sem consequência para o recurso novo, que já está válido e referenciado.
  }
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "16kb" }));

const MAX_PROMPT_LENGTH = 4100;
const MAX_GENRE_LENGTH = 100;
const FIRESTORE_DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || "helo-db";
const MAX_PHRASE_LENGTH = 500;
const MIN_MUSIC_DURATION_SECONDS = 10;
const MAX_MUSIC_DURATION_SECONDS = 300;
// Prazo da síntese de frase (R-10). A Function não repassa o áudio em fluxo —
// ela o carrega inteiro para salvar no Storage —, então o prazo cobre a
// chamada toda. Sem ele, uma ElevenLabs lenta prendia a Function até o limite
// da plataforma.
//
// A composição de MÚSICA não recebe prazo nesta fase, de propósito: ela
// demora minutos por natureza (até 300 segundos de áudio), e um prazo mal
// calibrado abortaria uma geração legítima. Fica registrado como pendência em
// docs/robustez-da-voz.md.
const PHRASE_TTS_TIMEOUT_MS = 20_000;

function sessionToken(req) {
  const cookie = String(req.headers.cookie || "");
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("__session="));
  return match ? decodeURIComponent(match.slice("__session=".length)) : "";
}

/**
 * Vínculo ativo com ESTE paciente, com a permissão pedida. Mesma checagem que
 * requirePatientAccess faz no app Next; repetida aqui porque as Functions não
 * compartilham código com ele.
 *
 * Devolve o motivo além do veredito: uma requisição sem sessão é 401 (falta
 * autenticar) e uma com sessão sem acesso é 403 (autenticou, não pode) — a
 * distinção importa para o cliente saber se refazer login resolve.
 */
async function patientAccess(req, patientId, permission) {
  const token = sessionToken(req);
  if (!/^[a-f0-9]{64}$/.test(token)) return { ok: false, status: 401, error: "autenticação obrigatória" };
  const db = getFirestore(admin.app(), FIRESTORE_DATABASE_ID);
  const session = await db.collection("authSessions").doc(token).get();
  if (!session.exists || String(session.data().expiresAt) < new Date().toISOString()) {
    return { ok: false, status: 401, error: "sessão expirada" };
  }
  const userId = String(session.data().userId || "");
  const user = await db.collection("users").doc(userId).get();
  if (!user.exists || user.data().status !== "active") {
    return { ok: false, status: 401, error: "usuário inativo" };
  }
  if (user.data().role === "admin") return { ok: true, userId };
  // O patientId do corpo NÃO é confiado: é exatamente o que esta busca
  // desmente. Sem vínculo ativo com ele, não há acesso — nem para gastar
  // crédito, nem para escrever na playlist dele.
  const link = await db.collection("userPatientAccess").doc(`${userId}_${patientId}`).get();
  const permitido =
    link.exists &&
    link.data().status === "active" &&
    Array.isArray(link.data().permissions) &&
    link.data().permissions.includes(permission);
  return permitido
    ? { ok: true, userId }
    : { ok: false, status: 403, error: "acesso negado" };
}

async function synthesizePhraseAudioHandler(req, res) {
  if (req.method !== "POST") {
    res.set("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }
  try {
    const patientId = Number(req.body?.patientId);
    const phraseId = textParameter(req.body?.phraseId);
    const requestedText = textParameter(req.body?.text);
    if (!Number.isSafeInteger(patientId) || patientId <= 0 || !phraseId || !requestedText || requestedText.length > MAX_PHRASE_LENGTH) {
      return res.status(400).json({ error: "patientId, phraseId e text válidos são obrigatórios." });
    }
    const acesso = await patientAccess(req, patientId, "createActivities");
    if (!acesso.ok) return res.status(acesso.status).json({ error: acesso.error });
    const db = getFirestore(admin.app(), FIRESTORE_DATABASE_ID);
    const phraseRef = db.collection("patients").doc(String(patientId)).collection("favoritePhrases").doc(phraseId);
    const phrase = await phraseRef.get();
    if (!phrase.exists || String(phrase.data().text || "") !== requestedText) return res.status(404).json({ error: "frase não encontrada" });
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return res.status(503).json({ error: "O serviço de voz não está configurado." });

    const patient = await db.collection("patients").doc(String(patientId)).get();
    if (!patient.exists) return res.status(404).json({ error: "paciente não encontrado" });
    // A fonte oficial do clone é o setting isolado do paciente. O campo no
    // perfil é aceito apenas para compatibilidade com dados já migrados.
    const cloneSetting = await patient.ref.collection("settings").doc("voice_id").get();
    const clonedVoiceId = textParameter(cloneSetting.data()?.value) || textParameter(patient.data().clonedVoiceId) || textParameter(patient.data().voiceId);
    let voiceId = clonedVoiceId;
    if (!voiceId) {
      const voices = await db.collection("platformVoices").get();
      const activeVoices = voices.docs.filter((doc) => doc.data().enabled !== false);
      const defaultVoice = activeVoices.find((doc) => doc.data().isDefault === true) || activeVoices[0];
      voiceId = textParameter(defaultVoice?.data().elevenLabsVoiceId) || process.env.ELEVENLABS_HELO_VOICE_ID || "";
    }
    if (!voiceId) return res.status(503).json({ error: "Nenhuma voz padrão está configurada." });

    let eleven;
    try {
      eleven = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: "POST", headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
        body: JSON.stringify({ text: requestedText, model_id: "eleven_multilingual_v2" }),
        signal: AbortSignal.timeout(PHRASE_TTS_TIMEOUT_MS),
      });
    } catch (caught) {
      // Timeout e falha de rede são estados transitórios: 503 diz ao cliente
      // que tentar de novo faz sentido. Um 502 diria que o pedido é que está
      // errado, e não está.
      const timeout = caught?.name === "TimeoutError" || caught?.name === "AbortError";
      console.error("[HELO PHRASES] síntese não completou", { falha: timeout ? "timeout" : "network" });
      return res.status(503).json({ error: "A ElevenLabs não respondeu a tempo." });
    }
    if (!eleven.ok) {
      // O corpo devolvido pela ElevenLabs NÃO entra no log: ele ecoa o texto
      // enviado, e o texto de uma frase é conteúdo do paciente. Status basta
      // para diagnosticar.
      console.error("[HELO PHRASES] ElevenLabs recusou síntese", { status: eleven.status });
      return res.status(502).json({ error: "A ElevenLabs não conseguiu gerar o áudio." });
    }
    const buffer = Buffer.from(await eleven.arrayBuffer());
    if (!buffer.length) return res.status(502).json({ error: "O áudio gerado está vazio." });

    // ——— A ordem, que é a garantia (R-04b) ———
    //
    // 1. o objeto NOVO nasce sob um id próprio, sem tocar no anterior;
    // 2. só depois o documento passa a apontar para ele;
    // 3. só depois as gerações antigas são varridas.
    //
    // Enquanto o passo 2 não acontece, a mídia anterior continua íntegra e
    // referenciada: uma falha de rede no meio da síntese não deixa o paciente
    // sem áudio. E se o passo 2 falhar, o objeto novo é removido na hora — ele
    // é o único que ninguém mais alcança, e deixá-lo seria criar o órfão que
    // esta fase existe para eliminar.
    const audioId = novoIdDeMidia();
    const storagePath = caminhoDeAudioDaFrase(patientId, phraseId, audioId);
    const file = baldeDaHelo().file(storagePath);
    await file.save(buffer, {
      resumable: false,
      metadata: {
        contentType: "audio/mpeg",
        // `private` e sem prazo longo: este objeto não é servido ao navegador
        // pelo Storage. Quem o entrega é a rota autenticada do Next, e é ela
        // que decide o cabeçalho que o navegador vê. Este aqui só impede que
        // um intermediário guarde a cópia caso o objeto seja lido por outro
        // caminho um dia.
        cacheControl: "private, no-store",
        // Metadata mínima e sem conteúdo: liga o objeto ao dono e diz o que
        // ele é. Nunca o texto da frase, nunca o nome da pessoa, nunca o
        // voiceId do clone.
        metadata: {
          heloResource: "patientPhraseAudio",
          heloPatientId: String(patientId),
          heloPhraseId: phraseId,
        },
      },
    });

    const anterior = phrase.data().audioStoragePath;
    try {
      await phraseRef.set(
        {
          audioStoragePath: storagePath,
          audioId,
          usesClonedVoice: Boolean(clonedVoiceId),
          synthesizedAt: new Date().toISOString(),
          // O schema antigo sai do documento no primeiro toque. Enquanto
          // `audioUrl` existir ali, existe uma URL pública guardada — e o
          // objetivo é que ela deixe de existir, não que seja ignorada.
          audioUrl: FieldValue.delete(),
          storagePath: FieldValue.delete(),
        },
        { merge: true }
      );
    } catch (falhaNoDocumento) {
      await file.delete({ ignoreNotFound: true }).catch(() => {});
      throw falhaNoDocumento;
    }

    await varrePrefixoDaFrase(patientId, phraseId, storagePath);
    if (typeof anterior === "string" && anterior && anterior !== storagePath) {
      // Gerações fora do prefixo atual (o caminho legado
      // `phrases_audio/{phraseId}.mp3`) não são alcançadas pela varredura.
      await baldeDaHelo().file(anterior).delete({ ignoreNotFound: true }).catch(() => {});
    }
    const legado = phrase.data().storagePath;
    if (typeof legado === "string" && legado && legado !== storagePath) {
      await baldeDaHelo().file(legado).delete({ ignoreNotFound: true }).catch(() => {});
    }

    // A resposta NÃO devolve URL nenhuma. O cliente já sabe onde pedir o áudio:
    // pela rota autenticada, com o id da frase. Devolver um endereço aqui seria
    // reabrir, na resposta, o que se acabou de fechar no banco.
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[HELO PHRASES] Falha na síntese", { etapa: "síntese", nome: error?.name });
    return res.status(500).json({ error: "Falha interna ao preparar o áudio." });
  }
}

function textParameter(value) {
  return typeof value === "string" ? value.trim() : "";
}

function musicTitle(prompt, genre) {
  const cleanPrompt = prompt.replace(/\s+/g, " ").trim();
  const shortPrompt = cleanPrompt.length > 64
    ? `${cleanPrompt.slice(0, 61).trimEnd()}...`
    : cleanPrompt;
  return genre ? `${genre}: ${shortPrompt}` : shortPrompt;
}

function playlistTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour);
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    period: hour >= 5 && hour < 12 ? "manhã" : hour >= 12 && hour < 18 ? "tarde" : "noite",
  };
}

async function generateMusicHandler(req, res) {
  if (req.method !== "POST") {
    res.set("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  try {
    const prompt = textParameter(req.body?.prompt);
    const genre = textParameter(req.body?.genre);
    // Duração com teto: sem ele, um único pedido podia encomendar uma hora de
    // composição. O padrão continua 240s; valores fora da faixa são cortados
    // para o limite em vez de recusar o pedido — a diferença é de custo, não
    // de segurança, e recusar aqui só produziria uma falha confusa na conversa.
    const durationSeconds = Math.min(
      MAX_MUSIC_DURATION_SECONDS,
      Math.max(
        MIN_MUSIC_DURATION_SECONDS,
        parseInt(req.body?.duration_seconds, 10) || 240
      )
    );
    const patientId = Number(req.body?.patientId);
    const apiKey = process.env.ELEVENLABS_API_KEY;

    // ——— R-07a ———
    //
    // Aqui havia `console.log("Received music payload:", { prompt, genre, … })`
    // — o pedido do cuidador, inteiro, no Cloud Logging. O prompt é criativo
    // por natureza ("algo calmo para dormir"), mas é ditado em voz alta numa
    // sessão clínica, sobre uma pessoa, e nada impede que saia como "uma
    // música para a Maria, que está agitada desde a internação".
    //
    // O que sobra é o que diagnostica sem contar nada: houve pedido, deste
    // tamanho, com esta duração. Nem o prompt, nem um recorte dele, nem um
    // hash — recorte e hash continuam sendo o conteúdo, só que mais difícil.
    console.log("[HELO MUSIC] pedido recebido", {
      caracteresNoPrompt: prompt.length,
      generoInformado: Boolean(genre),
      durationSeconds,
    });

    if (!prompt) {
      return res.status(400).json({ error: "O parâmetro 'prompt' é obrigatório." });
    }
    if (!Number.isSafeInteger(patientId) || patientId <= 0) {
      return res.status(400).json({ error: "O parâmetro 'patientId' é obrigatório." });
    }

    // ——— Autenticação e autorização (Fase 5.1A / R-03) ———
    //
    // Esta rota gasta crédito pago da ElevenLabs, grava um MP3 no Storage e
    // escreve na playlist de um paciente. Até aqui não pedia nada: bastava
    // conhecer a URL para compor música na conta da Helo e inserir faixas no
    // histórico de qualquer paciente, pelo id.
    //
    // A verificação vem ANTES de qualquer chamada externa — recusar é de
    // graça, e um pedido não autorizado não deve nem tocar no provedor.
    const acesso = await patientAccess(req, patientId, "createSession");
    if (!acesso.ok) {
      console.warn("[HELO MUSIC] pedido sem acesso ao paciente", { patientId, status: acesso.status });
      return res.status(acesso.status).json({ error: acesso.error });
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({ error: `O prompt deve ter no máximo ${MAX_PROMPT_LENGTH} caracteres.` });
    }
    if (genre.length > MAX_GENRE_LENGTH) {
      return res.status(400).json({ error: `O gênero deve ter no máximo ${MAX_GENRE_LENGTH} caracteres.` });
    }
    if (!apiKey) {
      console.error("[HELO MUSIC] ELEVENLABS_API_KEY não está disponível.");
      return res.status(503).json({ error: "O serviço de música não está configurado." });
    }

    // A Music API não possui um campo separado para gênero; ele é incorporado
    // ao prompt para orientar a composição sem enviar parâmetros desconhecidos.
    const compositionPrompt = genre
      ? `${prompt}\nGênero musical solicitado: ${genre}.`
      : prompt;
    if (compositionPrompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({
        error: "A combinação de prompt e gênero excede o limite permitido.",
      });
    }
    const elevenLabsResponse = await fetch(
      "https://api.elevenlabs.io/v1/music?output_format=mp3_48000_192",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          prompt: compositionPrompt,
          genre,
          duration_seconds: durationSeconds,
          model_id: "music_v2",
        }),
      }
    );

    if (!elevenLabsResponse.ok) {
      // ——— R-07b ———
      //
      // Aqui havia `await elevenLabsResponse.text()` e os primeiros 500
      // caracteres do corpo no log. Era a única ocorrência de corpo bruto do
      // provedor em todo o produto — e o corpo de uma recusa da ElevenLabs ecoa
      // o que foi enviado, ou seja, o prompt do cuidador de volta.
      //
      // Provedor, operação, status e um código nosso bastam para diagnosticar.
      // O corpo não é lido: não adianta ler e não registrar, porque a próxima
      // pessoa que passar por aqui vai registrar "só desta vez".
      console.error("[HELO MUSIC] provedor recusou a composição", {
        provider: "elevenlabs",
        operation: "generateMusic",
        httpStatus: elevenLabsResponse.status,
        errorCode: "MUSIC_PROVIDER_REJECTED",
      });
      return res.status(502).json({ error: "A ElevenLabs não conseguiu gerar a música.", code: "MUSIC_GENERATION_FAILED" });
    }

    const audioBuffer = Buffer.from(await elevenLabsResponse.arrayBuffer());
    if (!audioBuffer.length) {
      console.error("[HELO MUSIC] A ElevenLabs retornou um arquivo de áudio vazio.");
      return res.status(502).json({ error: "A música gerada não contém áudio." });
    }

    // ——— A-12: a música passa a viver sob o paciente ———
    //
    // Era `musics/{Date.now()}-{genero}.mp3`: namespace global, sem vínculo
    // nenhum com o paciente no caminho, nome derivado do relógio e do gênero
    // pedido. O documento ficava sob o paciente e o arquivo, fora dele — duas
    // verdades diferentes sobre a mesma faixa.
    //
    // Agora o id do documento nasce ANTES do arquivo e é o mesmo dos dois
    // lados. O caminho carrega o vínculo, e o nome não conta nada: nem gênero,
    // nem horário, nem uma letra do que foi pedido.
    const bucket = baldeDaHelo();
    const trackRef = getFirestore(admin.app(), FIRESTORE_DATABASE_ID)
      .collection("patients")
      .doc(String(patientId))
      .collection("playlist")
      .doc();
    const fileName = caminhoDeMusica(patientId, trackRef.id);
    const file = bucket.file(fileName);

    await file.save(audioBuffer, {
      resumable: false,
      metadata: {
        contentType: "audio/mpeg",
        // Sem URL pública, sem cache longo: quem entrega os bytes é a rota
        // autenticada do Next, e é ela que decide o que o navegador guarda.
        cacheControl: "private, max-age=0, must-revalidate",
        metadata: {
          heloResource: "patientMusic",
          heloPatientId: String(patientId),
          generatedBy: "helo",
        },
      },
    });

    const createdAt = new Date();
    const { dateKey, period } = playlistTime(createdAt);
    const title = musicTitle(prompt, genre) || "Música especial da Helo";
    try {
      await trackRef.set({
        title,
        prompt,
        genre,
        // `audioUrl` não existe mais no schema novo. O documento guarda o
        // CAMINHO — e um caminho, sozinho, não abre nada.
        storagePath: fileName,
        createdAt: createdAt.toISOString(),
        dateKey,
        period,
      });
    } catch (firestoreError) {
      // Evita manter um MP3 órfão quando seu histórico não pôde ser salvo.
      await file.delete({ ignoreNotFound: true }).catch(() => {});
      throw firestoreError;
    }
    // ——— R-14, na origem ———
    //
    // A resposta não devolve URL nenhuma. O navegador recebe o id da faixa e
    // pede o áudio à rota autenticada. E como o resultado da tool é montado a
    // partir DESTA resposta, não existe URL para vazar de volta à ElevenLabs.
    return res.status(200).json({
      trackId: trackRef.id,
      title,
      createdAt: createdAt.toISOString(),
      period,
    });
  } catch (error) {
    console.error("[HELO MUSIC] falha inesperada na geração", {
      operation: "generateMusic",
      errorCode: "MUSIC_GENERATION_FAILED",
      nome: error?.name,
    });
    return res.status(500).json({
      error: "Falha interna ao gerar a música.",
      code: "MUSIC_GENERATION_FAILED",
    });
  }
}

// Endpoint principal, acessível em /generateMusic pelo rewrite do Hosting.
exports.generateMusic = onRequest(
  {
    secrets: ["ELEVENLABS_API_KEY"],
    timeoutSeconds: 300,
    memory: "1GiB",
    cors: true,
  },
  generateMusicHandler
);

exports.synthesizePhraseAudio = onRequest(
  { secrets: ["ELEVENLABS_API_KEY"], timeoutSeconds: 120, memory: "1GiB", cors: true },
  synthesizePhraseAudioHandler
);

// ——— Endpoint legado (DEPRECIADO) ———
//
// Veio da primeira integração de música, quando a ElevenLabs chamava o webhook
// direto como server tool (commit e607109). Hoje quem chama é o cliente, em
// /generateMusic, com o cookie de sessão do cuidador — nenhum código do
// aplicativo aponta para cá.
//
// Ele NÃO é removido nesta fase: uma configuração no painel da ElevenLabs pode
// ainda apontar para cá, e apagar a rota trocaria uma falha silenciosa por
// outra. Mas ele deixou de ser um bypass — passa pelo MESMO handler, com a
// mesma autenticação. Uma server tool que chame daqui sem cookie de sessão
// agora recebe 401, e é isso que se quer: era exatamente o caminho anônimo
// para gastar crédito e escrever na playlist de qualquer paciente.
//
// Próximo passo (fora da 5.1A): confirmar no painel que nenhuma server tool
// aponta para /webhook/** e então remover a rota.
app.post(
  ["/generate_music", "/generateMusic", "/webhook/generate_music"],
  (req, res) => {
    console.warn("[HELO MUSIC] rota legada /webhook usada — depreciada, ver functions/index.js");
    return generateMusicHandler(req, res);
  }
);
exports.api = onRequest(
  {
    secrets: ["ELEVENLABS_API_KEY"],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  app
);
