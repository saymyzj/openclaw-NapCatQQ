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

export default function register(api: any): void {
  (globalThis as any).__napCatApi = api;
  (globalThis as any).__napCatGatewayConfig = api.config;

  startImageTempCleanup();
  api.registerChannel({ plugin: NapCatChannelPlugin });
  registerService(api);

  api.logger?.info?.("[napcat] plugin loaded");
}
