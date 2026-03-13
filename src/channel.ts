/**
 * NapCat Channel 插件定义
 */

import { getNapCatConfig, listAccountIds } from "./config.js";
import { sendTextMessage, sendMediaMessage } from "./send.js";

const meta = {
  id: "napcat",
  label: "NapCat",
  selectionLabel: "NapCat (QQ OneBot v11)",
  docsPath: "/channels/napcat",
  blurb: "NapCat OneBot v11 via WebSocket — QQ group monitoring with auto-intervention",
  aliases: ["qq", "napcat"],
  order: 80,
};

export const NapCatChannelPlugin = {
  id: "napcat",
  meta: { ...meta, id: meta.id },
  capabilities: {
    chatTypes: ["direct", "group"] as const,
    media: true,
    reactions: false,
    threads: false,
    polls: false,
  },
  reload: { configPrefixes: ["channels.napcat"] as const },
  config: {
    listAccountIds: (cfg: any) => listAccountIds(cfg),
    resolveAccount: (cfg: any, accountId?: string) => {
      const id = accountId ?? "default";
      const acc = cfg?.channels?.napcat?.accounts?.[id];
      if (acc) return { accountId: id, ...acc };
      const ch = cfg?.channels?.napcat;
      if (ch?.host) return { accountId: id, ...ch };
      return { accountId: id };
    },
  },
  groups: {
    resolveRequireMention: () => false, // 默认不需要 @ 即可通过自动介入回复
  },
  messaging: {
    normalizeTarget: (raw: string) => {
      const trimmed = raw?.trim();
      if (!trimmed) return undefined;
      return trimmed.replace(/^(napcat|onebot|qq):/i, "").trim();
    },
    targetResolver: {
      looksLikeId: (raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        return /^group:\d+$/.test(trimmed) || /^user:\d+$/.test(trimmed) || /^\d{6,}$/.test(trimmed);
      },
      hint: "user:<QQ号> 或 group:<群号>",
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    chunker: (text: string, limit: number) => {
      if (!text) return [];
      if (limit <= 0 || text.length <= limit) return [text];
      const chunks: string[] = [];
      let remaining = text;
      while (remaining.length > limit) {
        const window = remaining.slice(0, limit);
        const lastNewline = window.lastIndexOf("\n");
        const lastSpace = window.lastIndexOf(" ");
        let breakIdx = lastNewline > 0 ? lastNewline : lastSpace;
        if (breakIdx <= 0) breakIdx = limit;
        const chunk = remaining.slice(0, breakIdx).trimEnd();
        if (chunk.length > 0) chunks.push(chunk);
        const brokeOnSep = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
        remaining = remaining.slice(Math.min(remaining.length, breakIdx + (brokeOnSep ? 1 : 0))).trimStart();
      }
      if (remaining.length) chunks.push(remaining);
      return chunks;
    },
    chunkerMode: "text" as const,
    textChunkLimit: 4000,
    resolveTarget: ({ to }: { to?: string }) => {
      const t = to?.trim();
      if (!t) return { ok: false, error: new Error("NapCat requires --to <user_id|group_id>") };
      return { ok: true, to: t };
    },
    sendText: async ({ to, text, accountId, cfg }: { to: string; text: string; accountId?: string; cfg?: any }) => {
      const api = cfg ? { config: cfg } : (globalThis as any).__napCatApi;
      const config = getNapCatConfig(api, accountId);
      if (!config) return { channel: "napcat", ok: false, messageId: "", error: new Error("NapCat not configured") };
      const getConfig = () => getNapCatConfig(api, accountId);
      try {
        const result = await sendTextMessage(to, text, getConfig, cfg);
        if (!result.ok) return { channel: "napcat", ok: false, messageId: "", error: new Error(result.error) };
        return { channel: "napcat", ok: true, messageId: result.messageId ?? "" };
      } catch (e) {
        return { channel: "napcat", ok: false, messageId: "", error: e instanceof Error ? e : new Error(String(e)) };
      }
    },
    sendMedia: async (params: { to: string; text?: string; mediaUrl?: string; media?: string; accountId?: string; cfg?: any }) => {
      const { to, text, accountId, cfg } = params;
      const mediaUrl = params.mediaUrl ?? params.media;
      const api = cfg ? { config: cfg } : (globalThis as any).__napCatApi;
      const config = getNapCatConfig(api, accountId);
      if (!config) return { channel: "napcat", ok: false, messageId: "", error: new Error("NapCat not configured") };
      if (!mediaUrl?.trim()) return { channel: "napcat", ok: false, messageId: "", error: new Error("mediaUrl is required") };
      const getConfig = () => getNapCatConfig(api, accountId);
      try {
        const result = await sendMediaMessage(to, mediaUrl, text, getConfig, cfg);
        if (!result.ok) return { channel: "napcat", ok: false, messageId: "", error: new Error(result.error) };
        return { channel: "napcat", ok: true, messageId: result.messageId ?? "" };
      } catch (e) {
        return { channel: "napcat", ok: false, messageId: "", error: e instanceof Error ? e : new Error(String(e)) };
      }
    },
  },
};
