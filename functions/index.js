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

const MUSIC_LENGTH_MS = 30000;
const MAX_PROMPT_LENGTH = 4100;
const MAX_GENRE_LENGTH = 100;
const FIRESTORE_DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || "helo-db";
const MAX_PHRASE_LENGTH = 500;

function sessionToken(req) {
  const cookie = String(req.headers.cookie || "");
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("__session="));
  return match ? decodeURIComponent(match.slice("__session=".length)) : "";
}

async function canSynthesizePhrase(req, patientId) {
  const token = sessionToken(req);
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const db = getFirestore(admin.app(), FIRESTORE_DATABASE_ID);
  const session = await db.collection("authSessions").doc(token).get();
  if (!session.exists || String(session.data().expiresAt) < new Date().toISOString()) return false;
  const userId = String(session.data().userId || "");
  const user = await db.collection("users").doc(userId).get();
  if (!user.exists || user.data().status !== "active") return false;
  if (user.data().role === "admin") return true;
  const link = await db.collection("userPatientAccess").doc(`${userId}_${patientId}`).get();
  return Boolean(link.exists && link.data().status === "active" && Array.isArray(link.data().permissions) && link.data().permissions.includes("createActivities"));
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
    if (!await canSynthesizePhrase(req, patientId)) return res.status(403).json({ error: "acesso negado" });
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

    const eleven = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: "POST", headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
      body: JSON.stringify({ text: requestedText, model_id: "eleven_multilingual_v2" }),
    });
    if (!eleven.ok) {
      console.error("[HELO PHRASES] ElevenLabs recusou síntese", eleven.status, (await eleven.text()).slice(0, 500));
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
    const patientId = Number(req.body?.patientId);
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!prompt) {
      return res.status(400).json({ error: "O parâmetro 'prompt' é obrigatório." });
    }
    if (!Number.isSafeInteger(patientId) || patientId <= 0) {
      return res.status(400).json({ error: "O parâmetro 'patientId' é obrigatório." });
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
          music_length_ms: MUSIC_LENGTH_MS,
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
    timeoutSeconds: 540,
    memory: "1GiB",
    cors: true,
  },
  generateMusicHandler
);

exports.synthesizePhraseAudio = onRequest(
  { secrets: ["ELEVENLABS_API_KEY"], timeoutSeconds: 120, memory: "1GiB", cors: true },
  synthesizePhraseAudioHandler
);

// Compatibilidade com a integração anterior em /webhook/generate_music.
app.post(
  ["/generate_music", "/generateMusic", "/webhook/generate_music"],
  generateMusicHandler
);
exports.api = onRequest(
  {
    secrets: ["ELEVENLABS_API_KEY"],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  app
);
