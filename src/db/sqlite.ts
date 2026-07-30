import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const DB_DIR = path.join(os.homedir(), '.claude-free-bridge');
const DB_JSON = path.join(DB_DIR, 'db.json');

// Lightweight persistence wrapper: prefer sqlite if available (optional), otherwise JSON file fallback.
let sqliteAvailable = false;
let sqlite3: any = null;
try {
  // Try to require a sqlite driver if installed
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sqlite3 = require('better-sqlite3');
  sqliteAvailable = !!sqlite3;
} catch (e) {
  sqliteAvailable = false;
}

export async function initPersistence() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  if (sqliteAvailable) {
    const dbPath = path.join(DB_DIR, 'conversations.sqlite');
    const db = new sqlite3(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT, role TEXT, content TEXT, timestamp TEXT);`);
    return { type: 'sqlite', db };
  }
  // Ensure JSON file exists
  if (!fs.existsSync(DB_JSON)) fs.writeFileSync(DB_JSON, JSON.stringify({ conversations: {} }, null, 2), 'utf8');
  return { type: 'json', path: DB_JSON };
}

export function loadJsonStore(p: string) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { conversations: {} }; }
}

export function saveJsonStore(p: string, obj: any) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

export async function createConversation(store: any, id: string, title?: string) {
  if (store.type === 'sqlite') {
    const stmt = store.db.prepare('INSERT OR IGNORE INTO conversations (id,title,created_at,updated_at) VALUES (?, ?, datetime("now"), datetime("now"))');
    stmt.run(id, title || null);
    return { ok: true };
  }
  const js = loadJsonStore(store.path);
  js.conversations[id] = js.conversations[id] || { id, title: title || null, created_at: new Date().toISOString(), messages: [] };
  saveJsonStore(store.path, js);
  return { ok: true };
}

export async function appendMessage(store: any, conversationId: string, role: string, content: string) {
  if (store.type === 'sqlite') {
    const stmt = store.db.prepare('INSERT INTO messages (conversation_id,role,content,timestamp) VALUES (?, ?, ?, datetime("now"))');
    stmt.run(conversationId, role, content);
    return { ok: true };
  }
  const js = loadJsonStore(store.path);
  js.conversations[conversationId] = js.conversations[conversationId] || { id: conversationId, messages: [] };
  js.conversations[conversationId].messages.push({ role, content, timestamp: new Date().toISOString() });
  saveJsonStore(store.path, js);
  return { ok: true };
}

export async function getConversation(store: any, conversationId: string) {
  if (store.type === 'sqlite') {
    const c = store.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    const msgs = store.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId);
    return { conversation: c, messages: msgs };
  }
  const js = loadJsonStore(store.path);
  return js.conversations[conversationId] || null;
}
