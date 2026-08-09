import { requirePatientAccess, requireUser } from "@/lib/auth";
import { TAMANHO_MAXIMO_BYTES, tipoDeAudioAceito } from "@/lib/voice/dictation";
import { ditadoDisponivel, transcreve } from "@/lib/voice/dictation-server";
import { statusParaCliente } from "@/lib/voice/eleven-fetch";

// ——— Ditado do cuidador: áudio entra, texto sai, nada fica ———
//
// O único ponto do Helo por onde áudio de microfone passa. Ele existe para ser
// o gargalo: enquanto o navegador não falar direto com a ElevenLabs, todas as
// exigências da fase são implementáveis num lugar só — autenticação, vínculo
// com o paciente, flag, tipo, tamanho, prazo e retenção zero.
//
// O que este handler devolve é uma STRING. Não devolve identificador do
// provedor, não devolve grant, não cria registro, não toca em sessão nem em
// turno. O texto vai para um campo de formulário e para de existir se o
// cuidador não apertar o botão que já existia.
//
// ——— Ordem das verificações, e por que ela é essa ———
//
// O `patientId` vem num CABEÇALHO, não no corpo. Assim a autorização acontece
// antes de o corpo ser lido: com o ditado desligado, ou sem vínculo com o
// paciente, o áudio nem chega a ser desserializado — quanto mais enviado a
// alguém. É a diferença entre "recusamos depois de receber" e "não recebemos".

/** O cliente pergunta se o recurso existe para ele. Recebe um booleano. */
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof Response) return auth;
  // Estado DERIVADO. Nem a flag, nem a presença da chave, nem o plano do
  // workspace atravessam esta resposta.
  return Response.json(
    { available: ditadoDisponivel() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

function recusa(status: number, error: string, reason: string) {
  return Response.json({ error, reason }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const patientId = Number(request.headers.get("x-helo-patient-id"));
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return recusa(400, "patientId obrigatório", "patientId");
  }

  const auth = await requirePatientAccess(request, patientId);
  if (auth instanceof Response) return auth;

  // Fail-closed, e antes do corpo. Enquanto o workspace da ElevenLabs não
  // suportar retenção zero, é aqui que a Fase 5.2A para em produção — sem
  // chamada, sem crédito gasto, sem áudio guardado para tentar depois.
  if (!ditadoDisponivel()) {
    return recusa(503, "ditado indisponível", "desabilitado");
  }

  // Pré-conferência barata: o `Content-Length` é do cliente e não se confia
  // nele, mas quando ele já se declara grande demais não há motivo para
  // desserializar o multipart inteiro antes de recusar.
  const declarado = Number(request.headers.get("content-length"));
  if (Number.isFinite(declarado) && declarado > TAMANHO_MAXIMO_BYTES * 2) {
    return recusa(413, "áudio longo demais", "tamanho");
  }

  let audio: File | null = null;
  try {
    const form = await request.formData();
    const campo = form.get("audio");
    audio = campo instanceof File ? campo : null;
  } catch {
    return recusa(400, "envio inválido", "corpo");
  }
  if (!audio) return recusa(400, "áudio obrigatório", "corpo");

  // O `type` é o que o navegador declarou; o `name` é o que o cliente
  // escolheu. Conferimos o primeiro contra a allowlist e ignoramos o segundo
  // por completo — um nome de arquivo nunca foi evidência de formato.
  if (!tipoDeAudioAceito(audio.type)) {
    return recusa(415, "formato de áudio não suportado", "formato");
  }
  // O tamanho REAL, agora que ele é conhecido. Independente do cronômetro de
  // 60s, que vive no navegador e por isso não conta como garantia.
  if (audio.size > TAMANHO_MAXIMO_BYTES) {
    return recusa(413, "áudio longo demais", "tamanho");
  }
  if (audio.size === 0) return recusa(400, "áudio vazio", "corpo");

  const resultado = await transcreve(audio);
  if (!resultado.ok) {
    // A categoria já foi registrada com status e rótulo em
    // `chamaElevenLabsJson`. O cuidador recebe indisponibilidade e mais nada:
    // nem status do provedor, nem motivo da recusa, nem plano do workspace.
    return recusa(
      statusParaCliente(resultado.falha),
      "não foi possível transcrever",
      "provedor"
    );
  }

  // `transcript` pode vir vazio: o provedor ouviu silêncio. Quem trata isso é
  // a interface, que não altera o campo.
  return Response.json(
    { transcript: resultado.transcript },
    { headers: { "Cache-Control": "no-store" } }
  );
}
