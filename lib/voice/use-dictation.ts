"use client";

// ——— A captura: microfone aberto pelo menor tempo possível ———
//
// Um hook por campo. Cada instância é dona do seu `MediaStream`, do seu
// `MediaRecorder` e do seu cronômetro, e libera os três em toda saída — parar,
// cancelar, errar, desmontar, trocar de paciente, sair da conta.
//
// O áudio existe em memória e em mais lugar nenhum. Não vira ObjectURL (não há
// o que reproduzir: o cuidador acabou de falar, ele sabe o que disse), não é
// gravado, não entra em fila, não é guardado para reenviar. Quando a resposta
// chega, os pedaços são soltos; quando a chamada falha, também.
//
// O que ele devolve é uma string que a tela põe num campo. Nada mais acontece
// sozinho: apresentar, salvar e confirmar continuam sendo do botão que o
// cuidador já apertava antes desta fase existir.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isAgentConversationActive,
  registerDictationStop,
  setDictationActive,
} from "@/lib/audio-coordinator";
import {
  AVISO_LIMITE_DE_TEMPO,
  BITRATE_ALVO,
  DURACAO_MAXIMA_MS,
  TIPOS_DE_AUDIO_ACEITOS,
  aplicaTranscricao,
  classificaErroDeCaptura,
  classificaRespostaDoDitado,
  mensagemDoDitado,
  type EstadoDoDitado,
  type FalhaDoDitado,
} from "@/lib/voice/dictation";

/**
 * A disponibilidade é do SERVIDOR e é a mesma para a tela inteira. Perguntar
 * uma vez por campo daria quatro requisições idênticas por montagem, e o
 * quarto campo mostraria o botão alguns milissegundos depois do primeiro.
 * A promessa fica no módulo; quem chegar depois espera a mesma.
 */
let disponibilidadeNoServidor: Promise<boolean> | null = null;

function consultaDisponibilidade(): Promise<boolean> {
  disponibilidadeNoServidor ??= fetch("/api/voice/dictation", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<{ available?: unknown }>) : null))
    .then((d) => d?.available === true)
    .catch(() => false);
  return disponibilidadeNoServidor;
}

/** Só para os testes: a próxima montagem volta a perguntar. */
export function esqueceDisponibilidadeDoDitado(): void {
  disponibilidadeNoServidor = null;
}

/** O formato que ESTE navegador grava, dentre os que o servidor aceita. */
function formatoSuportado(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidatos = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const tipo of candidatos) {
    if (MediaRecorder.isTypeSupported?.(tipo)) return tipo;
  }
  // Safari antigo não implementa `isTypeSupported` e grava mp4 assim mesmo.
  return TIPOS_DE_AUDIO_ACEITOS.includes("audio/mp4") ? "audio/mp4" : null;
}

export interface Ditado {
  estado: EstadoDoDitado;
  /** O botão deve existir na tela. */
  disponivel: boolean;
  /** Frase para o cuidador — erro, aviso de limite ou nada. */
  aviso: string | null;
  /** Microfone aberto ou transcrição em andamento. */
  ativo: boolean;
  inicia: () => void;
  /** Encerra e transcreve o que foi gravado. */
  para: () => void;
  /** Descarta: nada é enviado, nada entra no campo. */
  cancela: () => void;
}

export interface OpcoesDoDitado {
  patientId: number | null;
  /** Recebe o texto final. Chamado no máximo uma vez por captura. */
  aoTranscrever: (texto: string) => void;
  /**
   * Motivo de produto para o ditado não valer aqui e agora — sem conexão, por
   * exemplo. Diferente de "o servidor desligou o recurso": ambos escondem o
   * botão, mas só um deles é decisão de configuração.
   */
  bloqueado?: boolean;
}

