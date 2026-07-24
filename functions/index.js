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
