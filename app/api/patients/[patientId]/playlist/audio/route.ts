import { requirePatientAccess } from "@/lib/auth";
import { firestore } from "@/lib/firestore";
import { caminhoDaFaixa } from "@/lib/playlist";
import { entregaMidia } from "@/lib/midia-privada";

// ——— A música da playlist, sem link público (Fase 5.4B / A-12, R-14) ———
//
// Música não é voz clonada, e a auditoria da 5.4A foi explícita sobre isso:
// ela não pede SpeechGrant e não carrega a identidade sonora de ninguém. Mas
// ela é composta a partir de um pedido do cuidador sobre um paciente, fica na
// playlist dele, e estava atrás de um Firebase download URL — durável, sem
// autenticação, e que ainda por cima voltava à ElevenLabs dentro do resultado
// da tool.
//
// A régua aqui é a mesma da frase: id da faixa, vínculo conferido no servidor,
// caminho resolvido de cá. O que muda é o cabeçalho de cache — ver abaixo.

export async function GET(
  request: Request,
  { params }: { params: Promise<{ patientId: string }> }
) {
  const { patientId: cru } = await params;
  const patientId = Number(cru);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return Response.json({ error: "patientId inválido" }, { status: 400 });
  }
  const id = (new URL(request.url).searchParams.get("id") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(id)) {
    return Response.json({ error: "id obrigatório" }, { status: 400 });
  }

  // Mesma régua da listagem da playlist.
  const auth = await requirePatientAccess(request, patientId, "viewMetrics");
  if (auth instanceof Response) return auth;

  const doc = await firestore
    .collection("patients")
    .doc(String(patientId))
    .collection("playlist")
    .doc(id)
    .get();
  if (!doc.exists) {
    return Response.json({ error: "mídia não encontrada" }, { status: 404 });
  }
  const faixa = caminhoDaFaixa(patientId, doc.data() ?? {});
  if (!faixa) {
    return Response.json({ error: "mídia não encontrada" }, { status: 404 });
  }

  return entregaMidia({
    caminho: faixa.caminho,
    balde: faixa.balde,
    contentType: "audio/mpeg",
    range: request.headers.get("range"),
    // `private` mantém a faixa fora de cache compartilhado; a revalidação
    // obrigatória mantém o controle de acesso vivo a cada uso, porque uma
    // resposta guardada por muito tempo sobreviveria à perda do vínculo.
    //
    // Aqui, ao contrário da voz clonada, o navegador PODE guardar a cópia: uma
    // música tem alguns megabytes, é ouvida inteira, e a barra de progresso
    // pede pedaços do arquivo o tempo todo. `no-store` transformaria cada
    // arrasto do cursor numa nova descida do trecho. É a única diferença de
    // política entre as duas mídias, e ela é sobre tamanho, não sobre sigilo.
    cacheControl: "private, max-age=0, must-revalidate",
    nomeDoArquivo: `musica-${id}.mp3`,
  });
}
