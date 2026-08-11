import { firestore } from "@/lib/firestore";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import {
  apagaObjeto,
  apagaPrefixo,
  caminhoDeFraseEhValido,
  prefixoDeAudioDaFrase,
} from "@/lib/midia-privada";

// ——— O áudio da frase deixou de ser um endereço (Fase 5.4B) ———
//
// `audioUrl` saiu do tipo, e a mudança não é cosmética. Ele guardava um
// Firebase download URL — token embutido, sem prazo, funcionando fora da Helo
// — e esse campo viajava até o navegador, que pedia o MP3 direto ao Storage.
// A voz clonada do paciente ficava a um link de distância de qualquer pessoa
// que já tivesse visto a tela uma vez.
//
// O que o cliente recebe agora é um booleano: `hasAudio`. Ele diz se vale a
// pena pedir os bytes à rota autenticada — e não diz onde eles estão, porque o
// cliente não precisa saber e não deve poder contar a ninguém.
//
// O caminho real fica em `audioStoragePath`, que **nunca** sai daqui para
// fora do servidor.

export type FavoritePhrase = {
  id: string;
  text: string;
  category: string | null;
  createdAt: string;
  /**
   * Existe áudio pré-sintetizado para esta frase?
   *
   * Substitui o antigo `audioUrl`. Quando `false`, a tela sintetiza na hora
   * pelo caminho do SpeechGrant — que continua sendo o mesmo de sempre.
   */
  hasAudio: boolean;
  usesClonedVoice: boolean;
};

const phrases = (patientId: number) =>
  firestore.collection("patients").doc(String(patientId)).collection("favoritePhrases");

/**
 * O caminho do objeto desta frase, do jeito que o servidor o enxerga.
 *
 * Aceita o campo novo (`audioStoragePath`) e o legado (`storagePath`, gravado
 * pela Function antes da 5.4B). Aceitar o legado é o que faz o áudio já
 * sintetizado continuar tocando pela rota autenticada desde o primeiro
 * instante — sem esperar migração, e sem que o navegador volte a ver uma URL
 * pública. O que a migração faz é matar a URL antiga; a leitura já está
 * fechada aqui.
 */
function caminhoDoAudio(dados: FirebaseFirestore.DocumentData | undefined): string | null {
  const novo = dados?.audioStoragePath;
  if (typeof novo === "string" && novo) return novo;
  const legado = dados?.storagePath;
  if (typeof legado === "string" && legado) return legado;
  return null;
}

function phraseFrom(id: string, value: FirebaseFirestore.DocumentData): FavoritePhrase {
  return {
    id,
    text: String(value.text ?? ""),
    category: value.category ? String(value.category) : null,
    createdAt: value.createdAt?.toDate?.().toISOString?.() ?? String(value.createdAt ?? ""),
    hasAudio: Boolean(caminhoDoAudio(value)),
    usesClonedVoice: value.usesClonedVoice === true,
  };
}

export async function listFavoritePhrases(patientId: number): Promise<FavoritePhrase[]> {
  const snap = await phrases(patientId).get();
  return snap.docs
    .map((doc) => phraseFrom(doc.id, doc.data()))
    .filter((phrase) => phrase.text)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Onde estão os bytes desta frase — resolvido pelo SERVIDOR, a partir do id.
 *
 * O cliente nomeia `patientId` + `phraseId`; quem traduz isso num caminho é
 * esta função. Nenhum caminho atravessa a fronteira do navegador em nenhuma
 * direção, e por isso não existe travessia de diretório a defender: o caminho
 * nunca vem de fora. A conferência de prefixo é a segunda tranca, para o caso
 * de um documento com caminho estragado.
 */
export async function resolveFavoritePhraseAudio(
  patientId: number,
  phraseId: string
): Promise<string | null> {
  if (!phraseId) return null;
  const doc = await phrases(patientId).doc(phraseId).get();
  if (!doc.exists) return null;
  const caminho = caminhoDoAudio(doc.data());
  if (!caminho || !caminhoDeFraseEhValido(caminho, patientId)) return null;
  return caminho;
}

export async function createFavoritePhrase(
  patientId: number,
  input: { text: string; category?: string | null }
): Promise<FavoritePhrase> {
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text || text.length > 500) throw new Error("A frase deve ter entre 1 e 500 caracteres.");
  const ref = phrases(patientId).doc();
  const createdAt = Timestamp.now();
  await ref.set({
    id: ref.id,
    text,
    category: input.category?.trim() || null,
    createdAt,
    usesClonedVoice: false,
  });
  return {
    id: ref.id,
    text,
    category: input.category?.trim() || null,
    createdAt: createdAt.toDate().toISOString(),
    hasAudio: false,
    usesClonedVoice: false,
  };
}

/**
 * Editar o texto invalida o áudio — e aqui a ordem do §16 se inverte de
 * propósito.
 *
 * O princípio geral é "preserve a mídia antiga até a nova estar pronta". Ele
 * vale para uma RE-SÍNTESE do mesmo texto, e é assim que a Function trabalha:
 * o objeto novo nasce sob outro id e só depois a referência troca.
 *
 * Para uma edição de TEXTO, seguir o mesmo princípio seria manter tocável um
 * áudio que diz outra coisa. A mídia antiga não é "a versão anterior" — ela é,
 * por construção, a frase errada, na voz do paciente. Preservá-la seria
 * preservar um defeito.
 *
 * Os invariantes que importam continuam de pé: o documento não fica apontando
 * para objeto inexistente (a referência sai junto), nenhum objeto novo nasce
 * órfão (nenhum nasce aqui), e o que a limpeza não conseguir apagar sai na
 * varredura da próxima síntese desta mesma frase.
 */
