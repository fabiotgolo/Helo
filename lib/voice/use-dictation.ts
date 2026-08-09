"use client";

// ——— A captura: microfone aberto pelo menor tempo possível ———
//
// Um hook por campo. Cada instância é dona do seu `MediaStream`, do seu
// `MediaRecorder` e do seu cronômetro, e libera os três em toda saída — parar,
// cancelar, errar, desmontar, trocar de paciente, sair da conta, esconder a
// aba, perder a rede, perder o aparelho.
//
// O áudio existe em memória e em mais lugar nenhum. Não vira ObjectURL (não há
// o que reproduzir: o cuidador acabou de falar, ele sabe o que disse), não é
// gravado, não entra em fila, não é guardado para reenviar. Quando a resposta
// chega, os pedaços são soltos; quando a chamada falha, também.
//
// O que ele devolve é uma string que a tela põe num campo. Nada mais acontece
// sozinho: apresentar, salvar e confirmar continuam sendo do botão que o
// cuidador já apertava antes desta fase existir.
//
// ——— O que a 5.2B mudou aqui, e por quê ———
//
// A 5.2A guardava o estado da captura em refs soltas — um stream, um gravador,
// um `canceladoRef` — e todas elas eram reaproveitadas pela tentativa seguinte.
// Isso produzia uma família inteira de defeitos com a mesma forma: uma callback
// de uma tentativa antiga chegando tarde e agindo sobre a atual.
//
//   iniciar → cancelar → iniciar de novo → a PRIMEIRA permissão resolve →
//   `canceladoRef` já voltou a `false` → o stream velho vira o stream atual.
//
//   enviar → trocar de paciente → a resposta chega → o campo do paciente NOVO
//   recebe o texto ditado sobre o anterior.
//
//   qualquer saída → `setDictationActive(false)` global → o microfone é
//   marcado como livre mesmo estando com outra pessoa.
//
// Nenhum desses se conserta com mais um boolean. O que conserta é dar
// IDENTIDADE à tentativa: tudo que uma captura possui vive num objeto criado
// quando ela começa e descartado quando ela acaba, e toda callback carrega a
// referência do objeto a que pertence. Uma callback atrasada compara, não se
// reconhece como atual, e vai embora sem tocar em nada — sem precisar saber por
// que deixou de valer.
//
// O `targetField` faz parte dessa identidade por consequência: cada campo tem o
// seu hook, uma navegação desmonta o hook, e a desmontagem invalida a execução.
// Uma transcrição pedida na pergunta não tem como cair na interpretação.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isDictationActive,
  isHeloAudioPlaying,
  registerDictationStop,
} from "@/lib/audio-coordinator";
import {
  adquireMicrofone,
  avancaMicrofone,
  agenteDetemMicrofone,
  liberaMicrofone,
  type ConcessaoDoMicrofone,
} from "@/lib/voice/mic-ownership";
import {
  AVISO_LIMITE_DE_TEMPO,
  AVISO_NAO_COUBE,
  BITRATE_ALVO,
  DURACAO_MAXIMA_MS,
  TIPOS_DE_AUDIO_ACEITOS,
  aplicaTranscricao,
  classificaErroDeCaptura,
  classificaRespostaDoDitado,
  limpaTranscricao,
  mensagemDoDitado,
  tipoDeAudioAceito,
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

/**
 * O tipo com que o Blob vai ser montado.
 *
 * Pedir um formato ao `MediaRecorder` não é o mesmo que recebê-lo: alguns
 * navegadores aceitam a construção e gravam outra coisa, e o Safari costuma
 * ignorar o que foi pedido. O `mimeType` do gravador é o que ele REALMENTE
 * produziu — e é ele que precisa combinar com os bytes, agora que o servidor
 * confere a assinatura do contêiner. Rotular um MP4 como `audio/webm` faria o
 * próprio Helo ser recusado pelo próprio Helo.
 *
 * Se o efetivo não estiver na allowlist (ou não existir), voltamos ao pedido —
 * a recusa acontece no servidor, que é onde ela vale.
 */
function tipoEfetivo(gravador: MediaRecorder, pedido: string): string {
  const efetivo = gravador.mimeType;
  return efetivo && tipoDeAudioAceito(efetivo) ? efetivo : pedido;
}

/**
 * Tudo que UMA tentativa de ditado possui.
 *
 * Criado em `inicia`, descartado em `encerra`, e nunca reaproveitado. Toda
 * callback assíncrona guarda a referência do seu — comparar com o vigente é o
 * único teste de validade que existe neste arquivo.
 */
interface Execucao {
  readonly concessao: ConcessaoDoMicrofone;
  readonly formato: string;
  stream: MediaStream | null;
  gravador: MediaRecorder | null;
  pedacos: BlobPart[];
  relogio: number | null;
  envio: AbortController | null;
  /** O teardown já rodou. Impede que ele conte duas vezes o que é único. */
  encerrada: boolean;
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

  const execucaoRef = useRef<Execucao | null>(null);
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

  /**
   * Solta TUDO que a execução possui, e devolve o microfone.
   *
   * Idempotente pela bandeira `encerrada`, e SEGURO contra atraso pela
   * concessão: `liberaMicrofone` de uma concessão vencida não solta o dono
   * atual — devolve `false` e não faz nada. É o que permite chamar isto de
   * qualquer caminho de saída, quantas vezes for, sem contar as chamadas.
   */
  const encerra = useCallback((execucao: Execucao) => {
    if (execucao.encerrada) return;
    execucao.encerrada = true;

    if (execucao.relogio != null) {
      window.clearTimeout(execucao.relogio);
      execucao.relogio = null;
    }
    execucao.envio?.abort();
    execucao.envio = null;

    const gravador = execucao.gravador;
    execucao.gravador = null;
    if (gravador && gravador.state !== "inactive") {
      try {
        gravador.stop();
      } catch {
        // Já estava encerrado. O que importa é o que vem depois.
      }
    }
    const stream = execucao.stream;
    execucao.stream = null;
    // A luz do microfone só apaga quando a ÚLTIMA trilha para. Enquanto uma
    // sobrar, o aparelho continua captando e o cuidador continua vendo o
    // indicador do navegador aceso — que é o pior estado possível: parece que
    // o Helo está gravando escondido.
    for (const trilha of stream?.getTracks() ?? []) trilha.stop();
    execucao.pedacos = [];

    liberaMicrofone(execucao.concessao);
    if (execucaoRef.current === execucao) execucaoRef.current = null;
  }, []);

  /** A execução ainda é a atual? Único teste de validade do arquivo. */
  const vigente = useCallback(
    (execucao: Execucao) => execucaoRef.current === execucao && !execucao.encerrada,
    []
  );

  /**
   * Encerra a captura em curso sem escrever nada no campo.
   *
   * `motivo` vira a frase que o cuidador lê. `null` é o cancelamento pedido por
   * ele — que não precisa de explicação nenhuma, porque ele acabou de pedir.
   */
  const abandona = useCallback(
    (motivo: FalhaDoDitado | null) => {
      const execucao = execucaoRef.current;
      if (execucao) encerra(execucao);
      setEstado(motivo === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : motivo ? "ERROR" : "IDLE");
      setAviso(motivo ? mensagemDoDitado(motivo) : null);
    },
    [encerra]
  );

  const cancela = useCallback(() => abandona(null), [abandona]);

  // Logout, troca de paciente e emergência do paciente encerram a captura de
  // fora para dentro: quem sai da conta não sabe (nem deveria saber) quantos
  // campos com ditado existem montados.
  useEffect(() => registerDictationStop(cancela), [cancela]);

  // Desmontar é uma saída como qualquer outra. Sem isto, fechar a tela com o
  // microfone aberto deixaria o stream vivo até o navegador resolver limpá-lo —
  // e a transcrição em voo voltaria para um campo que não existe mais.
  useEffect(
    () => () => {
      const execucao = execucaoRef.current;
      if (execucao) encerra(execucao);
    },
    [encerra]
  );

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

  // ——— A aba saiu de vista ———
  //
  // Gravar em background é a forma mais direta de o Helo virar um aparelho de
  // escuta: o indicador do navegador fica numa aba que ninguém está olhando, e
  // a conversa que continua na sala não tem nada a ver com o campo de texto.
  // Então some da vista = acabou. O áudio parcial é descartado, não enviado —
  // metade de uma pergunta transcrita é pior que pergunta nenhuma.
  //
  // Voltar NÃO retoma. Recomeçar é uma decisão, e é do cuidador.
  useEffect(() => {
    const sumiu = () => {
      if (!execucaoRef.current) return;
      abandona("BACKGROUNDED");
    };
    const aoMudarVisibilidade = () => {
      if (document.visibilityState === "hidden") sumiu();
    };
    document.addEventListener("visibilitychange", aoMudarVisibilidade);
    window.addEventListener("pagehide", sumiu);
    return () => {
      document.removeEventListener("visibilitychange", aoMudarVisibilidade);
      window.removeEventListener("pagehide", sumiu);
    };
  }, [abandona]);

  // Offline não é erro do ditado: é ausência de rede. O campo continua
  // digitável e o botão some — nada é gravado para enviar depois.
  //
  // Se a rede cai COM captura em curso, a captura acaba ali: gravar para
  // descobrir depois que não dá para enviar produziria um áudio órfão que só
  // teria dois destinos, e os dois são proibidos — fila ou reenvio.
  useEffect(() => {
    const atualiza = () => {
      const conectado = navigator.onLine !== false;
      setOnline(conectado);
      if (!conectado && execucaoRef.current) abandona("OFFLINE");
    };
    atualiza();
    window.addEventListener("online", atualiza);
    window.addEventListener("offline", atualiza);
    return () => {
      window.removeEventListener("online", atualiza);
      window.removeEventListener("offline", atualiza);
    };
  }, [abandona]);

  const envia = useCallback(
    async (execucao: Execucao, audio: Blob) => {
      if (!vigente(execucao) || patientId == null) return;
      const controle = new AbortController();
      execucao.envio = controle;
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
        // Abortar e conferir a validade são coisas diferentes, e as duas são
        // necessárias: o abort corta a requisição quando dá tempo, esta guarda
        // cobre a resposta que já estava chegando quando o contexto mudou.
        if (!vigente(execucao)) return;
        if (!resposta.ok) {
          const falha = classificaRespostaDoDitado(resposta.status);
          encerra(execucao);
          setEstado("ERROR");
          setAviso(mensagemDoDitado(falha));
          return;
        }
        const dados = (await resposta.json().catch(() => null)) as
          | { transcript?: unknown }
          | null;
        if (!vigente(execucao)) return;
        const texto = typeof dados?.transcript === "string" ? limpaTranscricao(dados.transcript) : "";
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
        if (!vigente(execucao) || (erro as { name?: string })?.name === "AbortError") return;
        // Uma falha de rede aqui NÃO gera nova tentativa: repetir seria mandar
        // de novo a voz de um cuidador sem que ninguém tenha pedido.
        const falha: FalhaDoDitado =
          navigator.onLine === false ? "OFFLINE" : "PROVIDER_UNAVAILABLE";
        encerra(execucao);
        setEstado("ERROR");
        setAviso(mensagemDoDitado(falha));
      } finally {
        // O Blob e os pedaços perdem o último dono aqui, com resposta ou sem —
        // e o microfone volta a ficar livre para o Agente.
        encerra(execucao);
      }
    },
    [encerra, patientId, vigente]
  );

  const para = useCallback(() => {
    const execucao = execucaoRef.current;
    const gravador = execucao?.gravador;
    if (!execucao || !gravador || gravador.state !== "recording") return;
    // Já não estamos capturando, mas a interação continua pendente: a posse
    // avança para PROCESSING em vez de ser devolvida. O `onstop` é quem monta o
    // Blob e chama `envia`; aqui só pedimos o fim.
    avancaMicrofone(execucao.concessao, "DICTATION_PROCESSING");
    setEstado("PROCESSING");
    if (execucao.relogio != null) {
      window.clearTimeout(execucao.relogio);
      execucao.relogio = null;
    }
    try {
      gravador.stop();
    } catch {
      encerra(execucao);
      setEstado("ERROR");
      setAviso(mensagemDoDitado("UNKNOWN"));
    }
  }, [encerra]);

  const inicia = useCallback(() => {
    if (patientId == null || !servidorPermite || bloqueado || !online) return;
    // Guarda SÍNCRONA contra o duplo clique. `estado` só chega no render
    // seguinte; entre dois cliques rápidos ele ainda diz "IDLE", e a 5.2A
    // abria dois `getUserMedia`. A execução vigente é a verdade imediata.
    if (execucaoRef.current) return;

    // Um dono de cada vez, e a decisão vem antes de qualquer coisa assíncrona.
    if (isDictationActive()) return; // outro campo está ditando
    if (agenteDetemMicrofone()) {
      setEstado("ERROR");
      setAviso("Encerre a conversa com a Helo antes de usar o ditado.");
      return;
    }
    // Áudio da Helo tocando: abrir o microfone agora transcreveria a própria
    // Helo — e, no pior caso, a voz clonada do PACIENTE entraria num campo que
    // o cuidador vai revisar como texto dele. Não interrompemos a fala em
    // curso; pedimos que ele espere, que é a ordem certa de prioridade.
    if (isHeloAudioPlaying()) {
      setEstado("ERROR");
      setAviso("Espere o áudio da Helo terminar para começar a ditar.");
      return;
    }

    const formato = formatoSuportado();
    if (!navigator.mediaDevices?.getUserMedia || !formato) {
      setEstado("ERROR");
      setAviso(mensagemDoDitado("UNSUPPORTED"));
      return;
    }

    // A posse é TOMADA aqui — antes do diálogo de permissão, antes do stream,
    // antes de tudo. Enquanto ela for nossa, o Agente não conecta; se já for de
    // alguém, `adquire` devolve null e desistimos sem abrir nada.
    const concessao = adquireMicrofone("DICTATION_REQUESTING");
    if (!concessao) {
      setEstado("ERROR");
      setAviso(mensagemDoDitado("MIC_OCUPADO"));
      return;
    }

    const execucao: Execucao = {
      concessao,
      formato,
      stream: null,
      gravador: null,
      pedacos: [],
      relogio: null,
      envio: null,
      encerrada: false,
    };
    execucaoRef.current = execucao;
    setAviso(null);
    setEstado("REQUESTING_PERMISSION");

    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      })
      .then((stream) => {
        // A permissão demorou e o mundo andou: cancelado, desmontado, paciente
        // trocado, aba escondida. A trilha nasce e morre aqui, sem nunca acender
        // o indicador por engano e sem ressuscitar um estado que já morreu.
        if (!vigente(execucao)) {
          for (const trilha of stream.getTracks()) trilha.stop();
          return;
        }
        execucao.stream = stream;
        execucao.pedacos = [];

        const gravador = new MediaRecorder(stream, {
          mimeType: formato,
          audioBitsPerSecond: BITRATE_ALVO,
        });
        execucao.gravador = gravador;
        const tipoDoBlob = tipoEfetivo(gravador, formato);

        gravador.ondataavailable = (evento) => {
          if (evento.data && evento.data.size > 0) execucao.pedacos.push(evento.data);
        };
        gravador.onerror = () => {
          if (!vigente(execucao)) return;
          encerra(execucao);
          setEstado("ERROR");
          setAviso(mensagemDoDitado("UNKNOWN"));
        };
        gravador.onstop = () => {
          const pedacos = execucao.pedacos;
          execucao.pedacos = [];
          // `stop()` também vem do teardown — cancelamento, desmontagem, aba
          // escondida. Nesses casos o áudio é lixo e vai embora com ele.
          if (!vigente(execucao)) return;
          if (pedacos.length === 0) {
            encerra(execucao);
            setEstado("ERROR");
            setAviso(mensagemDoDitado("EMPTY_TRANSCRIPT"));
            return;
          }
          // As trilhas param JÁ — a transcrição pode levar segundos, e o
          // microfone não fica aberto durante ela. A posse continua nossa.
          for (const trilha of execucao.stream?.getTracks() ?? []) trilha.stop();
          execucao.stream = null;
          void envia(execucao, new Blob(pedacos, { type: tipoDoBlob }));
        };

        // Um dispositivo arrancado da porta no meio da captura não dispara erro
        // no gravador: a trilha simplesmente termina. A 5.2A transcrevia o que
        // tinha até ali — o que devolve meia pergunta sem dizer que é meia. A
        // 5.2B descarta: um áudio que terminou por acidente não é um áudio que
        // alguém terminou de falar.
        for (const trilha of stream.getTracks()) {
          trilha.onended = () => {
            if (!vigente(execucao)) return;
            abandona("DEVICE_LOST");
          };
        }

        gravador.start();
        avancaMicrofone(concessao, "DICTATION_LISTENING");
        setEstado("LISTENING");

        execucao.relogio = window.setTimeout(() => {
          execucao.relogio = null;
          if (!vigente(execucao) || execucao.gravador?.state !== "recording") return;
          // O teto chegou: encerra e transcreve o que existe. Descartar seria
          // punir quem falou demais perdendo tudo que já foi dito.
          setAviso(AVISO_LIMITE_DE_TEMPO);
          para();
        }, DURACAO_MAXIMA_MS);
      })
      .catch((erro: unknown) => {
        if (!vigente(execucao)) return;
        abandona(classificaErroDeCaptura(erro));
      });
  }, [
    abandona,
    bloqueado,
    encerra,
    envia,
    online,
    para,
    patientId,
    servidorPermite,
    vigente,
  ]);

  const disponivel = servidorPermite && !bloqueado && online && patientId != null;
  const ativo = estado === "LISTENING" || estado === "PROCESSING";

  return {
    estado: disponivel ? estado : "UNAVAILABLE",
    disponivel,
    // O aviso sobrevive à indisponibilidade quando ela é a NOTÍCIA: a rede caiu
    // durante a gravação e o botão sumiu junto. Sem esta exceção, a captura
    // acabaria em silêncio e o cuidador ficaria esperando um texto que não vem.
    aviso: disponivel || estado === "ERROR" ? aviso : null,
    ativo,
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
  aoDitar,
  limite,
  bloqueado,
}: {
  patientId: number | null;
  valor: string;
  aoMudar: (texto: string) => void;
  /**
   * A transcrição BRUTA que acabou de entrar, com o texto do campo antes e
   * depois dela. Existe para a proveniência (§20): só quem viu o campo vazio
   * no instante anterior pode dizer que a pergunta nasceu por voz.
   */
  aoDitar?: (info: { transcricao: string; textoAntes: string; textoDepois: string }) => void;
  /** `maxLength` do campo. O que não couber não entra, e o cuidador é avisado. */
  limite: number;
  bloqueado?: boolean;
}): Ditado {
  const [naoCoube, setNaoCoube] = useState(false);

  const ditado = useDictation({
    patientId,
    bloqueado,
    aoTranscrever: (texto) => {
      const resultado = aplicaTranscricao(valor, texto, limite);
      setNaoCoube(resultado.naoCoube);
      if (!resultado.mudou) return;
      aoMudar(resultado.texto);
      aoDitar?.({ transcricao: texto, textoAntes: valor, textoDepois: resultado.texto });
    },
  });

  const inicia = useCallback(() => {
    setNaoCoube(false);
    ditado.inicia();
  }, [ditado]);

  return {
    ...ditado,
    inicia,
    aviso: naoCoube ? AVISO_NAO_COUBE : ditado.aviso,
  };
}
