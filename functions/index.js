const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const cors = require("cors");
const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.post(["/generate_music", "/webhook/generate_music"], async (req, res) => {
  try {
    const { prompt, duration_ms = 30000 } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "O parâmetro 'prompt' é obrigatório." });
    }

    const elevenlabs = new ElevenLabsClient({
      apiKey: process.env.ELEVENLABS_API_KEY,
    });

    // 1. Gera o stream da música
    const audioStream = await elevenlabs.music.compose({
      prompt: prompt,
      musicLengthMs: duration_ms,
      modelId: "music_v2",
    });

    // 2. Converte Stream para Buffer
    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);

    // 3. Salva no Firebase Storage como arquivo público
    const bucket = admin.storage().bucket();
    const fileName = `musicas/${Date.now()}_musica.mp3`;
    const file = bucket.file(fileName);

    await file.save(audioBuffer, {
      metadata: { contentType: "audio/mpeg" },
      public: true,
    });

    const audioUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

    // Retorna a URL limpa no JSON
    return res.status(200).json({
      status: "success",
      message: "Música gerada com sucesso!",
      audio_url: audioUrl,
    });
  } catch (error) {
    console.error("Erro na geração da música:", error);
    return res.status(500).json({ error: "Falha interna ao gerar música." });
  }
});

exports.api = onRequest({ secrets: ["ELEVENLABS_API_KEY"] }, app);
