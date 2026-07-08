import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// Singleton compatível com hot-reload do dev server
const globalForDb = globalThis as unknown as { __heloDb?: Database.Database };

function createDb(): Database.Database {
  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "helo.db"));
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      ended_at TEXT,
      operator TEXT,
      mode TEXT NOT NULL DEFAULT 'conversa'
    );

    -- Autoria protegida: cada passo da interação fica registrado —
    -- o que foi apresentado, qual gesto o paciente fez, se houve dúvida.
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER REFERENCES sessions(id),
      ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      type TEXT NOT NULL,
      category TEXT,
      question TEXT,
      options TEXT,
      gesture TEXT,
      detail TEXT,
      response_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER REFERENCES sessions(id),
      ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      text TEXT NOT NULL,
      category TEXT,
      sensitive INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      confirmations INTEGER NOT NULL DEFAULT 1
    );

    -- Rede de pessoas do paciente (esposa, filhos, médico...)
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      relation TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- Configurações (voz ElevenLabs, nome do paciente...)
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
  `);

  return db;
}

export const db: Database.Database = globalForDb.__heloDb ?? createDb();
globalForDb.__heloDb = db;
