/**
 * OneBot v11 消息解析工具
 */

import type { OneBotMessage } from "./types.js";

/** 从消息段提取引用的消息 ID */
export function getReplyMessageId(msg: OneBotMessage): number | undefined {
  if (!msg?.message || !Array.isArray(msg.message)) return undefined;
  const replySeg = msg.message.find((m) => m?.type === "reply");
  if (!replySeg?.data) return undefined;
  const id = replySeg.data.id;
  if (id == null) return undefined;
  const num = typeof id === "number" ? id : parseInt(String(id), 10);
  return Number.isNaN(num) ? undefined : num;
}

/** 从消息段数组中提取纯文本 */
export function getTextFromSegments(msg: OneBotMessage): string {
  const arr = msg?.message;
  if (!Array.isArray(arr)) return "";
  return arr
    .filter((m) => m?.type === "text")
    .map((m) => String(m?.data?.text ?? ""))
    .join("");
}

/** 获取消息的原始文本 */
export function getRawText(msg: OneBotMessage): string {
  if (typeof msg?.raw_message === "string" && msg.raw_message) return msg.raw_message;
  return getTextFromSegments(msg);
}

/** 检查消息是否 @ 了指定用户 */
export function isMentioned(msg: OneBotMessage, selfId: number): boolean {
  const arr = msg.message;
  if (!Array.isArray(arr)) return false;
  const selfStr = String(selfId);
  return arr.some((m) => m?.type === "at" && String(m?.data?.qq ?? m?.data?.id) === selfStr);
}

/** 从 get_msg 返回内容中提取文本 */
export function getTextFromMessageContent(content: string | unknown[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const m of content) {
    const seg = m as { type?: string; data?: Record<string, unknown> };
    if (seg?.type === "text") {
      const t = String(seg.data?.text ?? "");
      if (t) parts.push(t);
    } else if (seg?.type === "image") {
      const url = String(seg.data?.url ?? seg.data?.file ?? "");
      parts.push(url ? `[图片: ${url}]` : "[图片]");
    } else if (seg?.type === "video") {
      parts.push("[视频]");
    } else if (seg?.type === "file") {
      const name = String(seg.data?.name ?? seg.data?.file ?? "");
      parts.push(name ? `[文件: ${name}]` : "[文件]");
    }
  }
  return parts.join("");
}

/** 提取消息中的图片 URL 列表 */
export function getImageUrls(msg: OneBotMessage): string[] {
  const arr = msg?.message;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((m) => m?.type === "image")
    .map((m) => String(m?.data?.url ?? m?.data?.file ?? ""))
    .filter(Boolean);
}

/** 获取发送者展示名（群名片 > 昵称 > QQ号） */
export function getSenderName(msg: OneBotMessage): string {
  const sender = msg.sender;
  if (sender?.card && sender.card.trim()) return sender.card.trim();
  if (sender?.nickname && sender.nickname.trim()) return sender.nickname.trim();
  return String(msg.user_id ?? "unknown");
}
