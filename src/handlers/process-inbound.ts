/**
 * 入站消息处理 — 接收 NapCat 消息并分发给 AI
 *
 * 群聊逻辑：
 *   1. @机器人 → 任何群都立即回复
 *   2. 白名单群（monitorGroups）→ 定期巡检（每 30s 或 10 条消息），批量发给 AI 判断
 *   3. 其他 → 静默
 *
 * 私聊逻辑：
 *   - whitelistUserIds 非空时只处理白名单用户
 *   - 否则处理所有私聊
 */

import type { OneBotMessage } from "../types.js";
import { getNapCatConfig, getRenderMarkdownToPlain, getWhitelistUserIds } from "../config.js";
import { getRawText, getTextFromSegments, getReplyMessageId, getTextFromMessageContent, isMentioned, getSenderName } from "../message.js";
import { sendPrivateMsg, sendGroupMsg, sendPrivateImage, sendGroupImage, sendGroupVideo, sendPrivateVideo, uploadGroupFile, uploadPrivateFile, setMsgEmojiLike, getMsg } from "../connection.js";
import { markdownToPlain, collapseDoubleNewlines } from "../markdown.js";
import { setActiveReplyTarget, clearActiveReplyTarget, setActiveReplySessionId } from "../reply-context.js";
import { loadPluginSdk, getSdk } from "../sdk.js";
import {
  recordGroupMessage,
  getRecentGroupMessages,
  isMonitoredGroup,
  shouldPerformPeriodicCheck,
  lockPeriodicCheck,
  markPeriodicCheckDone,
  buildPeriodicCheckMessage,
  buildMentionContextPrompt,
  scheduleTimerCheck,
} from "./auto-intervene.js";
import { preCheckWithCheapModel } from "../precheck.js";

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
  const cfg = api.config;
  const napCatCfg = cfg?.channels?.napcat ?? {};

  // ─── 详细日志：记录收到的原始消息 ───
  const _senderName = getSenderName(msg);
  const _rawText = getRawText(msg);
  const _msgType = msg.message_type ?? "unknown";
  const _groupId = msg.group_id ?? "";
  const _segments = msg.message?.map((s: any) => `${s.type}${s.data ? ":" + JSON.stringify(s.data).slice(0, 80) : ""}`).join(", ") ?? "";
  api.logger?.info?.(`[napcat] ◀ recv ${_msgType} from ${msg.user_id}(${_senderName})${_groupId ? ` in group ${_groupId}` : ""}: "${_rawText.slice(0, 100)}" [segments: ${_segments}]`);

  // 忽略自己发的消息
  if (msg.user_id != null && Number(msg.user_id) === Number(selfId)) return;

  const isGroup = msg.message_type === "group";

  // ═══════════════════════════════════════════
  // 群聊处理
  // ═══════════════════════════════════════════
  if (isGroup) {
    const groupId = msg.group_id!;
    recordGroupMessage(groupId, msg);

    const mentioned = isMentioned(msg, selfId);
    const monitored = isMonitoredGroup(groupId, napCatCfg.monitorGroups ?? []);

    if (mentioned) {
      // ── @机器人：任何群都立即回复 ──
      api.logger?.info?.(`[napcat] @mentioned in group ${groupId}, processing immediately`);
      await dispatchGroupMention(api, msg, runtime, cfg, napCatCfg, config, selfId);
      return;
    }

    if (monitored && napCatCfg.autoIntervene !== false) {
      // ── 白名单群：检查是否该执行定期巡检 ──
      const shouldCheck = shouldPerformPeriodicCheck(groupId, {
        autoCheckIntervalMs: napCatCfg.autoCheckIntervalMs ?? 30000,
        autoCheckMessageThreshold: napCatCfg.autoCheckMessageThreshold ?? 10,
      });

      if (shouldCheck) {
        api.logger?.info?.(`[napcat] periodic check triggered for group ${groupId}`);
        // 异步执行巡检，不阻塞消息处理
        dispatchPeriodicCheck(api, groupId, runtime, cfg, napCatCfg, config).catch((e) => {
          api.logger?.error?.(`[napcat] periodic check failed for group ${groupId}: ${e?.message}`);
        });
      } else {
        api.logger?.info?.(`[napcat] group ${groupId} monitored, buffering (no check yet)`);
        // 设置定时器：到 autoCheckIntervalMs 后主动触发巡检
        const checkIntervalMs = napCatCfg.autoCheckIntervalMs ?? 30000;
        scheduleTimerCheck(groupId, checkIntervalMs, () => {
          api.logger?.info?.(`[napcat] timer-triggered periodic check for group ${groupId}`);
          dispatchPeriodicCheck(api, groupId, runtime, cfg, napCatCfg, config).catch((e) => {
            api.logger?.error?.(`[napcat] timer periodic check failed for group ${groupId}: ${e?.message}`);
          });
        });
      }
      return;
    }

    // 非白名单群 + 没有 @ → 忽略
    api.logger?.info?.(`[napcat] group ${groupId} not monitored and not mentioned, skipping`);
    return;
  }

  // ═══════════════════════════════════════════
  // 私聊处理
  // ═══════════════════════════════════════════
  const userId = msg.user_id!;
  const whitelist = getWhitelistUserIds(cfg);
  if (whitelist.length > 0 && !whitelist.includes(Number(userId))) {
    api.logger?.info?.(`[napcat] user ${userId} not in whitelist, skipping private msg`);
    return;
  }

  const messageText = await extractMessageText(msg);
  if (!messageText?.trim()) {
    api.logger?.info?.("[napcat] ignoring empty private message");
    return;
  }

  await dispatchToAI(api, {
    runtime, cfg, napCatCfg, config,
    userId, groupId: undefined, isGroup: false,
    senderName: getSenderName(msg),
    messageText,
    messageId: msg.message_id,
  });
}

