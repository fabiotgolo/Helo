// ——— O lado servidor do ditado: a chave, a flag e a retenção zero ———
//
// Este módulo existe separado de `lib/voice/dictation.ts` por um motivo só: ele
// lê `process.env`. Nada aqui pode ser importado por componente de cliente —
// no navegador estas variáveis não existem, e um `false` vindo de variável
// ausente pareceria uma decisão de segurança quando é apenas um bundle
// diferente. O cliente descobre se o ditado está disponível perguntando ao
// servidor, e recebe de volta um booleano — nunca a configuração.

import {
  IDIOMA_SCRIBE,
  MODELO_SCRIBE,
  PRAZO_TRANSCRICAO_MS,
  limpaTranscricao,
  urlDoScribe,
} from "@/lib/voice/dictation";
import {
  chamaElevenLabsJson,
  type FalhaElevenLabs,
} from "@/lib/voice/eleven-fetch";

/**
 * O ditado nasce DESLIGADO, e continua desligado por omissão.
 *
 * Enquanto o workspace da ElevenLabs não suportar retenção zero, o valor em
 * produção é `false` e nenhum áudio sai daqui. A flag é server-side de
 * propósito: `NEXT_PUBLIC_` chegaria ao navegador, e o que chega ao navegador
 * é sugestão, não decisão. Qualquer valor que não seja exatamente "true"
 * — ausente, vazio, "1", "yes" — deixa o ditado indisponível.
 */
export function ditadoHabilitado(): boolean {
  return process.env.HELO_VOICE_DICTATION_ENABLED === "true";
}

/** Sem chave não há provedor, e sem provedor não há ditado. */
export function provedorConfigurado(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

export function ditadoDisponivel(): boolean {
  return ditadoHabilitado() && provedorConfigurado();
}

export type ResultadoDaTranscricao =
  | { ok: true; transcript: string }
  | { ok: false; falha: FalhaElevenLabs; status: number | null };

interface RespostaDoScribe {
  text?: unknown;
}

/**
 * Áudio → texto, uma vez e uma vez só.
 *
 * ——— Por que não existe retentativa aqui ———
 *
 * Toda retentativa é uma segunda gravação do mesmo áudio no provedor. Como a
 * requisição já vai com `enable_logging=false` e o plano atual recusa esse
 * modo, uma retentativa que "ajustasse" o parâmetro para passar seria
 * exatamente o comportamento que a política proíbe — e é o tipo de conserto
 * que alguém faz de boa-fé às duas da manhã para "destravar o recurso".
 *
 * Então: uma chamada. Se falhar, falhou. O áudio já foi descartado quando esta
 * função retorna, não sobra nada para reenviar, e o cuidador continua com o
 * campo de digitação intacto — que é o que ele precisa para seguir trabalhando.
 */
export async function transcreve(audio: Blob): Promise<ResultadoDaTranscricao> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return { ok: false, falha: "rejected", status: null };

  const form = new FormData();
  // O nome do arquivo é irrelevante para o provedor e nunca é lido por nós; o
  // que importa é o tipo, que já foi conferido contra a allowlist.
  form.append("file", audio, "ditado");
  form.append("model_id", MODELO_SCRIBE);
  form.append("language_code", IDIOMA_SCRIBE);

  // `enable_logging=false` vai na QUERY (é onde o endpoint o lê) e não no
  // multipart. Não há caminho neste arquivo que monte a URL sem ele.
  const chamada = await chamaElevenLabsJson<RespostaDoScribe>(
    urlDoScribe(),
    { method: "POST", headers: { "xi-api-key": apiKey }, body: form, cache: "no-store" },
    { prazoMs: PRAZO_TRANSCRICAO_MS, rotulo: "dictation" }
  );

  if (!chamada.ok) {
    // Uma recusa 4xx aqui é, hoje, o caso conhecido: o plano não permite
    // retenção zero. Registramos que a exigência estava no pedido para que
    // quem lê o log não confunda com uma chave errada — e nada além disso.
    if (chamada.status !== null && chamada.status < 500) {
      console.error("[DITADO] provedor recusou a chamada com retenção zero", {
        status: chamada.status,
      });
    }
    return { ok: false, falha: chamada.falha, status: chamada.status };
  }

  // Só o texto. `words`, `language_probability` e o resto da resposta não
  // entram no Helo — nem em variável, nem em log.
  //
  // Texto vazio é sucesso, não falha: o provedor ouviu e não havia fala. Quem
  // decide o que fazer com isso é a interface, que não mexe no campo e diz
  // "não consegui entender" — bem diferente de "o serviço está fora".
  return { ok: true, transcript: limpaTranscricao(chamada.dados.text) };
}
