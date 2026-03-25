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

import { createHash } from "node:crypto";
import type { OneBotMessage } from "../types.js";
import { getNapCatConfig, getRenderMarkdownToPlain, getWhitelistUserIds } from "../config.js";
import { getRawText, getTextFromSegments, getReplyMessageId, getTextFromMessageContent, getImageUrls, getImageUrlsFromMessageContent, isMentioned, getSenderName } from "../message.js";
import { sendPrivateMsg, sendGroupMsg, sendPrivateImage, sendGroupImage, sendGroupVideo, sendPrivateVideo, uploadGroupFile, uploadPrivateFile, setMsgEmojiLike, getMsg, resolveMediaToBase64Cached, rememberMessageMediaEntries, getCachedMessageMediaEntries } from "../connection.js";
import { markdownToPlain, collapseDoubleNewlines } from "../markdown.js";
import { setActiveReplyTarget, clearActiveReplyTarget, setActiveReplySessionId } from "../reply-context.js";
import {
  getGroupEngagementState,
  markGroupDirected,
  markGroupReplyObserved,
  updateGroupProcessedCheckpoint,
  updateGroupReplyCheckpoint,
  updateGroupReplyAnchor,
  insertReflectionSample,
} from "../db.js";
import { loadPluginSdk, getSdk } from "../sdk.js";
import { normalizeOutboundReplyText, normalizePersonaTurn, normalizeVoiceText, requestVoiceTurn, type PersonaTurn } from "../persona.js";
import { registerPendingApprovalSurface } from "../pending-approval.js";
import { runReflectionBatch } from "../reflection-runner.js";
import { runAgentTextViaRuntime } from "../runtime-agent.js";
import {
  recordGroupMessage,
  attachGroupMessageImageSummary,
  getGroupMessagesAfterId,
  getUnrepliedGroupMessages,
  getMessagesSinceLastReply,
  isMonitoredGroup,
  shouldPerformPeriodicCheck,
  lockPeriodicCheck,
  markPeriodicCheckDone,
  getGroupReplyAnchor,
  scheduleTimerCheck,
  getGroupActivityVersion,
} from "./auto-intervene.js";
import { answerImagesWithResponses, summarizeImagesWithResponses } from "../responses.js";

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

  primeInboundImageCache(msg).catch((err) => {
    api.logger?.warn?.(`[napcat] image prefetch skipped for message ${msg.message_id ?? "unknown"}: ${err?.message}`);
  });

  // 忽略自己发的消息
  if (msg.user_id != null && Number(msg.user_id) === Number(selfId)) return;

  const isGroup = msg.message_type === "group";

  if (!isGroup && shouldHandleControlPlaneCommand(msg, napCatCfg)) {
    await handleControlPlaneCommand(api, {
      msg,
      runtime,
      cfg,
      config,
      napCatCfg,
    });
    return;
  }

  // ═══════════════════════════════════════════
  // 群聊处理
  // ═══════════════════════════════════════════
  if (isGroup) {
    const groupIdStr = String(msg.group_id);
    const groupId = parseInt(groupIdStr, 10);
    const recordedMessageId = recordGroupMessage(groupId, msg);
    if (looksDirectedToBot(msg, selfId)) {
      markGroupDirected(groupId, Number(msg.time ?? 0) > 0 ? Number(msg.time) * 1000 : Date.now());
    }

    const mentioned = isMentioned(msg, selfId);
    const monitored = isMonitoredGroup(groupId, napCatCfg.monitorGroups ?? []);

    maybeSummarizeGroupImagesToHistory(api, {
      cfg,
      napCatCfg,
      msg,
      groupId,
      dbMessageId: recordedMessageId,
      enabled: monitored,
    }).catch((err) => {
      api.logger?.warn?.(`[napcat] group image summary skipped for group ${groupId}: ${err?.message}`);
    });

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
  const extracted = await extractMessagePayload(msg, napCatCfg.multimodalImageMaxCount ?? 3, api);
  const imageUrls = extracted.imageUrls;
  const whitelist = getWhitelistUserIds(cfg);
  if (whitelist.length > 0 && !whitelist.includes(Number(userId))) {
    api.logger?.info?.(`[napcat] user ${userId} not in whitelist, skipping private msg`);
    return;
  }

  const messageText = extracted.text;
  if (!messageText?.trim() && imageUrls.length === 0) {
    api.logger?.info?.("[napcat] ignoring empty private message");
    return;
  }
  if (shouldUseMultimodalImages(napCatCfg, imageUrls)) {
    await dispatchImageAwareTurn(api, {
      runtime, cfg, napCatCfg, config,
      userId,
      groupId: undefined,
      isGroup: false,
      senderName: getSenderName(msg),
      messageText,
      rawMessageText: messageText,
      messageId: msg.message_id,
      imageUrls,
      replyCheckpointTs: 0,
    });
    return;
  }

  await dispatchToAI(api, {
    runtime, cfg, napCatCfg, config,
    userId, groupId: undefined, isGroup: false,
    senderName: getSenderName(msg),
    messageText,
    messageId: msg.message_id,
    replyCheckpointTs: 0,
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
  const extracted = await extractMessagePayload(msg, napCatCfg.multimodalImageMaxCount ?? 3, api);
  const imageUrls = extracted.imageUrls;
  const messageText = extracted.text;
  if (!messageText?.trim() && imageUrls.length === 0) {
    api.logger?.info?.("[napcat] ignoring empty @mention message");
    return;
  }

  const groupId = parseInt(String(msg.group_id), 10);
  const senderName = getSenderName(msg);

  // 附加群聊上下文：获取自上次真实回复以来的所有消息
  const recentMessages = getMessagesSinceLastReply(groupId, 50);

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

  if (shouldUseMultimodalImages(napCatCfg, imageUrls)) {
    await dispatchImageAwareTurn(api, {
      runtime, cfg, napCatCfg, config,
      userId: msg.user_id!, groupId, isGroup: true,
      senderName,
      messageText: enrichedText,
      rawMessageText: messageText,
      messageId: msg.message_id,
      imageUrls,
      replyCheckpointTs: Number(msg.time ?? 0) > 0 ? Number(msg.time) * 1000 : Date.now(),
    });
    return;
  }

  await dispatchToAI(api, {
    runtime, cfg, napCatCfg, config,
    userId: msg.user_id!, groupId, isGroup: true,
    senderName,
    messageText: enrichedText,
    rawMessageText: messageText,
    messageId: msg.message_id,
    replyCheckpointTs: Number(msg.time ?? 0) > 0 ? Number(msg.time) * 1000 : Date.now(),
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
  let processedUntilMessageId = 0;
  let activityVersionAtStart = getGroupActivityVersion(groupId);

  try {
    // 1. 获取自上次回复以来的所有未回复消息
    const recentMessages = getUnrepliedGroupMessages(groupId, 30);
    if (!recentMessages || recentMessages.length === 0) {
      api.logger?.info?.(`[napcat] periodic check for group ${groupId}: no messages`);
      return;
    }

    lastMsg = recentMessages[recentMessages.length - 1];
    processedUntilTs = Number(lastMsg?.timestamp ?? 0);
    processedUntilMessageId = Number(lastMsg?.messageId ?? 0);
    activityVersionAtStart = getGroupActivityVersion(groupId);

    const contextSource = getMessagesSinceLastReply(groupId, Math.max(recentMessages.length, 100));
    const sectionImageContext = await maybeBuildSectionImageContext(api, {
      cfg,
      napCatCfg,
      groupId,
      contextSource,
      recentMessages,
    });
    const contextLines = contextSource.map((m) => `[${m.senderName}]: ${m.body}`).join("\n");
    const enrichedText = `
<chat_context>
${contextLines}
</chat_context>
${sectionImageContext ? `\n${sectionImageContext}\n` : ""}

请根据上述群聊最新动态，给出一个自然的回复，**不要带有任何前缀和引号**。
如果你觉得此刻不合适回复，请只回复 NO_REPLY。
`;

    api.logger?.info?.(
      `[napcat] periodic check for group ${groupId}: persona mode active (${recentMessages.length} msgs)`,
    );

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
      replyCheckpointTs: processedUntilTs,
      staleGroupActivityVersion: activityVersionAtStart,
      stalePeriodicLastMessageId: processedUntilMessageId,
      stalePeriodicLastSenderName: String(lastMsg?.senderName ?? ""),
    });
  } finally {
    // 巡检结束后推进“已处理”游标，
    // 但不在这里更新“真实回复”游标，避免巡检回合在未真正发言时吃掉上下文。
    markPeriodicCheckDone(groupId);
    if (processedUntilTs > 0) updateGroupProcessedCheckpoint(groupId, processedUntilTs);
  }
}

async function dispatchImageAwareTurn(
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
    imageUrls: string[];
    replyCheckpointTs?: number;
  },
): Promise<void> {
  const {
    runtime, cfg, napCatCfg, config,
    userId, groupId, isGroup,
    senderName, messageText,
    messageId, imageUrls, replyCheckpointTs,
  } = opts;
  const rawMessageText = opts.rawMessageText ?? messageText;

  const dispatchMeta = resolveNapCatDispatchMeta({
    cfg,
    runtime,
    config,
    napCatCfg,
    userId,
    groupId,
    isGroup,
  });

  if (dispatchMeta.commandsDisabledForAgent && isOpenClawCommandInput(rawMessageText)) {
    api.logger?.info?.(`[napcat] blocking command-style input for agent ${dispatchMeta.route.agentId}: "${rawMessageText.slice(0, 100)}"`);
    const denyText = "当前 QQ 会话已禁用 OpenClaw 命令（如 /status、/model、/reset、!bash）。";
    if (isGroup && groupId != null) await sendGroupMsg(groupId, denyText);
    else await sendPrivateMsg(userId, denyText);
    return;
  }

  const questionAware = looksLikeImageQuestion(rawMessageText);
  const personaPreferred = shouldUsePersonaReply(napCatCfg, {
    isGroup,
    groupId,
    routeAgentId: dispatchMeta.route.agentId,
  });
  const multimodalText = questionAware
    ? buildVisionQuestionPromptWithContext(rawMessageText, imageUrls.length, personaPreferred && groupId != null ? buildGroupSectionContext(groupId, rawMessageText) : "")
    : buildVisionSummaryPrompt(imageUrls.length);
  const summaryAgentId = personaPreferred
    ? (napCatCfg?.persona?.coreAgentId ?? "persona-core")
    : dispatchMeta.route.agentId;
  api.logger?.info?.(
    `[napcat] ▶ analyzing multimodal input for session ${dispatchMeta.sessionId}, summaryAgent=${summaryAgentId}, replyAgent=${dispatchMeta.route.agentId} matchedBy=${dispatchMeta.route.matchedBy ?? "unknown"}, images=${imageUrls.length}, text="${multimodalText.slice(0, 100)}"`,
  );

  try {
    const imageSummary = await (questionAware ? answerImagesWithResponses : summarizeImagesWithResponses)({
      gatewayPort: cfg?.gateway?.port ?? 18789,
      gatewayToken: cfg?.gateway?.auth?.token ?? "",
      agentId: summaryAgentId,
      sessionKey: buildVisionSessionKey({
        agentId: summaryAgentId,
        mode: questionAware ? "answer" : "summary",
        isGroup,
        groupId,
        userId,
        imageRefs: imageUrls,
      }),
      inputText: multimodalText,
      imageUrls,
    });
    const enrichedText = [
      messageText.trim(),
      "",
      "<image_context>",
      imageSummary,
      "</image_context>",
    ].filter(Boolean).join("\n");

    await dispatchToAI(api, {
      runtime, cfg, napCatCfg, config,
      userId, groupId, isGroup,
      senderName,
      messageText: enrichedText,
      rawMessageText,
      messageId,
      replyCheckpointTs,
    });
  } catch (err: any) {
    api.logger?.error?.(`[napcat] multimodal analysis failed: ${err?.message}`);
    try {
      if (isGroup && groupId != null) await sendGroupMsg(groupId, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`);
      else await sendPrivateMsg(userId, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`);
    } catch { }
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

async function extractMessagePayload(msg: OneBotMessage, maxImageCount: number, api?: any): Promise<{ text: string; imageUrls: string[] }> {
  const directImageUrls = getImageUrls(msg);
  const replyId = getReplyMessageId(msg);
  if (replyId == null) {
    return {
      text: getRawText(msg),
      imageUrls: clampImageUrls(directImageUrls, maxImageCount),
    };
  }

  const userText = getTextFromSegments(msg);
  try {
    const cachedQuotedImages = getCachedMessageMediaEntries(replyId);
    const quoted = await getMsg(replyId);
    const quotedText = quoted ? getTextFromMessageContent(quoted.message) : "";
    let quotedImageEntries = cachedQuotedImages;
    if (quotedImageEntries.length === 0) {
      const quotedRawImageUrls = Array.from(new Set([
        ...(quoted ? getImageUrlsFromMessageContent(quoted.message) : []),
        ...(quoted ? getImageUrlsFromMessageContent((quoted as any)?.raw_message as string | undefined) : []),
        ...getImageUrlsFromMessageContent(quotedText),
      ]));
      api?.logger?.info?.(
        `[napcat] reply image extraction replyId=${replyId} cache=0 messageType=${Array.isArray(quoted?.message) ? "array" : typeof quoted?.message} rawType=${typeof (quoted as any)?.raw_message} extracted=${quotedRawImageUrls.length}`,
      );
      quotedImageEntries = await materializeImageRefEntries(quotedRawImageUrls);
      rememberMessageMediaEntries(replyId, quotedImageEntries);
    } else {
      api?.logger?.info?.(`[napcat] reply image extraction replyId=${replyId} cacheHit=${quotedImageEntries.length}`);
    }
    const quotedImageUrls = quotedImageEntries
      .map((entry) => {
        const source = String(entry.source ?? "").trim();
        if (/^https?:\/\//i.test(source)) return source;
        return entry.resolved || source;
      })
      .filter(Boolean);
    const senderLabel = quoted?.sender?.nickname ?? quoted?.sender?.user_id ?? "某人";
    const text = quotedText.trim()
      ? `[引用 ${String(senderLabel)} 的消息：${quotedText.trim()}]\n${userText}`
      : userText;
    return {
      text,
      imageUrls: clampImageUrls([...quotedImageUrls, ...directImageUrls], maxImageCount),
    };
  } catch {
    return {
      text: userText,
      imageUrls: clampImageUrls(directImageUrls, maxImageCount),
    };
  }
}

async function materializeImageRefs(refs: string[]): Promise<string[]> {
  const results = await Promise.allSettled(refs.map((ref) => resolveMediaToBase64Cached(ref)));
  return results
    .map((result, idx) => result.status === "fulfilled" ? result.value : refs[idx])
    .filter(Boolean);
}

async function materializeImageRefEntries(refs: string[]): Promise<Array<{ source: string; resolved: string }>> {
  const results = await Promise.allSettled(refs.map((ref) => resolveMediaToBase64Cached(ref)));
  return refs
    .map((ref, idx) => {
      const result = results[idx];
      return {
        source: String(ref ?? "").trim(),
        resolved: result?.status === "fulfilled" ? String(result.value ?? "").trim() : "",
      };
    })
    .filter((entry) => entry.source || entry.resolved);
}

async function primeInboundImageCache(msg: OneBotMessage): Promise<void> {
  const imageRefs = getImageUrls(msg);
  if (!Array.isArray(imageRefs) || imageRefs.length === 0 || msg.message_id == null) return;
  const cached = getCachedMessageMediaEntries(msg.message_id);
  if (cached.length > 0) return;
  const materialized = await materializeImageRefEntries(imageRefs);
  rememberMessageMediaEntries(msg.message_id, materialized);
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
    replyCheckpointTs?: number;
    staleGroupActivityVersion?: number;
    stalePeriodicLastMessageId?: number;
    stalePeriodicLastSenderName?: string;
  },
): Promise<void> {
  const {
    runtime, cfg, napCatCfg, config,
    userId, groupId, isGroup,
  } = opts;
  const {
    senderName, messageText,
  } = opts;
  const rawMessageText = opts.rawMessageText ?? messageText;
  const dispatchMeta = resolveNapCatDispatchMeta({
    cfg,
    runtime,
    config,
    napCatCfg,
    isGroup,
    userId,
    groupId,
  });
  const { route, commandsDisabledForAgent } = dispatchMeta;

  if (shouldUsePersonaReply(napCatCfg, {
    isGroup,
    groupId,
    routeAgentId: route.agentId,
  })) {
    try {
      await dispatchToAIPersona(api, opts, dispatchMeta);
      return;
    } catch (err: any) {
      api.logger?.error?.(`[napcat] persona dispatch failed: ${err?.message}`);
      if (!opts.isPeriodicCheck) {
        try {
          if (isGroup && groupId != null) await sendGroupMsg(groupId, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`);
          else await sendPrivateMsg(userId, `处理失败: ${err?.message?.slice(0, 80) || "未知错误"}`);
        } catch { }
      }
      return;
    }
  }

  await dispatchToAISingleBrain(api, opts, dispatchMeta);
}

async function dispatchToAIPersona(
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
    replyCheckpointTs?: number;
    staleGroupActivityVersion?: number;
    stalePeriodicLastMessageId?: number;
    stalePeriodicLastSenderName?: string;
  },
  dispatchMeta: {
    accountId: string;
    replyTarget: string;
    route: any;
    sessionId: string;
    commandsDisabledForAgent: boolean;
  },
): Promise<void> {
  const {
    runtime, cfg, napCatCfg,
    userId, groupId, isGroup, senderName,
    messageText, messageId, replyCheckpointTs,
    staleGroupActivityVersion,
    stalePeriodicLastMessageId,
    stalePeriodicLastSenderName,
  } = opts;
  if (!isGroup || groupId == null) {
    throw new Error("persona mode is currently supported for group turns only");
  }

  const personaCfg = napCatCfg?.persona ?? {};
  const coreAgentId = personaCfg.coreAgentId ?? "persona-core";
  const voiceAgentId = personaCfg.voiceAgentId ?? "voice-organ";
  const clearEmoji = await maybeSetThinkingEmoji(messageId, false);
  let deliveredReply = false;
  let deliveredReplyText = "";
  let personaDraftText = "";
  let contextExcerpt = "";

  try {
    const chatContext = buildGroupSectionContext(groupId, opts.rawMessageText ?? messageText);
    const imageContext = buildDualBrainSupplementalContext(messageText);
    const engagement = getGroupEngagementState(groupId);
    const anchor = getGroupReplyAnchor(groupId);
    const personaSessionKey = `agent:${coreAgentId}:napcat:group:${groupId}`;
    const personaInput = [
      "<operating_mode>chat</operating_mode>",
      "",
      "<chat_context>",
      extractTaggedBlock(chatContext, "chat_context"),
      "</chat_context>",
      "",
      "<engagement_state>",
      `talk_value: ${engagement.talkValue.toFixed(2)}`,
      `cooldown_until: ${engagement.cooldownUntil ? new Date(engagement.cooldownUntil).toLocaleString("zh-CN") : "0"}`,
      `last_directed_ts: ${engagement.lastDirectedTs ? new Date(engagement.lastDirectedTs).toLocaleString("zh-CN") : "0"}`,
      `last_bot_reply_ts: ${engagement.lastBotReplyTs ? new Date(engagement.lastBotReplyTs).toLocaleString("zh-CN") : "0"}`,
      `recent_response_success: ${engagement.recentResponseSuccess}`,
      "</engagement_state>",
      anchor ? [
        "",
        "<reply_anchor>",
        anchor.lastReplyTs ? `last_bot_reply_time: ${new Date(anchor.lastReplyTs).toLocaleString("zh-CN")}` : "",
        anchor.lastBotReplyText ? `last_bot_reply: ${anchor.lastBotReplyText}` : "",
        anchor.lastBotReplyExcerpt ? `recent_before_unreplied:\n${anchor.lastBotReplyExcerpt}` : "",
        "</reply_anchor>",
      ].filter(Boolean).join("\n") : "",
      imageContext,
      "",
      "<task>",
      "请判断这次是否应该说话；如果应该，说出你自己想表达的核心回复，并严格输出 persona-core.turn.v3 JSON。",
      "</task>",
    ].filter(Boolean).join("\n");
    contextExcerpt = extractTaggedBlock(chatContext, "chat_context");

    api.logger?.info?.(
      `[napcat] ▶ persona-core turn for group ${groupId}, coreAgent=${coreAgentId}, coreSession=${personaSessionKey}`,
    );
    const personaResult = await runAgentTextViaRuntime(api, {
      runtime,
      cfg,
      agentId: coreAgentId,
      sessionKey: personaSessionKey,
      inputText: personaInput,
      userId,
      groupId,
      isGroup,
      senderName,
      replyTarget: `napcat:group:${groupId}`,
    });
    if (personaResult.status === "deferred") {
      api.logger?.info?.(`[napcat] persona-core deferred followup for group ${groupId}`);
      return;
    }
    if (personaResult.status === "approval-pending" || personaResult.status === "approval-unavailable") {
      const pendingText = buildPersonaPendingReply(personaResult.status);
      registerPendingApprovalSurface(`group:${groupId}`, {
        groupId,
        chatContextExcerpt: extractTaggedBlock(chatContext, "chat_context"),
        personaAgentId: coreAgentId,
        voiceAgentId,
        personaSessionKey,
        voiceSessionKey: `agent:${voiceAgentId}:surface:group:${groupId}`,
        gatewayPort: cfg?.gateway?.port ?? 18789,
        gatewayToken: cfg?.gateway?.auth?.token ?? "",
      });
      api.logger?.info?.(
        `[napcat] persona-core waiting on approval for group ${groupId}: status=${personaResult.status}`,
      );
      await clearEmoji();
      await deliverNapCatPayload({
        api,
        cfg,
        payload: { text: pendingText },
        info: { kind: "final" },
        ctxNapcat: { userId, groupId, isGroup, senderName },
      });
      return;
    }
    const personaRaw = personaResult.finalText;
    const turn = normalizePersonaTurn(personaRaw);

    if (staleGroupActivityVersion != null && getGroupActivityVersion(groupId) !== staleGroupActivityVersion) {
      const staleDecision = evaluatePeriodicStaleHeuristic({
        groupId,
        baselineMessageId: stalePeriodicLastMessageId,
        baselineSenderName: stalePeriodicLastSenderName,
      });
      if (staleDecision.suppress) {
        api.logger?.info?.(`[napcat] suppressing stale persona turn for group ${groupId}: ${staleDecision.reason}`);
        return;
      }
      api.logger?.info?.(`[napcat] allowing stale persona turn for group ${groupId}: ${staleDecision.reason}`);
    }

    const personaAction = turn.decision.action;
    const normalizedFinalText = turn.delivery.final_text.trim();
    const shouldSpeak = personaAction === "speak" || normalizedFinalText.length > 0;

    if (!shouldSpeak) {
      api.logger?.info?.(`[napcat] persona-core decided silence for group ${groupId}`);
      return;
    }

    if (personaAction !== "speak" && normalizedFinalText.length > 0) {
      api.logger?.warn?.(
        `[napcat] persona-core returned non-empty delivery.final_text while action=${personaAction}; treating as speak for compatibility`,
      );
    }

    let finalReply = normalizedFinalText;
    personaDraftText = finalReply;
    if (!finalReply) {
      throw new Error("persona-core returned empty delivery.final_text");
    }

    const shouldUseVoice = personaCfg.voiceOnGroupOnly !== false ? isGroup : true;
    if (shouldUseVoice) {
      try {
        const voiceSessionKey = `agent:${voiceAgentId}:surface:group:${groupId}`;
        const voiceInput = [
          "<operating_mode>surface</operating_mode>",
          "",
          "<chat_context_excerpt>",
          extractTaggedBlock(chatContext, "chat_context"),
          "</chat_context_excerpt>",
          "",
          "<persona_packet>",
          JSON.stringify({
            world_model: turn.world_model,
            draft: {
              reply_to: turn.delivery.reply_to,
              core_text: finalReply,
            },
          }, null, 2),
          "</persona_packet>",
          "",
          "<task>",
          "请把 persona-core 的 core_text 改写成更自然、更像群友的一句话。",
          "除非原句已经几乎最优、再改只会变差，否则不要原样照抄。",
          "请只输出 voice-organ.turn.v2 JSON。",
          "</task>",
        ].join("\n");

        api.logger?.info?.(
          `[napcat] ▶ voice-organ turn for group ${groupId}, voiceAgent=${voiceAgentId}, voiceSession=${voiceSessionKey}`,
        );
        const gatewayPort = cfg?.gateway?.port ?? 18789;
        const gatewayToken = String(cfg?.gateway?.auth?.token ?? "").trim();
        if (gatewayToken) {
          const voiced = await requestVoiceTurn({
            gatewayPort,
            gatewayToken,
            agentId: voiceAgentId,
            sessionKey: voiceSessionKey,
            inputText: voiceInput,
          });
          if (voiced.trim()) finalReply = voiced.trim();
        } else {
          const voicedResult = await runAgentTextViaRuntime(api, {
            runtime,
            cfg,
            agentId: voiceAgentId,
            sessionKey: voiceSessionKey,
            inputText: voiceInput,
            userId,
            groupId,
            isGroup,
            senderName,
            replyTarget: `napcat:group:${groupId}`,
          });
          const voicedRaw = voicedResult.finalText;
          const voiced = normalizeVoiceText(voicedRaw);
          if (voiced.trim()) finalReply = voiced.trim();
        }
      } catch (err: any) {
        api.logger?.warn?.(`[napcat] voice-organ failed, using persona-core text: ${err?.message}`);
      }
    }

    if (staleGroupActivityVersion != null && getGroupActivityVersion(groupId) !== staleGroupActivityVersion) {
      const staleDecision = evaluatePeriodicStaleHeuristic({
        groupId,
        baselineMessageId: stalePeriodicLastMessageId,
        baselineSenderName: stalePeriodicLastSenderName,
      });
      if (staleDecision.suppress) {
        api.logger?.info?.(`[napcat] suppressing stale persona reply for group ${groupId}: ${staleDecision.reason}`);
        return;
      }
      api.logger?.info?.(`[napcat] allowing stale persona reply for group ${groupId}: ${staleDecision.reason}`);
    }

    await clearEmoji();
    await deliverNapCatPayload({
      api,
      cfg,
      payload: { text: finalReply },
      info: { kind: "final" },
      ctxNapcat: { userId, groupId, isGroup, senderName },
    });
    deliveredReply = true;
    deliveredReplyText = finalReply.trim();
  } finally {
    await clearEmoji();
    if (deliveredReply) {
      insertReflectionSample({
        groupId,
        contextExcerpt,
        personaDraft: personaDraftText || deliveredReplyText,
        voiceFinal: deliveredReplyText,
      });
      const anchorTs = replyCheckpointTs && replyCheckpointTs > 0 ? replyCheckpointTs : Date.now();
      updateGroupReplyCheckpoint(groupId, anchorTs);
      updateGroupReplyAnchor(groupId, {
        lastReplyTs: anchorTs,
        replyText: deliveredReplyText,
        excerpt: buildReplyAnchorExcerpt(groupId),
      });
      markGroupReplyObserved(groupId, anchorTs);
    }
  }
}

async function dispatchToAISingleBrain(
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
    replyCheckpointTs?: number;
    staleGroupActivityVersion?: number;
  },
  dispatchMeta: {
    accountId: string;
    replyTarget: string;
    route: any;
    sessionId: string;
    commandsDisabledForAgent: boolean;
  },
): Promise<void> {
  const {
    runtime, cfg, napCatCfg,
    userId, groupId, isGroup,
    senderName, messageText,
    messageId, isPeriodicCheck, replyCheckpointTs,
  } = opts;
  const rawMessageText = opts.rawMessageText ?? messageText;
  const { buildPendingHistoryContextFromMap, recordPendingHistoryEntry, clearHistoryEntriesIfEnabled } = getSdk();
  const staleGroupActivityVersion = opts.staleGroupActivityVersion;
  const { accountId, replyTarget, route, sessionId, commandsDisabledForAgent } = dispatchMeta;

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
  const effectiveAgentBody = messageText;
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

  const clearEmoji = await maybeSetThinkingEmoji(messageId, Boolean(isPeriodicCheck));

  // ─── 分发消息给 AI 并处理回复 ───
  api.logger?.info?.(
    `[napcat] ▶ dispatching to AI for session ${sessionId}${isPeriodicCheck ? " (periodic check)" : ""}, agent=${route.agentId} matchedBy=${route.matchedBy ?? "unknown"}, text="${messageText.slice(0, 100)}"`,
  );

  setActiveReplyTarget(replyTarget);
  const replySessionId = `napcat-reply-${Date.now()}-${sessionId}`;
  setActiveReplySessionId(replySessionId);

  const getConfig = () => getNapCatConfig(api);
  let deliveredReply = false;
  let deliveredReplyText = "";

  try {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: unknown, info: { kind: string }) => {
          if (isPeriodicCheck && groupId != null && staleGroupActivityVersion != null) {
            const currentVersion = getGroupActivityVersion(groupId);
            if (currentVersion !== staleGroupActivityVersion) {
              api.logger?.info?.(
                `[napcat] suppressing stale periodic reply for group ${groupId}: expectedActivity=${staleGroupActivityVersion} currentActivity=${currentVersion}`,
              );
              return;
            }
          }
          await clearEmoji();
          await deliverNapCatPayload({
            api,
            cfg,
            payload,
            info,
            ctxNapcat: (ctxPayload as any)._napcat || { userId, groupId, isGroup, senderName },
          });
          deliveredReply = true;
          deliveredReplyText = extractReplyAnchorText(
            typeof payload === "string" ? payload : (payload as any)?.text,
            typeof payload === "string" ? "" : (payload as any)?.body,
          );

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
    if (ig && gid && deliveredReply) {
      const anchorTs = replyCheckpointTs && replyCheckpointTs > 0 ? replyCheckpointTs : Date.now();
      updateGroupReplyCheckpoint(gid, anchorTs);
      updateGroupReplyAnchor(gid, {
        lastReplyTs: anchorTs,
        replyText: deliveredReplyText,
        excerpt: buildReplyAnchorExcerpt(gid),
      });
      markGroupReplyObserved(gid, anchorTs);
    }
    setActiveReplySessionId(null);
    clearActiveReplyTarget();
  }
}

async function maybeSummarizeGroupImagesToHistory(
  api: any,
  opts: {
    cfg: any;
    napCatCfg: any;
    msg: OneBotMessage;
    groupId: number;
    dbMessageId: number;
    enabled: boolean;
  },
): Promise<void> {
  const { cfg, napCatCfg, msg, groupId, dbMessageId, enabled } = opts;
  if (!enabled || napCatCfg.multimodalImagesEnabled === false) return;
  const imageRefs = clampImageUrls(getImageUrls(msg), napCatCfg.multimodalImageMaxCount ?? 3);
  if (imageRefs.length === 0) return;

  const summaryAgentId = napCatCfg?.persona?.coreAgentId ?? "persona-core";
  const imageSummary = await summarizeImagesWithResponses({
    gatewayPort: cfg?.gateway?.port ?? 18789,
    gatewayToken: cfg?.gateway?.auth?.token ?? "",
    agentId: summaryAgentId,
    sessionKey: buildVisionSessionKey({
      agentId: summaryAgentId,
      mode: "summary",
      isGroup: true,
      groupId,
      imageRefs: imageRefs,
    }),
    inputText: buildVisionSummaryPrompt(imageRefs.length),
    imageUrls: imageRefs,
  });

  attachGroupMessageImageSummary(dbMessageId, imageSummary);
  api.logger?.info?.(`[napcat] cached group image summary for group ${groupId}, messageRow=${dbMessageId}`);
}

async function deliverNapCatPayload(params: {
  api: any;
  cfg: any;
  payload: unknown;
  info: { kind: string };
  ctxNapcat: { userId?: number; groupId?: number; isGroup?: boolean; senderName?: string };
}): Promise<void> {
  const { api, cfg, payload, info, ctxNapcat } = params;
  const p = payload as { text?: string; body?: string; mediaUrl?: string; mediaUrls?: string[] } | string;
  const replyText = typeof p === "string" ? p : (p?.text ?? p?.body ?? "");
  const mediaUrl = typeof p === "string" ? undefined : (p?.mediaUrl ?? p?.mediaUrls?.[0]);
  const trimmed = normalizeOutboundReplyText((replyText || "").trim());

  api.logger?.info?.(`[napcat] ▶ AI reply (kind=${info.kind}): text="${trimmed.slice(0, 120)}" mediaUrl=${mediaUrl ?? "none"}`);

  if ((!trimmed || trimmed === "NO_REPLY" || trimmed.endsWith("NO_REPLY")) && !mediaUrl) {
    api.logger?.info?.("[napcat] ▶ AI replied NO_REPLY, skipping");
    return;
  }

  const { userId: uid, groupId: gid, isGroup: ig } = ctxNapcat;
  const getConfig = () => getNapCatConfig(api);

  const qqImages: string[] = [];
  const qqVideos: string[] = [];
  const qqFiles: string[] = [];
  let cleanedText = trimmed;

  const qqImgRegex = /<\s*qq(?:img|image|pic|_img)\s*>([\s\S]*?)<\s*\/\s*qq(?:img|image|pic|_img)\s*>/gi;
  let qqMatch: RegExpExecArray | null;
  while ((qqMatch = qqImgRegex.exec(cleanedText)) !== null) {
    const val = qqMatch[1].trim();
    if (val) qqImages.push(val);
  }
  cleanedText = cleanedText.replace(qqImgRegex, "").trim();

  const qqVideoRegex = /<\s*qqvideo\s*>([\s\S]*?)<\s*\/\s*qqvideo\s*>/gi;
  while ((qqMatch = qqVideoRegex.exec(cleanedText)) !== null) {
    const val = qqMatch[1].trim();
    if (val) qqVideos.push(val);
  }
  cleanedText = cleanedText.replace(qqVideoRegex, "").trim();

  const qqFileRegex = /<\s*qqfile\s*>([\s\S]*?)<\s*\/\s*qqfile\s*>/gi;
  while ((qqMatch = qqFileRegex.exec(cleanedText)) !== null) {
    const val = qqMatch[1].trim();
    if (val) qqFiles.push(val);
  }
  cleanedText = cleanedText.replace(qqFileRegex, "").trim();

  if (qqImages.length > 0 || qqVideos.length > 0 || qqFiles.length > 0) {
    api.logger?.info?.(`[napcat] extracted qq tags: ${qqImages.length} images, ${qqVideos.length} videos, ${qqFiles.length} files`);
  }

  const imageUrlsFromText: string[] = [];
  let textWithoutImages = cleanedText;

  const mdImageRegex = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = mdImageRegex.exec(cleanedText)) !== null) {
    const url = mdMatch[1];
    if (/^https?:\/\//i.test(url)) imageUrlsFromText.push(url);
  }
  textWithoutImages = textWithoutImages.replace(mdImageRegex, "").trim();

  const bareImageUrlRegex = /(?:^|\s)(https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp|bmp)(?:\?\S*)?)/gi;
  let bareMatch: RegExpExecArray | null;
  while ((bareMatch = bareImageUrlRegex.exec(textWithoutImages)) !== null) {
    const url = bareMatch[1];
    if (!imageUrlsFromText.includes(url)) imageUrlsFromText.push(url);
  }
  if (imageUrlsFromText.length > 0) {
    textWithoutImages = textWithoutImages.replace(bareImageUrlRegex, "").trim();
  }

  const allImageUrls = [...(mediaUrl ? [mediaUrl] : []), ...qqImages, ...imageUrlsFromText];
  const hasMedia = allImageUrls.length > 0 || qqVideos.length > 0 || qqFiles.length > 0;

  const usePlain = getRenderMarkdownToPlain(cfg);
  let textPlain = usePlain
    ? markdownToPlain(hasMedia ? textWithoutImages : cleanedText)
    : (hasMedia ? textWithoutImages : cleanedText);
  textPlain = collapseDoubleNewlines(textPlain);

  try {
    if (textPlain) {
      if (ig && gid) await sendGroupMsg(gid, textPlain, getConfig);
      else if (uid) await sendPrivateMsg(uid, textPlain, getConfig);
    }
    for (const imgUrl of allImageUrls) {
      api.logger?.info?.(`[napcat] sending image: ${imgUrl.slice(0, 80)}`);
      if (ig && gid) await sendGroupImage(gid, imgUrl, getConfig);
      else if (uid) await sendPrivateImage(uid, imgUrl, getConfig);
    }
    for (const vidUrl of qqVideos) {
      api.logger?.info?.(`[napcat] sending video: ${vidUrl.slice(0, 80)}`);
      if (ig && gid) await sendGroupVideo(gid, vidUrl, getConfig);
      else if (uid) await sendPrivateVideo(uid, vidUrl, getConfig);
    }
    for (const filePath of qqFiles) {
      const fileName = filePath.split("/").pop() || "file";
      api.logger?.info?.(`[napcat] sending file: ${filePath.slice(0, 80)}`);
      if (ig && gid) await uploadGroupFile(gid, filePath, fileName, getConfig);
      else if (uid) await uploadPrivateFile(uid, filePath, fileName, getConfig);
    }
  } catch (e: any) {
    api.logger?.error?.(`[napcat] deliver failed: ${e?.message}`);
  }
}

async function maybeSetThinkingEmoji(messageId: number | undefined, isPeriodicCheck: boolean): Promise<() => Promise<void>> {
  let emojiAdded = false;
  if (messageId != null && !isPeriodicCheck) {
    try {
      await setMsgEmojiLike(messageId, 60, true);
      emojiAdded = true;
    } catch { /* not supported */ }
  }

  return async () => {
    if (emojiAdded && messageId != null) {
      try { await setMsgEmojiLike(messageId, 60, false); } catch { }
      emojiAdded = false;
    }
  };
}

function resolveNapCatDispatchMeta(params: {
  cfg: any;
  runtime: any;
  config: any;
  napCatCfg: any;
  isGroup: boolean;
  userId: number;
  groupId: number | undefined;
}): {
  accountId: string;
  replyTarget: string;
  route: any;
  sessionId: string;
  commandsDisabledForAgent: boolean;
} {
  const { cfg, runtime, config, napCatCfg, isGroup, userId, groupId } = params;
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
  const commandsDisabledForAgent = (napCatCfg.disableCommandsForAgents ?? ["persona-core", "voice-organ"]).includes(route.agentId);
  return { accountId, replyTarget, route, sessionId, commandsDisabledForAgent };
}

function getPrimaryAdminUserId(napCatCfg: any): number | null {
  const admins = Array.isArray(napCatCfg?.admins) ? napCatCfg.admins : [];
  for (const admin of admins) {
    const asNumber = Number(admin);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  }
  return null;
}

function shouldHandleControlPlaneCommand(msg: OneBotMessage, napCatCfg: any): boolean {
  if (msg.message_type !== "private") return false;
  const primaryAdmin = getPrimaryAdminUserId(napCatCfg);
  if (!primaryAdmin || Number(msg.user_id ?? 0) !== primaryAdmin) return false;
  const text = getRawText(msg).trim();
  return /^\/approve\b/i.test(text) || /^\/reflect\b/i.test(text);
}

async function handleControlPlaneCommand(api: any, params: {
  msg: OneBotMessage;
  runtime: any;
  cfg: any;
  config: any;
  napCatCfg: any;
}): Promise<void> {
  const { msg, runtime, cfg, config, napCatCfg } = params;
  const text = getRawText(msg).trim();
  if (/^\/approve\b/i.test(text)) {
    await dispatchControlPlaneNativeCommand(api, {
      runtime,
      cfg,
      config,
      napCatCfg,
      msg,
      commandText: text,
    });
    return;
  }
  if (/^\/reflect\b/i.test(text)) {
    await dispatchPersonaReflectionCommand(api, {
      runtime,
      cfg,
      napCatCfg,
      msg,
      commandText: text,
    });
  }
}

async function dispatchControlPlaneNativeCommand(api: any, params: {
  runtime: any;
  cfg: any;
  config: any;
  napCatCfg: any;
  msg: OneBotMessage;
  commandText: string;
}): Promise<void> {
  const { runtime, cfg, config, napCatCfg, msg, commandText } = params;
  const userId = Number(msg.user_id);
  const senderName = getSenderName(msg);
  const dispatchMeta = resolveNapCatDispatchMeta({
    cfg,
    runtime,
    config,
    napCatCfg,
    isGroup: false,
    userId,
    groupId: undefined,
  });
  const { accountId, replyTarget, route } = dispatchMeta;
  const chatType = "direct";
  const envelopeOptions = runtime.channel.reply?.resolveEnvelopeFormatOptions?.(cfg) ?? {};
  const body =
    runtime.channel.reply?.formatInboundEnvelope?.({
      channel: "NapCat",
      from: senderName,
      timestamp: Date.now(),
      body: commandText,
      chatType,
      sender: { name: senderName, id: String(userId) },
      envelope: envelopeOptions,
    }) ?? { content: [{ type: "text", text: commandText }] };

  const ctxPayload = {
    Body: body,
    BodyForAgent: commandText,
    BodyForCommands: commandText,
    RawBody: commandText,
    CommandBody: commandText,
    From: replyTarget,
    To: replyTarget,
    SessionKey: dispatchMeta.sessionId,
    AccountId: route.accountId ?? accountId,
    ChatType: chatType,
    ConversationLabel: `${replyTarget}:control`,
    SenderName: senderName,
    SenderId: String(userId),
    Provider: "napcat",
    Surface: "napcat",
    MessageSid: `napcat-control-${Date.now()}`,
    Timestamp: Date.now(),
    OriginatingChannel: "napcat",
    OriginatingTo: replyTarget,
    CommandAuthorized: true,
    DeliveryContext: {
      channel: "napcat",
      to: replyTarget,
      accountId: route.accountId ?? accountId,
    },
    _napcat: { userId, groupId: undefined, isGroup: false, senderName },
  };

  api.logger?.info?.(
    `[napcat] ▶ control-plane command dispatch route=${route.agentId} session=${dispatchMeta.sessionId} replyTarget=${replyTarget} ` +
    `origin=${ctxPayload.OriginatingChannel}:${ctxPayload.OriginatingTo} ` +
    `delivery=${formatDeliveryContextForLog(ctxPayload.DeliveryContext)} text="${commandText.slice(0, 120)}"`,
  );

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: unknown, info: { kind: string }) => {
        await deliverNapCatPayload({
          api,
          cfg,
          payload,
          info,
          ctxNapcat: { userId, groupId: undefined, isGroup: false, senderName },
        });
      },
      onError: async (err: any) => {
        api.logger?.error?.(`[napcat] control-plane command error: ${err}`);
      },
    },
  });
}

async function dispatchPersonaReflectionCommand(api: any, params: {
  runtime: any;
  cfg: any;
  napCatCfg: any;
  msg: OneBotMessage;
  commandText: string;
}): Promise<void> {
  const { runtime, cfg, napCatCfg, msg, commandText } = params;
  const match = commandText.match(/^\/reflect(?:\s+(\d+))?(?:\s+(\d+))?$/i);
  const requestedGroupId = match?.[1] ? Number(match[1]) : undefined;
  const requestedLimit = match?.[2] ? Math.max(1, Math.min(20, Number(match[2]))) : 5;
  const userId = Number(msg.user_id);

  try {
    const result = await runReflectionBatch(api, {
      runtime,
      cfg,
      napCatCfg,
      limit: requestedLimit,
      groupId: requestedGroupId,
      userId,
      senderName: getSenderName(msg),
      replyTarget: `napcat:${userId}`,
      triggerSource: "manual",
    });
    if (result.processedCount === 0) {
      await sendPrivateMsg(userId, "没有待反思样本。");
      return;
    }
    api.logger?.info?.(`[napcat] ▶ reflection private send success user=${userId} chars=${result.summary.length}`);
    await sendPrivateMsg(userId, result.summary);
  } catch (err: any) {
    api.logger?.error?.(`[napcat] reflection command failed: ${err?.message}`);
    api.logger?.info?.(
      `[napcat] ▶ reflection private send failure user=${userId} reason="${err?.message?.slice(0, 120) || "未知错误"}"`,
    );
    await sendPrivateMsg(
      userId,
      `本次 reflection 失败：${err?.message?.slice(0, 120) || "未知错误"}`,
    );
  }
}

function formatDeliveryContextForLog(deliveryContext: unknown): string {
  if (!deliveryContext || typeof deliveryContext !== "object") return "(none)";
  const channel = String((deliveryContext as any).channel ?? "").trim() || "(none)";
  const to = String((deliveryContext as any).to ?? "").trim() || "(none)";
  const accountId = String((deliveryContext as any).accountId ?? "").trim() || "(none)";
  const threadId = (deliveryContext as any).threadId;
  return `${channel}:${to}:account=${accountId}${threadId != null ? `:thread=${String(threadId)}` : ""}`;
}

function buildPersonaPendingReply(status: "approval-pending" | "approval-unavailable"): string {
  if (status === "approval-pending") {
    return "我先去查，这一步需要审批，批完我继续回你。";
  }
  return "我先去申请一下查询权限，批完再继续给你补结果。";
}


function shouldUseMultimodalImages(napCatCfg: any, imageUrls: string[]): boolean {
  return napCatCfg.multimodalImagesEnabled !== false && imageUrls.length > 0;
}

function clampImageUrls(imageUrls: string[], maxCount: number): string[] {
  const normalized = imageUrls
    .map((url) => String(url ?? "").trim())
    .filter((url) => /^https?:\/\//i.test(url) || url.startsWith("base64://") || url.startsWith("file://"));
  return normalized.slice(0, Math.max(1, Number(maxCount || 1)));
}

function buildVisionSummaryPrompt(imageCount: number): string {
  if (imageCount <= 1) {
    return "请只观察当前这张图片，输出简短、客观的中文视觉摘要，不要回答用户问题，不要参考聊天历史。";
  }
  return `请只观察当前这 ${imageCount} 张图片，按“图片1/图片2/...”输出简短、客观的中文视觉摘要，不要回答用户问题，不要参考聊天历史。`;
}

function buildVisionQuestionPrompt(questionText: string, imageCount: number): string {
  const cleaned = questionText.trim() || "请根据图片直接回答用户刚才的问题。";
  if (imageCount <= 1) {
    return `请只基于当前这张图片回答用户问题：${cleaned}`;
  }
  return `请只基于当前这 ${imageCount} 张图片回答用户问题：${cleaned}`;
}

function buildVisionQuestionPromptWithContext(questionText: string, imageCount: number, contextBlock: string): string {
  const base = buildVisionQuestionPrompt(questionText, imageCount);
  const context = extractTaggedBlock(contextBlock, "chat_context");
  if (!context) return base;
  return [
    base,
    "",
    "补充语境：以下是当前这节群聊历史，仅用于帮助你理解这次问图问题，不要回答历史里没明确提到的内容。",
    context,
  ].join("\n");
}

function shouldUsePersonaReply(
  napCatCfg: any,
  params: {
    isGroup: boolean;
    groupId: number | undefined;
    routeAgentId: string;
  },
): boolean {
  const personaCfg = napCatCfg?.persona;
  if (!personaCfg?.enabled) return false;
  if (!params.isGroup) return false;
  if (params.groupId == null) return false;
  return true;
}

function buildGroupSectionContext(groupId: number, fallbackText: string): string {
  const contextSource = getMessagesSinceLastReply(groupId, 100);
  const contextLines = contextSource.length > 0
    ? contextSource.map((m) => `[${m.senderName}]: ${m.body}`).join("\n")
    : `[群聊]: ${fallbackText.trim()}`;
  return `<chat_context>\n${contextLines}\n</chat_context>`;
}

function buildDualBrainSupplementalContext(messageText: string): string {
  const imageContext = extractTaggedBlock(messageText, "image_context");
  if (!imageContext) return "";
  return `<image_context>\n${imageContext}\n</image_context>`;
}

function extractTaggedBlock(text: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i");
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? "";
}

function buildReplyAnchorExcerpt(groupId: number): string {
  const recent = getMessagesSinceLastReply(groupId, 4);
  return recent
    .map((m) => `[${m.senderName}]: ${m.body}`)
    .join("\n")
    .trim();
}

async function maybeBuildSectionImageContext(
  api: any,
  opts: {
    cfg: any;
    napCatCfg: any;
    groupId: number;
    contextSource: Array<{ senderName: string; body: string; timestamp: number }>;
    recentMessages: Array<{ senderName: string; body: string; timestamp: number }>;
  },
): Promise<string> {
  const questionText = opts.recentMessages.map((m) => `[${m.senderName}]: ${m.body}`).join("\n").trim();
  if (!looksLikeImageQuestion(questionText)) return "";

  const imageRefs = collectImageRefsFromEntries(opts.contextSource);
  if (imageRefs.length === 0) return "";

  const summaryAgentId = opts.napCatCfg?.persona?.coreAgentId ?? "persona-core";
  api.logger?.info?.(
    `[napcat] ▶ analyzing section images for pending question, summaryAgent=${summaryAgentId}, images=${imageRefs.length}`,
  );

  const imageAnswer = await answerImagesWithResponses({
    gatewayPort: opts.cfg?.gateway?.port ?? 18789,
    gatewayToken: opts.cfg?.gateway?.auth?.token ?? "",
    agentId: summaryAgentId,
    sessionKey: buildVisionSessionKey({
      agentId: summaryAgentId,
      mode: "answer",
      isGroup: true,
      groupId: opts.groupId,
      imageRefs,
    }),
    inputText: buildVisionQuestionPrompt(questionText, imageRefs.length),
    imageUrls: imageRefs,
  });

  return imageAnswer.trim() ? `<image_context>\n${imageAnswer.trim()}\n</image_context>` : "";
}

function collectImageRefsFromEntries(entries: Array<{ body: string }>): string[] {
  const refs = new Set<string>();
  for (const entry of entries) {
    for (const ref of getImageUrlsFromMessageContent(entry.body)) {
      const normalized = String(ref ?? "").trim();
      if (normalized) refs.add(normalized);
    }
  }
  return Array.from(refs).slice(0, 3);
}

function buildVisionSessionKey(params: {
  agentId: string;
  mode: "summary" | "answer";
  isGroup: boolean;
  groupId?: number;
  userId?: number;
  imageRefs: string[];
}): string {
  const scope = params.isGroup
    ? `group:${String(params.groupId ?? "unknown")}`
    : `user:${String(params.userId ?? "unknown")}`;
  return `agent:${params.agentId}:vision:${params.mode}:${scope}`.toLowerCase();
}

function evaluatePeriodicStaleHeuristic(params: {
  groupId: number;
  baselineMessageId?: number;
  baselineSenderName?: string;
}): { suppress: boolean; reason: string } {
  const baselineMessageId = Number(params.baselineMessageId ?? 0);
  const baselineSenderName = String(params.baselineSenderName ?? "").trim();
  if (!baselineMessageId || !baselineSenderName) {
    return { suppress: true, reason: "missing-baseline" };
  }

  const newMessages = getGroupMessagesAfterId(params.groupId, baselineMessageId, 8);
  if (newMessages.length === 0) {
    return { suppress: true, reason: "stale-without-visible-new-messages" };
  }

  const sameSenderFollowup = newMessages.some((message) => sameSenderName(message.senderName, baselineSenderName));
  if (sameSenderFollowup) {
    return { suppress: true, reason: "same-sender-followup" };
  }

  return { suppress: false, reason: "interleaving-other-speaker" };
}

function sameSenderName(left: string, right: string): boolean {
  return String(left ?? "").trim() !== "" && String(left ?? "").trim() === String(right ?? "").trim();
}

function extractReplyAnchorText(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const trimmed = String(candidate ?? "").trim();
    if (trimmed && trimmed !== "NO_REPLY") return trimmed.slice(0, 500);
  }
  return "";
}

function looksDirectedToBot(msg: OneBotMessage, selfId: number): boolean {
  if (isMentioned(msg, selfId)) return true;
  return getRawText(msg).includes("小爪");
}

function looksLikeImageQuestion(text: string): boolean {
  const normalized = String(text ?? "").toLowerCase();
  if (!normalized.trim()) return false;
  return /(图片|照片|自拍|表情包|表情|图里|这张图|这图片|长啥|长得|帅|好看|颜值|哪个|谁更|谁最|可爱|看到|看得到|看见|像不像)/i.test(normalized);
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
