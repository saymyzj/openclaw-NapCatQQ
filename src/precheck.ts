/**
 * 定期巡检预筛选 — 用便宜模型判断是否需要回复，省 key
 *
 * 流程：调用 OpenClaw Gateway API → 便宜模型回答 YES/NO → 只有 YES 才走主模型
 */

import http from "http";

const PRE_CHECK_TIMEOUT_MS = 15000;

export interface PreCheckResult {
  think: string;      // 思考过程
  action: "reply" | "silence"; // 决定是否插话
  urgency: number;    // 紧急程度 1-5
}

const DEFAULT_PRECHECK: PreCheckResult = { think: "", action: "silence", urgency: 0 };

/**
 * 调用 OpenClaw Gateway 的 chat completions API，用便宜模型判断是否需要回复
 */
export async function preCheckWithCheapModel(
  messagesText: string,
  opts: {
    gatewayPort: number;
    gatewayToken: string;
    model?: string;
    customPrompt?: string;
    agentId?: string;
  },
): Promise<PreCheckResult> {
  const systemPrompt = `你是一个群聊观察者。阅读最近的群聊记录，决定机器人是否需要介入。
请严格输出 JSON 格式（不要包含 markdown 代码块）：
{
  "think": "分析群友在聊什么，判断我是该插话还是保持沉默。如果插话，切入点是什么？",
  "action": "reply" 或 "silence",
  "urgency": 1到5的数字(纯闲聊为1，有人提问或求助为3，明确提到我或需要立刻救场为5)
}
规则：只有在有人提问、话题适合AI发挥、或者群友遇到困难时才选 reply。别人斗图或闲聊选 silence。${opts.customPrompt ? `\n\n额外指引：${opts.customPrompt}` : ""}`;

  const body = JSON.stringify({
    model: opts.agentId ? `openclaw:${opts.agentId}` : (opts.model ?? "openclaw"),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: messagesText },
    ],
    temperature: 0.1,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${opts.gatewayToken}`,
  };
  if (opts.agentId) headers["x-openclaw-agent-id"] = opts.agentId;

  try {
    const response = await httpPost(
      `http://127.0.0.1:${opts.gatewayPort}/v1/chat/completions`,
      body,
      headers,
    );

    const data = JSON.parse(response);
    const raw = String(data?.choices?.[0]?.message?.content ?? "").trim();

    // 优先按 JSON 解析；失败则回退到 YES/NO 规则
    try {
      const parsed = JSON.parse(raw) as Partial<PreCheckResult>;
      return {
        think: String(parsed.think ?? ""),
        action: parsed.action === "reply" ? "reply" : "silence",
        urgency: typeof parsed.urgency === "number" ? parsed.urgency : Number(parsed.urgency ?? 0),
      };
    } catch {
      const upper = raw.toUpperCase();
      if (upper.includes("YES")) return { think: "fallback_yes", action: "reply", urgency: 3 };
      if (upper.includes("NO")) return { think: "fallback_no", action: "silence", urgency: 0 };
      return DEFAULT_PRECHECK;
    }
  } catch (err: any) {
    // 降级策略：解析失败时保持沉默，防止乱发消息
    return { think: `Planner解析失败: ${err?.message?.slice(0, 60)}`, action: "silence", urgency: 0 };
  }
}

function httpPost(url: string, body: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(PRE_CHECK_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error("precheck timeout"));
    });
    req.write(body);
    req.end();
  });
}
