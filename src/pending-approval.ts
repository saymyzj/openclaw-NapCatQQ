import { createHash } from "node:crypto";

import {
  findDeliveredFollowupByFingerprint,
  getPendingFollowupJob,
  markFollowupJobDelivered,
  registerFollowupJob,
} from "./db.js";
import { normalizePersonaTurn, normalizeVoiceText, requestVoiceTurn } from "./persona.js";
import { runAgentTextViaRuntime } from "./runtime-agent.js";

type PendingApprovalSurfaceEntry = {
  groupId: number;
  chatContextExcerpt: string;
  personaAgentId: string;
  voiceAgentId: string;
  personaSessionKey: string;
  voiceSessionKey: string;
  gatewayPort: number;
  gatewayToken: string;
  ttlMs?: number;
};

export function registerPendingApprovalSurface(targetKey: string, entry: PendingApprovalSurfaceEntry): void {
  const normalized = normalizeTargetKey(targetKey);
  if (!normalized) return;
  registerFollowupJob({
    targetKey: normalized,
    groupId: Number(entry.groupId),
    personaSessionKey: String(entry.personaSessionKey ?? ""),
    voiceSessionKey: String(entry.voiceSessionKey ?? ""),
    personaAgentId: String(entry.personaAgentId ?? "persona-core"),
    voiceAgentId: String(entry.voiceAgentId ?? "voice-organ"),
    chatContextExcerpt: String(entry.chatContextExcerpt ?? ""),
    ttlMs: entry.ttlMs,
  });
}

export async function finalizePendingApprovalFollowup(params: {
  target: { type: "user" | "group"; id: number } | null;
  text: string;
  cfg?: any;
}): Promise<{ text: string; suppress: boolean }> {
  const { target, cfg } = params;
  if (!target || target.type !== "group") {
    return { text: params.text, suppress: false };
  }

  const normalizedText = String(params.text ?? "").trim();
  if (!normalizedText) {
    return { text: params.text, suppress: false };
  }

  const targetKey = normalizeTargetKey(`group:${target.id}`);
  const rawFingerprint = fingerprint(normalizedText);
  if (findDeliveredFollowupByFingerprint(targetKey, rawFingerprint)) {
    return { text: "", suppress: true };
  }

  const pending = getPendingFollowupJob(targetKey);
  if (!pending) {
    return { text: params.text, suppress: false };
  }

  const finalText = await buildFollowupReply({
    pending,
    rawText: normalizedText,
    cfg,
  });
  markFollowupJobDelivered({
    jobId: pending.id,
    rawFingerprint,
    finalText,
  });
  return { text: finalText, suppress: false };
}

async function buildFollowupReply(opts: {
  pending: ReturnType<typeof getPendingFollowupJob> extends infer T ? Exclude<T, null> : never;
  rawText: string;
  cfg?: any;
}): Promise<string> {
  const runtimeReply = await tryRuntimeFollowup(opts).catch(() => "");
  if (runtimeReply.trim()) return runtimeReply.trim();

  const voiceFallback = await tryVoiceFallback(opts).catch(() => "");
  if (voiceFallback.trim()) return voiceFallback.trim();

  return opts.rawText;
}

