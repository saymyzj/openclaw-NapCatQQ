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
    .map((m) => renderSegmentToText(m as { type?: string; data?: Record<string, unknown> }))
    .filter(Boolean)
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
    const rendered = renderSegmentToText(seg);
    if (rendered) parts.push(rendered);
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

/** 从 get_msg 返回内容中提取图片 URL 列表 */
export function getImageUrlsFromMessageContent(content: string | unknown[] | undefined): string[] {
  if (typeof content === "string") {
    return extractImageRefsFromText(content);
  }
  if (!Array.isArray(content)) return [];
  const urls = content
    .filter((m) => (m as { type?: string })?.type === "image")
    .map((m) => {
      const seg = m as { data?: Record<string, unknown> };
      return String(seg?.data?.url ?? seg?.data?.file ?? "");
    })
    .filter(Boolean);

  // 有些 get_msg 返回的消息段里仍会混入原始 CQ 文本，额外扫一遍字符串表示做兜底。
  const fromSerialized = extractImageRefsFromText(JSON.stringify(content));
  return Array.from(new Set([...urls, ...fromSerialized]));
}

function extractImageRefsFromText(text: string): string[] {
  const normalized = String(text || "").replace(/&amp;/gi, "&");
  const refs: string[] = [];

  const cqImageRegex = /\[CQ:image,[^\]]*url=([^,\]]+)[^\]]*\]/gi;
  let match: RegExpExecArray | null;
  while ((match = cqImageRegex.exec(normalized)) !== null) {
    pushDecodedRef(refs, match[1]);
  }

  const quotedImageRegex = /\[图片:\s*([^\]\s]+)\]/gi;
  while ((match = quotedImageRegex.exec(normalized)) !== null) {
    pushDecodedRef(refs, match[1]);
  }

  return Array.from(new Set(refs.filter(Boolean)));
}

function pushDecodedRef(target: string[], rawValue: unknown): void {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return;
  try {
    target.push(decodeURIComponent(raw));
  } catch {
    target.push(raw);
  }
}

function renderSegmentToText(seg: { type?: string; data?: Record<string, unknown> }): string {
  if (!seg?.type) return "";
  if (seg.type === "text") {
    return String(seg.data?.text ?? "");
  }
  if (seg.type === "image") {
    const summary = String(seg.data?.summary ?? "").trim();
    const url = String(seg.data?.url ?? seg.data?.file ?? "");
    if (summary) return `[图片:${normalizeBracketedText(summary)}]`;
    return url ? `[图片: ${url}]` : "[图片]";
  }
  if (seg.type === "video") {
    return "[视频]";
  }
  if (seg.type === "file") {
    const name = String(seg.data?.name ?? seg.data?.file ?? "");
    return name ? `[文件: ${name}]` : "[文件]";
  }
  if (seg.type === "face") {
    return renderFaceSegment(seg.data);
  }
  return "";
}

function renderFaceSegment(data: Record<string, unknown> | undefined): string {
  const raw = (data?.raw ?? {}) as Record<string, unknown>;
  const faceTextRaw = String(raw?.faceText ?? data?.faceText ?? "").trim();
  const normalizedText = normalizeFaceText(faceTextRaw);
  if (normalizedText) return `[QQ表情: ${normalizedText}]`;

  const faceId = String(data?.id ?? raw?.faceIndex ?? "").trim();
  if (faceId) return `[QQ表情#${faceId}]`;
  return "[QQ表情]";
}

function normalizeFaceText(text: string): string {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const noLeadingSlash = trimmed.replace(/^\/+/, "");
  return normalizeBracketedText(noLeadingSlash);
}

function normalizeBracketedText(text: string): string {
  return String(text || "")
    .replace(/^\[+|\]+$/g, "")
    .trim();
}

/** 获取发送者展示名（群名片 > 昵称 > QQ号） */
export function getSenderName(msg: OneBotMessage): string {
  const sender = msg.sender;
  if (sender?.card && sender.card.trim()) return sender.card.trim();
  if (sender?.nickname && sender.nickname.trim()) return sender.nickname.trim();
  return String(msg.user_id ?? "unknown");
}
