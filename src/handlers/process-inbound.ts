/**
 * 入站消息处理 — 接收 NapCat 消息并分发给 AI
 */

import type { OneBotMessage } from "../types.js";
import { getNapCatConfig, getRenderMarkdownToPlain, getWhitelistUserIds } from "../config.js";
import { getRawText, getTextFromSegments, getReplyMessageId, getTextFromMessageContent, isMentioned, getSenderName } from "../message.js";
import { sendPrivateMsg, sendGroupMsg, sendPrivateImage, sendGroupImage, setMsgEmojiLike, getMsg } from "../connection.js";
import { markdownToPlain, collapseDoubleNewlines } from "../markdown.js";
import { setActiveReplyTarget, clearActiveReplyTarget, setActiveReplySessionId } from "../reply-context.js";
import { loadPluginSdk, getSdk } from "../sdk.js";
import { shouldIntervene, recordGroupMessage, getRecentGroupMessages, buildAutoInterveneSystemPrompt } from "./auto-intervene.js";

const DEFAULT_HISTORY_LIMIT = 20;
export const sessionHistories = new Map<string, Array<{ sender: string; body: string; timestamp: number; messageId: string }>>();

export async function processInboundMessage(api: any, msg: OneBotMessage): Promise<void> {
  await loadPluginSdk();
  const { buildPendingHistoryContextFromMap, recordPendingHistoryEntry, clearHistoryEntriesIfEnabled } = getSdk();

  const runtime = api.runtime;
  if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    api.logger?.warn?.("[napcat] runtime.channel.reply not available");
    return;
  }

  const config = getNapCatConfig(api);
  if (!config) {
    api.logger?.warn?.("[napcat] not configured");
    return;
  }

  const selfId = msg.self_id ?? 0;
  // 忽略自己发的消息
  if (msg.user_id != null && Number(msg.user_id) === Number(selfId)) return;

  const isGroup = msg.message_type === "group";
  const cfg = api.config;
  const napCatCfg = cfg?.channels?.napcat ?? {};

  // ─── 群聊自动介入判断 ───
  if (isGroup) {
    // 记录所有群消息到缓冲区（用于上下文分析）
    recordGroupMessage(msg.group_id!, msg);

    const decision = shouldIntervene(msg, selfId, {
      requireMention: napCatCfg.requireMention ?? false,
      autoIntervene: napCatCfg.autoIntervene ?? true,
      autoInterveneKeywords: napCatCfg.autoInterveneKeywords ?? [],
      monitorGroups: napCatCfg.monitorGroups ?? [],
    });

    if (!decision.shouldIntervene) {
      api.logger?.info?.(`[napcat] skip group msg: ${decision.reason}`);
      return;
    }

    api.logger?.info?.(`[napcat] intervene: reason=${decision.reason} context=${decision.context?.slice(0, 50) ?? ""}`);
  }

  // ─── 提取消息文本 ───
  const replyId = getReplyMessageId(msg);
  let messageText: string;
  if (replyId != null) {
    const userText = getTextFromSegments(msg);
    try {
      const quoted = await getMsg(replyId);
      const quotedText = quoted ? getTextFromMessageContent(quoted.message) : "";
      const senderLabel = quoted?.sender?.nickname ?? quoted?.sender?.user_id ?? "某人";
      messageText = quotedText.trim()
        ? `[引用 ${String(senderLabel)} 的消息：${quotedText.trim()}]\n${userText}`
        : userText;
    } catch {
      messageText = userText;
    }
  } else {
    messageText = getRawText(msg);
  }

  if (!messageText?.trim()) {
    api.logger?.info?.("[napcat] ignoring empty message");
    return;
  }

  // ─── 白名单检查 ───
  const userId = msg.user_id!;
  const whitelist = getWhitelistUserIds(cfg);
  if (whitelist.length > 0 && !whitelist.includes(Number(userId))) {
    api.logger?.info?.(`[napcat] user ${userId} not in whitelist`);
    return;
  }

  // ─── 构建会话上下文 ───
  const groupId = msg.group_id;
  const sessionId = isGroup
    ? `napcat:group:${groupId}`.toLowerCase()
    : `napcat:${userId}`.toLowerCase();

  const route = runtime.channel.routing?.resolveAgentRoute?.({
    cfg,
    sessionKey: sessionId,
    channel: "napcat",
    accountId: config.accountId ?? "default",
  }) ?? { agentId: "main" };

  const storePath = runtime.channel.session?.resolveStorePath?.(cfg?.session?.store, {
    agentId: route.agentId,
  }) ?? "";

  const envelopeOptions = runtime.channel.reply?.resolveEnvelopeFormatOptions?.(cfg) ?? {};
  const chatType = isGroup ? "group" : "direct";
  const senderName = getSenderName(msg);
  const fromLabel = senderName;

  // 自动介入时附加群聊上下文
  let enrichedMessageText = messageText;
  if (isGroup && napCatCfg.autoIntervene) {
    const recentMessages = getRecentGroupMessages(groupId!, 10);
    if (recentMessages.length > 1) {
      const contextLines = recentMessages
        .slice(0, -1) // 排除当前消息
        .map((e) => `[${e.senderName}]: ${e.body}`)
        .join("\n");
      enrichedMessageText = `[群聊上下文]\n${contextLines}\n\n[当前消息]\n${senderName}: ${messageText}`;
    }
  }

  const formattedBody =
    runtime.channel.reply?.formatInboundEnvelope?.({
      channel: "NapCat",
      from: fromLabel,
      timestamp: Date.now(),
      body: enrichedMessageText,
      chatType,
      sender: { name: fromLabel, id: String(userId) },
      envelope: envelopeOptions,
    }) ?? { content: [{ type: "text", text: enrichedMessageText }] };

  const body = buildPendingHistoryContextFromMap
    ? buildPendingHistoryContextFromMap({
        historyMap: sessionHistories,
        historyKey: sessionId,
        limit: napCatCfg.historyLimit ?? DEFAULT_HISTORY_LIMIT,
        currentMessage: formattedBody,
        formatEntry: (entry: any) =>
          runtime.channel.reply?.formatInboundEnvelope?.({
            channel: "NapCat",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: entry.body,
            chatType,
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          }) ?? { content: [{ type: "text", text: entry.body }] },
      })
    : formattedBody;

  if (recordPendingHistoryEntry) {
    recordPendingHistoryEntry({
      historyMap: sessionHistories,
      historyKey: sessionId,
      entry: {
        sender: fromLabel,
        body: messageText,
        timestamp: Date.now(),
        messageId: `napcat-${Date.now()}`,
      },
      limit: napCatCfg.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    });
  }

  // ─── 构建分发上下文 ───
  const replyTarget = isGroup ? `napcat:group:${groupId}` : `napcat:${userId}`;
  const ctxPayload = {
    Body: body,
    RawBody: messageText,
    From: replyTarget,
    To: replyTarget,
    SessionKey: sessionId,
    AccountId: config.accountId ?? "default",
    ChatType: chatType,
    ConversationLabel: replyTarget,
    SenderName: fromLabel,
    SenderId: String(userId),
    Provider: "napcat",
    Surface: "napcat",
    MessageSid: `napcat-${Date.now()}`,
    Timestamp: Date.now(),
    OriginatingChannel: "napcat",
    OriginatingTo: replyTarget,
    CommandAuthorized: true,
    DeliveryContext: {
      channel: "napcat",
      to: replyTarget,
      accountId: config.accountId ?? "default",
    },
    _napcat: { userId, groupId, isGroup, senderName },
  };

  if (runtime.channel.session?.recordInboundSession) {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionId,
      ctx: ctxPayload,
      updateLastRoute: !isGroup ? { sessionKey: sessionId, channel: "napcat", to: String(userId), accountId: config.accountId ?? "default" } : undefined,
      onRecordError: (err: any) => api.logger?.warn?.(`[napcat] recordInboundSession: ${err}`),
    });
  }

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({ channel: "napcat", accountId: config.accountId ?? "default", direction: "inbound" });
  }

  // ─── 思考表情 ───
  const userMessageId = msg.message_id;
  let emojiAdded = false;
  if (userMessageId != null) {
    try {
      await setMsgEmojiLike(userMessageId, 60, true);
      emojiAdded = true;
    } catch { /* not supported */ }
  }

  const clearEmoji = async () => {
    if (emojiAdded && userMessageId != null) {
      try { await setMsgEmojiLike(userMessageId, 60, false); } catch { }
      emojiAdded = false;
    }
  };

  // ─── 分发消息给 AI 并处理回复 ───
  api.logger?.info?.(`[napcat] dispatching message for session ${sessionId}`);

  setActiveReplyTarget(replyTarget);
  const replySessionId = `napcat-reply-${Date.now()}-${sessionId}`;
  setActiveReplySessionId(replySessionId);

  const getConfig = () => getNapCatConfig(api);

  try {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: unknown, info: { kind: string }) => {
          await clearEmoji();

          const p = payload as { text?: string; body?: string; mediaUrl?: string; mediaUrls?: string[] } | string;
          const replyText = typeof p === "string" ? p : (p?.text ?? p?.body ?? "");
          const mediaUrl = typeof p === "string" ? undefined : (p?.mediaUrl ?? p?.mediaUrls?.[0]);
          const trimmed = (replyText || "").trim();

          // NO_REPLY 表示 AI 认为不需要回复
          if ((!trimmed || trimmed === "NO_REPLY" || trimmed.endsWith("NO_REPLY")) && !mediaUrl) return;

          const { userId: uid, groupId: gid, isGroup: ig } = (ctxPayload as any)._napcat || {};

          const usePlain = getRenderMarkdownToPlain(cfg);
          let textPlain = usePlain ? markdownToPlain(trimmed) : trimmed;
          textPlain = collapseDoubleNewlines(textPlain);

          try {
            // 发送文本
            if (textPlain) {
              if (ig && gid) await sendGroupMsg(gid, textPlain, getConfig);
              else if (uid) await sendPrivateMsg(uid, textPlain, getConfig);
            }
            // 发送媒体
            if (mediaUrl) {
              if (ig && gid) await sendGroupImage(gid, mediaUrl, getConfig);
              else if (uid) await sendPrivateImage(uid, mediaUrl, getConfig);
            }
          } catch (e: any) {
            api.logger?.error?.(`[napcat] deliver failed: ${e?.message}`);
          }

          if (info.kind === "final" && clearHistoryEntriesIfEnabled) {
            clearHistoryEntriesIfEnabled({
              historyMap: sessionHistories,
              historyKey: sessionId,
              limit: napCatCfg.historyLimit ?? DEFAULT_HISTORY_LIMIT,
            });
          }
        },
        onError: async (err: any) => {
          api.logger?.error?.(`[napcat] reply error: ${err}`);
          await clearEmoji();
        },
      },
    });
  } catch (err: any) {
    await clearEmoji();
    api.logger?.error?.(`[napcat] dispatch failed: ${err?.message}`);
    try {
      const { userId: uid, groupId: gid, isGroup: ig } = (ctxPayload as any)._napcat || {};
      if (ig && gid) await sendGroupMsg(gid, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`);
      else if (uid) await sendPrivateMsg(uid, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`);
    } catch { }
  } finally {
    setActiveReplySessionId(null);
    clearActiveReplyTarget();
  }
}
