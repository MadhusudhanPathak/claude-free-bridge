import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_DIR, DB_JSON_PATH } from '../config/paths';

interface SqliteDriver {
  new (dbPath: string): SqliteDatabase;
}

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

export interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
  messages: MessageRecord[];
}

export interface MessageRecord {
  role: string;
  content: string;
  timestamp: string;
}

export type PersistenceStore =
  | { type: 'sqlite'; db: SqliteDatabase }
  | { type: 'json'; path: string };

// Prefers a native sqlite driver when available; falls back to a JSON file store otherwise.
let sqliteDriver: SqliteDriver | null = null;
try {
  sqliteDriver = require('better-sqlite3');
} catch {
  sqliteDriver = null;
}

export async function initPersistence(): Promise<PersistenceStore> {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (sqliteDriver) {
    const dbPath = path.join(CONFIG_DIR, 'conversations.sqlite');
    const db = new sqliteDriver(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT, role TEXT, content TEXT, timestamp TEXT);`);
    return { type: 'sqlite', db };
  }

  if (!fs.existsSync(DB_JSON_PATH)) {
    fs.writeFileSync(DB_JSON_PATH, JSON.stringify({ conversations: {} }, null, 2), 'utf8');
  }
  return { type: 'json', path: DB_JSON_PATH };
}

interface JsonStore {
  conversations: Record<string, Conversation>;
}

function loadJsonStore(filePath: string): JsonStore {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { conversations: {} };
  }
}

function saveJsonStore(filePath: string, data: JsonStore): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function createConversation(store: PersistenceStore, id: string, title?: string): Promise<{ ok: true }> {
  if (store.type === 'sqlite') {
    store.db
      .prepare('INSERT OR IGNORE INTO conversations (id,title,created_at,updated_at) VALUES (?, ?, datetime("now"), datetime("now"))')
      .run(id, title || null);
    return { ok: true };
  }
  const data = loadJsonStore(store.path);
  data.conversations[id] = data.conversations[id] || { id, title: title || null, created_at: new Date().toISOString(), messages: [] };
  saveJsonStore(store.path, data);
  return { ok: true };
}

export async function appendMessage(store: PersistenceStore, conversationId: string, role: string, content: string): Promise<{ ok: true }> {
  if (store.type === 'sqlite') {
    store.db
      .prepare('INSERT INTO messages (conversation_id,role,content,timestamp) VALUES (?, ?, ?, datetime("now"))')
      .run(conversationId, role, content);
    return { ok: true };
  }
  const data = loadJsonStore(store.path);
  data.conversations[conversationId] = data.conversations[conversationId] || { id: conversationId, title: null, created_at: new Date().toISOString(), messages: [] };
  data.conversations[conversationId].messages.push({ role, content, timestamp: new Date().toISOString() });
  saveJsonStore(store.path, data);
  return { ok: true };
}

export async function getConversation(store: PersistenceStore, conversationId: string): Promise<{ conversation: unknown; messages: unknown[] } | Conversation | null> {
  if (store.type === 'sqlite') {
    const conversation = store.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    const messages = store.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId);
    return { conversation, messages };
  }
  const data = loadJsonStore(store.path);
  return data.conversations[conversationId] || null;
}
