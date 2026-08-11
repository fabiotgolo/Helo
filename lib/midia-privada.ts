import { getStorage } from "firebase-admin/storage";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";

// ——— Mídia do paciente: privada, e privada por construção (Fase 5.4B) ———
//
// Até aqui, o áudio pré-sintetizado de uma frase favorita virava um Firebase
// download URL — `getDownloadURL(file)` —, e essa URL ia para o Firestore e de
// lá para o navegador, que a pedia direto ao `firebasestorage.googleapis.com`.
//
// O que isso significava, dito sem eufemismo: a voz clonada do paciente
// dizendo uma frase dele ficava atrás de um endereço que funciona **sem
// sessão**, **sem vínculo**, **sem SpeechGrant** e **sem prazo**. Quem tivesse
// o link tinha o áudio, para sempre — inclusive depois de perder o acesso ao
// paciente. Era o caminho que contornava inteiro o portão erguido na 5.1A.
//
// ——— Por que Storage Rules não resolviam isso ———
//
// Um download token do Firebase é uma *capability*: ele existe justamente para
// entregar o objeto a quem não está autenticado, e por isso **passa por cima
// das Rules**. Endurecer `storage.rules` — que a 5.4B também faz — protege o
// acesso direto pelo SDK do cliente e não encosta na URL com token. A correção
// tinha de ser outra: parar de emitir o token.
//
// ——— O modelo ———
//
// O objeto vive no Storage e **nunca** ganha URL pública. Quem o entrega é uma
// rota do Next que já sabe fazer a pergunta certa: quem é você, e você alcança
// ESTE paciente? A referência guardada no Firestore é um caminho — e um
// caminho, sozinho, não dá acesso a nada.
//
// O endereçamento segue o padrão que `/api/media` já usa e que a 5.4A apontou
// como o certo: **o cliente nomeia `patientId` + `id do recurso`, e o servidor
// resolve o caminho real**. Nenhuma rota aceita caminho livre do navegador, e
// por isso não existe path traversal a defender: o caminho nunca vem de fora.
//
// A validação de prefixo aqui dentro é a segunda tranca, não a primeira: o
// caminho vem de um documento que já vive sob o paciente, e ainda assim é
// conferido contra o namespace daquele paciente antes de qualquer leitura.

/**
 * O bucket da aplicação.
 *
 * Existia em dois lugares com regras diferentes — `getStorage().bucket()` em
 * `lib/favorite-phrases.ts` (que depende de um bucket padrão configurado) e um
 * literal com `??` na rota da playlist (porque o App Hosting nem sempre
 * configura esse padrão). Duas formas de responder à mesma pergunta é uma a
 * mais: agora é aqui, e é uma só.
 */
export function baldeDaHelo() {
  const nome =
    process.env.FIREBASE_STORAGE_BUCKET?.trim() ||
    "helo-app-7fbf8.firebasestorage.app";
  return getStorage().bucket(nome);
}

/** Identificador opaco de objeto. Não deriva de texto, nome nem relógio. */
export function novoIdDeMidia(): string {
  return randomBytes(12).toString("hex");
}

// ——— Os namespaces ———
//
// Tudo do paciente vive sob o paciente. O vínculo é ESTRUTURAL: não existe
// objeto de áudio de um paciente fora da pasta dele, e é isso que torna a
// conferência de prefixo uma pergunta com resposta.
//
// O nome do arquivo é opaco. Nunca o texto da frase, nunca o nome da pessoa,
// nunca o prompt — nada do conteúdo aparece no caminho.

/** `patients/{id}/phrase-audio/{phraseId}/` — todas as gerações de uma frase. */
export function prefixoDeAudioDaFrase(patientId: number, phraseId: string): string {
  return `patients/${patientId}/phrase-audio/${phraseId}/`;
}

/** Uma geração específica. O `audioId` é opaco e novo a cada síntese. */
export function caminhoDeAudioDaFrase(
  patientId: number,
  phraseId: string,
  audioId: string
): string {
  return `${prefixoDeAudioDaFrase(patientId, phraseId)}${audioId}.mp3`;
}

/** `patients/{id}/musics/{musicId}.mp3` — o que a A-12 tira de `musics/`. */
export function caminhoDeMusica(patientId: number, musicId: string): string {
  return `patients/${patientId}/musics/${musicId}.mp3`;
}

// ——— O legado ———
//
// Objetos gravados antes desta fase estão em dois lugares antigos:
// `patients/{id}/phrases_audio/{phraseId}.mp3` (com sublinhado, sem geração) e
// `musics/{timestamp}.mp3` (global, sem paciente nenhum no caminho).
//
// Eles continuam LEGÍVEIS pela rota autenticada — de propósito. O documento que
// guarda esse caminho já vive sob o paciente, então quem chega até ele já
// passou pela autorização; recusar a leitura só quebraria o áudio de quem tem
// direito a ele, sem tirar nada de quem tem a URL antiga. O que fecha a URL
// antiga é a migração (scripts/migrar-midia-privada.mjs), não a recusa aqui.
//
// A escrita, essa sim, nunca mais acontece nesses caminhos.

