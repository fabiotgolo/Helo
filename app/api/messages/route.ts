import { insertMessage } from "@/lib/store";
import { requirePatientAccess } from "@/lib/auth";
import { issueSpeechGrant } from "@/lib/voice/speech-grant";
import type { HeloMessage } from "@/lib/types";

// Registrar comunicação exige vínculo com createSession no paciente.
//
// Quando a mensagem registrada É uma fala confirmada do paciente, a resposta
// já traz o SpeechGrant correspondente. Isso não é um atalho: é a ordem
// correta — o registro autoritativo passa a existir ANTES da voz, e o grant
// atesta o texto que o servidor acabou de gravar, não o que o cliente quer
// falar. Evita também um segundo ida-e-volta entre confirmar e falar, que na
// Conversa apareceria como atraso entre o gesto e a voz.
export async function POST(request: Request) {
  const m = (await request.json()) as HeloMessage;
  if (!m.text || !m.status) {
    return Response.json({ error: "text e status obrigatórios" }, { status: 400 });
  }
  const patientId = Number(m.patientId);
  const auth = await requirePatientAccess(request, patientId, "createSession");
  if (auth instanceof Response) return auth;
  const id = await insertMessage(m);

  // Só fala CONFIRMADA do paciente autoriza voz. "descartada" e falas da
  // plataforma saem daqui sem grant — e sem grant não há voz do paciente.
  const isConfirmedPatientSpeech =
    m.status === "confirmada" &&
    (m.speakerRole ?? "patient") === "patient" &&
    m.confirmationStatus !== "rejected";

  if (!isConfirmedPatientSpeech) return Response.json({ id });

  const { grant, expiresAt } = issueSpeechGrant({
    patientId,
    text: m.text,
    origin: "confirmedMessage",
  });
  return Response.json(
    { id, grant, expiresAt },
    { headers: { "Cache-Control": "no-store" } }
  );
}