export async function updateFavoritePhrase(
  patientId: number,
  phraseId: string,
  input: { text: string; category?: string | null }
): Promise<FavoritePhrase> {
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!phraseId || !text || text.length > 500) {
    throw new Error("A frase deve ter entre 1 e 500 caracteres.");
  }
  const ref = phrases(patientId).doc(phraseId);
  const existing = await ref.get();
  if (!existing.exists) throw new Error("Frase não encontrada.");
  await ref.set(
    {
      text,
      category: input.category?.trim() || null,
      usesClonedVoice: false,
      updatedAt: Timestamp.now(),
      audioStoragePath: FieldValue.delete(),
      audioId: FieldValue.delete(),
      // Campos do schema anterior. Um documento tocado pela 5.4B sai daqui sem
      // URL pública guardada, mesmo que tivesse uma.
      audioUrl: FieldValue.delete(),
      storagePath: FieldValue.delete(),
    },
    { merge: true }
  );
  await descartaMidiaDaFrase(patientId, phraseId, existing.data());
  return phraseFrom(phraseId, (await ref.get()).data()!);
}

export async function deleteFavoritePhrase(patientId: number, phraseId: string): Promise<void> {
  if (!phraseId) throw new Error("Frase não encontrada.");
  const ref = phrases(patientId).doc(phraseId);
  const existing = await ref.get();
  if (!existing.exists) throw new Error("Frase não encontrada.");
  // O áudio morre com a frase. A limpeza vem ANTES da exclusão do documento:
  // se ela falhar, o documento ainda existe e a próxima tentativa alcança o
  // arquivo. Apagar o documento primeiro seria perder o único ponteiro para
  // um MP3 na voz do paciente.
  await descartaMidiaDaFrase(patientId, phraseId, existing.data(), { varreSempre: true });
  await ref.delete();
}

/**
 * Remove todo o áudio desta frase — a geração atual, as anteriores e o
 * caminho legado, que fica fora do prefixo e por isso precisa ser nomeado.
 *
 * BEST-EFFORT por definição: uma falha do Storage não pode derrubar a edição
 * ou a exclusão que a pediu. O resíduo é detectável (é tudo que sobra sob o
 * prefixo da frase) e some na varredura da próxima síntese.
 */
async function descartaMidiaDaFrase(
  patientId: number,
  phraseId: string,
  dados: FirebaseFirestore.DocumentData | undefined,
  opcoes?: { varreSempre?: boolean }
): Promise<void> {
  // ——— Não bater no Storage à toa ———
  //
  // A esmagadora maioria das frases nunca teve áudio pré-sintetizado, e
  // varrer um prefixo vazio custa uma ida à rede DENTRO da requisição do
  // cuidador. Sem isto, editar uma frase que nunca foi sintetizada pagava o
  // preço de uma faxina que não tinha o que limpar — e num ambiente sem
  // credencial de Storage (o do E2E) isso pendurava a edição inteira.
  //
  // A exclusão varre de qualquer forma: ela é rara, é final, e é a última
  // chance de alcançar um resíduo que tenha sobrado de uma limpeza anterior
  // malsucedida.
  if (!opcoes?.varreSempre && !dados?.audioStoragePath && !dados?.storagePath) return;

  await apagaPrefixo(prefixoDeAudioDaFrase(patientId, phraseId));
  const legado = dados?.storagePath;
  if (typeof legado === "string" && legado && caminhoDeFraseEhValido(legado, patientId)) {
    await apagaObjeto(legado);
  }
}

/**
 * A voz do paciente mudou: o que foi pré-sintetizado com a voz anterior deixa
 * de valer (Fase 5.4B, §19).
 *
 * A política é a mais simples que é coerente com o produto: **invalidar**. Não
 * regenerar (seria trabalho pago sem ninguém ter pedido), não marcar como
 * "desatualizado" (seria um estado novo na interface), não deixar tocando
 * (seria a voz errada dizendo a frase certa). Sem áudio pré-sintetizado, a
 * tela cai no caminho que já existia: pede o grant e sintetiza na hora, com a
 * voz que vale AGORA. Nada muda para quem usa.
 *
 * Devolve quantas frases perderam o áudio — número, nunca texto.
 */
export async function invalidateFavoritePhraseAudio(patientId: number): Promise<number> {
  const snap = await phrases(patientId).get();
  let invalidadas = 0;
  for (const doc of snap.docs) {
    if (!caminhoDoAudio(doc.data())) continue;
    await doc.ref.set(
      {
        usesClonedVoice: false,
        audioStoragePath: FieldValue.delete(),
        audioId: FieldValue.delete(),
        audioUrl: FieldValue.delete(),
        storagePath: FieldValue.delete(),
      },
      { merge: true }
    );
    await descartaMidiaDaFrase(patientId, doc.id, doc.data());
    invalidadas += 1;
  }
  return invalidadas;
}
