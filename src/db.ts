import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create the sqlite database in the plugin's root directory (one level up from src)
const dbPath = join(__dirname, '..', 'group_chat.sqlite');
export const db = new DatabaseSync(dbPath);

// Initialize table schema
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    sender_name TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    is_summarized INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_group_time ON messages(group_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_summarized ON messages(is_summarized);
`);

// Checkpoints table to track the last time the bot replied in a group
db.exec(`
  CREATE TABLE IF NOT EXISTS checkpoints (
    group_id INTEGER PRIMARY KEY,
    last_reply_ts INTEGER NOT NULL
  );
`);

export interface DbMessage {
  id: number;
  group_id: number;
  sender_name: string;
  content: string;
  timestamp: number;
  is_summarized: number;
}

// Insert a message
export function insertGroupMessage(groupId: number, senderName: string, content: string) {
  // Ensure types match sqlite schema to avoid datatype mismatch
  const nGroupId = Number(groupId);
  const sSenderName = String(senderName || 'unknown');
  const sContent = String(content || '');
  const nTimestamp = Date.now();
  
  const stmt = db.prepare('INSERT INTO messages (group_id, sender_name, content, timestamp) VALUES (?, ?, ?, ?)');
  stmt.run(nGroupId, sSenderName, sContent, nTimestamp);
}

// Get recent N messages for a group
export function getRecentGroupMessages(groupId: number, limit: number = 20): DbMessage[] {
  const stmt = db.prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY timestamp DESC LIMIT ?');
  const rows = stmt.all(Number(groupId), Number(limit)) as unknown as DbMessage[];
  return rows.reverse(); // Return in ascending chronological order
}

// Get unreplied messages for a group
export function getUnrepliedGroupMessages(groupId: number, limit: number = 50): DbMessage[] {
  const nGroupId = Number(groupId);
  
  // Get the last reply timestamp, default to 0 if not found
  const stmtTime = db.prepare('SELECT last_reply_ts FROM checkpoints WHERE group_id = ?');
  const rowTime = stmtTime.get(nGroupId) as { last_reply_ts: number } | undefined;
  const lastReplyTs = rowTime ? rowTime.last_reply_ts : 0;

  // Get messages since the last reply, or up to the limit
  const stmt = db.prepare('SELECT * FROM messages WHERE group_id = ? AND timestamp > ? ORDER BY timestamp DESC LIMIT ?');
  const rows = stmt.all(nGroupId, lastReplyTs, Number(limit)) as unknown as DbMessage[];
  return rows.reverse(); // Return in ascending chronological order
}

// Clean up old messages (keep only the most recent 500)
export function cleanupOldMessages(groupId: number) {
  const nGroupId = Number(groupId);
  const stmt = db.prepare(`
    DELETE FROM messages
    WHERE group_id = ?
      AND id NOT IN (
        SELECT id FROM messages WHERE group_id = ? ORDER BY timestamp DESC LIMIT 500
      )
  `);
  stmt.run(nGroupId, nGroupId);
}

// Update the checkpoint for a group
export function updateGroupCheckpoint(groupId: number, lastReplyTs: number = Date.now()) {
  const nGroupId = Number(groupId);
  const stmt = db.prepare('INSERT INTO checkpoints (group_id, last_reply_ts) VALUES (?, ?) ON CONFLICT(group_id) DO UPDATE SET last_reply_ts = excluded.last_reply_ts');
  stmt.run(nGroupId, Number(lastReplyTs));
}

// Mark a list of messages as summarized
export function markMessagesAsSummarized(ids: number[]) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(`UPDATE messages SET is_summarized = 1 WHERE id IN (${placeholders})`);
  stmt.run(...ids);
}