export function useDictation({
  patientId,
  aoTranscrever,
  bloqueado = false,
}: OpcoesDoDitado): Ditado {
  const [estado, setEstado] = useState<EstadoDoDitado>("IDLE");
  const [aviso, setAviso] = useState<string | null>(null);
  const [servidorPermite, setServidorPermite] = useState(false);
  const [online, setOnline] = useState(true);

  const streamRef = useRef<MediaStream | null>(null);
  const gravadorRef = useRef<MediaRecorder | null>(null);
  const pedacosRef = useRef<BlobPart[]>([]);
  const relogioRef = useRef<number | null>(null);
  const canceladoRef = useRef(false);
  const envioRef = useRef<AbortController | null>(null);
  // A callback muda a cada render (é uma closure sobre o texto do campo). O
  // gravador é criado uma vez por captura e viveria com a primeira versão —
  // que escreveria por cima de tudo que o cuidador digitou desde então.
  const aoTranscreverRef = useRef(aoTranscrever);
  useEffect(() => {
    aoTranscreverRef.current = aoTranscrever;
  });

  useEffect(() => {
    let vivo = true;
    consultaDisponibilidade().then((v) => {
      if (vivo) setServidorPermite(v);
    });
    return () => {
      vivo = false;
    };
  }, []);

  // Offline não é erro do ditado: é ausência de rede. O campo continua
  // digitável e o botão some — nada é gravado para enviar depois.
  useEffect(() => {
    const atualiza = () => setOnline(navigator.onLine !== false);
    atualiza();
    window.addEventListener("online", atualiza);
    window.addEventListener("offline", atualiza);
    return () => {
      window.removeEventListener("online", atualiza);
      window.removeEventListener("offline", atualiza);
    };
  }, []);

  /**
   * Solta TUDO. Chamada em toda saída, com ou sem sucesso, e idempotente —
   * `stop()` num gravador já parado lança, e uma trilha parada duas vezes é
   * inofensiva, então a ordem aqui importa mais que a elegância.
   */
  const liberaCaptura = useCallback(() => {
    if (relogioRef.current != null) {
      window.clearTimeout(relogioRef.current);
      relogioRef.current = null;
    }
    const gravador = gravadorRef.current;
    gravadorRef.current = null;
    if (gravador && gravador.state !== "inactive") {
      try {
        gravador.stop();
      } catch {
        // Já estava encerrado. O que importa é o que vem depois.
      }
    }
    const stream = streamRef.current;
    streamRef.current = null;
    // A luz do microfone só apaga quando a ÚLTIMA trilha para. Enquanto uma
    // sobrar, o aparelho continua captando e o cuidador continua vendo o
    // indicador do navegador aceso — que é o pior estado possível: parece que
    // o Helo está gravando escondido.
    for (const trilha of stream?.getTracks() ?? []) trilha.stop();
    pedacosRef.current = [];
    setDictationActive(false);
  }, []);

  const cancela = useCallback(() => {
    canceladoRef.current = true;
    envioRef.current?.abort();
    envioRef.current = null;
    liberaCaptura();
    setEstado("IDLE");
    setAviso(null);
  }, [liberaCaptura]);

  // Logout e troca de paciente encerram a captura de fora para dentro: quem
  // sai da conta não sabe (nem deveria saber) quantos campos com ditado
  // existem montados.
  useEffect(() => registerDictationStop(cancela), [cancela]);

  // Desmontar é uma saída como qualquer outra. Sem isto, fechar a tela com o
  // microfone aberto deixaria o stream vivo até o navegador resolver limpá-lo.
  useEffect(() => () => {
    canceladoRef.current = true;
    envioRef.current?.abort();
    liberaCaptura();
  }, [liberaCaptura]);

  // Trocar de paciente no meio de uma captura descarta a captura: o áudio foi
  // falado sobre outra pessoa. A PRIMEIRA atribuição não é troca — cancelar
  // ali derrubaria uma captura que ninguém pediu para derrubar (foi assim que
  // o purge da 5.1B matou o pré-aquecimento da Emergência).
  const pacienteAnterior = useRef<number | null>(null);
  useEffect(() => {
    const anterior = pacienteAnterior.current;
    pacienteAnterior.current = patientId;
    if (anterior == null || anterior === patientId) return;
    cancela();
  }, [patientId, cancela]);

  const falhou = useCallback(
    (falha: FalhaDoDitado) => {
      liberaCaptura();
      setEstado(falha === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "ERROR");
      setAviso(mensagemDoDitado(falha));
    },
    [liberaCaptura]
  );

  const envia = useCallback(
    async (audio: Blob) => {
      if (canceladoRef.current || patientId == null) return;
      const controle = new AbortController();
      envioRef.current = controle;
      try {
        const corpo = new FormData();
        corpo.append("audio", audio, "ditado");
        const resposta = await fetch("/api/voice/dictation", {
          method: "POST",
          // O paciente vai no cabeçalho: assim o servidor autoriza antes de
          // ler o corpo, e o identificador não entra na URL.
          headers: { "x-helo-patient-id": String(patientId) },
          body: corpo,
          cache: "no-store",
          signal: controle.signal,
        });
        if (canceladoRef.current) return;
        if (!resposta.ok) {
          falhou(classificaRespostaDoDitado(resposta.status));
          return;
        }
        const dados = (await resposta.json().catch(() => null)) as
          | { transcript?: unknown }
          | null;
        if (canceladoRef.current) return;
        const texto = typeof dados?.transcript === "string" ? dados.transcript : "";
        if (!texto) {
          // O provedor ouviu e não havia fala. O campo NÃO é alterado: "não
          // entendi" nunca pode virar "apagou o que você escreveu".
          setEstado("ERROR");
          setAviso(mensagemDoDitado("EMPTY_TRANSCRIPT"));
          return;
        }
        aoTranscreverRef.current(texto);
        setEstado("DRAFT_READY");
        setAviso(null);
      } catch (erro) {
        if (canceladoRef.current || (erro as { name?: string })?.name === "AbortError") return;
        falhou(navigator.onLine === false ? "OFFLINE" : "PROVIDER_UNAVAILABLE");
      } finally {
        envioRef.current = null;
        // O Blob e os pedaços perdem o último dono aqui, com resposta ou sem.
        liberaCaptura();
      }
    },
    [falhou, liberaCaptura, patientId]
  );

  const para = useCallback(() => {
    const gravador = gravadorRef.current;
    if (!gravador || gravador.state === "inactive") return;
    // O `onstop` é quem monta o Blob e chama `envia`. Aqui só pedimos o fim.
    setEstado("PROCESSING");
    try {
      gravador.stop();
    } catch {
      falhou("UNKNOWN");
    }
  }, [falhou]);

  const inicia = useCallback(() => {
    if (patientId == null || !servidorPermite || bloqueado || !online) return;
    if (estado === "LISTENING" || estado === "PROCESSING") return;

    // Um dono de cada vez. O Agente abriu o microfone primeiro e fica com ele.
    if (isAgentConversationActive()) {
      setEstado("ERROR");
      setAviso("A conversa com a Helo está usando o microfone. Encerre a conversa para ditar.");
      return;
    }
    const formato = formatoSuportado();
    if (!navigator.mediaDevices?.getUserMedia || !formato) {
      falhou("UNSUPPORTED");
      return;
    }

    canceladoRef.current = false;
    setAviso(null);
    setEstado("REQUESTING_PERMISSION");

    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      })
      .then((stream) => {
        // Cancelado enquanto o navegador mostrava o diálogo de permissão: a
        // trilha nasce e morre aqui, sem nunca acender o indicador por engano.
        if (canceladoRef.current) {
          for (const trilha of stream.getTracks()) trilha.stop();
          return;
        }
        streamRef.current = stream;
        pedacosRef.current = [];

        const gravador = new MediaRecorder(stream, {
          mimeType: formato,
          audioBitsPerSecond: BITRATE_ALVO,
        });
        gravadorRef.current = gravador;

        gravador.ondataavailable = (evento) => {
          if (evento.data && evento.data.size > 0) pedacosRef.current.push(evento.data);
        };
        gravador.onerror = () => falhou("UNKNOWN");
        gravador.onstop = () => {
          const pedacos = pedacosRef.current;
          pedacosRef.current = [];
          if (canceladoRef.current) return;
          if (pedacos.length === 0) {
            setEstado("ERROR");
            setAviso(mensagemDoDitado("EMPTY_TRANSCRIPT"));
            liberaCaptura();
            return;
          }
          // As trilhas param JÁ — a transcrição pode levar segundos, e o
          // microfone não fica aberto durante ela.
          for (const trilha of streamRef.current?.getTracks() ?? []) trilha.stop();
          streamRef.current = null;
          setDictationActive(false);
          void envia(new Blob(pedacos, { type: formato }));
        };

        // Um dispositivo arrancado da porta no meio da captura não dispara
        // erro no gravador: a trilha simplesmente termina. Sem isto a tela
        // ficaria em "ouvindo" para sempre, gravando silêncio.
        for (const trilha of stream.getTracks()) {
          trilha.onended = () => {
            if (gravadorRef.current?.state === "recording") para();
          };
        }

        gravador.start();
        setDictationActive(true);
        setEstado("LISTENING");

        relogioRef.current = window.setTimeout(() => {
          relogioRef.current = null;
          if (gravadorRef.current?.state !== "recording") return;
          // O teto chegou: encerra e transcreve o que existe. Descartar seria
          // punir quem falou demais perdendo tudo que já foi dito.
          setAviso(AVISO_LIMITE_DE_TEMPO);
          para();
        }, DURACAO_MAXIMA_MS);
      })
      .catch((erro: unknown) => falhou(classificaErroDeCaptura(erro)));
  }, [bloqueado, envia, estado, falhou, liberaCaptura, online, para, patientId, servidorPermite]);

  const disponivel = servidorPermite && !bloqueado && online && patientId != null;

  return {
    estado: disponivel ? estado : "UNAVAILABLE",
    disponivel,
    aviso: disponivel ? aviso : null,
    ativo: estado === "LISTENING" || estado === "PROCESSING",
    inicia,
    para,
    cancela,
  };
}

