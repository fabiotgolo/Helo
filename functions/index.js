const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { getDownloadURL } = require("firebase-admin/storage");
const { getFirestore } = require("firebase-admin/firestore");

if (!admin.apps.length) {
  admin.initializeApp();
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
    const storagePath = `patients/${patientId}/phrases_audio/${phraseId}.mp3`;
    const file = admin.storage().bucket().file(storagePath);
    await file.save(buffer, { resumable: false, metadata: { contentType: "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" } });
    const audioUrl = await getDownloadURL(file);
    await phraseRef.set({ audioUrl, storagePath, usesClonedVoice: Boolean(clonedVoiceId), synthesizedAt: new Date().toISOString() }, { merge: true });
    return res.status(200).json({ audioUrl });
  } catch (error) {
    console.error("[HELO PHRASES] Falha na síntese", error);
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

    console.log("Received music payload:", { prompt: req.body?.prompt, genre: req.body?.genre, durationSeconds });

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
      const responseText = await elevenLabsResponse.text();
      console.error("[HELO MUSIC] ElevenLabs recusou a composição.", {
        status: elevenLabsResponse.status,
        response: responseText.slice(0, 500),
      });
      return res.status(502).json({ error: "A ElevenLabs não conseguiu gerar a música." });
    }

    const audioBuffer = Buffer.from(await elevenLabsResponse.arrayBuffer());
    if (!audioBuffer.length) {
      console.error("[HELO MUSIC] A ElevenLabs retornou um arquivo de áudio vazio.");
      return res.status(502).json({ error: "A música gerada não contém áudio." });
    }

    const bucket = admin.storage().bucket();
    const safeGenre = genre
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32);
    const fileName = `musics/${Date.now()}${safeGenre ? `-${safeGenre}` : ""}.mp3`;
    const file = bucket.file(fileName);

    await file.save(audioBuffer, {
      resumable: false,
      metadata: {
        contentType: "audio/mpeg",
        cacheControl: "public, max-age=31536000, immutable",
        metadata: {
          generatedBy: "helo",
          genre: genre || "unspecified",
        },
      },
    });

    const audioUrl = await getDownloadURL(file);
    const createdAt = new Date();
    const { dateKey, period } = playlistTime(createdAt);
    const title = musicTitle(prompt, genre) || "Música especial da Helo";
    try {
      await getFirestore(admin.app(), FIRESTORE_DATABASE_ID)
        .collection("patients")
        .doc(String(patientId))
        .collection("playlist")
        .add({
          title,
          prompt,
          genre,
          audioUrl,
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
    return res.status(200).json({
      audioUrl,
      title,
      createdAt: createdAt.toISOString(),
      period,
    });
  } catch (error) {
    console.error("[HELO MUSIC] Falha inesperada na geração da música.", error);
    return res.status(500).json({ error: "Falha interna ao gerar a música." });
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