async function tryRuntimeFollowup(opts: {
  pending: NonNullable<ReturnType<typeof getPendingFollowupJob>>;
  rawText: string;
  cfg?: any;
}): Promise<string> {
  const api = (globalThis as any).__napCatApi;
  const runtime = api?.runtime;
  if (!api || !runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) return "";

  const personaResult = await runAgentTextViaRuntime(api, {
    runtime,
    cfg: opts.cfg,
    agentId: opts.pending.persona_agent_id || "persona-core",
    sessionKey: opts.pending.persona_session_key || `agent:persona-core:napcat:group:${opts.pending.group_id}`,
    inputText: [
      "<operating_mode>chat</operating_mode>",
      "",
      "<chat_context>",
      opts.pending.chat_context_excerpt,
      "</chat_context>",
      "",
      "<tool_followup_result>",
      opts.rawText,
      "</tool_followup_result>",
      "",
      "<task>",
      "你之前有一轮群聊回复因为工具审批而挂起，现在工具结果已经返回。",
      "请基于这段结果，给出你现在真正要在群里说的核心回复，并严格输出 persona-core.turn.v3 JSON。",
      "不要重复等待话术，不要暴露审批或工具内部机制。",
      "</task>",
    ].join("\n"),
    userId: 0,
    groupId: opts.pending.group_id,
    isGroup: true,
    senderName: "approval-followup",
    replyTarget: `napcat:group:${opts.pending.group_id}`,
  });
  const turn = normalizePersonaTurn(personaResult.finalText);
  let finalText = turn.delivery.final_text.trim();
  if (!finalText) {
    finalText = opts.rawText;
  }

  try {
    const voiceInput = [
      "<operating_mode>surface</operating_mode>",
      "",
      "<chat_context_excerpt>",
      opts.pending.chat_context_excerpt,
      "</chat_context_excerpt>",
      "",
      "<persona_packet>",
      JSON.stringify({
        draft: {
          reply_to: "current",
          core_text: finalText,
        },
      }, null, 2),
      "</persona_packet>",
      "",
      "<task>",
      "请把这句审批完成后的群聊回复改写成更自然、更像群友的一句话。",
      "不要新增未经确认的细节。",
      "请只输出 voice-organ.turn.v2 JSON。",
      "</task>",
    ].join("\n");

    const gatewayPort = opts.cfg?.gateway?.port ?? 18789;
    const gatewayToken = String(opts.cfg?.gateway?.auth?.token ?? "").trim();
    let voiced = "";
    if (gatewayToken) {
      voiced = await requestVoiceTurn({
        gatewayPort,
        gatewayToken,
        agentId: opts.pending.voice_agent_id || "voice-organ",
        sessionKey: opts.pending.voice_session_key || `agent:voice-organ:surface:group:${opts.pending.group_id}`,
        inputText: voiceInput,
        timeoutMs: 60_000,
      });
    } else {
      const voiceResult = await runAgentTextViaRuntime(api, {
        runtime,
        cfg: opts.cfg,
        agentId: opts.pending.voice_agent_id || "voice-organ",
        sessionKey: opts.pending.voice_session_key || `agent:voice-organ:surface:group:${opts.pending.group_id}`,
        inputText: voiceInput,
        userId: 0,
        groupId: opts.pending.group_id,
        isGroup: true,
        senderName: "approval-followup",
        replyTarget: `napcat:group:${opts.pending.group_id}`,
      });
      voiced = normalizeVoiceText(voiceResult.finalText);
    }
    if (voiced.trim()) finalText = voiced.trim();
  } catch {
    // fall back to persona text
  }

  return finalText.trim();
}

async function tryVoiceFallback(opts: {
  pending: NonNullable<ReturnType<typeof getPendingFollowupJob>>;
  rawText: string;
  cfg?: any;
}): Promise<string> {
  const gatewayPort = opts.cfg?.gateway?.port ?? 18789;
  const gatewayToken = opts.cfg?.gateway?.auth?.token ?? "";
  if (!gatewayToken) return "";
  return requestVoiceTurn({
    gatewayPort,
    gatewayToken,
    agentId: opts.pending.voice_agent_id || "voice-organ",
    sessionKey: opts.pending.voice_session_key || `agent:voice-organ:surface:group:${opts.pending.group_id}`,
    timeoutMs: 60_000,
    inputText: [
      "<operating_mode>surface</operating_mode>",
      "",
      "<chat_context_excerpt>",
      opts.pending.chat_context_excerpt,
      "</chat_context_excerpt>",
      "",
      "<persona_packet>",
      JSON.stringify({
        draft: {
          reply_to: "current",
          core_text: opts.rawText.replace(/^\[\[reply_to_current\]\]\s*/i, ""),
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
}

function normalizeTargetKey(targetKey: string): string {
  return String(targetKey ?? "").trim().toLowerCase();
}

function fingerprint(text: string): string {
  return createHash("sha1").update(String(text ?? "").trim()).digest("hex");
}
