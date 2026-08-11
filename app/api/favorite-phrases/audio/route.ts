import { requirePatientAccess } from "@/lib/auth";
import { comPoliticaSemCache, jsonSemCache } from "@/lib/cache-policy";
import { resolveFavoritePhraseAudio } from "@/lib/favorite-phrases";
import { entregaMidia } from "@/lib/midia-privada";

// ——— O áudio da frase, entregue por quem sabe perguntar (Fase 5.4B / R-04) ———
//
// Esta rota substitui um Firebase download URL. A diferença entre as duas
// coisas é a pergunta que cada uma faz antes de entregar o áudio:
//
//   a URL antiga perguntava  "você tem o token?"
//   esta rota pergunta       "quem é você, e você alcança este paciente?"
//
// A primeira pergunta é respondida por qualquer pessoa que já tenha visto o
// link — inclusive depois de perder o acesso ao paciente, inclusive fora da
// Helo, para sempre. A segunda é respondida pelo servidor, agora, contra o
// vínculo que vale agora.
//
// ——— Endereçamento ———
//
// O cliente manda `patientId` e `phraseId`. Não manda caminho, e a rota não
// aceitaria: quem traduz id em caminho é `resolveFavoritePhraseAudio`, do lado
// de cá. É o padrão que `/api/media` já usa e que a auditoria da 5.4A apontou
// como o certo — sem caminho vindo de fora, não há travessia de diretório a
// defender.
//
// O vínculo com o paciente é estrutural em três camadas: o `requirePatientAccess`
// confere o acesso, o documento vive sob o paciente, e o caminho ainda é
// conferido contra o namespace dele. Pedir a frase de A informando o paciente B
// não encontra documento nenhum — 404, sem um byte.
//
// ——— SpeechGrant ———
//
// Não é pedido aqui, e não deve ser. O grant autoriza a SÍNTESE — o momento em
// que um texto vira voz do paciente —, e essa autorização já aconteceu quando
// a frase foi salva e pré-sintetizada. Reproduzir mídia legitimamente criada é
// outra operação, e a régua dela é autenticação mais vínculo. O que a 5.4B
// fechou não foi a falta de grant no playback: foi o playback ANÔNIMO.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const patientId = Number(url.searchParams.get("patientId"));
  const phraseId = (url.searchParams.get("phraseId") ?? "").trim();

  if (!Number.isInteger(patientId) || patientId <= 0) {
    return jsonSemCache({ error: "patientId obrigatório" }, { status: 400 });
  }
  // Ids do Firestore são alfanuméricos. Recusar o resto aqui é barato e evita
  // que uma string estranha chegue a virar caminho de documento.
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(phraseId)) {
    return jsonSemCache({ error: "phraseId obrigatório" }, { status: 400 });
  }

  // Mesma régua da leitura da frase em si: ver as frases do paciente.
  const auth = await requirePatientAccess(request, patientId, "viewActivities");
  if (auth instanceof Response) return comPoliticaSemCache(auth);

  const caminho = await resolveFavoritePhraseAudio(patientId, phraseId);
  if (!caminho) {
    // Um só código para "a frase não existe", "ela não tem áudio" e "o caminho
    // guardado não pertence a este paciente". A distinção não interessa a quem
    // pergunta, e distinguir contaria o que existe do outro lado.
    return jsonSemCache({ error: "mídia não encontrada" }, { status: 404 });
  }

  return entregaMidia({
    caminho,
    contentType: "audio/mpeg",
    range: request.headers.get("range"),
    // A voz clonada do paciente é o dado mais sensível que o Helo produz.
    // `private` mantém a resposta fora de qualquer cache compartilhado;
    // `no-store` a mantém fora do disco de quem ouviu. O custo é uma
    // requisição por reprodução — e o áudio já está pré-sintetizado, que era
    // exatamente o motivo de mantê-lo pré-sintetizado.
    cacheControl: "private, no-store",
    nomeDoArquivo: `frase-${phraseId}.mp3`,
  });
}
