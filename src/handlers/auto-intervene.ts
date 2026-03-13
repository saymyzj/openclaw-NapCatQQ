/**
 * 群聊自动介入判断模块
 *
 * 监控群聊消息，通过以下方式判断是否需要 AI 介入：
 * 1. 关键词匹配（配置的 autoInterveneKeywords）
 * 2. 直接 @机器人
 * 3. 累积消息上下文分析（通过 AI 判断是否有需要帮助的问题）
 */

import type { OneBotMessage, HistoryEntry } from "../types.js";
import { getSenderName, getTextFromSegments, isMentioned } from "../message.js";

/** 群聊消息缓冲区，用于上下文分析 */
const groupMessageBuffer = new Map<number, HistoryEntry[]>();
const MAX_BUFFER_SIZE = 50;

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

/** 获取群聊最近消息（用于给 AI 提供上下文） */
export function getRecentGroupMessages(groupId: number, limit = 10): HistoryEntry[] {
  const buffer = groupMessageBuffer.get(groupId) ?? [];
  return buffer.slice(-limit);
}

/** 清空群聊缓冲区 */
export function clearGroupBuffer(groupId: number): void {
  groupMessageBuffer.delete(groupId);
}

export interface InterveneDecision {
  shouldIntervene: boolean;
  reason: string;
  context?: string;
}

/**
 * 判断是否需要介入群聊
 *
 * 检查优先级：
 * 1. @机器人 → 必须回复
 * 2. 关键词匹配 → 回复
 * 3. 上下文分析 → 检测求助、技术问题、争议等
 */
export function shouldIntervene(
  msg: OneBotMessage,
  selfId: number,
  config: {
    requireMention?: boolean;
    autoIntervene?: boolean;
    autoInterveneKeywords?: string[];
    monitorGroups?: number[];
  }
): InterveneDecision {
  const groupId = msg.group_id;
  const text = (getTextFromSegments(msg) || String(msg.raw_message ?? "")).trim();

  // 检查是否在监控群列表中
  if (config.monitorGroups && config.monitorGroups.length > 0) {
    if (groupId && !config.monitorGroups.includes(groupId)) {
      return { shouldIntervene: false, reason: "not_in_monitor_list" };
    }
  }

  // 1. @机器人 → 必须回复
  if (isMentioned(msg, selfId)) {
    return { shouldIntervene: true, reason: "mentioned" };
  }

  // requireMention=true 时，只有 @才回复
  if (config.requireMention) {
    return { shouldIntervene: false, reason: "require_mention" };
  }

  // 2. 关键词匹配
  if (config.autoInterveneKeywords && config.autoInterveneKeywords.length > 0) {
    const lowerText = text.toLowerCase();
    for (const kw of config.autoInterveneKeywords) {
      if (lowerText.includes(kw.toLowerCase())) {
        return { shouldIntervene: true, reason: "keyword", context: kw };
      }
    }
  }

  // 3. 自动介入：智能匹配模式
  if (config.autoIntervene) {
    // 求助模式匹配
    const helpPatterns = [
      /怎么(办|做|弄|搞|解决|处理|配置|设置|安装)/,
      /如何/,
      /有人(知道|了解|会|能)/,
      /请问/,
      /求(助|帮|教)/,
      /帮(帮|个)忙/,
      /谁(能|会|知道)/,
      /为什么/,
      /什么(原因|问题|情况)/,
      /有没有(人|办法|方法)/,
      /能不能/,
      /可以吗/,
      /出(错|问题|bug)/i,
      /报错/,
      /error/i,
      /failed/i,
      /crash/i,
      /不(行|对|能|工作|运行|好使)/,
      /挂了/,
      /炸了/,
      /help/i,
      /how to/i,
      /what('?s| is)/i,
      /can('?t| not)/i,
      /doesn('?t| not)/i,
      /won('?t| not)/i,
    ];

    for (const pattern of helpPatterns) {
      if (pattern.test(text)) {
        // 获取上下文来丰富判断
        const recentMessages = getRecentGroupMessages(groupId!, 5);
        const contextSummary = recentMessages
          .map((e) => `${e.senderName}: ${e.body}`)
          .join("\n");
        return {
          shouldIntervene: true,
          reason: "auto_detect",
          context: contextSummary || text,
        };
      }
    }
  }

  return { shouldIntervene: false, reason: "no_trigger" };
}

/**
 * 构建自动介入时的系统提示词
 */
export function buildAutoInterveneSystemPrompt(
  decision: InterveneDecision,
  customPrompt?: string,
  recentMessages?: HistoryEntry[]
): string {
  const contextBlock = recentMessages?.length
    ? `\n\n以下是群聊最近的对话记录，请参考上下文进行回复：\n${recentMessages.map((e) => `[${e.senderName}]: ${e.body}`).join("\n")}`
    : "";

  if (customPrompt) {
    return `${customPrompt}${contextBlock}`;
  }

  const basePrompt = `你是一个群聊AI助手。你正在监控群聊消息，当检测到有人需要帮助或有问题需要解答时自动介入。

规则：
1. 只在确实能提供有价值帮助时才回复
2. 回复要简洁、有针对性，不要太长
3. 如果不确定答案，诚实说明，不要编造
4. 语气自然友好，像一个有经验的群友
5. 如果是闲聊或不需要帮助的内容，回复 NO_REPLY`;

  if (decision.reason === "mentioned") {
    return `${basePrompt}\n\n用户直接@了你，请回复他们的问题。${contextBlock}`;
  }

  if (decision.reason === "keyword") {
    return `${basePrompt}\n\n检测到关键词「${decision.context}」触发了自动介入。请判断是否需要帮助并给出回复。如果这条消息不需要你回复，请直接回复 NO_REPLY。${contextBlock}`;
  }

  return `${basePrompt}\n\n检测到群友可能需要帮助。请判断是否需要介入。如果这条消息不需要你回复，请直接回复 NO_REPLY。${contextBlock}`;
}
