import { readFile } from "node:fs/promises";
import path from "node:path";

const RUNTIME_DEFERRED_POLL_MS = 8_000;
const RUNTIME_DEFERRED_POLL_INTERVAL_MS = 250;

export type RuntimeAgentRunResult = {
  finalText: string;
  status: "completed" | "approval-pending" | "approval-unavailable" | "deferred";
  approvalMessage: string;
  queuedFinal: boolean;
};

export async function runAgentTextViaRuntime(
  api: any,
  params: {
    runtime: any;
    cfg: any;
    agentId: string;
    sessionKey: string;
    inputText: string;
    userId: number;
    groupId: number | undefined;
    isGroup: boolean;
    senderName: string;
    replyTarget: string;
  },
): Promise<RuntimeAgentRunResult> {
  const { runtime, cfg, agentId, sessionKey, inputText, userId, groupId, isGroup, senderName, replyTarget } = params;
  const accountId = "default";
  const chatType = isGroup ? "group" : "direct";
  const dispatchStartedAt = Date.now();
  const storePath = runtime.channel.session?.resolveStorePath?.(cfg?.session?.store, {
    agentId,
  }) ?? "";
  const envelopeOptions = runtime.channel.reply?.resolveEnvelopeFormatOptions?.(cfg) ?? {};
  const formattedBody =
    runtime.channel.reply?.formatInboundEnvelope?.({
      channel: "NapCat",
      from: senderName,
      timestamp: Date.now(),
      body: inputText,
      chatType,
      sender: { name: senderName, id: String(userId) },
      envelope: envelopeOptions,
    }) ?? { content: [{ type: "text", text: inputText }] };

  const ctxPayload = {
    Body: formattedBody,
    BodyForAgent: inputText,
    BodyForCommands: inputText,
    RawBody: inputText,
    CommandBody: inputText,
    From: replyTarget,
    To: replyTarget,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: chatType,
    ConversationLabel: replyTarget,
    SenderName: senderName,
    SenderId: String(userId),
    Provider: "napcat",
    Surface: "napcat",
    MessageSid: `napcat-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    Timestamp: Date.now(),
    OriginatingChannel: "napcat",
    OriginatingTo: replyTarget,
    CommandAuthorized: false,
    DeliveryContext: {
      channel: "napcat",
      to: replyTarget,
      accountId,
    },
    _napcat: { userId, groupId, isGroup, senderName },
  };

  api.logger?.info?.(
    `[napcat] ▶ runtime dispatch agent=${agentId} sessionKey=${sessionKey} replyTarget=${replyTarget} ` +
    `storePath=${storePath || "(empty)"} origin=${ctxPayload.OriginatingChannel}:${ctxPayload.OriginatingTo} ` +
    `delivery=${formatDeliveryContextForLog(ctxPayload.DeliveryContext)} chatType=${chatType}`,
  );

  if (runtime.channel.session?.recordInboundSession) {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey,
        channel: "napcat",
        to: replyTarget,
        accountId,
      },
      onRecordError: (err: any) => api.logger?.warn?.(`[napcat] runtime recordInboundSession(${agentId}): ${err}`),
    });
    api.logger?.info?.(
      `[napcat] ▶ runtime session recorded agent=${agentId} sessionKey=${sessionKey} ` +
      `updateLastRoute=napcat:${replyTarget} account=${accountId}`,
    );
  }

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({ channel: "napcat", accountId, direction: "inbound" });
  }

  let finalText = "";
  let deliverError: Error | null = null;
  const result = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: unknown, info: { kind: string }) => {
        if (info.kind !== "final") return;
        finalText = extractRuntimeFinalText(
          typeof payload === "string" ? payload : (payload as any)?.text,
          typeof payload === "string" ? "" : (payload as any)?.body,
        );
      },
      onError: async (err: any) => {
        deliverError = err instanceof Error ? err : new Error(String(err));
      },
    },
  });

  if (deliverError) throw deliverError;
  const approvalState = await detectApprovalStateFromSession({
    storePath,
    sessionKey,
    startedAtMs: dispatchStartedAt,
  });
  if (!result?.queuedFinal && !finalText.trim() && approvalState.status === "completed") {
    const deferredState = await detectDeferredRuntimeStateFromSession({
      storePath,
      sessionKey,
      startedAtMs: dispatchStartedAt,
      waitMs: RUNTIME_DEFERRED_POLL_MS,
      pollIntervalMs: RUNTIME_DEFERRED_POLL_INTERVAL_MS,
    });
    if (deferredState.status === "deferred") {
      api.logger?.info?.(
        `[napcat] runtime dispatch deferred agent=${agentId} sessionKey=${sessionKey} reason=${deferredState.reason}`,
      );
      return {
        finalText: "",
        status: "deferred",
        approvalMessage: "",
        queuedFinal: false,
      };
    }
    throw new Error(`runtime agent ${agentId} produced no final reply`);
  }
  api.logger?.info?.(
    `[napcat] ▶ runtime dispatch settled agent=${agentId} sessionKey=${sessionKey} ` +
    `queuedFinal=${String(Boolean(result?.queuedFinal))} finalChars=${finalText.trim().length} ` +
    `status=${approvalState.status}`,
  );
  return {
    finalText: finalText.trim(),
    status: approvalState.status,
    approvalMessage: approvalState.message,
    queuedFinal: Boolean(result?.queuedFinal),
  };
}

function formatDeliveryContextForLog(deliveryContext: unknown): string {
  if (!deliveryContext || typeof deliveryContext !== "object") return "(none)";
  const channel = String((deliveryContext as any).channel ?? "").trim() || "(none)";
  const to = String((deliveryContext as any).to ?? "").trim() || "(none)";
  const accountId = String((deliveryContext as any).accountId ?? "").trim() || "(none)";
  const threadId = (deliveryContext as any).threadId;
  return `${channel}:${to}:account=${accountId}${threadId != null ? `:thread=${String(threadId)}` : ""}`;
}

async function detectApprovalStateFromSession(params: {
  storePath: string;
  sessionKey: string;
  startedAtMs: number;
}): Promise<{ status: RuntimeAgentRunResult["status"]; message: string }> {
  const sessionFile = await resolveSessionFilePath(params.storePath, params.sessionKey);
  if (!sessionFile) {
    return { status: "completed", message: "" };
  }

  try {
    const sessionRaw = await readFile(sessionFile, "utf8");
    const lines = sessionRaw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-40);

    let latestStatus: "approval-pending" | "approval-unavailable" | null = null;
    let latestMessage = "";

    for (const line of lines) {
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const timestampMs = Date.parse(String(parsed?.timestamp ?? ""));
      if (Number.isFinite(timestampMs) && timestampMs < params.startedAtMs - 2000) {
        continue;
      }

      if (parsed?.type !== "message") continue;
      if (parsed?.message?.role !== "toolResult") continue;
      const details = parsed?.message?.details;
      if (!details || typeof details !== "object") continue;
      if (details.status !== "approval-pending" && details.status !== "approval-unavailable") continue;

      latestStatus = details.status;
      latestMessage = String(
        parsed?.message?.content?.[0]?.text ??
        details.warningText ??
        "",
      ).trim();
    }

    return latestStatus
      ? { status: latestStatus, message: latestMessage }
      : { status: "completed", message: "" };
  } catch {
    return { status: "completed", message: "" };
  }
}

async function detectDeferredRuntimeStateFromSession(params: {
  storePath: string;
  sessionKey: string;
  startedAtMs: number;
  waitMs: number;
  pollIntervalMs: number;
}): Promise<{ status: "completed" | "deferred"; reason: string }> {
  const sessionFile = await resolveSessionFilePath(params.storePath, params.sessionKey);
  if (!sessionFile) return { status: "completed", reason: "" };

  const deadline = Date.now() + Math.max(0, params.waitMs);
  while (true) {
    try {
      const sessionRaw = await readFile(sessionFile, "utf8");
      const lines = sessionRaw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-120);

      for (const line of lines) {
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const timestampMs = Date.parse(String(parsed?.timestamp ?? ""));
        if (Number.isFinite(timestampMs) && timestampMs < params.startedAtMs - 2000) {
          continue;
        }

        if (parsed?.type !== "message") continue;
        const role = String(parsed?.message?.role ?? "");
        const text = extractSessionMessageText(parsed);

        if (role === "user" && text.includes("[Queued messages while agent was busy]")) {
          return { status: "deferred", reason: "queued-followup" };
        }

        if (
          role === "assistant" &&
          String(parsed?.message?.provider ?? "").trim() === "openclaw" &&
          String(parsed?.message?.model ?? "").trim() === "delivery-mirror"
        ) {
          return { status: "deferred", reason: "delivery-mirror" };
        }
      }
    } catch {
      return { status: "completed", reason: "" };
    }

    if (Date.now() >= deadline) break;
    await sleep(params.pollIntervalMs);
  }

  return { status: "completed", reason: "" };
}

async function resolveSessionFilePath(storePath: string, sessionKey: string): Promise<string | null> {
  if (!storePath) return null;
  try {
    const storeRaw = await readFile(storePath, "utf8");
    const store = JSON.parse(storeRaw) as Record<string, { sessionId?: string; sessionFile?: string }>;
    const entry = store[sessionKey];
    if (!entry?.sessionId && !entry?.sessionFile) {
      return null;
    }
    return entry.sessionFile
      ? String(entry.sessionFile)
      : path.join(path.dirname(storePath), `${String(entry.sessionId)}.jsonl`);
  } catch {
    return null;
  }
}

function extractSessionMessageText(parsed: any): string {
  const content = Array.isArray(parsed?.message?.content) ? parsed.message.content : [];
  return content
    .map((item: any) => String(item?.text ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractRuntimeFinalText(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const trimmed = String(candidate ?? "").trim();
    if (trimmed && trimmed !== "NO_REPLY") return trimmed;
  }
  return "";
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
