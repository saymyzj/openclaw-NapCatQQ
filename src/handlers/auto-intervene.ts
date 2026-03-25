/**
 * 群聊自动介入判断模块
 *
 * 两种触发方式：
 * 1. @机器人 → 任何群聊中都立即回复
 * 2. 白名单群定期巡检 → 每 N 秒或 M 条消息后，把最近消息发给 AI 判断是否需要回复
 */

import type { OneBotMessage, HistoryEntry } from "../types.js";
import { getSenderName, getTextFromSegments, isMentioned } from "../message.js";
import {
  insertGroupMessage,
  appendGroupMessageSummary,
  getGroupMessagesAfterId as getGroupMessagesAfterIdDb,
  getRecentGroupMessages as getRecentGroupMessagesDb,
  getUnrepliedGroupMessages as getUnrepliedGroupMessagesDb,
  getGroupMessagesAfterTimestamp as getGroupMessagesAfterTimestampDb,
  getMessagesSinceLastReply as getMessagesSinceLastReplyDb,
  getGroupReplyAnchor as getGroupReplyAnchorDb,
  cleanupOldMessages,
} from "../db.js";

/** 定期巡检状态 */
const groupCheckState = new Map<number, { lastCheckTime: number; messageCount: number }>();

/** 正在巡检中的群（防止并发） */
const groupCheckLock = new Set<number>();

/** 定时巡检 timer，到时间后主动触发 */
const groupTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** 定时巡检回调注册表 */
const groupTimerCallbacks = new Map<number, () => void>();
const groupActivityVersion = new Map<number, number>();

/** 记录群聊消息到缓冲区 */
export function recordGroupMessage(groupId: number | string, msg: OneBotMessage): number {
  const senderName = getSenderName(msg);
  const content = getTextFromSegments(msg) || String(msg.raw_message ?? "");
  const numGroupId = typeof groupId === 'string' ? parseInt(groupId, 10) : groupId;
  const rowId = insertGroupMessage(numGroupId, senderName, content);
  cleanupOldMessages(numGroupId);
  groupActivityVersion.set(numGroupId, (groupActivityVersion.get(numGroupId) ?? 0) + 1);
  return rowId;
}

export function attachGroupMessageImageSummary(messageId: number, summary: string): void {
  appendGroupMessageSummary(messageId, summary);
}

export function getGroupActivityVersion(groupId: number): number {
  return groupActivityVersion.get(groupId) ?? 0;
}

/** 获取群聊最近消息 */
export function getRecentGroupMessages(groupId: number | string, limit = 10): HistoryEntry[] {
  const numGroupId = typeof groupId === 'string' ? parseInt(groupId, 10) : groupId;
  const messages = getRecentGroupMessagesDb(numGroupId, limit);
  return messages.map(msg => ({
    sender: String(msg.sender_name),
    senderName: msg.sender_name,
    body: msg.content,
    timestamp: msg.timestamp,
    messageId: String(msg.id),
  }));
}

/** 获取群聊中自上次回复以来的未回复消息 */
export function getUnrepliedGroupMessages(groupId: number | string, limit = 50): HistoryEntry[] {
  const numGroupId = typeof groupId === 'string' ? parseInt(groupId, 10) : groupId;
  const messages = getUnrepliedGroupMessagesDb(numGroupId, limit);
  return messages.map(msg => ({
    sender: String(msg.sender_name),
    senderName: msg.sender_name,
    body: msg.content,
    timestamp: msg.timestamp,
    messageId: String(msg.id),
  }));
}

/** 获取群聊中自上次真实回复以来的消息 */
export function getMessagesSinceLastReply(groupId: number | string, limit = 100): HistoryEntry[] {
  const numGroupId = typeof groupId === 'string' ? parseInt(groupId, 10) : groupId;
  const messages = getMessagesSinceLastReplyDb(numGroupId, limit);
  return messages.map(msg => ({
    sender: String(msg.sender_name),
    senderName: msg.sender_name,
    body: msg.content,
    timestamp: msg.timestamp,
    messageId: String(msg.id),
  }));
}

export function getGroupMessagesAfterTimestamp(groupId: number | string, afterTs: number, limit = 20): HistoryEntry[] {
  const numGroupId = typeof groupId === 'string' ? parseInt(groupId, 10) : groupId;
  const messages = getGroupMessagesAfterTimestampDb(numGroupId, Number(afterTs), limit);
  return messages.map(msg => ({
    sender: String(msg.sender_name),
    senderName: msg.sender_name,
    body: msg.content,
    timestamp: msg.timestamp,
    messageId: String(msg.id),
  }));
}

