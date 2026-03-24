/**
 * 消息发送 — 文本与媒体
 */

import {
  sendPrivateMsg,
  sendGroupMsg,
  sendPrivateImage,
  sendGroupImage,
  sendGroupVideo,
  sendPrivateVideo,
  uploadGroupFile,
  uploadPrivateFile,
} from "./connection.js";
import { resolveTargetForReply } from "./reply-context.js";
import { getRenderMarkdownToPlain } from "./config.js";
import { markdownToPlain, collapseDoubleNewlines } from "./markdown.js";
import { requestVoiceTurn } from "./persona.js";
import { takePendingApprovalSurface } from "./pending-approval.js";
import type { NapCatConfig, SendResult } from "./types.js";

type ConfigGetter = () => NapCatConfig | null;

function parseTarget(to: string): { type: "user" | "group"; id: number } | null {
  const t = to.replace(/^(napcat|onebot|qq):/i, "").trim();
  if (!t) return null;
  if (t.startsWith("group:")) {
    const id = parseInt(t.slice(6), 10);
    return isNaN(id) ? null : { type: "group", id };
  }
  const raw = t.replace(/^user:/, "");
  const id = parseInt(raw, 10);
  if (isNaN(id)) return null;
  if (raw === t && !t.includes(":")) {
    return { type: id > 100000000 ? "user" : "group", id };
  }
  return { type: "user", id };
}

/** 发送文本消息 */
export async function sendTextMessage(
  to: string, text: string, getConfig?: ConfigGetter, cfg?: any
): Promise<SendResult> {
  const resolvedTo = resolveTargetForReply(to);
  const target = parseTarget(resolvedTo);
  if (!target) return { ok: false, error: `Invalid target: ${to}` };
  if (!text?.trim()) return { ok: false, error: "No text provided" };

  let finalText = getRenderMarkdownToPlain(cfg) ? markdownToPlain(text) : text.trim();
  finalText = collapseDoubleNewlines(finalText);
  finalText = await maybeRewritePendingApprovalFollowup(target, finalText, cfg);

  try {
    let messageId: number | undefined;
    if (target.type === "group") messageId = await sendGroupMsg(target.id, finalText, getConfig);
    else messageId = await sendPrivateMsg(target.id, finalText, getConfig);
    return { ok: true, messageId: messageId != null ? String(messageId) : "" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function maybeRewritePendingApprovalFollowup(
  target: { type: "user" | "group"; id: number } | null,
  text: string,
  cfg?: any,
): Promise<string> {
  if (!target || target.type !== "group") return text;
  const pending = takePendingApprovalSurface(`group:${target.id}`);
  if (!pending) return text;

  const trimmed = String(text ?? "").trim();
  if (!trimmed) return text;

  try {
    const voiced = await requestVoiceTurn({
      gatewayPort: pending.gatewayPort,
      gatewayToken: pending.gatewayToken,
      agentId: pending.voiceAgentId,
      sessionKey: `agent:${pending.voiceAgentId}:surface:group:${pending.groupId}`,
      timeoutMs: 60000,
      inputText: [
        "<operating_mode>surface</operating_mode>",
        "",
        "<chat_context_excerpt>",
        pending.chatContextExcerpt,
        "</chat_context_excerpt>",
        "",
        "<persona_packet>",
        JSON.stringify({
          draft: {
            reply_to: "current",
            core_text: trimmed.replace(/^\[\[reply_to_current\]\]\s*/i, ""),
          },
        }, null, 2),
        "</persona_packet>",
        "",
        "<task>",
        "请把这句已经完成查询后的回复改写成更自然、更像群友的一句话。",
        "保留事实含义，不要新增未经确认的细节。",
        "请只输出 voice-organ.turn.v2 JSON。",
        "</task>",
      ].join("\n"),
    });
    return voiced.trim() || text;
  } catch {
    return text;
  }
}

/** 发送媒体消息（图片） */
export async function sendMediaMessage(
  to: string, mediaUrl: string, text?: string, getConfig?: ConfigGetter, cfg?: any
): Promise<SendResult> {
  const resolvedTo = resolveTargetForReply(to);
  const target = parseTarget(resolvedTo);
  if (!target) return { ok: false, error: `Invalid target: ${to}` };
  if (!mediaUrl?.trim()) return { ok: false, error: "No mediaUrl provided" };

  let finalText = text?.trim() ? (getRenderMarkdownToPlain(cfg) ? markdownToPlain(text) : text.trim()) : "";
  if (finalText) finalText = collapseDoubleNewlines(finalText);

  try {
    let messageId: number | undefined;
    // 先发文本
    if (finalText) {
      if (target.type === "group") messageId = await sendGroupMsg(target.id, finalText, getConfig);
      else messageId = await sendPrivateMsg(target.id, finalText, getConfig);
    }
    // 再发图片
    if (target.type === "group") {
      const id = await sendGroupImage(target.id, mediaUrl, getConfig);
      if (id != null) messageId = id;
    } else {
      const id = await sendPrivateImage(target.id, mediaUrl, getConfig);
      if (id != null) messageId = id;
    }
    return { ok: true, messageId: messageId != null ? String(messageId) : "" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 发送视频 */
export async function sendVideoMessage(
  to: string, videoUrl: string, text?: string, getConfig?: ConfigGetter, cfg?: any
): Promise<SendResult> {
  const resolvedTo = resolveTargetForReply(to);
  const target = parseTarget(resolvedTo);
  if (!target) return { ok: false, error: `Invalid target: ${to}` };

  try {
    let messageId: number | undefined;
    if (text?.trim()) {
      const finalText = getRenderMarkdownToPlain(cfg) ? markdownToPlain(text) : text.trim();
      if (target.type === "group") await sendGroupMsg(target.id, finalText, getConfig);
      else await sendPrivateMsg(target.id, finalText, getConfig);
    }
    if (target.type === "group") messageId = await sendGroupVideo(target.id, videoUrl, getConfig);
    else messageId = await sendPrivateVideo(target.id, videoUrl, getConfig);
    return { ok: true, messageId: messageId != null ? String(messageId) : "" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 发送文件 */
export async function sendFileMessage(
  to: string, filePath: string, fileName: string, getConfig?: ConfigGetter
): Promise<SendResult> {
  const resolvedTo = resolveTargetForReply(to);
  const target = parseTarget(resolvedTo);
  if (!target) return { ok: false, error: `Invalid target: ${to}` };

  try {
    if (target.type === "group") await uploadGroupFile(target.id, filePath, fileName, getConfig);
    else await uploadPrivateFile(target.id, filePath, fileName, getConfig);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
