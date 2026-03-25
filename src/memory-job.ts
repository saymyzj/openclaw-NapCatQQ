import {
  claimDailyMemoryJobs,
  completeDailyMemoryJob,
  failDailyMemoryJob,
  getMessagesForDailyMemory,
  getReflectionSamplesForDailyMemory,
} from "./db.js";
import { runAgentTextViaRuntime } from "./runtime-agent.js";

export interface DailyMemoryBatchResult {
  dateKey: string;
  processedGroups: number;
  summaries: string[];
}

export async function runDailyMemoryBatch(api: any, params: {
  runtime: any;
  cfg: any;
  napCatCfg: any;
  limit?: number;
  userId: number;
  senderName: string;
  replyTarget: string;
  triggerSource: "manual" | "heartbeat" | "cron";
  dateKey?: string;
  leaseMs?: number;
}): Promise<DailyMemoryBatchResult> {
  const {
    runtime,
    cfg,
    napCatCfg,
    limit,
    userId,
    senderName,
    replyTarget,
    triggerSource,
    dateKey = formatDateKey(Date.now()),
    leaseMs,
  } = params;
  const range = getDateRange(dateKey);
  const personaAgentId = napCatCfg?.persona?.coreAgentId ?? "persona-core";
  const jobs = claimDailyMemoryJobs({
    dateKey,
    startTs: range.startTs,
    endTs: range.endTs,
    limit,
    leaseMs,
  });
  const summaries: string[] = [];

  for (const job of jobs) {
    try {
      const messages = getMessagesForDailyMemory({
        groupId: job.group_id,
        startTs: range.startTs,
        endTs: range.endTs,
        afterMessageId: job.last_message_id,
        limit: 80,
      });
      const samples = getReflectionSamplesForDailyMemory({
        groupId: job.group_id,
        startTs: range.startTs,
        endTs: range.endTs,
        afterSampleId: job.last_reflection_sample_id,
        limit: 30,
      });

      if (messages.length === 0 && samples.length === 0) {
        completeDailyMemoryJob({
          dateKey,
          groupId: job.group_id,
          leaseToken: job.leaseToken,
          lastMessageId: job.latestMessageId,
          lastReflectionSampleId: job.latestReflectionSampleId,
        });
        continue;
      }

      const inputText = [
        "<operating_mode>reflection</operating_mode>",
        "",
        `<trigger_source>${triggerSource}</trigger_source>`,
        `<daily_memory_date>${dateKey}</daily_memory_date>`,
        `<group_id>${job.group_id}</group_id>`,
        "",
        "<group_chat_packets>",
        messages.map((message, index) => [
          `<message_${index + 1}>`,
          `id: ${message.id}`,
          `time: ${new Date(message.timestamp).toLocaleString("zh-CN")}`,
          `speaker: ${message.sender_name}`,
          "content:",
          message.content,
          `</message_${index + 1}>`,
        ].join("\n")).join("\n\n"),
        "</group_chat_packets>",
        "",
        "<bot_reply_packets>",
        samples.map((sample, index) => [
          `<reply_${index + 1}>`,
          `sample_id: ${sample.id}`,
          `time: ${new Date(sample.created_at).toLocaleString("zh-CN")}`,
          `persona_draft: ${sample.persona_draft}`,
          `voice_final: ${sample.voice_final}`,
          `</reply_${index + 1}>`,
        ].join("\n")).join("\n\n"),
        "</bot_reply_packets>",
        "",
        "<task>",
        `请把这些今天新增的聊天片段增量沉淀到 memory/${dateKey}.md。`,
        "只更新当天 daily memory，不要改 MEMORY.md、IDENTITY.md、SOUL.md。",
        `这份 daily memory 是同一天共享文件，但你这次只处理 group_id=${job.group_id} 的内容。`,
        `必须使用标题“## group_id: ${job.group_id}”作为本群分段；如果该分段已存在，只更新该分段；如果不存在，就新增该分段。`,
        "不要把当前群的内容写进其他 group_id 分段，也不要改写其他群已经存在的分段。",
        "内容以“事实 + 互动感受 + 值得吸收的表达变化”为主，不要照抄整段群聊流水。",
        "如果今天文件已存在，做增量续写或轻度整理；不要把之前已经写过的内容重复写一遍。",
        "最后只用简短中文总结本次补写了什么。",
        "</task>",
      ].join("\n");

      const result = await runAgentTextViaRuntime(api, {
        runtime,
        cfg,
        agentId: personaAgentId,
        sessionKey: `agent:${personaAgentId}:daily-memory:${dateKey}`,
        inputText,
        userId,
        groupId: undefined,
        isGroup: false,
        senderName,
        replyTarget,
      });

      completeDailyMemoryJob({
        dateKey,
        groupId: job.group_id,
        leaseToken: job.leaseToken,
        lastMessageId: job.latestMessageId,
        lastReflectionSampleId: job.latestReflectionSampleId,
      });
      summaries.push(`group ${job.group_id}: ${result.finalText || "daily memory updated"}`);
    } catch (err: any) {
      failDailyMemoryJob({
        dateKey,
        groupId: job.group_id,
        leaseToken: job.leaseToken,
        error: err?.message,
      });
      throw err;
    }
  }

  return {
    dateKey,
    processedGroups: summaries.length,
    summaries,
  };
}

function formatDateKey(timestampMs: number): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(timestampMs));
}

function getDateRange(dateKey: string): { startTs: number; endTs: number } {
  const [year, month, day] = String(dateKey).split("-").map((part) => Number(part));
  const start = new Date(year, Math.max(0, month - 1), day, 0, 0, 0, 0);
  const end = new Date(year, Math.max(0, month - 1), day + 1, 0, 0, 0, 0);
  return {
    startTs: start.getTime(),
    endTs: end.getTime(),
  };
}