/**
 * O ditado ligado a UM campo de texto — a forma como as quatro telas o usam.
 *
 * A transcrição entra pelo mesmo `onChange` que o teclado usa. Nenhuma tela
 * ganha um caminho de escrita novo: para o resto do fluxo, um texto ditado e
 * um texto digitado são indistinguíveis, e é isso que garante que o botão de
 * submissão continue sendo o único gatilho funcional.
 */
export function useDictationField({
  patientId,
  valor,
  aoMudar,
  limite,
  bloqueado,
}: {
  patientId: number | null;
  valor: string;
  aoMudar: (texto: string) => void;
  /** `maxLength` do campo. O que passar disso é cortado, e o cuidador é avisado. */
  limite: number;
  bloqueado?: boolean;
}): Ditado {
  const [truncado, setTruncado] = useState(false);

  const ditado = useDictation({
    patientId,
    bloqueado,
    aoTranscrever: (texto) => {
      const resultado = aplicaTranscricao(valor, texto, limite);
      if (!resultado.mudou) return;
      setTruncado(resultado.truncado);
      aoMudar(resultado.texto);
    },
  });

  const inicia = useCallback(() => {
    setTruncado(false);
    ditado.inicia();
  }, [ditado]);

  return {
    ...ditado,
    inicia,
    aviso: truncado
      ? "O texto passou do limite do campo e foi cortado no fim. Confira antes de continuar."
      : ditado.aviso,
  };
}