// ─────────────────────────────────────────────
// @机器人 的群聊即时回复
// ─────────────────────────────────────────────
async function dispatchGroupMention(
  api: any,
  msg: OneBotMessage,
  runtime: any,
  cfg: any,
  napCatCfg: any,
  config: any,
  selfId: number,
): Promise<void> {
  const messageText = await extractMessageText(msg);
  if (!messageText?.trim()) {
    api.logger?.info?.("[napcat] ignoring empty @mention message");
    return;
  }

  const groupId = msg.group_id!;
  const senderName = getSenderName(msg);

  // 附加群聊上下文
  const recentMessages = getRecentGroupMessages(groupId, 10);
  let enrichedText = messageText;
  if (recentMessages.length > 1) {
    const contextLines = recentMessages
      .slice(0, -1)
      .map((e) => `[${e.senderName}]: ${e.body}`)
      .join("\n");
    enrichedText = `[群聊上下文]\n${contextLines}\n\n[当前消息]\n${senderName}: ${messageText}`;
  }

  await dispatchToAI(api, {
    runtime, cfg, napCatCfg, config,
    userId: msg.user_id!, groupId, isGroup: true,
    senderName,
    messageText: enrichedText,
    rawMessageText: messageText,
    messageId: msg.message_id,
  });
}

// ─────────────────────────────────────────────
// 白名单群定期巡检
// ─────────────────────────────────────────────
async function dispatchPeriodicCheck(
  api: any,
  groupId: number,
  runtime: any,
  cfg: any,
  napCatCfg: any,
  config: any,
): Promise<void> {
  lockPeriodicCheck(groupId);
  try {
    const recentMessages = getRecentGroupMessages(groupId, 15);
    if (recentMessages.length < 2) {
      api.logger?.info?.(`[napcat] periodic check for group ${groupId}: not enough messages, skipping`);
      return;
    }

    const checkMessage = buildPeriodicCheckMessage(
      groupId,
      recentMessages,
      napCatCfg.autoIntervenePrompt,
    );

    // ── 第一步：用便宜模型预筛选 ──
    const gatewayPort = cfg?.gateway?.port ?? 18789;
    const gatewayToken = cfg?.gateway?.auth?.token ?? "";
    const preCheckModel = napCatCfg.preCheckModel ?? "github-copilot/gpt-5-mini";

    api.logger?.info?.(`[napcat] periodic check for group ${groupId}: pre-screening with ${preCheckModel} (${recentMessages.length} msgs)`);

    const preResult = await preCheckWithCheapModel(checkMessage, {
      gatewayPort,
      gatewayToken,
      model: preCheckModel,
      customPrompt: napCatCfg.autoIntervenePrompt,
    });

    api.logger?.info?.(`[napcat] periodic check for group ${groupId}: precheck result=${preResult.shouldReply} reason=${preResult.reason}`);

    if (!preResult.shouldReply) {
      api.logger?.info?.(`[napcat] periodic check for group ${groupId}: cheap model says NO, skipping main model`);
      return;
    }

    // ── 第二步：便宜模型说 YES，调用主模型生成回复 ──
    api.logger?.info?.(`[napcat] periodic check for group ${groupId}: cheap model says YES, dispatching to main model`);

    const lastMsg = recentMessages[recentMessages.length - 1];

    await dispatchToAI(api, {
      runtime, cfg, napCatCfg, config,
      userId: Number(lastMsg.sender) || 0,
      groupId,
      isGroup: true,
      senderName: "群聊巡检",
      messageText: checkMessage,
      rawMessageText: checkMessage,
      messageId: undefined,
      isPeriodicCheck: true,
    });
  } finally {
    markPeriodicCheckDone(groupId);
  }
}

