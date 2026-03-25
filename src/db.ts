import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
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
    reflected_at INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT NOT NULL DEFAULT '',
    lease_expires_at INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    trigger_source TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_reflection_samples_group_created ON reflection_samples(group_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_reflection_samples_pending ON reflection_samples(reflected_at, created_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_memory_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_key TEXT NOT NULL,
    group_id INTEGER NOT NULL,
    last_message_id INTEGER NOT NULL DEFAULT 0,
    last_reflection_sample_id INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT NOT NULL DEFAULT '',
    lease_expires_at INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE(date_key, group_id)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_memory_state_pending ON daily_memory_state(date_key, lease_expires_at, updated_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS followup_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_key TEXT NOT NULL,
    group_id INTEGER NOT NULL,
    persona_session_key TEXT NOT NULL DEFAULT '',
    voice_session_key TEXT NOT NULL DEFAULT '',
    persona_agent_id TEXT NOT NULL DEFAULT '',
    voice_agent_id TEXT NOT NULL DEFAULT '',
    chat_context_excerpt TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    raw_fingerprint TEXT NOT NULL DEFAULT '',
    final_text TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    delivered_at INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_followup_jobs_target_status ON followup_jobs(target_key, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_followup_jobs_target_fingerprint ON followup_jobs(target_key, raw_fingerprint, delivered_at);
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

const reflectionSampleColumns = db.prepare(`PRAGMA table_info(reflection_samples)`).all() as Array<{ name: string }>;
const reflectionSampleColumnNames = new Set(reflectionSampleColumns.map((col) => col.name));
if (!reflectionSampleColumnNames.has("lease_token")) {
  db.exec(`ALTER TABLE reflection_samples ADD COLUMN lease_token TEXT NOT NULL DEFAULT ''`);
}
if (!reflectionSampleColumnNames.has("lease_expires_at")) {
  db.exec(`ALTER TABLE reflection_samples ADD COLUMN lease_expires_at INTEGER NOT NULL DEFAULT 0`);
}
if (!reflectionSampleColumnNames.has("last_attempt_at")) {
  db.exec(`ALTER TABLE reflection_samples ADD COLUMN last_attempt_at INTEGER NOT NULL DEFAULT 0`);
}
if (!reflectionSampleColumnNames.has("attempt_count")) {
  db.exec(`ALTER TABLE reflection_samples ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`);
}
if (!reflectionSampleColumnNames.has("last_error")) {
  db.exec(`ALTER TABLE reflection_samples ADD COLUMN last_error TEXT NOT NULL DEFAULT ''`);
}
if (!reflectionSampleColumnNames.has("trigger_source")) {
  db.exec(`ALTER TABLE reflection_samples ADD COLUMN trigger_source TEXT NOT NULL DEFAULT ''`);
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_reflection_samples_lease
  ON reflection_samples(reflected_at, lease_expires_at, created_at);
`);

const dailyMemoryColumns = db.prepare(`PRAGMA table_info(daily_memory_state)`).all() as Array<{ name: string }>;
const dailyMemoryColumnNames = new Set(dailyMemoryColumns.map((col) => col.name));
if (!dailyMemoryColumnNames.has("last_message_id")) {
  db.exec(`ALTER TABLE daily_memory_state ADD COLUMN last_message_id INTEGER NOT NULL DEFAULT 0`);
}
if (!dailyMemoryColumnNames.has("last_reflection_sample_id")) {
  db.exec(`ALTER TABLE daily_memory_state ADD COLUMN last_reflection_sample_id INTEGER NOT NULL DEFAULT 0`);
}
if (!dailyMemoryColumnNames.has("lease_token")) {
  db.exec(`ALTER TABLE daily_memory_state ADD COLUMN lease_token TEXT NOT NULL DEFAULT ''`);
}
if (!dailyMemoryColumnNames.has("lease_expires_at")) {
  db.exec(`ALTER TABLE daily_memory_state ADD COLUMN lease_expires_at INTEGER NOT NULL DEFAULT 0`);
}
if (!dailyMemoryColumnNames.has("last_attempt_at")) {
  db.exec(`ALTER TABLE daily_memory_state ADD COLUMN last_attempt_at INTEGER NOT NULL DEFAULT 0`);
}
if (!dailyMemoryColumnNames.has("attempt_count")) {
  db.exec(`ALTER TABLE daily_memory_state ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`);
}
if (!dailyMemoryColumnNames.has("last_error")) {
  db.exec(`ALTER TABLE daily_memory_state ADD COLUMN last_error TEXT NOT NULL DEFAULT ''`);
}
if (!dailyMemoryColumnNames.has("updated_at")) {
  db.exec(`ALTER TABLE daily_memory_state ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`);
}

const followupColumns = db.prepare(`PRAGMA table_info(followup_jobs)`).all() as Array<{ name: string }>;
const followupColumnNames = new Set(followupColumns.map((col) => col.name));
if (!followupColumnNames.has("persona_session_key")) {
  db.exec(`ALTER TABLE followup_jobs ADD COLUMN persona_session_key TEXT NOT NULL DEFAULT ''`);
}
if (!followupColumnNames.has("voice_session_key")) {
  db.exec(`ALTER TABLE followup_jobs ADD COLUMN voice_session_key TEXT NOT NULL DEFAULT ''`);
}
if (!followupColumnNames.has("persona_agent_id")) {
  db.exec(`ALTER TABLE followup_jobs ADD COLUMN persona_agent_id TEXT NOT NULL DEFAULT ''`);
}
if (!followupColumnNames.has("voice_agent_id")) {
  db.exec(`ALTER TABLE followup_jobs ADD COLUMN voice_agent_id TEXT NOT NULL DEFAULT ''`);
}
if (!followupColumnNames.has("chat_context_excerpt")) {
  db.exec(`ALTER TABLE followup_jobs ADD COLUMN chat_context_excerpt TEXT NOT NULL DEFAULT ''`);
}
if (!followupColumnNames.has("status")) {
  db.exec(`ALTER TABLE followup_jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
}
if (!followupColumnNames.has("raw_fingerprint")) {
  db.exec(`ALTER TABLE followup_jobs ADD COLUMN raw_fingerprint TEXT NOT NULL DEFAULT ''`);
}
if (!followupColumnNames.has("final_text")) {
  db.exec(`ALTER TABLE followup_jobs ADD COLUMN final_text TEXT NOT NULL DEFAULT ''`);
}
if (!followupColumnNames.has("created_at")) {
  db.exec(`ALTER TABLE followup_jobs ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`);
}
if (!followupColumnNames.has("updated_at")) {
  db.exec(`ALTER TABLE followup_jobs ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`);
}
if (!followupColumnNames.has("delivered_at")) {
  db.exec(`ALTER TABLE followup_jobs ADD COLUMN delivered_at INTEGER NOT NULL DEFAULT 0`);
}
if (!followupColumnNames.has("expires_at")) {
  db.exec(`ALTER TABLE followup_jobs ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0`);
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
  lease_token: string;
  lease_expires_at: number;
  last_attempt_at: number;
  attempt_count: number;
  last_error: string;
  trigger_source: string;
}

export interface ClaimedReflectionBatch {
  leaseToken: string;
  samples: ReflectionSample[];
}

export interface DailyMemoryState {
  id: number;
  date_key: string;
  group_id: number;
  last_message_id: number;
  last_reflection_sample_id: number;
  lease_token: string;
  lease_expires_at: number;
  last_attempt_at: number;
  attempt_count: number;
  last_error: string;
  updated_at: number;
}

export interface ClaimedDailyMemoryJob extends DailyMemoryState {
  leaseToken: string;
  latestMessageId: number;
  latestReflectionSampleId: number;
}

export interface FollowupJob {
  id: number;
  target_key: string;
  group_id: number;
  persona_session_key: string;
  voice_session_key: string;
  persona_agent_id: string;
  voice_agent_id: string;
  chat_context_excerpt: string;
  status: string;
  raw_fingerprint: string;
  final_text: string;
  created_at: number;
  updated_at: number;
  delivered_at: number;
  expires_at: number;
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
  const now = Date.now();
  if (groupId != null) {
    const stmt = db.prepare(`
      SELECT * FROM reflection_samples
      WHERE reflected_at = 0
        AND group_id = ?
        AND (lease_expires_at = 0 OR lease_expires_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?
    `);
    return stmt.all(Number(groupId), now, Number(limit)) as unknown as ReflectionSample[];
  }

  const stmt = db.prepare(`
    SELECT * FROM reflection_samples
    WHERE reflected_at = 0
      AND (lease_expires_at = 0 OR lease_expires_at <= ?)
    ORDER BY created_at ASC
    LIMIT ?
  `);
  return stmt.all(now, Number(limit)) as unknown as ReflectionSample[];
}

export function claimPendingReflectionSamples(opts: {
  limit?: number;
  groupId?: number;
  leaseMs?: number;
  triggerSource?: string;
}): ClaimedReflectionBatch {
  const limit = Math.max(1, Number(opts.limit ?? 5));
  const leaseMs = Math.max(10_000, Number(opts.leaseMs ?? 5 * 60_000));
  const now = Date.now();
  const leaseToken = randomUUID();
  const leaseExpiresAt = now + leaseMs;

  db.exec("BEGIN IMMEDIATE");
  try {
    const selectStmt = opts.groupId != null
      ? db.prepare(`
          SELECT id
          FROM reflection_samples
          WHERE reflected_at = 0
            AND group_id = ?
            AND (lease_expires_at = 0 OR lease_expires_at <= ?)
          ORDER BY created_at ASC
          LIMIT ?
        `)
      : db.prepare(`
          SELECT id
          FROM reflection_samples
          WHERE reflected_at = 0
            AND (lease_expires_at = 0 OR lease_expires_at <= ?)
          ORDER BY created_at ASC
          LIMIT ?
        `);
    const rows = (opts.groupId != null
      ? selectStmt.all(Number(opts.groupId), now, limit)
      : selectStmt.all(now, limit)) as Array<{ id: number }>;
    const ids = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);

    if (ids.length === 0) {
      db.exec("COMMIT");
      return { leaseToken: "", samples: [] };
    }

    const placeholders = ids.map(() => "?").join(",");
    const updateStmt = db.prepare(`
      UPDATE reflection_samples
      SET lease_token = ?,
          lease_expires_at = ?,
          last_attempt_at = ?,
          attempt_count = COALESCE(attempt_count, 0) + 1,
          last_error = '',
          trigger_source = ?
      WHERE id IN (${placeholders})
    `);
    updateStmt.run(
      leaseToken,
      leaseExpiresAt,
      now,
      String(opts.triggerSource ?? "").trim(),
      ...ids,
    );

    const claimedStmt = db.prepare(`
      SELECT *
      FROM reflection_samples
      WHERE lease_token = ?
      ORDER BY created_at ASC
    `);
    const samples = claimedStmt.all(leaseToken) as unknown as ReflectionSample[];
    db.exec("COMMIT");
    return { leaseToken, samples };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function markReflectionSamplesReflected(ids: number[], leaseToken?: string): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  const whereLease = leaseToken ? ` AND lease_token = ?` : "";
  const stmt = db.prepare(`
    UPDATE reflection_samples
    SET reflected_at = ?,
        lease_token = '',
        lease_expires_at = 0,
        last_error = ''
    WHERE id IN (${placeholders})${whereLease}
  `);
  if (leaseToken) {
    stmt.run(Date.now(), ...ids, leaseToken);
    return;
  }
  stmt.run(Date.now(), ...ids);
}

export function releaseReflectionSampleLease(ids: number[], opts?: { leaseToken?: string; error?: string }): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  const whereLease = opts?.leaseToken ? ` AND lease_token = ?` : "";
  const stmt = db.prepare(`
    UPDATE reflection_samples
    SET lease_token = '',
        lease_expires_at = 0,
        last_error = ?
    WHERE id IN (${placeholders})${whereLease}
  `);
  const errorText = String(opts?.error ?? "").trim().slice(0, 500);
  if (opts?.leaseToken) {
    stmt.run(errorText, ...ids, opts.leaseToken);
    return;
  }
  stmt.run(errorText, ...ids);
}

export function claimDailyMemoryJobs(opts: {
  dateKey: string;
  startTs: number;
  endTs: number;
  limit?: number;
  leaseMs?: number;
}): ClaimedDailyMemoryJob[] {
  const dateKey = String(opts.dateKey ?? "").trim();
  if (!dateKey) return [];

  const limit = Math.max(1, Number(opts.limit ?? 2));
  const leaseMs = Math.max(10_000, Number(opts.leaseMs ?? 5 * 60_000));
  const now = Date.now();

  db.exec("BEGIN IMMEDIATE");
  try {
    const candidateRows = db.prepare(`
      SELECT DISTINCT group_id
      FROM (
        SELECT group_id FROM messages WHERE timestamp >= ? AND timestamp < ?
        UNION
        SELECT group_id FROM reflection_samples WHERE created_at >= ? AND created_at < ?
      )
      ORDER BY group_id ASC
    `).all(Number(opts.startTs), Number(opts.endTs), Number(opts.startTs), Number(opts.endTs)) as Array<{ group_id: number }>;

    const upsertStateStmt = db.prepare(`
      INSERT INTO daily_memory_state (
        date_key,
        group_id,
        last_message_id,
        last_reflection_sample_id,
        lease_token,
        lease_expires_at,
        last_attempt_at,
        attempt_count,
        last_error,
        updated_at
      )
      VALUES (?, ?, 0, 0, '', 0, 0, 0, '', 0)
      ON CONFLICT(date_key, group_id) DO NOTHING
    `);
    for (const row of candidateRows) {
      upsertStateStmt.run(dateKey, Number(row.group_id));
    }

    const stateRows = db.prepare(`
      SELECT *
      FROM daily_memory_state
      WHERE date_key = ?
        AND (lease_expires_at = 0 OR lease_expires_at <= ?)
      ORDER BY updated_at ASC, id ASC
    `).all(dateKey, now) as unknown as DailyMemoryState[];

    const jobs: ClaimedDailyMemoryJob[] = [];
    const updateLeaseStmt = db.prepare(`
      UPDATE daily_memory_state
      SET lease_token = ?,
          lease_expires_at = ?,
          last_attempt_at = ?,
          attempt_count = COALESCE(attempt_count, 0) + 1,
          last_error = ''
      WHERE id = ?
    `);
    const latestMessageStmt = db.prepare(`
      SELECT COALESCE(MAX(id), 0) AS max_id
      FROM messages
      WHERE group_id = ?
        AND timestamp >= ?
        AND timestamp < ?
    `);
    const latestReflectionStmt = db.prepare(`
      SELECT COALESCE(MAX(id), 0) AS max_id
      FROM reflection_samples
      WHERE group_id = ?
        AND created_at >= ?
        AND created_at < ?
    `);

    for (const state of stateRows) {
      if (jobs.length >= limit) break;

      const latestMessage = latestMessageStmt.get(
        Number(state.group_id),
        Number(opts.startTs),
        Number(opts.endTs),
      ) as { max_id: number } | undefined;
      const latestReflection = latestReflectionStmt.get(
        Number(state.group_id),
        Number(opts.startTs),
        Number(opts.endTs),
      ) as { max_id: number } | undefined;

      const latestMessageId = Number(latestMessage?.max_id ?? 0);
      const latestReflectionSampleId = Number(latestReflection?.max_id ?? 0);
      const hasPending =
        latestMessageId > Number(state.last_message_id ?? 0) ||
        latestReflectionSampleId > Number(state.last_reflection_sample_id ?? 0);
      if (!hasPending) continue;

      const leaseToken = randomUUID();
      updateLeaseStmt.run(leaseToken, now + leaseMs, now, Number(state.id));
      jobs.push({
        ...state,
        leaseToken,
        latestMessageId,
        latestReflectionSampleId,
      });
    }

    db.exec("COMMIT");
    return jobs;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getMessagesForDailyMemory(opts: {
  groupId: number;
  startTs: number;
  endTs: number;
  afterMessageId?: number;
  limit?: number;
}): DbMessage[] {
  const stmt = db.prepare(`
    SELECT *
    FROM messages
    WHERE group_id = ?
      AND timestamp >= ?
      AND timestamp < ?
      AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `);
  return stmt.all(
    Number(opts.groupId),
    Number(opts.startTs),
    Number(opts.endTs),
    Number(opts.afterMessageId ?? 0),
    Math.max(1, Number(opts.limit ?? 80)),
  ) as unknown as DbMessage[];
}

export function getReflectionSamplesForDailyMemory(opts: {
  groupId: number;
  startTs: number;
  endTs: number;
  afterSampleId?: number;
  limit?: number;
}): ReflectionSample[] {
  const stmt = db.prepare(`
    SELECT *
    FROM reflection_samples
    WHERE group_id = ?
      AND created_at >= ?
      AND created_at < ?
      AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `);
  return stmt.all(
    Number(opts.groupId),
    Number(opts.startTs),
    Number(opts.endTs),
    Number(opts.afterSampleId ?? 0),
    Math.max(1, Number(opts.limit ?? 40)),
  ) as unknown as ReflectionSample[];
}

export function completeDailyMemoryJob(opts: {
  dateKey: string;
  groupId: number;
  leaseToken?: string;
  lastMessageId: number;
  lastReflectionSampleId: number;
}): void {
  const whereLease = opts.leaseToken ? ` AND lease_token = ?` : "";
  const stmt = db.prepare(`
    UPDATE daily_memory_state
    SET last_message_id = ?,
        last_reflection_sample_id = ?,
        lease_token = '',
        lease_expires_at = 0,
        last_error = '',
        updated_at = ?
    WHERE date_key = ?
      AND group_id = ?${whereLease}
  `);
  if (opts.leaseToken) {
    stmt.run(
      Number(opts.lastMessageId),
      Number(opts.lastReflectionSampleId),
      Date.now(),
      String(opts.dateKey),
      Number(opts.groupId),
      opts.leaseToken,
    );
    return;
  }
  stmt.run(
    Number(opts.lastMessageId),
    Number(opts.lastReflectionSampleId),
    Date.now(),
    String(opts.dateKey),
    Number(opts.groupId),
  );
}

export function failDailyMemoryJob(opts: {
  dateKey: string;
  groupId: number;
  leaseToken?: string;
  error?: string;
}): void {
  const whereLease = opts.leaseToken ? ` AND lease_token = ?` : "";
  const stmt = db.prepare(`
    UPDATE daily_memory_state
    SET lease_token = '',
        lease_expires_at = 0,
        last_error = ?,
        updated_at = ?
    WHERE date_key = ?
      AND group_id = ?${whereLease}
  `);
  const errorText = String(opts.error ?? "").trim().slice(0, 500);
  if (opts.leaseToken) {
    stmt.run(errorText, Date.now(), String(opts.dateKey), Number(opts.groupId), opts.leaseToken);
    return;
  }
  stmt.run(errorText, Date.now(), String(opts.dateKey), Number(opts.groupId));
}

export function registerFollowupJob(input: {
  targetKey: string;
  groupId: number;
  personaSessionKey: string;
  voiceSessionKey: string;
  personaAgentId: string;
  voiceAgentId: string;
  chatContextExcerpt: string;
  ttlMs?: number;
}): number {
  const now = Date.now();
  const expiresAt = now + Math.max(60_000, Number(input.ttlMs ?? 10 * 60_000));
  db.prepare(`
    UPDATE followup_jobs
    SET status = 'superseded',
        updated_at = ?
    WHERE target_key = ?
      AND status = 'pending'
  `).run(now, String(input.targetKey));

  const result = db.prepare(`
    INSERT INTO followup_jobs (
      target_key,
      group_id,
      persona_session_key,
      voice_session_key,
      persona_agent_id,
      voice_agent_id,
      chat_context_excerpt,
      status,
      raw_fingerprint,
      final_text,
      created_at,
      updated_at,
      delivered_at,
      expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', '', ?, ?, 0, ?)
  `).run(
    String(input.targetKey).trim().toLowerCase(),
    Number(input.groupId),
    String(input.personaSessionKey ?? ""),
    String(input.voiceSessionKey ?? ""),
    String(input.personaAgentId ?? ""),
    String(input.voiceAgentId ?? ""),
    String(input.chatContextExcerpt ?? "").trim(),
    now,
    now,
    expiresAt,
  );
  return Number(result.lastInsertRowid);
}

export function getPendingFollowupJob(targetKey: string): FollowupJob | null {
  const now = Date.now();
  const normalized = String(targetKey ?? "").trim().toLowerCase();
  if (!normalized) return null;
  const row = db.prepare(`
    SELECT *
    FROM followup_jobs
    WHERE target_key = ?
      AND status = 'pending'
      AND expires_at > ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(normalized, now) as FollowupJob | undefined;
  return row ?? null;
}

export function findDeliveredFollowupByFingerprint(targetKey: string, rawFingerprint: string, withinMs: number = 60 * 60_000): FollowupJob | null {
  const normalizedTarget = String(targetKey ?? "").trim().toLowerCase();
  const normalizedFingerprint = String(rawFingerprint ?? "").trim();
  if (!normalizedTarget || !normalizedFingerprint) return null;
  const row = db.prepare(`
    SELECT *
    FROM followup_jobs
    WHERE target_key = ?
      AND raw_fingerprint = ?
      AND status = 'delivered'
      AND delivered_at >= ?
    ORDER BY delivered_at DESC
    LIMIT 1
  `).get(normalizedTarget, normalizedFingerprint, Date.now() - withinMs) as FollowupJob | undefined;
  return row ?? null;
}

export function markFollowupJobDelivered(opts: {
  jobId: number;
  rawFingerprint: string;
  finalText: string;
}): void {
  db.prepare(`
    UPDATE followup_jobs
    SET status = 'delivered',
        raw_fingerprint = ?,
        final_text = ?,
        updated_at = ?,
        delivered_at = ?
    WHERE id = ?
  `).run(
    String(opts.rawFingerprint ?? "").trim(),
    String(opts.finalText ?? "").trim(),
    Date.now(),
    Date.now(),
    Number(opts.jobId),
  );
}

export function markFollowupJobFailed(opts: {
  jobId: number;
  status?: "expired" | "failed" | "superseded";
  finalText?: string;
}): void {
  db.prepare(`
    UPDATE followup_jobs
    SET status = ?,
        final_text = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    String(opts.status ?? "failed"),
    String(opts.finalText ?? "").trim(),
    Date.now(),
    Number(opts.jobId),
  );
}
