/**
 * 定期巡检预筛选 — 用便宜模型判断是否需要回复，省 key
 *
 * 流程：调用 OpenClaw Gateway API → 便宜模型回答 YES/NO → 只有 YES 才走主模型
 */

import http from "http";

const PRE_CHECK_TIMEOUT_MS = 15000;

export interface PreCheckResult {
  shouldReply: boolean;
  reason: string;
}

/**
 * 调用 OpenClaw Gateway 的 chat completions API，用便宜模型判断是否需要回复
 */
export async function preCheckWithCheapModel(
  messagesText: string,
  opts: {
    gatewayPort: number;
    gatewayToken: string;
    model: string;
    customPrompt?: string;
  },
): Promise<PreCheckResult> {
  const systemPrompt = `你是一个群聊消息预筛选助手。你的任务是判断以下群聊消息中是否有需要 AI 助手回复的内容。

判断标准：
- 有人在提问或求助 → YES
- 有技术问题、报错、需要帮忙的内容 → YES
- 有人在讨论一个话题且 AI 可以提供有价值的信息 → YES
- 纯闲聊、打招呼、聊天、表情包、灌水 → NO
- 消息太少或内容不明确 → NO
${opts.customPrompt ? `\n额外指引：${opts.customPrompt}` : ""}

只回答 YES 或 NO，不要解释。`;

  const body = JSON.stringify({
    model: opts.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: messagesText },
    ],
    max_tokens: 10,
    temperature: 0,
  });

  try {
    const response = await httpPost(
      `http://127.0.0.1:${opts.gatewayPort}/v1/chat/completions`,
      body,
      {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${opts.gatewayToken}`,
      },
    );

    const data = JSON.parse(response);
    const content = (data?.choices?.[0]?.message?.content ?? "").trim().toUpperCase();

    if (content.includes("YES")) {
      return { shouldReply: true, reason: "precheck_yes" };
    }
    return { shouldReply: false, reason: "precheck_no" };
  } catch (err: any) {
    // 预筛选失败时保守处理：放行，让主模型判断
    return { shouldReply: true, reason: `precheck_error: ${err?.message?.slice(0, 60)}` };
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
