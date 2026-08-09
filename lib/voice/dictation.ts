// ——— Ditado do cuidador: o domínio, fora do React e fora do DOM ———
//
// A Fase 5.2A dá ao CUIDADOR uma forma de preencher campos de texto falando.
// Ela não dá voz ao paciente, e a fronteira entre as duas coisas é o motivo
// deste arquivo existir separado: aqui não há grant, não há voiceId, não há
// autoria. Há um áudio que vira texto e cai num campo que o cuidador ainda
// precisa ler, corrigir e submeter com o botão que já existia.
//
// O que sai daqui é rascunho. Sempre. Não existe caminho, nesta camada ou em
// qualquer outra, que leve um transcript direto a uma fala confirmada, a um
// SIM/TALVEZ/NÃO, ou a um SpeechGrant — e isso não é garantido por uma
// verificação, é garantido pela ausência da ligação.
//
// ——— Por que é lote e não streaming ———
//
// O SDK instalado traz `useScribe`, que abre um WebSocket do navegador direto
// para a ElevenLabs e devolve parciais ao vivo. Não usamos: nesse desenho o
// Helo sai do caminho, e sair do caminho significa não conseguir exigir
// autenticação, nem teto de bytes, nem — o que decide — retenção zero, que o
// `ScribeHookOptions` sequer expõe. O áudio de um cuidador dizendo "o senhor
// está sentindo dor na perna?" é conteúdo clínico. Ele passa pelo servidor do
// Helo ou não é gravado.
//
// O preço é não ter parciais. Está assumido: para uma frase de duas linhas,
// gravar → parar → processar → texto é um fluxo bom, e é uma máquina de
// estados que cabe na cabeça de quem for mantê-la.

// ---------- Limites ----------

/**
 * Teto de uma captura.
 *
 * Sessenta segundos de fala corrida dão cerca de 150 palavras, ~900
 * caracteres. O maior campo com ditado aceita 500. O relógio, portanto, nunca
 * é o que interrompe uma pergunta legítima — ele existe para o microfone que
 * ficou aberto por esquecimento, e é folgado o bastante para quem pensa no
 * meio da frase.
 */
export const DURACAO_MAXIMA_MS = 60_000;

/**
 * Teto de bytes, conferido no SERVIDOR e independente do cronômetro.
 *
 * O cronômetro vive no navegador, e o navegador é o que não se confia. A
 * aritmética: gravamos opus a 32 kbps mono, o que dá ~240 KB em 60s; o Safari
 * ignora o bitrate pedido e entrega AAC a ~64 kbps, ~480 KB. Dois mebibytes
 * são quatro vezes o pior caso realista — folga para contêiner e para um
 * navegador que resolva ser generoso, sem deixar de ser um limite de verdade.
 */
export const TAMANHO_MAXIMO_BYTES = 2 * 1024 * 1024;

/** Bitrate pedido ao MediaRecorder. Fala inteligível não precisa de mais. */
export const BITRATE_ALVO = 32_000;

/**
 * Prazo da chamada ao provedor. TOTAL, não até os cabeçalhos: aqui a resposta
 * é um JSON curto lido inteiro no servidor — o oposto do TTS, que transmite.
 * Trinta segundos porque a transcrição de um minuto de áudio costuma levar
 * poucos segundos, e quem espera está com a tela parada em "processando".
 */
export const PRAZO_TRANSCRICAO_MS = 30_000;

/** Só áudio → texto. Nada de diarização, entidades, keyterms ou tradução. */
export const MODELO_SCRIBE = "scribe_v2";
export const IDIOMA_SCRIBE = "por";

/**
 * Teto do texto que aceitamos como transcrição.
 *
 * Sessenta segundos de fala corrida dão ~900 caracteres, e o maior campo com
 * ditado aceita 500. Quatro mil é folga larga para um provedor verboso, e
 * ainda assim um limite: uma resposta gigante — provedor com defeito, resposta
 * de outro endpoint, página de erro que veio com status 200 — não pode virar
 * uma string enorme circulando pela interface e pelo campo de formulário.
 * Acima disso não truncamos: texto clínico cortado no meio é pior que ausente.
 */
export const TAMANHO_MAXIMO_TRANSCRICAO = 4_000;

// ---------- Retenção zero ----------

/**
 * O workspace do Helo está no Grant Tier 2, e a ElevenLabs confirmou que o
 * modo de retenção zero é recurso Enterprise: uma requisição com
 * `enable_logging=false` NÃO será aceita no plano atual.
 *
 * Isso não vira uma alternativa configurável. A política é uma só:
 *
 *     DITADO HABILITADO = RETENÇÃO ZERO OBRIGATÓRIA.
 *
 * Não existe variável para desligar o parâmetro, não existe repetição da
 * chamada sem ele, não existe segunda tentativa. Se a ElevenLabs recusar, o
 * ditado fica indisponível e a digitação continua exatamente como está hoje.
 * Um produto que se adapta sozinho ao modo com retenção é um produto que
 * grava a voz de um cuidador falando de dor sem que ninguém tenha decidido
 * isso.
 *
 * O parâmetro vai na QUERY, não no multipart — é onde o endpoint o lê.
 */
