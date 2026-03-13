/**
 * 群聊自动介入判断模块
 *
 * 两种触发方式：
 * 1. @机器人 → 任何群聊中都立即回复
 * 2. 白名单群定期巡检 → 每 N 秒或 M 条消息后，把最近消息发给 AI 判断是否需要回复
 */

import type { OneBotMessage, HistoryEntry } from "../types.js";
import { getSenderName, getTextFromSegments, isMentioned } from "../message.js";

/** 群聊消息缓冲区 */
const groupMessageBuffer = new Map<number, HistoryEntry[]>();
const MAX_BUFFER_SIZE = 50;

/** 定期巡检状态 */
const groupCheckState = new Map<number, { lastCheckTime: number; messageCount: number }>();

/** 正在巡检中的群（防止并发） */
const groupCheckLock = new Set<number>();

/** 定时巡检 timer，到时间后主动触发 */
const groupTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** 定时巡检回调注册表 */
const groupTimerCallbacks = new Map<number, () => void>();

/** 记录群聊消息到缓冲区 */
export function recordGroupMessage(groupId: number, msg: OneBotMessage): void {
  if (!groupMessageBuffer.has(groupId)) groupMessageBuffer.set(groupId, []);
  const buffer = groupMessageBuffer.get(groupId)!;
  buffer.push({
    sender: String(msg.user_id ?? ""),
    senderName: getSenderName(msg),
    body: getTextFromSegments(msg) || String(msg.raw_message ?? ""),
    timestamp: Date.now(),
    messageId: String(msg.message_id ?? ""),
  });
  if (buffer.length > MAX_BUFFER_SIZE) buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
}

/** 获取群聊最近消息 */
export function getRecentGroupMessages(groupId: number, limit = 10): HistoryEntry[] {
  const buffer = groupMessageBuffer.get(groupId) ?? [];
  return buffer.slice(-limit);
}

/** 清空群聊缓冲区 */
export function clearGroupBuffer(groupId: number): void {
  groupMessageBuffer.delete(groupId);
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

/**
 * 构建定期巡检时发给 AI 的消息体
 */
export function buildPeriodicCheckMessage(
  groupId: number,
  recentMessages: HistoryEntry[],
  customPrompt?: string
): string {
  const lines = recentMessages.map((e) => {
    const time = new Date(e.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return `[${e.senderName} ${time}]: ${e.body}`;
  });

  return `[群聊消息巡检 - 群${groupId}]\n` +
    `以下是最近的群聊消息记录。请判断是否有你可以帮助回答的问题或有价值的参与点。\n` +
    `如果需要回复，直接给出自然的回复内容（像一个有经验的群友那样）。\n` +
    `如果不需要回复，回复 NO_REPLY。\n` +
    (customPrompt ? `\n额外指引：${customPrompt}\n` : "") +
    `\n${lines.join("\n")}`;
}

/**
 * 构建 @机器人 时的上下文消息
 */
export function buildMentionContextPrompt(
  recentMessages: HistoryEntry[],
  customPrompt?: string
): string {
  if (!recentMessages?.length) return customPrompt ?? "";

  const contextBlock = recentMessages
    .map((e) => `[${e.senderName}]: ${e.body}`)
    .join("\n");

  const base = customPrompt ?? "你是一个群聊AI助手，用户直接@了你，请回复他们的问题。回复要简洁有针对性。";
  return `${base}\n\n以下是群聊最近的对话记录，请参考上下文进行回复：\n${contextBlock}`;
}
