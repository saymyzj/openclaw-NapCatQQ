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
import { updateGroupCheckpoint } from "../db.js";
import { loadPluginSdk, getSdk } from "../sdk.js";
import {
  recordGroupMessage,
  getRecentGroupMessages,
  getUnrepliedGroupMessages,
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
    const groupIdStr = String(msg.group_id);
    const groupId = parseInt(groupIdStr, 10);
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

  const groupId = parseInt(String(msg.group_id), 10);
  const senderName = getSenderName(msg);

  // 附加群聊上下文：获取自上次回复以来的所有消息
  const recentMessages = getUnrepliedGroupMessages(groupId, 50);

  // 按照你的要求：将未回复的消息拼接，但如果只有一条就直接使用即可
  let enrichedText = messageText;
  if (recentMessages.length > 1) {
    const contextLines = recentMessages
      .map((e) => `[${e.senderName}]: ${e.body}`)
      .join("\n");

    const promptBase = config.requireMention
      ? "你是一个群聊AI助手。用户@了你，请回复他们。"
      : "你是一个热心的群聊参与者。这是最新的对话记录，请直接给出你的回复（不要解释，不要带自己的名字前缀）：";

    enrichedText = `${promptBase}

<chat_context>
${contextLines}
</chat_context>`;
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
  let lastMsg: any = null;
  let processedUntilTs = 0;

  try {
    // 1. 获取自上次回复以来的所有未回复消息
    const recentMessages = getUnrepliedGroupMessages(groupId, 30);
    if (!recentMessages || recentMessages.length === 0) {
      api.logger?.info?.(`[napcat] periodic check for group ${groupId}: no messages`);
      return;
    }

    lastMsg = recentMessages[recentMessages.length - 1];
    processedUntilTs = Number(lastMsg?.timestamp ?? 0);

    const checkMessage = buildPeriodicCheckMessage(
      groupId,
      recentMessages,
      napCatCfg.autoIntervenePrompt,
    );

    // ── 第一步：用便宜模型预筛选 ──
    const gatewayPort = cfg?.gateway?.port ?? 18789;
    const gatewayToken = cfg?.gateway?.auth?.token ?? "";
    const preCheckAgentId = napCatCfg.preCheckAgentId ?? "planner";

    api.logger?.info?.(`[napcat] periodic check for group ${groupId}: pre-screening via agent ${preCheckAgentId} (${recentMessages.length} msgs)`);

    const preResult = await preCheckWithCheapModel(checkMessage, {
      gatewayPort,
      gatewayToken,
      agentId: preCheckAgentId,
      model: napCatCfg.preCheckModel,
      customPrompt: napCatCfg.autoIntervenePrompt,
    });

    api.logger?.info?.(`[napcat] periodic check for group ${groupId}: precheck result=${JSON.stringify(preResult)}`);

    if (!preResult || preResult.action !== "reply") {
      api.logger?.info?.(`[napcat] periodic check for group ${groupId}: planner says NO (${preResult?.think}). Insight: ${preResult?.action}`);
      return;
    }

    api.logger?.info?.(`[napcat] periodic check for group ${groupId}: planner says YES, dispatching to main model. Insight: ${preResult.think}`);

    // 直接将所有未回复消息组织为上下文发送
    const contextLines = recentMessages.map((m) => `[${m.senderName}]: ${m.body}`).join("\n");
    const enrichedText = `
<chat_context>
${contextLines}
</chat_context>

请根据上述群聊最新动态，给出一个自然的回复，**不要带有任何前缀和引号**。
如果你觉得此刻不合适回复，请只回复 NO_REPLY。
`;

    await dispatchToAI(api, {
      runtime, cfg, napCatCfg, config,
      userId: 0, // 巡检事件没有特定发件人，用 0 代表系统触发
      groupId,
      isGroup: true,
      senderName: "群聊巡检",
      messageText: enrichedText,
      rawMessageText: lastMsg.body,
      messageId: undefined,
      isPeriodicCheck: true,
    });
  } finally {
    // 如果是群聊且发送过消息（未抛出异常或中途跳出），更新回复检查点。
    // 在整个过程完整结束后记录，确保真正的答复才会更新检查点。
    markPeriodicCheckDone(groupId);
    if (processedUntilTs > 0) updateGroupCheckpoint(groupId, processedUntilTs);
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
  const accountId = config.accountId ?? "default";
  const replyTarget = isGroup ? `napcat:group:${groupId}` : `napcat:${userId}`;
  const route = resolveNapCatRoute({
    cfg,
    runtime,
    accountId,
    isGroup,
    userId,
    groupId,
  }) ?? { agentId: "main", accountId, sessionKey: replyTarget.toLowerCase(), matchedBy: "default" };
  const sessionId = String(route.sessionKey ?? replyTarget).toLowerCase();
  const commandsDisabledForAgent = (napCatCfg.disableCommandsForAgents ?? ["chat", "planner"]).includes(route.agentId);

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
  const effectiveAgentBody = isPeriodicCheck ? messageText : rawMessageText;
  const ctxPayload = {
    Body: body,
    BodyForAgent: effectiveAgentBody,
    BodyForCommands: effectiveAgentBody,
    RawBody: effectiveAgentBody,
    CommandBody: effectiveAgentBody,
    From: replyTarget,
    To: replyTarget,
    SessionKey: sessionId,
    AccountId: route.accountId ?? accountId,
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
    CommandAuthorized: commandsDisabledForAgent ? false : true,
    DeliveryContext: {
      channel: "napcat",
      to: replyTarget,
      accountId: route.accountId ?? accountId,
    },
    _napcat: { userId, groupId, isGroup, senderName },
  };

  if (runtime.channel.session?.recordInboundSession) {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: sessionId,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey: sessionId,
        channel: "napcat",
        to: replyTarget,
        accountId: route.accountId ?? accountId,
      },
      onRecordError: (err: any) => api.logger?.warn?.(`[napcat] recordInboundSession: ${err}`),
    });
  }

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({ channel: "napcat", accountId: route.accountId ?? accountId, direction: "inbound" });
  }

  if (!isPeriodicCheck && commandsDisabledForAgent && isOpenClawCommandInput(rawMessageText)) {
    api.logger?.info?.(`[napcat] blocking command-style input for agent ${route.agentId}: "${rawMessageText.slice(0, 100)}"`);
    const denyText = "当前 QQ 会话已禁用 OpenClaw 命令（如 /status、/model、/reset、!bash）。";
    if (isGroup && groupId != null) {
      await sendGroupMsg(groupId, denyText);
    } else {
      await sendPrivateMsg(userId, denyText);
    }
    return;
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
  api.logger?.info?.(
    `[napcat] ▶ dispatching to AI for session ${sessionId}${isPeriodicCheck ? " (periodic check)" : ""}, agent=${route.agentId} matchedBy=${route.matchedBy ?? "unknown"}, text="${messageText.slice(0, 100)}"`,
  );

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
    // 如果是群聊且发送过消息（未抛出异常或中途跳出），更新回复检查点。
    // 在整个过程完整结束后记录，确保真正的答复才会更新检查点。
    const { groupId: gid, isGroup: ig } = (ctxPayload as any)._napcat || {};
    if (ig && gid) {
       updateGroupCheckpoint(gid);
    }
    setActiveReplySessionId(null);
    clearActiveReplyTarget();
  }
}

function resolveNapCatRoute(params: {
  cfg: any;
  runtime: any;
  accountId: string;
  isGroup: boolean;
  userId: number;
  groupId: number | undefined;
}): any {
  const { cfg, runtime, accountId, isGroup, userId, groupId } = params;
  const resolver = runtime.channel.routing?.resolveAgentRoute;
  if (!resolver) return null;

  const peerCandidates = isGroup
    ? [
        { kind: "group", id: `group:${String(groupId)}` },
        { kind: "group", id: String(groupId) },
      ]
    : [
        { kind: "direct", id: `user:${String(userId)}` },
        { kind: "direct", id: String(userId) },
      ];

  let fallbackRoute: any = null;
  for (const peer of peerCandidates) {
    const route = resolver({
      cfg,
      channel: "napcat",
      accountId,
      peer,
    });
    if (!fallbackRoute) fallbackRoute = route;
    if (route?.matchedBy && route.matchedBy !== "default") return route;
  }
  return fallbackRoute;
}

function isOpenClawCommandInput(text: string | undefined): boolean {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return false;
  return trimmed.startsWith("/") || trimmed.startsWith("!");
}
