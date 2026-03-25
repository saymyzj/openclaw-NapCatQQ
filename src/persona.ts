const PERSONA_TIMEOUT_MS = 45000;
const VOICE_TIMEOUT_MS = 18000;
const REFLECTION_TIMEOUT_MS = 180000;

export interface PersonaTurn {
  schema_version: string;
  decision: {
    action: "speak" | "silence";
    reason: string;
    confidence: number;
  };
  world_model: {
    facts: string[];
    visual_findings: string[];
    unknowns: string[];
  };
  delivery: {
    reply_to: "current" | "thread";
    final_text: string;
  };
  tool_intent: {
    type: string;
    summary: string;
    requires_admin_approval: boolean;
  };
  self_update_intent: {
    need_update: boolean;
    target: string;
    reason: string;
    proposed_change: string;
  };
  state_update: {
    memory_candidates: string[];
  };
  safety: {
    risk: "low" | "medium" | "high";
    notes: string[];
  };
}

type LegacyPersonaTurn = {
  schema?: string;
  should_speak?: boolean;
  delivery?: {
    final_text?: string;
    reply_to?: "current" | "thread";
  };
  tool_intent?: {
    type?: string;
    summary?: string;
    requires_admin_approval?: boolean;
  };
  self_update_intent?: {
    need_update?: boolean;
    target?: string;
    reason?: string;
    proposed_change?: string;
  };
  state_update?: {
    memory_candidates?: string[];
  };
  world_model?: {
    facts?: string[];
    visual_findings?: string[];
    unknowns?: string[];
  };
  safety?: {
    risk?: "low" | "medium" | "high";
    notes?: string[];
  };
};

const DEFAULT_PERSONA_TURN: PersonaTurn = {
  schema_version: "persona-core.turn.v3",
  decision: {
    action: "silence",
    reason: "",
    confidence: 0,
  },
  world_model: {
    facts: [],
    visual_findings: [],
    unknowns: [],
  },
  delivery: {
    reply_to: "current",
    final_text: "",
  },
  tool_intent: {
    type: "none",
    summary: "",
    requires_admin_approval: false,
  },
  self_update_intent: {
    need_update: false,
    target: "none",
    reason: "",
    proposed_change: "",
  },
  state_update: {
    memory_candidates: [],
  },
  safety: {
    risk: "low",
    notes: [],
  },
};

export async function requestPersonaTurn(opts: {
  gatewayPort: number;
  gatewayToken: string;
  agentId: string;
  sessionKey: string;
  inputText: string;
}): Promise<PersonaTurn> {
  const responseText = await callGatewayChatCompletions({
    gatewayPort: opts.gatewayPort,
    gatewayToken: opts.gatewayToken,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    temperature: 0.3,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "persona_core_turn_v3",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            schema_version: { type: "string" },
            decision: {
              type: "object",
              additionalProperties: false,
              properties: {
                action: { type: "string", enum: ["speak", "silence"] },
                reason: { type: "string" },
                confidence: { type: "number" },
              },
              required: ["action", "reason", "confidence"],
            },
            world_model: {
              type: "object",
              additionalProperties: false,
              properties: {
                facts: { type: "array", items: { type: "string" }, maxItems: 12 },
                visual_findings: { type: "array", items: { type: "string" }, maxItems: 8 },
                unknowns: { type: "array", items: { type: "string" }, maxItems: 8 },
              },
              required: ["facts", "visual_findings", "unknowns"],
            },
            delivery: {
              type: "object",
              additionalProperties: false,
              properties: {
                reply_to: { type: "string", enum: ["current", "thread"] },
                final_text: { type: "string" },
              },
              required: ["reply_to", "final_text"],
            },
            tool_intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string" },
                summary: { type: "string" },
                requires_admin_approval: { type: "boolean" },
              },
              required: ["type", "summary", "requires_admin_approval"],
            },
            self_update_intent: {
              type: "object",
              additionalProperties: false,
              properties: {
                need_update: { type: "boolean" },
                target: { type: "string" },
                reason: { type: "string" },
                proposed_change: { type: "string" },
              },
              required: ["need_update", "target", "reason", "proposed_change"],
            },
            state_update: {
              type: "object",
              additionalProperties: false,
              properties: {
                memory_candidates: { type: "array", items: { type: "string" }, maxItems: 8 },
              },
              required: ["memory_candidates"],
            },
            safety: {
              type: "object",
              additionalProperties: false,
              properties: {
                risk: { type: "string", enum: ["low", "medium", "high"] },
                notes: { type: "array", items: { type: "string" }, maxItems: 8 },
              },
              required: ["risk", "notes"],
            },
          },
          required: [
            "schema_version",
            "decision",
            "world_model",
            "delivery",
            "tool_intent",
            "self_update_intent",
            "state_update",
            "safety",
          ],
        },
      },
    },
    messages: [
      {
        role: "system",
        content: [
          "你是 persona-core，本体人格，不是客服，不是规划器，也不是文案器官。",
          "你要结合这一节真实群聊历史、可能的图片感知结果、最近互动状态，决定现在要不要说话。",
          "如果应该说，只给一句你自己本来就愿意发出的核心回复，不要把表达空间提前写死给 voice-organ。",
          "不要输出 markdown，不要输出代码块，不要解释内部机制。",
          "如果当前回合更适合沉默，就输出 action=silence。",
          "不要使用 exec，也不要调用依赖 exec / shell / python 的 skill。",
          "如果需要联网找公开信息，优先使用可直接联网的工具；如果确实需要 shell 或脚本，只在 tool_intent 里表达意图，不要自行执行。",
          "如果需要联网或高风险动作，可以在 tool_intent 中表达，但不要编造已经执行过的结果。",
          "如果你认为某些风格或记忆值得未来吸收，可以在 self_update_intent 里表达，但聊天回合不要求你立刻修改文件。",
        ].join("\n"),
      },
      {
        role: "user",
        content: opts.inputText,
      },
    ],
  });

  return normalizePersonaTurn(responseText);
}

