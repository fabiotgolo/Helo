import { firestore } from "@/lib/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

export type FavoritePhrase = {
  id: string;
  text: string;
  category: string | null;
  createdAt: string;
  audioUrl: string | null;
  usesClonedVoice: boolean;
};

const phrases = (patientId: number) =>
  firestore.collection("patients").doc(String(patientId)).collection("favoritePhrases");

function phraseFrom(id: string, value: FirebaseFirestore.DocumentData): FavoritePhrase {
  return {
    id,
    text: String(value.text ?? ""),
    category: value.category ? String(value.category) : null,
    createdAt: value.createdAt?.toDate?.().toISOString?.() ?? String(value.createdAt ?? ""),
    audioUrl: value.audioUrl ? String(value.audioUrl) : null,
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
    audioUrl: null,
    usesClonedVoice: false,
  });
  return { id: ref.id, text, category: input.category?.trim() || null, createdAt: createdAt.toDate().toISOString(), audioUrl: null, usesClonedVoice: false };
}

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
  await ref.set({
    text,
    category: input.category?.trim() || null,
    audioUrl: null,
    storagePath: null,
    usesClonedVoice: false,
    updatedAt: Timestamp.now(),
  }, { merge: true });
  return phraseFrom(phraseId, (await ref.get()).data()!);
}

export async function deleteFavoritePhrase(patientId: number, phraseId: string): Promise<void> {
  if (!phraseId) throw new Error("Frase não encontrada.");
  const ref = phrases(patientId).doc(phraseId);
  const existing = await ref.get();
  if (!existing.exists) throw new Error("Frase não encontrada.");
  const storagePath = existing.data()?.storagePath;
  if (typeof storagePath === "string" && storagePath) {
    await getStorage().bucket().file(storagePath).delete({ ignoreNotFound: true });
  }
  await ref.delete();
}