function prefixosLegitimosDeFrase(patientId: number): string[] {
  return [
    `patients/${patientId}/phrase-audio/`,
    `patients/${patientId}/phrases_audio/`,
  ];
}

function prefixosLegitimosDeMusica(patientId: number): string[] {
  return [`patients/${patientId}/musics/`, "musics/"];
}

/**
 * O caminho guardado pertence mesmo a este paciente?
 *
 * Segunda tranca. A primeira é o `requirePatientAccess` da rota; a terceira é o
 * fato de o documento viver sob o paciente. Esta existe para o caso de um
 * documento com caminho estragado — por migração malfeita, por escrita manual,
 * por bug — não virar uma leitura de outro lugar do bucket.
 */
export function caminhoDeFraseEhValido(caminho: string, patientId: number): boolean {
  return caminhoValido(caminho, prefixosLegitimosDeFrase(patientId));
}

export function caminhoDeMusicaEhValido(caminho: string, patientId: number): boolean {
  return caminhoValido(caminho, prefixosLegitimosDeMusica(patientId));
}

function caminhoValido(caminho: string, prefixos: string[]): boolean {
  if (typeof caminho !== "string" || !caminho) return false;
  // Nada de travessia, nada de barra inicial, nada de segmento vazio: o
  // caminho vem do nosso próprio banco, mas "vem do nosso banco" não é uma
  // garantia — é uma expectativa.
  if (caminho.includes("..") || caminho.startsWith("/") || caminho.includes("//")) {
    return false;
  }
  return prefixos.some((p) => caminho.startsWith(p));
}

// ——— A entrega dos bytes ———

/**
 * O intervalo pedido pelo `Range`, quando ele é um pedido que sabemos servir.
 *
 * `null` = sem `Range` (entrega inteira). `"invalido"` = pedido malformado ou
 * fora do arquivo, que vira 416. Exportado para a suíte de domínio: um erro de
 * aritmética aqui entrega o pedaço errado do áudio, e isso não é o tipo de
 * coisa que se confere por inspeção.
 */
export function interpretaRange(
  cabecalho: string | null,
  tamanho: number
): { inicio: number; fim: number } | "invalido" | null {
  if (!cabecalho) return null;
  const casa = /^bytes=(\d*)-(\d*)$/.exec(cabecalho.trim());
  if (!casa) return null;
  const [, cru1, cru2] = casa;
  if (!cru1 && !cru2) return "invalido";
  // `bytes=-500`: os últimos 500 bytes.
  if (!cru1) {
    const ultimos = Number(cru2);
    if (!Number.isFinite(ultimos) || ultimos <= 0) return "invalido";
    return { inicio: Math.max(0, tamanho - ultimos), fim: tamanho - 1 };
  }
  const inicio = Number(cru1);
  if (!Number.isFinite(inicio) || inicio >= tamanho) return "invalido";
  const fim = cru2 ? Math.min(Number(cru2), tamanho - 1) : tamanho - 1;
  if (!Number.isFinite(fim) || fim < inicio) return "invalido";
  return { inicio, fim };
}

export interface EntregaDeMidia {
  /** Caminho JÁ validado contra o namespace do paciente. */
  caminho: string;
  contentType: string;
  /** O cabeçalho `Range` da requisição, quando houver. */
  range: string | null;
  /**
   * `no-store` para a voz clonada do paciente. A música aceita uma política
   * menos rígida, mas nunca `public` — ver a decisão em cada rota.
   */
  cacheControl: string;
  /** Nome sugerido no download. Nunca conteúdo — só um rótulo técnico. */
  nomeDoArquivo: string;
}

/**
 * Entrega o objeto por streaming, com suporte a `Range`.
 *
 * Streaming e não `download()` porque uma música pode ter alguns megabytes e o
 * runtime tem 512 MiB: carregar o arquivo inteiro na memória para repassá-lo
 * seria trocar uma URL pública por um gargalo. E `Range` porque a barra de
 * progresso da música **já existe** — sem ele, arrastar o cursor deixaria de
 * funcionar, e a 5.4B não é uma mudança de experiência.
 */
