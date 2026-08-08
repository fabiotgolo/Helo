// ——— SpeechGrant: a autorização para a voz do paciente ———
//
// O problema que este módulo existe para resolver (R-01 da auditoria 5.0):
// até aqui, `/api/tts` decidia se podia usar a voz clonada do paciente lendo
// dois campos do CORPO DA REQUISIÇÃO — `speakerRole` e `confirmationStatus`.
// A verificação acontecia no servidor, mas a VERDADE vinha do cliente. Quem
// pedia a fala também declarava que ela estava autorizada.
//
// A partir daqui vale o invariante:
//
//   NENHUM CLIENTE DECLARA SOZINHO QUE UM TEXTO É FALA DO PACIENTE.
//
// Um grant é emitido SOMENTE pelo servidor, a partir de uma origem que o
// próprio servidor resolveu (ver `speech-sources.ts`), e carrega o hash do
// texto que ele autorizou. O cliente não escolhe o texto: ele nomeia um
// RECURSO, e o servidor responde qual é o texto daquele recurso.
//
// ——— O que um grant prova, e o que ele não prova ———
//
// PROVA: que este texto exato, para este paciente exato, veio de uma origem
// legítima e continua dentro da validade. Texto arbitrário não passa.
//
// NÃO PROVA: que um humano tocou a tela. A confirmação por gesto acontece
// inteiramente no cliente em todos os fluxos de hoje, e nenhum deles persiste
// o gesto ANTES de falar. Essa lacuna é conhecida, está registrada na
// auditoria, e a outra metade dela é fechada pelo gate de origem do Agent
// (R-02): o texto vem do servidor, e o toque só pode vir de humano.
//
// Não afirme, em código ou comentário, que um grant é prova de consentimento.
// Ele é prova de PROCEDÊNCIA.
//
// ——— Forma ———
//
// `hg1.<payload base64url>.<assinatura base64url>` — opaco para o cliente,
// que nunca o interpreta. Assinado com HMAC-SHA256. Sem estado no servidor:
// um registro em banco custaria uma escrita por fala, e a Emergência não pode
// ficar mais lenta para provar o que uma assinatura já prova.
//
// O grant NÃO contém: segredo da ElevenLabs, voiceId técnico, o texto em
// claro, dado clínico. Só o hash do texto, o paciente, a origem e o prazo.

import { createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";

/** Origens que podem autorizar a voz do paciente. Fechada por construção. */
export type SpeechGrantOrigin =
  | "routineAnswer"
  | "emergencyItem"
  | "activityResponse"
  | "favoritePhrase"
  | "confirmedMessage"
  | "patientVoicePreview";

export const SPEECH_GRANT_ORIGINS: readonly SpeechGrantOrigin[] = [
  "routineAnswer",
  "emergencyItem",
  "activityResponse",
  "favoritePhrase",
  "confirmedMessage",
  "patientVoicePreview",
] as const;

/**
 * Validade. Curta de propósito: um grant existe para atravessar a distância
 * entre "o servidor autorizou" e "o áudio começou", que é de milissegundos.
 * Dois minutos absorvem rede ruim sem virar uma credencial reutilizável.
 */
export const SPEECH_GRANT_TTL_MS = 120_000;

export interface SpeechGrantClaims {
  patientId: number;
  /** SHA-256 do texto autorizado, em hex. O texto em claro nunca viaja aqui. */
  textHash: string;
  origin: SpeechGrantOrigin;
  /** Epoch ms. */
  expiresAt: number;
}

export type SpeechGrantRejection =
  | "missing"
  | "malformed"
  | "badSignature"
  | "expired"
  | "patientMismatch"
  | "textMismatch";

export type SpeechGrantVerdict =
  | { ok: true; claims: SpeechGrantClaims }
  | { ok: false; reason: SpeechGrantRejection };

// ——— Chave de assinatura ———
//
// `HELO_SPEECH_GRANT_SECRET` quando existir. Sem ela, uma chave aleatória por
// PROCESSO — guardada em globalThis para sobreviver ao hot reload do `next
// dev`, que recarrega módulos sem reiniciar o processo.
//
// O fallback é seguro e é a razão de esta fase não exigir configuração nova:
// o App Hosting roda com `maxInstances: 1`, então emissão e verificação
// acontecem no mesmo processo. Ao escalar para mais de uma instância, defina
// a variável — sem ela, um grant emitido por uma instância seria recusado por
// outra. A falha, nesse caso, é FECHADA (403 e o cliente repete), nunca
// aberta.
const GRANT_SECRET_KEY = "__heloSpeechGrantSecret";

function secret(): Buffer {
  const configured = process.env.HELO_SPEECH_GRANT_SECRET?.trim();
  if (configured) return Buffer.from(configured, "utf8");
  const store = globalThis as unknown as Record<string, Buffer | undefined>;
  if (!store[GRANT_SECRET_KEY]) store[GRANT_SECRET_KEY] = randomBytes(32);
  return store[GRANT_SECRET_KEY]!;
}

/**
 * Normaliza antes de derivar o hash. Sem isto, um espaço a mais devolvido por
 * uma origem — ou um `\r\n` vindo do Firestore — recusaria uma fala legítima,
 * e o defeito apareceria como "a voz do paciente parou de funcionar".
 */
export function canonicalSpeechText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function speechTextHash(text: string): string {
  return createHash("sha256").update(canonicalSpeechText(text), "utf8").digest("hex");
}

function b64url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(payload: string): string {
  return b64url(createHmac("sha256", secret()).update(payload, "utf8").digest());
}

/**
 * Emite o grant. `text` é o texto que o SERVIDOR resolveu — nunca o que o
 * cliente pediu para falar.
 */
export function issueSpeechGrant(input: {
  patientId: number;
  text: string;
  origin: SpeechGrantOrigin;
  now?: number;
}): { grant: string; expiresAt: number } {
  const now = input.now ?? Date.now();
  const claims: SpeechGrantClaims = {
    patientId: input.patientId,
    textHash: speechTextHash(input.text),
    origin: input.origin,
    expiresAt: now + SPEECH_GRANT_TTL_MS,
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return { grant: `hg1.${payload}.${sign(payload)}`, expiresAt: claims.expiresAt };
}

function parseClaims(value: unknown): SpeechGrantClaims | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (!Number.isInteger(c.patientId) || (c.patientId as number) <= 0) return null;
  if (typeof c.textHash !== "string" || !/^[a-f0-9]{64}$/.test(c.textHash)) return null;
  if (!SPEECH_GRANT_ORIGINS.includes(c.origin as SpeechGrantOrigin)) return null;
  if (typeof c.expiresAt !== "number" || !Number.isFinite(c.expiresAt)) return null;
  return {
    patientId: c.patientId as number,
    textHash: c.textHash,
    origin: c.origin as SpeechGrantOrigin,
    expiresAt: c.expiresAt,
  };
}

/**
 * Verifica o grant contra o que está SENDO PEDIDO agora. A assinatura é
 * conferida antes de qualquer leitura do conteúdo — um payload adulterado não
 * chega a ser interpretado.
 *
 * A ordem das recusas importa para o diagnóstico, não para a segurança: todas
 * devolvem 403 para quem chama.
 */
export function verifySpeechGrant(
  grant: unknown,
  expected: { patientId: number; text: string; now?: number }
): SpeechGrantVerdict {
  if (typeof grant !== "string" || !grant) return { ok: false, reason: "missing" };
  const parts = grant.split(".");
  if (parts.length !== 3 || parts[0] !== "hg1") return { ok: false, reason: "malformed" };
  const [, payload, signature] = parts;

  // Comparação em tempo constante. Buffers de tamanhos diferentes fazem
  // `timingSafeEqual` lançar, então o tamanho é conferido antes.
  const expectedSig = fromB64url(sign(payload));
  const providedSig = fromB64url(signature);
  if (
    expectedSig.length !== providedSig.length ||
    !timingSafeEqual(expectedSig, providedSig)
  ) {
    return { ok: false, reason: "badSignature" };
  }

  let claims: SpeechGrantClaims | null = null;
  try {
    claims = parseClaims(JSON.parse(fromB64url(payload).toString("utf8")));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!claims) return { ok: false, reason: "malformed" };

  const now = expected.now ?? Date.now();
  if (claims.expiresAt <= now) return { ok: false, reason: "expired" };
  if (claims.patientId !== expected.patientId) return { ok: false, reason: "patientMismatch" };
  if (claims.textHash !== speechTextHash(expected.text)) {
    return { ok: false, reason: "textMismatch" };
  }
  return { ok: true, claims };
}
