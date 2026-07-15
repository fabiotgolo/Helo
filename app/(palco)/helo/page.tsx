"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { OverlayPanel, OverlayVeil } from "@/components/overlay-panel";
import { useHelo } from "@/lib/helo-state";

type SessionError = string | null;

function HeloSession({ onError }: { onError: (message: string) => void }) {
  const { stop, setAgentAmplitude } = useHelo();
  const {
    startSession,
    endSession,
    status,
    isSpeaking,
    isListening,
    getOutputByteFrequencyData,
  } = useConversation();
  const [starting, setStarting] = useState(false);
  const startedRef = useRef(false);
  const startingRef = useRef(false);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      const bytes = getOutputByteFrequencyData();
      let total = 0;
      for (const value of bytes) total += value * value;
      // RMS normalizado, suavizado pelo próprio loop do OrbStage.
      setAgentAmplitude(bytes.length ? Math.min(1, Math.sqrt(total / bytes.length) / 128) : 0);
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [getOutputByteFrequencyData, setAgentAmplitude]);

  useEffect(() => {
    return () => {
      setAgentAmplitude(null);
      if (startedRef.current) endSession();
    };
  }, [endSession, setAgentAmplitude]);

  const connect = useCallback(async () => {
    if (startingRef.current || status !== "disconnected") return;
    startingRef.current = true;
    setStarting(true);
    stop(); // evita sobreposição com a camada TTS existente da plataforma
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Seu navegador não oferece acesso ao microfone.");
      }
      // Explica e pede consentimento antes de a SDK iniciar sua própria captura.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());

      const response = await fetch("/api/helo/conversation-token", { method: "POST" });
      const data = (await response.json().catch(() => null)) as { conversationToken?: string; error?: string } | null;
      if (!response.ok || !data?.conversationToken) {
        throw new Error(data?.error ?? "Não foi possível preparar a conversa.");
      }
      startedRef.current = true;
      startSession({ conversationToken: data.conversationToken, connectionType: "webrtc" });
    } catch (error) {
      startedRef.current = false;
      const name = error instanceof DOMException ? error.name : "";
      onError(
        name === "NotAllowedError"
          ? "Permissão do microfone negada. Autorize o microfone e tente novamente."
          : name === "NotFoundError"
            ? "Nenhum microfone foi encontrado."
            : name === "NotReadableError"
              ? "O microfone está em uso por outro aplicativo."
              : error instanceof Error
                ? error.message
                : "Não foi possível iniciar a conversa."
      );
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [onError, startSession, status, stop]);

  const end = useCallback(() => {
    if (status !== "disconnected" || startedRef.current) endSession();
    startedRef.current = false;
    setAgentAmplitude(null);
  }, [endSession, setAgentAmplitude, status]);

  const label =
    starting || status === "connecting"
      ? "Conectando..."
      : status === "connected" && isSpeaking
        ? "Helo está falando..."
        : status === "connected" && isListening
          ? "Ouvindo..."
          : status === "connected"
            ? "Conectada"
            : "Desconectada";

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div aria-live="polite" className="text-lg font-medium text-ink">{label}</div>
      <p className="max-w-md text-sm text-ink-soft">
        A conversa usa a voz oficial da Helo. O microfone só será solicitado ao conectar.
      </p>
      {status === "disconnected" ? (
        <button type="button" onClick={() => void connect()} disabled={starting} className="rounded-full bg-accent px-7 py-3 font-medium text-on-accent disabled:cursor-wait disabled:opacity-60">
          {starting ? "Conectando..." : "Conectar com Helo"}
        </button>
      ) : (
        <button type="button" onClick={end} className="rounded-full border border-line bg-card px-7 py-3 font-medium text-ink hover:border-ink-mute">
          Encerrar conversa
        </button>
      )}
    </div>
  );
}

export default function HeloPage() {
  const [error, setError] = useState<SessionError>(null);
  return (
    <main className="relative flex flex-1 items-center px-4 pb-8 sm:px-6">
      <OverlayVeil />
      <OverlayPanel label="Conversa com a Helo" variant="imersivo" className="relative z-10 max-w-xl">
        <ConversationProvider onError={() => setError("A conversa foi interrompida. Verifique sua conexão e tente novamente.") }>
          <HeloSession onError={setError} />
        </ConversationProvider>
        {error && <p role="alert" className="mt-5 text-center text-sm text-danger">{error}</p>}
      </OverlayPanel>
    </main>
  );
}