export function getGroupMessagesAfterId(groupId: number | string, afterId: number, limit = 20): HistoryEntry[] {
  const numGroupId = typeof groupId === 'string' ? parseInt(groupId, 10) : groupId;
  const messages = getGroupMessagesAfterIdDb(numGroupId, Number(afterId), limit);
  return messages.map(msg => ({
    sender: String(msg.sender_name),
    senderName: msg.sender_name,
    body: msg.content,
    timestamp: msg.timestamp,
    messageId: String(msg.id),
  }));
}

export function getGroupReplyAnchor(groupId: number | string): {
  lastReplyTs: number;
  lastBotReplyText: string;
  lastBotReplyExcerpt: string;
} | null {
  const numGroupId = typeof groupId === 'string' ? parseInt(groupId, 10) : groupId;
  return getGroupReplyAnchorDb(numGroupId);
}

/** 清空群聊缓冲区 */
export function clearGroupBuffer(groupId: number): void {
  // Database handles rolling cleanup automatically, no full clear needed
}

/**
 * 判断白名单群是否应该执行定期巡检
 *
 * 触发条件（满足任一）：
 * - 距上次巡检 >= autoCheckIntervalMs（默认 30s）且有 >= 2 条新消息
 * - 新消息 >= autoCheckMessageThreshold（默认 10 条）
 */
export function shouldPerformPeriodicCheck(
  groupId: number,
  config: { autoCheckIntervalMs?: number; autoCheckMessageThreshold?: number }
): boolean {
  if (groupCheckLock.has(groupId)) return false;

  const state = groupCheckState.get(groupId);
  if (!state) {
    groupCheckState.set(groupId, { lastCheckTime: Date.now(), messageCount: 1 });
    return false;
  }

  state.messageCount++;

  const intervalMs = config.autoCheckIntervalMs ?? 30000;
  const threshold = config.autoCheckMessageThreshold ?? 10;

  const timePassed = Date.now() - state.lastCheckTime >= intervalMs && state.messageCount >= 2;
  const enoughMessages = state.messageCount >= threshold;

  return timePassed || enoughMessages;
}

/** 标记巡检开始（加锁） */
export function lockPeriodicCheck(groupId: number): void {
  groupCheckLock.add(groupId);
}

/** 标记巡检完成（解锁 + 重置计数 + 清除 timer） */
export function markPeriodicCheckDone(groupId: number): void {
  groupCheckLock.delete(groupId);
  groupCheckState.set(groupId, { lastCheckTime: Date.now(), messageCount: 0 });
  clearTimerCheck(groupId);
}

/**
 * 注册定时巡检回调 — 当消息缓存了但条件未满足时，设置一个 timer
 * 到达 intervalMs 后主动触发巡检
 */
export function scheduleTimerCheck(
  groupId: number,
  intervalMs: number,
  callback: () => void,
): void {
  // 已有 timer 或正在巡检中，不重复设置
  if (groupTimers.has(groupId) || groupCheckLock.has(groupId)) return;

  const state = groupCheckState.get(groupId);
  if (!state || state.messageCount < 1) return;

  // 计算距离条件满足还需要多久
  const elapsed = Date.now() - state.lastCheckTime;
  const remaining = Math.max(intervalMs - elapsed, 1000); // 至少 1 秒

  groupTimerCallbacks.set(groupId, callback);
  const timer = setTimeout(() => {
    groupTimers.delete(groupId);
    groupTimerCallbacks.delete(groupId);
    // timer 触发时再次检查状态
    const s = groupCheckState.get(groupId);
    if (s && s.messageCount >= 2 && !groupCheckLock.has(groupId)) {
      callback();
    }
  }, remaining);

  groupTimers.set(groupId, timer);
}

/** 取消定时巡检 timer（巡检完成后调用） */
export function clearTimerCheck(groupId: number): void {
  const timer = groupTimers.get(groupId);
  if (timer) {
    clearTimeout(timer);
    groupTimers.delete(groupId);
  }
  groupTimerCallbacks.delete(groupId);
}

/** 检查群是否在白名单中 */
export function isMonitoredGroup(groupId: number, monitorGroups: number[]): boolean {
  if (!monitorGroups || monitorGroups.length === 0) return false;
  return monitorGroups.includes(groupId);
}