export const BASE_SCRIBE = "https://api.elevenlabs.io/v1/speech-to-text";

export function urlDoScribe(base: string = BASE_SCRIBE): string {
  return `${base}?enable_logging=false`;
}

// ---------- Tipos de áudio ----------

/**
 * O que os navegadores que suportamos realmente produzem — e nada além.
 *
 *   Chrome, Edge   audio/webm;codecs=opus
 *   Firefox        audio/ogg;codecs=opus  (e webm)
 *   Safari 14.1+   audio/mp4              (AAC)
 *
 * A lista é de tipos-base. O parâmetro `codecs` é aceito e ignorado; qualquer
 * outro parâmetro reprova. O `filename` do multipart nunca é consultado: o
 * cliente escolhe esse nome, e um nome não é evidência de nada.
 */
export const TIPOS_DE_AUDIO_ACEITOS = ["audio/webm", "audio/ogg", "audio/mp4"] as const;

export type TipoDeAudio = (typeof TIPOS_DE_AUDIO_ACEITOS)[number];

/** Devolve o tipo-base aceito, ou null. Nunca lança. */
export function tipoDeAudioAceito(valor: unknown): TipoDeAudio | null {
  if (typeof valor !== "string") return null;
  const [base, ...parametros] = valor.split(";").map((p) => p.trim());
  const normalizado = base.toLowerCase();
  if (!(TIPOS_DE_AUDIO_ACEITOS as readonly string[]).includes(normalizado)) return null;
  // Um `Content-Type` com parâmetro desconhecido não é um formato que
  // reconhecemos — é um pedido de que confiemos em algo que não conferimos.
  for (const parametro of parametros) {
    if (!/^codecs=/i.test(parametro)) return null;
  }
  return normalizado as TipoDeAudio;
}

// ---------- Estados ----------

/**
 * O ciclo inteiro do ditado, e nada mais que isso. `UNAVAILABLE` não é erro:
 * é o produto dizendo que aqui, agora, não dá — sem chave, sem microfone, sem
 * conexão ou com o recurso desligado no servidor.
 */
export type EstadoDoDitado =
  | "IDLE"
  | "REQUESTING_PERMISSION"
  | "LISTENING"
  | "PROCESSING"
  | "DRAFT_READY"
  | "PERMISSION_DENIED"
  | "UNAVAILABLE"
  | "ERROR";

export type FalhaDoDitado =
  | "PERMISSION_DENIED"
  | "NO_DEVICE"
  /** O microfone sumiu NO MEIO da gravação — cabo puxado, fone desligado. */
  | "DEVICE_LOST"
  | "UNSUPPORTED"
  | "OFFLINE"
  /** A tela saiu de vista com o microfone aberto: cancelamos por privacidade. */
  | "BACKGROUNDED"
  /** O microfone está com o Agente Helo, ou há áudio da Helo tocando. */
  | "MIC_OCUPADO"
  | "TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "EMPTY_TRANSCRIPT"
  | "CANCELLED"
  | "UNKNOWN";

/**
 * O que o cuidador lê. Sem status HTTP, sem nome de provedor, sem "Enterprise",
 * sem "retenção", sem configuração interna. Quem opera o Helo descobre a causa
 * no log do servidor; quem está ao lado de um paciente descobre o que fazer.
 */
export function mensagemDoDitado(falha: FalhaDoDitado): string {
  switch (falha) {
    case "PERMISSION_DENIED":
      return "O microfone não foi liberado. Você pode digitar normalmente.";
    case "NO_DEVICE":
      return "Nenhum microfone disponível. Você pode digitar normalmente.";
    case "DEVICE_LOST":
      return "O microfone foi desconectado durante a gravação. Nada foi enviado — você pode digitar ou ditar de novo.";
    case "UNSUPPORTED":
      return "Este navegador não grava áudio. Você pode digitar normalmente.";
    case "OFFLINE":
      return "A conexão caiu e o ditado foi interrompido. O que você digitou continua aqui.";
    case "BACKGROUNDED":
      return "O ditado foi cancelado porque esta tela saiu de vista. Nada foi gravado nem enviado.";
    case "MIC_OCUPADO":
      return "O microfone está em uso pela Helo. Encerre a conversa ou espere o áudio terminar para ditar.";
    case "TIMEOUT":
      return "A transcrição demorou demais. Tente de novo ou digite.";
    case "PROVIDER_UNAVAILABLE":
      return "O ditado está indisponível agora. Você pode digitar normalmente.";
    case "EMPTY_TRANSCRIPT":
      return "Não consegui entender o que foi dito. Tente de novo mais perto do microfone.";
    case "CANCELLED":
      return "Ditado cancelado.";
    default:
      return "Não foi possível transcrever. Você pode digitar normalmente.";
  }
}

