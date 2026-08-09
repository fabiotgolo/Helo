// ——— O que o arquivo É, não o que ele diz ser ———
//
// A Fase 5.2A conferia o `Content-Type` que o navegador declarou no multipart e
// deixava passar. Está registrado lá como limitação, e é esta: o `Content-Type`
// de uma parte de multipart é texto escrito pelo cliente. Um cliente que não
// seja o Helo escreve `audio/webm` e manda o que quiser — e o que ele mandar
// segue para a ElevenLabs com a chave do Helo, contando como uso e podendo ser
// qualquer coisa menos a voz de um cuidador.
//
// Aqui olhamos os primeiros bytes. Não é um parser de mídia e não deve virar
// um: não lemos duração, faixas, codec nem metadados — nada que exija percorrer
// o arquivo, e nada que crie uma superfície nova para entrada hostil. Lemos a
// assinatura do contêiner, que ocupa oito bytes, e exigimos que ela combine com
// o tipo declarado.
//
// A coerência importa tanto quanto a detecção. Um WebM válido enviado como
// `audio/mp4` não é um engano de navegador — é alguém tentando descobrir de
// qual dos dois lados o Helo decide. Os dois têm de concordar, ou não passa.
//
// O `filename` continua sem ser consultado em lugar nenhum. Nunca foi
// evidência de nada.

import type { TipoDeAudio } from "@/lib/voice/dictation";

export type ContainerDeAudio = "webm" | "ogg" | "mp4";

/** Bytes suficientes para decidir. Nenhum caminho aqui lê além disso. */
export const BYTES_DE_ASSINATURA = 12;

function comeca(bytes: Uint8Array, assinatura: readonly number[], deslocamento = 0): boolean {
  if (bytes.length < deslocamento + assinatura.length) return false;
  for (let i = 0; i < assinatura.length; i++) {
    if (bytes[deslocamento + i] !== assinatura[i]) return false;
  }
  return true;
}

// EBML — a cabeça de todo Matroska, e WebM é um perfil de Matroska. Chrome,
// Edge e Firefox produzem isto para `audio/webm`.
const EBML = [0x1a, 0x45, 0xdf, 0xa3] as const;
// "OggS" — a cabeça de toda página Ogg. Firefox, para `audio/ogg`.
const OGGS = [0x4f, 0x67, 0x67, 0x53] as const;
// "ftyp" no byte 4: ISO-BMFF (MP4, M4A). Safari, para `audio/mp4`. Os quatro
// primeiros bytes são o tamanho da caixa e variam — por isso o deslocamento.
const FTYP = [0x66, 0x74, 0x79, 0x70] as const;

/**
 * O contêiner que estes bytes realmente são, ou `null`.
 *
 * Nunca lança e nunca é ambíguo: as três assinaturas não se confundem entre si
 * — duas estão no byte 0 e são diferentes, a terceira está no byte 4.
 */
export function detectaContainer(bytes: Uint8Array): ContainerDeAudio | null {
  if (comeca(bytes, EBML)) return "webm";
  if (comeca(bytes, OGGS)) return "ogg";
  if (comeca(bytes, FTYP, 4)) return "mp4";
  return null;
}

/**
 * O único par válido de cada tipo declarado.
 *
 * Deliberadamente rígido. Seria tentador aceitar EBML sob `audio/ogg` — os dois
 * carregam Opus, o provedor engoliria — mas aceitar significa que a declaração
 * do cliente deixou de valer alguma coisa, e ela é metade da conferência.
 */
const CONTAINER_DO_TIPO: Record<TipoDeAudio, ContainerDeAudio> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
};

export function containerCombinaComTipo(
  container: ContainerDeAudio,
  tipo: TipoDeAudio
): boolean {
  return CONTAINER_DO_TIPO[tipo] === container;
}

export type VeredictoDoContainer =
  | { ok: true; container: ContainerDeAudio }
  /** Bytes que não são nenhum contêiner conhecido — ou curtos demais para ser. */
  | { ok: false; motivo: "desconhecido" }
  /** É um contêiner conhecido, mas não o que o cliente declarou. */
  | { ok: false; motivo: "incoerente"; container: ContainerDeAudio };

/**
 * O veredicto completo: detecta e confere contra o tipo declarado.
 *
 * Os dois motivos de recusa levam à mesma resposta HTTP e à mesma frase para o
 * cuidador. Existem separados para o log do servidor: "desconhecido" é quase
 * sempre um navegador que produziu algo que não previmos; "incoerente" é quase
 * sempre alguém testando o endpoint. Distinguir os dois é a diferença entre
 * corrigir um suporte de navegador e olhar para um cliente.
 */
export function verificaContainer(
  bytes: Uint8Array,
  tipoDeclarado: TipoDeAudio
): VeredictoDoContainer {
  const container = detectaContainer(bytes);
  if (container === null) return { ok: false, motivo: "desconhecido" };
  if (!containerCombinaComTipo(container, tipoDeclarado)) {
    return { ok: false, motivo: "incoerente", container };
  }
  return { ok: true, container };
}