export async function requestVoiceTurn(opts: {
  gatewayPort: number;
  gatewayToken: string;
  agentId: string;
  sessionKey: string;
  inputText: string;
  timeoutMs?: number;
}): Promise<string> {
  const responseText = await callGatewayChatCompletions({
    gatewayPort: opts.gatewayPort,
    gatewayToken: opts.gatewayToken,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    temperature: 0.85,
    timeoutMs: opts.timeoutMs ?? VOICE_TIMEOUT_MS,
    reasoning: {
      effort: "none",
      exclude: true,
      enabled: false,
    },
    extraBody: {
      include_reasoning: false,
      thinking: { type: "disabled" },
    },
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "voice_organ_turn_v2",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            schema_version: { type: "string" },
            final_text: { type: "string" },
          },
          required: ["schema_version", "final_text"],
        },
      },
    },
    messages: [
      {
        role: "system",
        content: [
          "你是 voice-organ，只负责把 persona-core 已经决定的意思，说得更自然、更像群友。",
          "不能新增事实，不能改变风险判断，不能暴露内部机制。",
          "你收到的是本体想表达的核心草稿，不是必须原样照抄的终稿。",
          "默认应当重写措辞，让它更顺口、更像群聊里会发出来的话。",
          "只有在原句已经足够自然、继续改写反而更差时，才允许原样输出。",
          "你只有一个任务：输出最终一句话。",
        ].join("\n"),
      },
      {
        role: "user",
        content: opts.inputText,
      },
    ],
  });

  return normalizeVoiceText(responseText);
}

export async function requestPersonaReflection(opts: {
  gatewayPort: number;
  gatewayToken: string;
  agentId: string;
  sessionKey: string;
  inputText: string;
}): Promise<string> {
  const responseText = await callGatewayChatCompletions({
    gatewayPort: opts.gatewayPort,
    gatewayToken: opts.gatewayToken,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    temperature: 0.2,
    timeoutMs: REFLECTION_TIMEOUT_MS,
    messages: [
      {
        role: "system",
        content: [
          "你是 persona-core，当前处于 reflection 模式。",
          "你的任务是回顾最近几轮中你自己的草稿与最终发出去的话，判断哪些变化值得吸收成长期人格与表达习惯。",
          "如果有必要，你可以更新当前工作区中的 MEMORY.md、IDENTITY.md、SOUL.md 或 daily memory。",
          "只有在变化足够稳定、合理、不会破坏安全边界时，才修改 SOUL.md。",
          "reflection 只允许做人格文件维护，不要把版本控制、提交、清理工作区当成任务的一部分。",
          "不要使用 git、commit、status、add、diff、rm、mv、python 或其他 shell 收尾动作。",
          "不要使用 exec，也不要调用依赖 exec / shell / python 的 skill。",
          "如果你认为某个文件应该删除或移动，只在总结里说明，不要自己执行删除或移动。",
          "最后只输出一小段中文总结，不要输出 markdown，不要输出代码块。",
        ].join("\n"),
      },
      {
        role: "user",
        content: opts.inputText,
      },
    ],
  });

  return responseText.replace(/^```(?:text|markdown)?/i, "").replace(/```$/i, "").trim();
}