/** Aviso do teto de tempo. Separado da lista de falhas: não é uma falha. */
export const AVISO_LIMITE_DE_TEMPO =
  "O tempo máximo de gravação foi atingido. Transcrevendo o que foi gravado.";

/**
 * O transcript não coube no campo, e por isso NADA foi escrito. Também não é
 * falha: o ditado funcionou, o texto é que é maior que o espaço.
 */
export const AVISO_NAO_COUBE =
  "O que foi ditado não cabe no limite deste campo, então nada foi alterado. Encurte o texto ou dite em partes.";

// ---------- Transcrição → campo ----------

/**
 * O texto como ele pode entrar num campo: sem espaço sobrando, sem quebras de
 * linha vindas do provedor, e nada mais. Não "corrigimos" pontuação nem
 * capitalização — o que o cuidador falou é dele, e adivinhar aqui produziria
 * uma frase que ninguém disse.
 */
export function limpaTranscricao(bruto: unknown): string {
  if (typeof bruto !== "string") return "";
  return bruto.replace(/\s+/g, " ").trim();
}

/**
 * A resposta do provedor, conferida como ESTRUTURA antes de virar texto.
 *
 * `null` quer dizer "isto não é uma transcrição": não é string, ou é grande
 * demais para ter saído de um minuto de fala. Não é a mesma coisa que string
 * vazia, que é uma transcrição legítima de silêncio.
 */
export function validaTranscricao(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;
  if (bruto.length > TAMANHO_MAXIMO_TRANSCRICAO) return null;
  return limpaTranscricao(bruto);
}

export interface AplicacaoDeTranscricao {
  texto: string;
  /** Falso quando nada pôde entrar no campo — vazio, ou não coube. */
  mudou: boolean;
  /**
   * O texto todo junto passaria do `maxLength` do campo, e por isso NADA foi
   * escrito. O cuidador é avisado e o que ele já tinha continua onde estava.
   */
  naoCoube: boolean;
}

/**
 * A transcrição ACRESCENTA ao que já está no campo; não substitui.
 *
 * A escolha custou uma discussão comigo mesmo. "Substituir" é o que a maioria
 * dos ditados faz, e seria uma linha a menos. Mas o cuidador digita e fala no
 * mesmo campo, muitas vezes na mesma frase — digitou metade, ditou o resto —,
 * e substituir apagaria sem aviso um texto que ninguém pediu para apagar, num
 * momento em que a pessoa está de olho no paciente e não na tela. Acrescentar
 * nunca destrói trabalho; o que sobra o cuidador apaga, que é uma tecla.
 *
 * Transcrição vazia não encosta no campo: "não entendi" não pode virar
 * "apagou o que você escreveu".
 *
 * ——— E o que não cabe não entra ———
 *
 * A 5.2A cortava o excedente no fim e avisava. A 5.2B não corta.
 *
 * Um `maxLength` num campo do Helo é o limite de uma pergunta que vai ser lida
 * por um paciente; cortar no caractere 500 produz uma frase que termina no meio
 * — e uma frase pela metade apresentada a alguém que só pode responder SIM ou
 * NÃO é pior que nenhuma frase. Pior ainda: quem ditou estava olhando para o
 * paciente, não para a tela, e um corte silencioso só aparece depois de o botão
 * "Continuar" já ter sido apertado.
 *
 * Então, quando não cabe: o campo fica exatamente como estava, e o cuidador é
 * avisado. Ele encurta, apaga o que não quer, ou dita de novo em duas partes —
 * três caminhos que ele controla, nenhum deles destrutivo.
 */
export function aplicaTranscricao(
  atual: string,
  transcricao: string,
  limite: number
): AplicacaoDeTranscricao {
  const limpa = limpaTranscricao(transcricao);
  if (!limpa) return { texto: atual, mudou: false, naoCoube: false };

  const base = atual ?? "";
  const juntos = base.trim() ? `${base.replace(/\s+$/, "")} ${limpa}` : limpa;
  if (juntos.length > limite) return { texto: base, mudou: false, naoCoube: true };
  return { texto: juntos, mudou: true, naoCoube: false };
}

// ---------- Proveniência ----------

