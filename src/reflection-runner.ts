import {
  claimPendingReflectionSamples,
  markReflectionSamplesReflected,
  releaseReflectionSampleLease,
} from "./db.js";
import { runAgentTextViaRuntime } from "./runtime-agent.js";

export interface ReflectionBatchResult {
  processedCount: number;
  summary: string;
  sampleIds: number[];
  triggerSource: string;
}

export async function runReflectionBatch(api: any, params: {
  runtime: any;
  cfg: any;
  napCatCfg: any;
  limit?: number;
  groupId?: number;
  userId: number;
  senderName: string;
  replyTarget: string;
  triggerSource: "manual" | "heartbeat" | "cron";
  leaseMs?: number;
}): Promise<ReflectionBatchResult> {
  const {
    runtime,
    cfg,
    napCatCfg,
    limit,
    groupId,
    userId,
    senderName,
    replyTarget,
    triggerSource,
    leaseMs,
  } = params;
  const personaAgentId = napCatCfg?.persona?.coreAgentId ?? "persona-core";
  const reflectionSessionKey = groupId != null
    ? `agent:${personaAgentId}:reflection:group:${groupId}`
    : `agent:${personaAgentId}:reflection:global`;
  const claimed = claimPendingReflectionSamples({
    limit,
    groupId,
    leaseMs,
    triggerSource,
  });

  if (claimed.samples.length === 0 || !claimed.leaseToken) {
    return {
      processedCount: 0,
      summary: "",
      sampleIds: [],
      triggerSource,
    };
  }

  const sampleIds = claimed.samples.map((sample) => sample.id);
  const packets = claimed.samples.map((sample, index) => [
    `<sample_${index + 1}>`,
    `group_id: ${sample.group_id}`,
    `created_at: ${new Date(sample.created_at).toLocaleString("zh-CN")}`,
    `attempt_count: ${sample.attempt_count}`,
    `context_excerpt:`,
    sample.context_excerpt,
    `persona_draft: ${sample.persona_draft}`,
    `voice_final: ${sample.voice_final}`,
    `edit_distance_summary: ${buildEditDistanceSummary(sample.persona_draft, sample.voice_final)}`,
    `</sample_${index + 1}>`,
  ].join("\n")).join("\n\n");

  const inputText = [
    "<operating_mode>reflection</operating_mode>",
    "",
    `<trigger_source>${triggerSource}</trigger_source>`,
    "",
    "<reflection_packets>",
    packets,
    "</reflection_packets>",
    "",
    "<memory_candidates>",
    claimed.samples
      .map((sample) => `group ${sample.group_id}: ${sample.voice_final}`)
      .join("\n"),
    "</memory_candidates>",
    "",
    "<task>",
    "请回顾这些样本，判断哪些表达变化值得吸收。必要时更新当前工作区中的记忆或人格文件，然后用简短中文总结你这次做了什么。",
    "</task>",
  ].join("\n");

  api.logger?.info?.(
    `[napcat] ▶ reflection batch trigger=${triggerSource} session=${reflectionSessionKey} ` +
    `samples=${claimed.samples.length} requestedGroup=${groupId ?? "global"} replyTarget=${replyTarget}`,
  );

  try {
    const summaryResult = await runAgentTextViaRuntime(api, {
      runtime,
      cfg,
      agentId: personaAgentId,
      sessionKey: reflectionSessionKey,
      inputText,
      userId,
      groupId: undefined,
      isGroup: false,
      senderName,
      replyTarget,
    });
    const summary = summaryResult.finalText || `已完成 reflection，共处理 ${claimed.samples.length} 条样本。`;
    markReflectionSamplesReflected(sampleIds, claimed.leaseToken);
    return {
      processedCount: claimed.samples.length,
      summary,
      sampleIds,
      triggerSource,
    };
  } catch (err: any) {
    releaseReflectionSampleLease(sampleIds, {
      leaseToken: claimed.leaseToken,
      error: err?.message,
    });
    throw err;
  }
}

function buildEditDistanceSummary(before: string, after: string): string {
  const a = String(before ?? "").trim();
  const b = String(after ?? "").trim();
  if (!a && !b) return "both empty";
  if (!a) return "persona draft empty, final text added";
  if (!b) return "final text empty";
  if (a === b) return "unchanged";
  if (b.length < a.length) return "final text is shorter and tighter";
  if (b.length > a.length) return "final text is more expanded or reshaped";
  return "wording changed with similar length";
}
