/**
 * NapCat 配置解析
 */

import type { NapCatConfig } from "./types.js";

export function getNapCatConfig(api: any, accountId?: string): NapCatConfig | null {
  const cfg = api?.config ?? (globalThis as any).__napCatGatewayConfig;
  const id = accountId ?? "default";

  const channel = cfg?.channels?.napcat;
  const account = channel?.accounts?.[id];
  if (account?.host && account?.port) {
    return { accountId: id, ...account, enabled: account.enabled !== false };
  }

  if (channel?.host && channel?.port) {
    return {
      accountId: id,
      host: channel.host,
      port: channel.port,
      accessToken: channel.accessToken,
      path: channel.path ?? "/",
      monitorGroups: channel.monitorGroups ?? [],
      autoIntervene: channel.autoIntervene ?? true,
      autoInterveneKeywords: channel.autoInterveneKeywords ?? [],
      autoIntervenePrompt: channel.autoIntervenePrompt,
      requireMention: channel.requireMention ?? false,
      historyLimit: channel.historyLimit ?? 20,
      rateLimitMs: channel.rateLimitMs ?? 1000,
      renderMarkdownToPlain: channel.renderMarkdownToPlain ?? true,
      whitelistUserIds: channel.whitelistUserIds ?? [],
      admins: channel.admins ?? [],
    };
  }

  // 环境变量回退
  const host = process.env.NAPCAT_WS_HOST;
  const portStr = process.env.NAPCAT_WS_PORT;
  if (host && portStr) {
    const port = parseInt(portStr, 10);
    if (Number.isFinite(port)) {
      return {
        accountId: id,
        host,
        port,
        accessToken: process.env.NAPCAT_WS_ACCESS_TOKEN || undefined,
        path: process.env.NAPCAT_WS_PATH ?? "/",
      };
    }
  }

  return null;
}

export function getRenderMarkdownToPlain(cfg: any): boolean {
  const v = cfg?.channels?.napcat?.renderMarkdownToPlain;
  return v === undefined ? true : Boolean(v);
}

export function getWhitelistUserIds(cfg: any): number[] {
  const v = cfg?.channels?.napcat?.whitelistUserIds;
  if (!Array.isArray(v)) return [];
  return v.filter((x: unknown) => typeof x === "number" || (typeof x === "string" && /^\d+$/.test(x))).map(Number);
}

export function listAccountIds(apiOrCfg: any): string[] {
  const cfg = apiOrCfg?.config ?? apiOrCfg ?? (globalThis as any).__napCatGatewayConfig;
  const accounts = cfg?.channels?.napcat?.accounts;
  if (accounts && Object.keys(accounts).length > 0) return Object.keys(accounts);
  if (cfg?.channels?.napcat?.host) return ["default"];
  return [];
}