/**
 * De onde veio o texto que está no campo — e a resposta tem de ser verdadeira.
 *
 * `VOICE_TRANSCRIPTION` precisa significar "esta pergunta NASCEU de uma
 * transcrição de voz", não "em algum momento houve voz neste campo". A
 * diferença aparece no caso mais comum de todos: o cuidador digita metade,
 * percebe que é mais rápido falar o resto, e dita. Marcar a pergunta inteira
 * como ditada aí seria atribuir à voz um texto que a pessoa escreveu com as
 * mãos — e proveniência é registro clínico, não estatística de uso.
 *
 * As regras, todas determinísticas:
 *
 *   campo vazio + ditado          → nasceu por voz
 *   campo com texto + ditado      → continua digitada, para sempre
 *   nasceu por voz + edição       → continua por voz; `original` não muda
 *   nasceu por voz + outro ditado → `original` ganha a nova transcrição BRUTA
 *   campo esvaziado               → a procedência morre junto com o texto
 *
 * `original` guarda as transcrições cruas, na ordem, unidas por espaço — o que
 * a voz produziu antes de qualquer revisão. Nunca as edições manuais: o texto
 * final já está no campo, e misturar os dois faria `originalText` mentir
 * exatamente onde ele existe para não mentir.
 *
 * Não guardamos cronologia de teclas. Isto é tudo que o produto precisa saber.
 */
export type OrigemDoTexto = "MANUAL_TEXT" | "VOICE_TRANSCRIPTION";

export interface ProcedenciaDoTexto {
  origem: OrigemDoTexto;
  /** Transcrições brutas aceitas, em ordem. `null` quando a origem é manual. */
  original: string | null;
}

/** O estado de um campo em que ninguém falou ainda. */
export function procedenciaInicial(): ProcedenciaDoTexto {
  return { origem: "MANUAL_TEXT", original: null };
}

/**
 * Uma transcrição acabou de entrar. `textoAntes` é o conteúdo do campo no
 * instante ANTERIOR — é ele que decide se a pergunta nasce por voz.
 */
export function registraDitado(
  atual: ProcedenciaDoTexto,
  textoAntes: string,
  transcricao: string
): ProcedenciaDoTexto {
  const limpa = limpaTranscricao(transcricao);
  if (!limpa) return atual;
  if (atual.origem === "VOICE_TRANSCRIPTION") {
    return {
      origem: "VOICE_TRANSCRIPTION",
      original: atual.original ? `${atual.original} ${limpa}` : limpa,
    };
  }
  // Já havia texto digitado quando a voz chegou: a pergunta é dele.
  if ((textoAntes ?? "").trim()) return atual;
  return { origem: "VOICE_TRANSCRIPTION", original: limpa };
}

/**
 * O campo mudou por digitação. Esvaziá-lo apaga a procedência — o texto que a
 * voz produziu não existe mais, e o próximo a entrar define a origem de novo.
 * Qualquer outra edição preserva: revisar o que se ditou é o fluxo, não é
 * escrever de novo.
 */
export function registraEdicao(
  atual: ProcedenciaDoTexto,
  textoDepois: string
): ProcedenciaDoTexto {
  if ((textoDepois ?? "").trim()) return atual;
  return procedenciaInicial();
}

// ---------- Classificação de falhas ----------

/**
 * Erros do `getUserMedia`/`MediaRecorder` em categorias que a interface sabe
 * explicar. O nome do DOMException é o único sinal confiável — a mensagem
 * varia por navegador e por idioma do sistema.
 */
export function classificaErroDeCaptura(erro: unknown): FalhaDoDitado {
  const nome = (erro as { name?: unknown } | null)?.name;
  switch (nome) {
    case "NotAllowedError":
    case "SecurityError":
      return "PERMISSION_DENIED";
    case "NotFoundError":
    case "OverconstrainedError":
      return "NO_DEVICE";
    // Dispositivo ocupado por outro programa, ou arrancado da porta no meio.
    case "NotReadableError":
      return "NO_DEVICE";
    case "AbortError":
      return "CANCELLED";
    case "TypeError":
      return "UNSUPPORTED";
    default:
      return "UNKNOWN";
  }
}

/**
 * Resposta do `/api/voice/dictation` em categoria.
 *
 * Tudo que não é 200 leva à mesma conclusão prática — não há transcrição, o
 * campo continua digitável — e nenhuma delas gera nova tentativa automática.
 * A distinção existe para a frase que o cuidador lê.
 */
export function classificaRespostaDoDitado(status: number): FalhaDoDitado {
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status === 401 || status === 403) return "PROVIDER_UNAVAILABLE";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  // 413, 415, 400: o áudio não serve. Do ponto de vista de quem gravou, é a
  // mesma coisa que o serviço não ter funcionado.
  return "PROVIDER_UNAVAILABLE";
}
