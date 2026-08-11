import { requirePatientAccess } from "@/lib/auth";
import { comPoliticaSemCache, jsonSemCache } from "@/lib/cache-policy";
import { consomeLimite, respostaDeLimite } from "@/lib/rate-limit";
import { SpeechGrantConfigError, issueSpeechGrant } from "@/lib/voice/speech-grant";
import { parseSpeechSource, resolveSpeechSource } from "@/lib/voice/speech-sources";

// Emissão de autorização para a voz do paciente.
//
// O cliente NOMEIA um recurso; o servidor responde qual é o texto daquele
// recurso e emite o grant para ESSE texto. Em nenhum momento o texto a falar
// vem do navegador — é a diferença entre "o servidor confere o que o cliente
// afirmou" e "o servidor é quem afirma".
//
// Devolve o texto canônico junto com o grant de propósito: o cliente precisa
// sintetizar exatamente o que foi autorizado, e receber os dois juntos torna
// impossível uma divergência silenciosa entre o que a tela mostra e o que a
// voz diz.
//
// Não devolve voiceId, não devolve segredo, e a resposta é no-store.

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    patientId?: unknown;
    source?: unknown;
  } | null;

  const patientId = Number(body?.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return jsonSemCache({ error: "patientId obrigatório" }, { status: 400 });
  }

  const source = parseSpeechSource(body?.source);
  if (!source) {
    return jsonSemCache({ error: "origem de fala inválida" }, { status: 400 });
  }

  // Vínculo ativo com ESTE paciente. O patientId do cliente não é confiado:
  // é exatamente o que esta verificação existe para desmentir.
  const auth = await requirePatientAccess(request, patientId);
  if (auth instanceof Response) return comPoliticaSemCache(auth);

  // ——— A-10 ———
  //
  // Emitir um grant não gasta crédito: é um HMAC. O que este limite protege é
  // a TENTATIVA repetida — nomear recursos em sequência para descobrir quais
  // existem, ou moer o portão até achar uma folga. O teto (90/minuto) fica
  // acima do de `/api/tts` de propósito: cada síntese que não vem do cache
  // pede um grant antes, então um limite menor aqui estrangularia o de lá.
  const limite = await consomeLimite("grant", { userId: auth.user.id });
  if (!limite.permitido) return respostaDeLimite(limite);

  const resolved = await resolveSpeechSource(patientId, source);
  if (!resolved.ok) {
    return jsonSemCache({ error: resolved.error }, { status: resolved.status });
  }

  // Configuração inválida vira 503 e um log no servidor. O cliente recebe uma
  // indisponibilidade genérica: o motivo detalhado é para quem opera, e nada
  // do segredo aparece em nenhum dos dois lados.
  let issued: { grant: string; expiresAt: number };
  try {
    issued = issueSpeechGrant({
      patientId,
      text: resolved.text,
      origin: resolved.origin,
    });
  } catch (caught) {
    if (caught instanceof SpeechGrantConfigError) {
      console.error("[VOZ] SpeechGrant indisponível:", caught.message);
      return jsonSemCache({ error: "voz do paciente indisponível" }, { status: 503 });
    }
    throw caught;
  }
  const { grant, expiresAt } = issued;

  return jsonSemCache({ grant, text: resolved.text, origin: resolved.origin, expiresAt });
}