export async function entregaMidia(entrega: EntregaDeMidia): Promise<Response> {
  const arquivo = baldeDaHelo().file(entrega.caminho);
  let tamanho: number;
  try {
    const [meta] = await arquivo.getMetadata();
    tamanho = Number(meta.size ?? 0);
  } catch {
    // Objeto ausente é 404 e mais nada: nem o caminho, nem o erro do Storage.
    return Response.json({ error: "mídia não encontrada" }, { status: 404 });
  }
  if (!Number.isFinite(tamanho) || tamanho <= 0) {
    return Response.json({ error: "mídia não encontrada" }, { status: 404 });
  }

  const comuns: Record<string, string> = {
    "Content-Type": entrega.contentType,
    "Cache-Control": entrega.cacheControl,
    "Accept-Ranges": "bytes",
    // O tipo é nosso, não do usuário: nada aqui vem de campo preenchido por
    // ninguém. `nosniff` fecha a porta de o navegador decidir outra coisa.
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `inline; filename="${entrega.nomeDoArquivo}"`,
  };

  const intervalo = interpretaRange(entrega.range, tamanho);
  if (intervalo === "invalido") {
    return new Response(null, {
      status: 416,
      headers: { ...comuns, "Content-Range": `bytes */${tamanho}` },
    });
  }

  if (intervalo) {
    const fluxo = arquivo.createReadStream({ start: intervalo.inicio, end: intervalo.fim });
    return new Response(Readable.toWeb(fluxo) as ReadableStream, {
      status: 206,
      headers: {
        ...comuns,
        "Content-Range": `bytes ${intervalo.inicio}-${intervalo.fim}/${tamanho}`,
        "Content-Length": String(intervalo.fim - intervalo.inicio + 1),
      },
    });
  }

  const fluxo = arquivo.createReadStream();
  return new Response(Readable.toWeb(fluxo) as ReadableStream, {
    status: 200,
    headers: { ...comuns, "Content-Length": String(tamanho) },
  });
}

// ——— Limpeza ———
//
// Apagar é sempre BEST-EFFORT, e essa palavra tem consequência: uma falha aqui
// não pode derrubar a operação que a pediu. Perder a chance de remover um
// arquivo antigo é um resíduo; perder a referência do arquivo novo por causa
// disso seria perder a mídia.
//
// O resíduo não precisa de fila nem de job: o caminho de cada frase é um
// PREFIXO, e toda síntese varre o prefixo dela. Um objeto que escapou hoje sai
// na próxima síntese daquela frase — a limpeza se conserta sozinha.

/**
 * O prazo de qualquer limpeza. **Best-effort tem que ter relógio.**
 *
 * A limpeza acontece DENTRO da requisição do cuidador — é o que garante a
 * ordem (a mídia sai antes do documento). Mas um Storage lento, sem
 * credencial ou fora do ar transformaria "apagar um arquivo antigo" em "a
 * edição da frase não responde", e aí o cuidador perde a operação por causa
 * de uma faxina.
 *
 * Passado o prazo, seguimos em frente. O resíduo é o mesmo que qualquer outra
 * falha de limpeza produz, e some pelo mesmo caminho: a varredura por prefixo
 * da próxima síntese daquela frase.
 */
const PRAZO_DE_LIMPEZA_MS = 5_000;

function comPrazo<T>(promessa: Promise<T>, valorSePassar: T): Promise<T> {
  return Promise.race([
    promessa,
    new Promise<T>((resolve) => {
      const id = setTimeout(() => resolve(valorSePassar), PRAZO_DE_LIMPEZA_MS);
      (id as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
}

/** Apaga um objeto. Devolve se conseguiu; nunca lança, nunca pendura. */
export async function apagaObjeto(caminho: string): Promise<boolean> {
  return comPrazo(
    baldeDaHelo()
      .file(caminho)
      .delete({ ignoreNotFound: true })
      .then(() => true)
      .catch(() => false),
    false
  );
}

/** Apaga tudo sob um prefixo, exceto o que for explicitamente preservado. */
export async function apagaPrefixo(
  prefixo: string,
  opcoes?: { exceto?: string }
): Promise<{ apagados: number; falhou: boolean }> {
  return comPrazo(varrePrefixo(prefixo, opcoes), { apagados: 0, falhou: true });
}

async function varrePrefixo(
  prefixo: string,
  opcoes?: { exceto?: string }
): Promise<{ apagados: number; falhou: boolean }> {
  try {
    const [arquivos] = await baldeDaHelo().getFiles({ prefix: prefixo });
    const alvos = arquivos.filter((a) => a.name !== opcoes?.exceto);
    const resultados = await Promise.all(
      alvos.map((a) =>
        a
          .delete({ ignoreNotFound: true })
          .then(() => true)
          .catch(() => false)
      )
    );
    return {
      apagados: resultados.filter(Boolean).length,
      falhou: resultados.some((r) => !r),
    };
  } catch {
    return { apagados: 0, falhou: true };
  }
}
