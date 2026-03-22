/**
 * OpenClaw NapCat Channel Plugin
 *
 * 将 NapCat (OneBot v11) 接入 OpenClaw Gateway，支持：
 * - 发送文本、图片、文件、视频
 * - 群聊消息监控
 * - AI 自动判断是否需要介入群聊
 */

import { NapCatChannelPlugin } from "./channel.js";
import { registerService } from "./service.js";
import { startImageTempCleanup } from "./connection.js";
import { runBackgroundSummarizer } from "./memory-job.js";

export default function register(api: any): void {
  (globalThis as any).__napCatApi = api;
  (globalThis as any).__napCatGatewayConfig = api.config;

  startImageTempCleanup();
  api.registerChannel({ plugin: NapCatChannelPlugin });
  registerService(api);

  api.logger?.info?.("[napcat] plugin loaded");

  // 启动旁路记忆压缩定时器 (每天 24 小时执行一次，或单次重启后 2 小时执行)
  setTimeout(() => {
    const gatewayPort = api.config?.gateway?.port ?? 18789;
    const gatewayToken = api.config?.gateway?.auth?.token ?? "";
    const model = api.config?.channels?.napcat?.preCheckModel ?? "github-copilot/gpt-4o-mini";
    runBackgroundSummarizer(api, gatewayPort, gatewayToken, model).catch(() => {});
    
    setInterval(() => {
      runBackgroundSummarizer(api, gatewayPort, gatewayToken, model).catch(() => {});
    }, 24 * 60 * 60 * 1000); // 24小时
  }, 60 * 60 * 1000); // 插件启动1小时后先尝试做一次归档，防止每天频繁重启导致永远不归档
}
