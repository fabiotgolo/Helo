const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const cors = require("cors");
const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");

const app = express();

// Permite requisições do ElevenAgents e do Frontend
app.use(cors({ origin: true }));
app.use(express.json());

// Endpoint chamado pelo ElevenAgents
app.post("/generate_music", async (req, res) => {
  try {
    const { prompt, duration_ms = 30000 } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "O parâmetro 'prompt' é obrigatório." });
    }

    // Inicializa o cliente com a chave injetada pelo Secret Manager em tempo de execução
    const elevenlabs = new ElevenLabsClient({
      apiKey: process.env.ELEVENLABS_API_KEY,
    });

    // Chama a API de composição musical da ElevenLabs
    const audioStream = await elevenlabs.music.compose({
      prompt: prompt,
      musicLengthMs: duration_ms,
      modelId: "music_v2",
    });

    // TODO: Salvar o stream no Firebase Storage para obter a URL pública do MP3
    const audioUrl = "https://heloapp.web.app/audios/exemplo.mp3";

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

// Exporta a função declarando a permissão ao secret
exports.api = onRequest({ secrets: ["ELEVENLABS_API_KEY"] }, app);
