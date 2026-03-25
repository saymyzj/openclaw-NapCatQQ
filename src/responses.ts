import { setTimeout as delay } from "node:timers/promises";
import { resolveMediaToBase64Cached } from "./connection.js";

const RESPONSES_TIMEOUT_MS = 30000;

export interface OpenResponsesImageInput {
  type: "input_image";
  source:
    | { type: "url"; url: string }
    | { type: "base64"; media_type: string; data: string };
}

export async function summarizeImagesWithResponses(opts: {
  gatewayPort: number;
  gatewayToken: string;
  agentId: string;
  sessionKey?: string;
  inputText: string;
  imageUrls: string[];
}): Promise<string> {
  return analyzeImagesWithResponses({
    gatewayPort: opts.gatewayPort,
    gatewayToken: opts.gatewayToken,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    inputText: opts.inputText,
    imageUrls: opts.imageUrls,
    developerText: [
      "你是一个图片理解辅助器，只负责把当前图片内容转成简短、客观、可供聊天模型继续使用的文字摘要。",
      "要求：",
      "1. 只描述图里实际能看见的内容，不要编造。",
      "2. 优先提取截图文字、报错、界面元素、人物/物体、场景和明显关系。",
      "3. 输出简洁中文，控制在 120 字内。",
      "4. 如果有多张图，按“图片1/图片2/...”分条描述。",
      "5. 不要直接回答用户问题，只做图像摘要。",
    ].join("\n"),
  });
}

export async function answerImagesWithResponses(opts: {
  gatewayPort: number;
  gatewayToken: string;
  agentId: string;
  sessionKey?: string;
  inputText: string;
  imageUrls: string[];
}): Promise<string> {
  return analyzeImagesWithResponses({
    gatewayPort: opts.gatewayPort,
    gatewayToken: opts.gatewayToken,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    inputText: opts.inputText,
    imageUrls: opts.imageUrls,
    developerText: [
      "你是一个群聊图片问答辅助器，要基于当前图片和用户刚才的问题，直接给出简短、自然、可信的中文回答。",
      "要求：",
      "1. 只依据图片里实际能看见的内容回答，不要编造。",
      "2. 如果用户问的是外观比较、谁更帅/更好看、像不像、表情包在表达什么，可以给出轻量主观看法，但必须明确基于可见特征，不要装成绝对事实。",
      "3. 如果图片信息不足以支撑问题，就直接说看不准/看不出来。",
      "4. 输出简洁中文，控制在 120 字内，不要解释过程。",
      "5. 如果有多张图，必要时用“左边/右边/中间/图片1/图片2”来区分。",
    ].join("\n"),
  });
}

async function analyzeImagesWithResponses(opts: {
  gatewayPort: number;
  gatewayToken: string;
  agentId: string;
  sessionKey?: string;
  inputText: string;
  imageUrls: string[];
  developerText: string;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = delay(RESPONSES_TIMEOUT_MS, undefined, { signal: controller.signal })
    .then(() => controller.abort(new Error("responses timeout")))
    .catch(() => undefined);

  try {
    const imageItems: OpenResponsesImageInput[] = await Promise.all(
      opts.imageUrls.map(async (url) => {
        const trimmedUrl = String(url ?? "").trim();
        if (/^https?:\/\//i.test(trimmedUrl) && !shouldInlineImageAsBase64(trimmedUrl)) {
          return {
            type: "input_image" as const,
            source: {
              type: "url" as const,
              url: trimmedUrl,
            },
          };
        }
        const base64 = await resolveMediaToBase64Cached(trimmedUrl);
        return {
          type: "input_image" as const,
          source: {
            type: "base64" as const,
            media_type: inferImageMediaType(trimmedUrl),
            data: base64.startsWith("base64://") ? base64.slice("base64://".length) : base64,
          },
        };
      }),
    );

    const response = await fetch(`http://127.0.0.1:${opts.gatewayPort}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${opts.gatewayToken}`,
        "x-openclaw-agent-id": opts.agentId,
        ...(opts.sessionKey ? { "x-openclaw-session-key": opts.sessionKey } : {}),
      },
      body: JSON.stringify({
        model: "openclaw",
        input: [
          {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text: opts.developerText,
              },
            ],
          },
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: opts.inputText },
              ...imageItems,
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`responses ${response.status}: ${body.slice(0, 300) || response.statusText}`);
    }

    const data = await response.json();
    const text = extractOutputText(data);
    if (!text.trim()) throw new Error("responses returned empty output");
    return text.trim();
  } finally {
    controller.abort();
    await timeout;
  }
}

function extractOutputText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const texts: string[] = [];
  for (const item of data?.output ?? []) {
    if (item?.type !== "message" || !Array.isArray(item?.content)) continue;
    for (const part of item.content) {
      if (part?.type === "output_text" && typeof part?.text === "string" && part.text) {
        texts.push(part.text);
      }
    }
  }
  return texts.join("");
}

function inferImageMediaType(url: string): string {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".bmp")) return "image/bmp";
  if (clean.endsWith(".heic")) return "image/heic";
  if (clean.endsWith(".heif")) return "image/heif";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  return "image/jpeg";
}

function shouldInlineImageAsBase64(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "qq.com"
      || host.endsWith(".qq.com")
      || host === "qq.com.cn"
      || host.endsWith(".qq.com.cn")
      || host === "qpic.cn"
      || host.endsWith(".qpic.cn");
  } catch {
    return false;
  }
}
