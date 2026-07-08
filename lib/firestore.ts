import { initializeApp, getApps, applicationDefault } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

// ID do projeto Firebase. Em produção (App Hosting) as credenciais vêm
// automaticamente da conta de serviço do runtime (ADC). Localmente, use o
// emulador do Firestore ou GOOGLE_APPLICATION_CREDENTIALS.
const PROJECT_ID =
  process.env.GCLOUD_PROJECT ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  process.env.FIREBASE_PROJECT_ID ??
  "helo-app-7fbf8";

// O banco Firestore da Helo é nomeado "helo-db" (não o "(default)"). O SDK
// precisa apontar explicitamente para ele, senão retorna 5 NOT_FOUND.
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID ?? "helo-db";

// Singleton compatível com o hot-reload do dev server.
const globalForDb = globalThis as unknown as { __heloFs?: Firestore };

function createFirestore(): Firestore {
  const useEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  if (getApps().length === 0) {
    initializeApp({
      projectId: PROJECT_ID,
      // Com o emulador (dev) não há credencial a resolver. Em produção o App
      // Hosting fornece a conta de serviço do runtime via ADC.
      ...(useEmulator ? {} : { credential: applicationDefault() }),
    });
  }
  const fs = getFirestore(DATABASE_ID);
  fs.settings({ ignoreUndefinedProperties: true });
  return fs;
}

export const firestore: Firestore = globalForDb.__heloFs ?? createFirestore();
globalForDb.__heloFs = firestore;