async function callGatewayChatCompletions(opts: {
  gatewayPort: number;
  gatewayToken: string;
  agentId: string;
  sessionKey: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  responseFormat?: Record<string, unknown>;
  extraBody?: Record<string, unknown>;
  reasoning?: {
    effort?: "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
    exclude?: boolean;
    enabled?: boolean;
  };
  timeoutMs?: number;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("persona chat completion timeout")), opts.timeoutMs ?? PERSONA_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${opts.gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${opts.gatewayToken}`,
        "x-openclaw-agent-id": opts.agentId,
        "x-openclaw-session-key": opts.sessionKey,
      },
      body: JSON.stringify({
        model: `openclaw:${opts.agentId}`,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.2,
        ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
        ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
        ...(opts.extraBody ?? {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`chat completions ${response.status}: ${body.slice(0, 300) || response.statusText}`);
    }

    const data = await response.json();
    return String(data?.choices?.[0]?.message?.content ?? "").trim();
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizePersonaTurn(raw: string): PersonaTurn {
  try {
    const parsed = JSON.parse(raw) as Partial<PersonaTurn> & LegacyPersonaTurn;
    const normalizedSchemaVersion = normalizeString(
      parsed.schema_version ?? parsed.schema,
      DEFAULT_PERSONA_TURN.schema_version,
    );
    const normalizedFinalText = normalizeString(parsed.delivery?.final_text, "");
    const legacyShouldSpeak = typeof parsed.should_speak === "boolean" ? parsed.should_speak : undefined;
    const normalizedAction = parsed.decision?.action === "speak"
      ? "speak"
      : parsed.decision?.action === "silence"
        ? "silence"
        : legacyShouldSpeak === true
          ? "speak"
          : legacyShouldSpeak === false
            ? "silence"
            : normalizedFinalText
              ? "speak"
              : "silence";
    const normalizedReason = normalizeString(
      parsed.decision?.reason,
      legacyShouldSpeak != null ? "legacy_should_speak" : normalizedFinalText ? "legacy_final_text" : "",
    );
    const normalizedConfidence = normalizeNumber(
      parsed.decision?.confidence,
      legacyShouldSpeak != null ? 0.8 : normalizedFinalText ? 0.3 : 0,
    );

    return {
      schema_version: normalizedSchemaVersion,
      decision: {
        action: normalizedAction,
        reason: normalizedReason,
        confidence: normalizedConfidence,
      },
      world_model: {
        facts: normalizeStringArray(parsed.world_model?.facts, 12),
        visual_findings: normalizeStringArray(parsed.world_model?.visual_findings, 8),
        unknowns: normalizeStringArray(parsed.world_model?.unknowns, 8),
      },
      delivery: {
        reply_to: parsed.delivery?.reply_to === "thread" ? "thread" : "current",
        final_text: normalizedFinalText,
      },
      tool_intent: {
        type: normalizeString(parsed.tool_intent?.type, "none"),
        summary: normalizeString(parsed.tool_intent?.summary, ""),
        requires_admin_approval: Boolean(parsed.tool_intent?.requires_admin_approval),
      },
      self_update_intent: {
        need_update: Boolean(parsed.self_update_intent?.need_update),
        target: normalizeString(parsed.self_update_intent?.target, "none"),
        reason: normalizeString(parsed.self_update_intent?.reason, ""),
        proposed_change: normalizeString(parsed.self_update_intent?.proposed_change, ""),
      },
      state_update: {
        memory_candidates: normalizeStringArray(parsed.state_update?.memory_candidates, 8),
      },
      safety: {
        risk: normalizeRisk(parsed.safety?.risk),
        notes: normalizeStringArray(parsed.safety?.notes, 8),
      },
    };
  } catch {
    const fallback = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    return {
      ...DEFAULT_PERSONA_TURN,
      decision: {
        action: fallback ? "speak" : "silence",
        reason: fallback ? "fallback_text" : "",
        confidence: fallback ? 0.3 : 0,
      },
      delivery: {
        reply_to: "current",
        final_text: fallback,
      },
      world_model: {
        facts: fallback ? [fallback] : [],
        visual_findings: [],
        unknowns: [],
      },
    };
  }
}

export function normalizeVoiceText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { final_text?: string; text?: string };
    const normalized = normalizeString(parsed.final_text ?? parsed.text, "");
    if (normalized) return normalized;
  } catch {
    // fall through
  }
  return raw.replace(/^```(?:json|text|markdown)?/i, "").replace(/```$/i, "").trim();
}

function normalizeString(value: unknown, fallback: string): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeRisk(value: unknown): "low" | "medium" | "high" {
  switch (String(value ?? "").trim()) {
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      return "low";
  }
}
