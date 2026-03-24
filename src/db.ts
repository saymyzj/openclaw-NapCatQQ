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
    last_reply_ts INTEGER NOT NULL DEFAULT 0,
    last_processed_ts INTEGER NOT NULL DEFAULT 0,
    last_bot_reply_text TEXT NOT NULL DEFAULT '',
    last_bot_reply_excerpt TEXT NOT NULL DEFAULT ''
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS engagement_state (
    group_id INTEGER PRIMARY KEY,
    talk_value REAL NOT NULL DEFAULT 0.65,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    last_directed_ts INTEGER NOT NULL DEFAULT 0,
    last_bot_reply_ts INTEGER NOT NULL DEFAULT 0,
    recent_response_success INTEGER NOT NULL DEFAULT 0
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS reflection_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    context_excerpt TEXT NOT NULL DEFAULT '',
    persona_draft TEXT NOT NULL DEFAULT '',
    voice_final TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    reflected_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_reflection_samples_group_created ON reflection_samples(group_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_reflection_samples_pending ON reflection_samples(reflected_at, created_at);
`);

const checkpointColumns = db.prepare(`PRAGMA table_info(checkpoints)`).all() as Array<{ name: string }>;
const checkpointColumnNames = new Set(checkpointColumns.map((col) => col.name));
if (!checkpointColumnNames.has("last_reply_ts")) {
  db.exec(`ALTER TABLE checkpoints ADD COLUMN last_reply_ts INTEGER NOT NULL DEFAULT 0`);
}
if (!checkpointColumnNames.has("last_processed_ts")) {
  db.exec(`ALTER TABLE checkpoints ADD COLUMN last_processed_ts INTEGER NOT NULL DEFAULT 0`);
}
if (!checkpointColumnNames.has("last_bot_reply_text")) {
  db.exec(`ALTER TABLE checkpoints ADD COLUMN last_bot_reply_text TEXT NOT NULL DEFAULT ''`);
}
if (!checkpointColumnNames.has("last_bot_reply_excerpt")) {
  db.exec(`ALTER TABLE checkpoints ADD COLUMN last_bot_reply_excerpt TEXT NOT NULL DEFAULT ''`);
}

export interface GroupReplyAnchor {
  lastReplyTs: number;
  lastBotReplyText: string;
  lastBotReplyExcerpt: string;
}

export interface EngagementState {
  talkValue: number;
  cooldownUntil: number;
  lastDirectedTs: number;
  lastBotReplyTs: number;
  recentResponseSuccess: number;
}

export interface DbMessage {
  id: number;
  group_id: number;
  sender_name: string;
  content: string;
  timestamp: number;
  is_summarized: number;
}

export interface ReflectionSample {
  id: number;
  group_id: number;
  context_excerpt: string;
  persona_draft: string;
  voice_final: string;
  created_at: number;
  reflected_at: number;
}

// Insert a message
export function insertGroupMessage(groupId: number, senderName: string, content: string) {
  // Ensure types match sqlite schema to avoid datatype mismatch
  const nGroupId = Number(groupId);
  const sSenderName = String(senderName || 'unknown');
  const sContent = String(content || '');
  const nTimestamp = Date.now();
  
  const stmt = db.prepare('INSERT INTO messages (group_id, sender_name, content, timestamp) VALUES (?, ?, ?, ?)');
  const result = stmt.run(nGroupId, sSenderName, sContent, nTimestamp);
  return Number(result.lastInsertRowid);
}

export function appendGroupMessageSummary(messageId: number, summary: string) {
  const nMessageId = Number(messageId);
  const sSummary = String(summary || "").trim();
  if (!nMessageId || !sSummary) return;
  const stmt = db.prepare(`
    UPDATE messages
    SET content = CASE
      WHEN content LIKE '%[图片摘要]%' THEN content
      ELSE content || char(10) || '[图片摘要] ' || ?
    END,
        is_summarized = 1
    WHERE id = ?
  `);
  stmt.run(sSummary, nMessageId);
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
  
  // Planner only needs messages that have not been processed by previous patrol rounds.
  const stmtTime = db.prepare('SELECT last_processed_ts FROM checkpoints WHERE group_id = ?');
  const rowTime = stmtTime.get(nGroupId) as { last_processed_ts: number } | undefined;
  const lastProcessedTs = rowTime ? rowTime.last_processed_ts : 0;

  // Get messages since the last processed checkpoint, or up to the limit
  const stmt = db.prepare('SELECT * FROM messages WHERE group_id = ? AND timestamp > ? ORDER BY timestamp DESC LIMIT ?');
  const rows = stmt.all(nGroupId, lastProcessedTs, Number(limit)) as unknown as DbMessage[];
  return rows.reverse(); // Return in ascending chronological order
}

// Get messages since the last actual bot reply
export function getMessagesSinceLastReply(groupId: number, limit: number = 100): DbMessage[] {
  const nGroupId = Number(groupId);

  const stmtTime = db.prepare('SELECT last_reply_ts FROM checkpoints WHERE group_id = ?');
  const rowTime = stmtTime.get(nGroupId) as { last_reply_ts: number } | undefined;
  const lastReplyTs = rowTime ? rowTime.last_reply_ts : 0;

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

// Update the processed checkpoint for a group
export function updateGroupProcessedCheckpoint(groupId: number, lastProcessedTs: number = Date.now()) {
  const nGroupId = Number(groupId);
  const stmt = db.prepare(`
    INSERT INTO checkpoints (group_id, last_reply_ts, last_processed_ts, last_bot_reply_text, last_bot_reply_excerpt)
    VALUES (
      ?,
      COALESCE((SELECT last_reply_ts FROM checkpoints WHERE group_id = ?), 0),
      ?,
      COALESCE((SELECT last_bot_reply_text FROM checkpoints WHERE group_id = ?), ''),
      COALESCE((SELECT last_bot_reply_excerpt FROM checkpoints WHERE group_id = ?), '')
    )
    ON CONFLICT(group_id) DO UPDATE SET last_processed_ts = excluded.last_processed_ts
  `);
  stmt.run(nGroupId, nGroupId, Number(lastProcessedTs), nGroupId, nGroupId);
}

// Update the last actual bot reply checkpoint for a group
export function updateGroupReplyCheckpoint(groupId: number, lastReplyTs: number = Date.now()) {
  const nGroupId = Number(groupId);
  const stmt = db.prepare(`
    INSERT INTO checkpoints (group_id, last_reply_ts, last_processed_ts, last_bot_reply_text, last_bot_reply_excerpt)
    VALUES (
      ?,
      ?,
      COALESCE((SELECT last_processed_ts FROM checkpoints WHERE group_id = ?), 0),
      COALESCE((SELECT last_bot_reply_text FROM checkpoints WHERE group_id = ?), ''),
      COALESCE((SELECT last_bot_reply_excerpt FROM checkpoints WHERE group_id = ?), '')
    )
    ON CONFLICT(group_id) DO UPDATE SET last_reply_ts = excluded.last_reply_ts
  `);
  stmt.run(nGroupId, Number(lastReplyTs), nGroupId, nGroupId, nGroupId);
}

export function updateGroupReplyAnchor(
  groupId: number,
  opts: { lastReplyTs?: number; replyText: string; excerpt?: string },
) {
  const nGroupId = Number(groupId);
  const replyTs = Number(opts.lastReplyTs ?? Date.now());
  const replyText = String(opts.replyText ?? "").trim();
  const excerpt = String(opts.excerpt ?? "").trim();
  const stmt = db.prepare(`
    INSERT INTO checkpoints (
      group_id,
      last_reply_ts,
      last_processed_ts,
      last_bot_reply_text,
      last_bot_reply_excerpt
    )
    VALUES (
      ?,
      ?,
      COALESCE((SELECT last_processed_ts FROM checkpoints WHERE group_id = ?), 0),
      ?,
      ?
    )
    ON CONFLICT(group_id) DO UPDATE SET
      last_reply_ts = excluded.last_reply_ts,
      last_bot_reply_text = excluded.last_bot_reply_text,
      last_bot_reply_excerpt = excluded.last_bot_reply_excerpt
  `);
  stmt.run(nGroupId, replyTs, nGroupId, replyText, excerpt);
}

export function getGroupReplyAnchor(groupId: number): GroupReplyAnchor | null {
  const nGroupId = Number(groupId);
  const stmt = db.prepare(`
    SELECT last_reply_ts, last_bot_reply_text, last_bot_reply_excerpt
    FROM checkpoints
    WHERE group_id = ?
  `);
  const row = stmt.get(nGroupId) as
    | { last_reply_ts: number; last_bot_reply_text: string; last_bot_reply_excerpt: string }
    | undefined;
  if (!row) return null;
  return {
    lastReplyTs: Number(row.last_reply_ts ?? 0),
    lastBotReplyText: String(row.last_bot_reply_text ?? ""),
    lastBotReplyExcerpt: String(row.last_bot_reply_excerpt ?? ""),
  };
}

export function getGroupEngagementState(groupId: number): EngagementState {
  const nGroupId = Number(groupId);
  const stmt = db.prepare(`
    SELECT talk_value, cooldown_until, last_directed_ts, last_bot_reply_ts, recent_response_success
    FROM engagement_state
    WHERE group_id = ?
  `);
  const row = stmt.get(nGroupId) as
    | {
        talk_value: number;
        cooldown_until: number;
        last_directed_ts: number;
        last_bot_reply_ts: number;
        recent_response_success: number;
      }
    | undefined;
  if (!row) {
    return {
      talkValue: 0.65,
      cooldownUntil: 0,
      lastDirectedTs: 0,
      lastBotReplyTs: 0,
      recentResponseSuccess: 0,
    };
  }
  return {
    talkValue: Number(row.talk_value ?? 0.65),
    cooldownUntil: Number(row.cooldown_until ?? 0),
    lastDirectedTs: Number(row.last_directed_ts ?? 0),
    lastBotReplyTs: Number(row.last_bot_reply_ts ?? 0),
    recentResponseSuccess: Number(row.recent_response_success ?? 0),
  };
}

export function markGroupDirected(groupId: number, timestamp: number = Date.now()) {
  const nGroupId = Number(groupId);
  const ts = Number(timestamp);
  const stmt = db.prepare(`
    INSERT INTO engagement_state (
      group_id, talk_value, cooldown_until, last_directed_ts, last_bot_reply_ts, recent_response_success
    )
    VALUES (
      ?,
      COALESCE((SELECT talk_value FROM engagement_state WHERE group_id = ?), 0.65),
      COALESCE((SELECT cooldown_until FROM engagement_state WHERE group_id = ?), 0),
      ?,
      COALESCE((SELECT last_bot_reply_ts FROM engagement_state WHERE group_id = ?), 0),
      COALESCE((SELECT recent_response_success FROM engagement_state WHERE group_id = ?), 0)
    )
    ON CONFLICT(group_id) DO UPDATE SET last_directed_ts = excluded.last_directed_ts
  `);
  stmt.run(nGroupId, nGroupId, nGroupId, ts, nGroupId, nGroupId);
}

export function markGroupReplyObserved(groupId: number, timestamp: number = Date.now()) {
  const nGroupId = Number(groupId);
  const ts = Number(timestamp);
  const stmt = db.prepare(`
    INSERT INTO engagement_state (
      group_id, talk_value, cooldown_until, last_directed_ts, last_bot_reply_ts, recent_response_success
    )
    VALUES (
      ?,
      COALESCE((SELECT talk_value FROM engagement_state WHERE group_id = ?), 0.65),
      ?,
      COALESCE((SELECT last_directed_ts FROM engagement_state WHERE group_id = ?), 0),
      ?,
      1
    )
    ON CONFLICT(group_id) DO UPDATE SET
      cooldown_until = excluded.cooldown_until,
      last_bot_reply_ts = excluded.last_bot_reply_ts,
      recent_response_success = MIN(5, COALESCE(engagement_state.recent_response_success, 0) + 1)
  `);
  stmt.run(nGroupId, nGroupId, ts + 15000, nGroupId, ts);
}

// Mark a list of messages as summarized
export function markMessagesAsSummarized(ids: number[]) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(`UPDATE messages SET is_summarized = 1 WHERE id IN (${placeholders})`);
  stmt.run(...ids);
}

export function insertReflectionSample(input: {
  groupId: number;
  contextExcerpt: string;
  personaDraft: string;
  voiceFinal: string;
}): number {
  const stmt = db.prepare(`
    INSERT INTO reflection_samples (group_id, context_excerpt, persona_draft, voice_final, created_at, reflected_at)
    VALUES (?, ?, ?, ?, ?, 0)
  `);
  const result = stmt.run(
    Number(input.groupId),
    String(input.contextExcerpt ?? "").trim(),
    String(input.personaDraft ?? "").trim(),
    String(input.voiceFinal ?? "").trim(),
    Date.now(),
  );
  return Number(result.lastInsertRowid);
}

export function getPendingReflectionSamples(limit: number = 5, groupId?: number): ReflectionSample[] {
  if (groupId != null) {
    const stmt = db.prepare(`
      SELECT * FROM reflection_samples
      WHERE reflected_at = 0 AND group_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `);
    return stmt.all(Number(groupId), Number(limit)) as unknown as ReflectionSample[];
  }

  const stmt = db.prepare(`
    SELECT * FROM reflection_samples
    WHERE reflected_at = 0
    ORDER BY created_at ASC
    LIMIT ?
  `);
  return stmt.all(Number(limit)) as unknown as ReflectionSample[];
}

export function markReflectionSamplesReflected(ids: number[]): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  const stmt = db.prepare(`
    UPDATE reflection_samples
    SET reflected_at = ?
    WHERE id IN (${placeholders})
  `);
  stmt.run(Date.now(), ...ids);
}