// ─────────────────────────────────────────────
// 提取消息文本（含引用处理）
// ─────────────────────────────────────────────
async function extractMessageText(msg: OneBotMessage): Promise<string> {
  const replyId = getReplyMessageId(msg);
  if (replyId != null) {
    const userText = getTextFromSegments(msg);
    try {
      const quoted = await getMsg(replyId);
      const quotedText = quoted ? getTextFromMessageContent(quoted.message) : "";
      const senderLabel = quoted?.sender?.nickname ?? quoted?.sender?.user_id ?? "某人";
      return quotedText.trim()
        ? `[引用 ${String(senderLabel)} 的消息：${quotedText.trim()}]\n${userText}`
        : userText;
    } catch {
      return userText;
    }
  }
  return getRawText(msg);
}

// ─────────────────────────────────────────────
// 核心：分发给 AI 并处理回复
// ─────────────────────────────────────────────
async function dispatchToAI(
  api: any,
  opts: {
    runtime: any;
    cfg: any;
    napCatCfg: any;
    config: any;
    userId: number;
    groupId: number | undefined;
    isGroup: boolean;
    senderName: string;
    messageText: string;
    rawMessageText?: string;
    messageId: number | undefined;
    isPeriodicCheck?: boolean;
  },
): Promise<void> {
  const {
    runtime, cfg, napCatCfg, config,
    userId, groupId, isGroup,
    senderName, messageText,
    messageId, isPeriodicCheck,
  } = opts;
  const rawMessageText = opts.rawMessageText ?? messageText;
  const { buildPendingHistoryContextFromMap, recordPendingHistoryEntry, clearHistoryEntriesIfEnabled } = getSdk();

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
  const fromLabel = senderName;

  const formattedBody =
    runtime.channel.reply?.formatInboundEnvelope?.({
      channel: "NapCat",
      from: fromLabel,
      timestamp: Date.now(),
      body: messageText,
      chatType,
      sender: { name: fromLabel, id: String(userId) },
      envelope: envelopeOptions,
    }) ?? { content: [{ type: "text", text: messageText }] };

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

  if (recordPendingHistoryEntry && !isPeriodicCheck) {
    recordPendingHistoryEntry({
      historyMap: sessionHistories,
      historyKey: sessionId,
      entry: {
        sender: fromLabel,
        body: rawMessageText,
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
    RawBody: rawMessageText,
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
      updateLastRoute: { sessionKey: sessionId, channel: "napcat", to: isGroup ? `group:${groupId}` : String(userId), accountId: config.accountId ?? "default" },
      onRecordError: (err: any) => api.logger?.warn?.(`[napcat] recordInboundSession: ${err}`),
    });
  }

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({ channel: "napcat", accountId: config.accountId ?? "default", direction: "inbound" });
  }

  // ─── 思考表情（巡检时不加） ───
  let emojiAdded = false;
  if (messageId != null && !isPeriodicCheck) {
    try {
      await setMsgEmojiLike(messageId, 60, true);
      emojiAdded = true;
    } catch { /* not supported */ }
  }

  const clearEmoji = async () => {
    if (emojiAdded && messageId != null) {
      try { await setMsgEmojiLike(messageId, 60, false); } catch { }
      emojiAdded = false;
    }
  };

  // ─── 分发消息给 AI 并处理回复 ───
  api.logger?.info?.(`[napcat] ▶ dispatching to AI for session ${sessionId}${isPeriodicCheck ? " (periodic check)" : ""}, text="${messageText.slice(0, 100)}"`);

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

          api.logger?.info?.(`[napcat] ▶ AI reply (kind=${info.kind}): text="${trimmed.slice(0, 120)}" mediaUrl=${mediaUrl ?? "none"}`);

          // NO_REPLY 表示 AI 认为不需要回复
          if ((!trimmed || trimmed === "NO_REPLY" || trimmed.endsWith("NO_REPLY")) && !mediaUrl) {
            api.logger?.info?.(`[napcat] ▶ AI replied NO_REPLY, skipping`);
            return;
          }

          const { userId: uid, groupId: gid, isGroup: ig } = (ctxPayload as any)._napcat || {};

          // ── 1. 提取 <qqimg>/<qqvideo>/<qqfile> 标签 ──
          const qqImages: string[] = [];
          const qqVideos: string[] = [];
          const qqFiles: string[] = [];
          let cleanedText = trimmed;

          // <qqimg>path_or_url</qqimg> (及常见变体 qqimage, qq_img 等)
          const qqImgRegex = /<\s*qq(?:img|image|pic|_img)\s*>([\s\S]*?)<\s*\/\s*qq(?:img|image|pic|_img)\s*>/gi;
          let qqMatch: RegExpExecArray | null;
          while ((qqMatch = qqImgRegex.exec(cleanedText)) !== null) {
            const val = qqMatch[1].trim();
            if (val) qqImages.push(val);
          }
          cleanedText = cleanedText.replace(qqImgRegex, "").trim();

          // <qqvideo>path_or_url</qqvideo>
          const qqVideoRegex = /<\s*qqvideo\s*>([\s\S]*?)<\s*\/\s*qqvideo\s*>/gi;
          while ((qqMatch = qqVideoRegex.exec(cleanedText)) !== null) {
            const val = qqMatch[1].trim();
            if (val) qqVideos.push(val);
          }
          cleanedText = cleanedText.replace(qqVideoRegex, "").trim();

          // <qqfile>path_or_url</qqfile>
          const qqFileRegex = /<\s*qqfile\s*>([\s\S]*?)<\s*\/\s*qqfile\s*>/gi;
          while ((qqMatch = qqFileRegex.exec(cleanedText)) !== null) {
            const val = qqMatch[1].trim();
            if (val) qqFiles.push(val);
          }
          cleanedText = cleanedText.replace(qqFileRegex, "").trim();

          const hasQqTags = qqImages.length > 0 || qqVideos.length > 0 || qqFiles.length > 0;
          if (hasQqTags) {
            api.logger?.info?.(`[napcat] extracted qq tags: ${qqImages.length} images, ${qqVideos.length} videos, ${qqFiles.length} files`);
          }

          // ── 2. 提取 markdown 图片和裸图片 URL ──
          const imageUrlsFromText: string[] = [];
          let textWithoutImages = cleanedText;

          // ![alt](url)
          const mdImageRegex = /!\[[^\]]*\]\(([^)\s]+)\)/g;
          let mdMatch: RegExpExecArray | null;
          while ((mdMatch = mdImageRegex.exec(cleanedText)) !== null) {
            const url = mdMatch[1];
            if (/^https?:\/\//i.test(url)) imageUrlsFromText.push(url);
          }
          textWithoutImages = textWithoutImages.replace(mdImageRegex, "").trim();

          // 裸图片 URL
          const bareImageUrlRegex = /(?:^|\s)(https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp|bmp)(?:\?\S*)?)/gi;
          let bareMatch: RegExpExecArray | null;
          while ((bareMatch = bareImageUrlRegex.exec(textWithoutImages)) !== null) {
            const url = bareMatch[1];
            if (!imageUrlsFromText.includes(url)) imageUrlsFromText.push(url);
          }
          if (imageUrlsFromText.length > 0) {
            textWithoutImages = textWithoutImages.replace(bareImageUrlRegex, "").trim();
          }

          // ── 3. 合并所有图片来源 ──
          const allImageUrls = [...(mediaUrl ? [mediaUrl] : []), ...qqImages, ...imageUrlsFromText];
          const hasMedia = allImageUrls.length > 0 || qqVideos.length > 0 || qqFiles.length > 0;

          const usePlain = getRenderMarkdownToPlain(cfg);
          let textPlain = usePlain
            ? markdownToPlain(hasMedia ? textWithoutImages : cleanedText)
            : (hasMedia ? textWithoutImages : cleanedText);
          textPlain = collapseDoubleNewlines(textPlain);

          try {
            // 发送文本
            if (textPlain) {
              if (ig && gid) await sendGroupMsg(gid, textPlain, getConfig);
              else if (uid) await sendPrivateMsg(uid, textPlain, getConfig);
            }
            // 发送图片
            for (const imgUrl of allImageUrls) {
              api.logger?.info?.(`[napcat] sending image: ${imgUrl.slice(0, 80)}`);
              if (ig && gid) await sendGroupImage(gid, imgUrl, getConfig);
              else if (uid) await sendPrivateImage(uid, imgUrl, getConfig);
            }
            // 发送视频
            for (const vidUrl of qqVideos) {
              api.logger?.info?.(`[napcat] sending video: ${vidUrl.slice(0, 80)}`);
              if (ig && gid) await sendGroupVideo(gid, vidUrl, getConfig);
              else if (uid) await sendPrivateVideo(uid, vidUrl, getConfig);
            }
            // 发送文件
            for (const filePath of qqFiles) {
              const fileName = filePath.split("/").pop() || "file";
              api.logger?.info?.(`[napcat] sending file: ${filePath.slice(0, 80)}`);
              if (ig && gid) await uploadGroupFile(gid, filePath, fileName, getConfig);
              else if (uid) await uploadPrivateFile(uid, filePath, fileName, getConfig);
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
    if (!isPeriodicCheck) {
      try {
        const { userId: uid, groupId: gid, isGroup: ig } = (ctxPayload as any)._napcat || {};
        if (ig && gid) await sendGroupMsg(gid, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`);
        else if (uid) await sendPrivateMsg(uid, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`);
      } catch { }
    }
  } finally {
    setActiveReplySessionId(null);
    clearActiveReplyTarget();
  }
}
