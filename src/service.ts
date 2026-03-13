/**
 * NapCat WebSocket 服务 — 连接管理与消息分发
 */

import WebSocket from "ws";
import type { OneBotMessage } from "./types.js";
import { getNapCatConfig } from "./config.js";
import {
  connectForward,
  setWs,
  stopConnection,
  handleEchoResponse,
  startImageTempCleanup,
  stopImageTempCleanup,
} from "./connection.js";
import { processInboundMessage } from "./handlers/process-inbound.js";

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];

export function registerService(api: any): void {
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  function scheduleReconnect() {
    if (stopping) return;
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    api.logger?.info?.(`[napcat] reconnecting in ${delay}ms (attempt ${reconnectAttempt + 1})`);
    reconnectTimer = setTimeout(() => {
      reconnectAttempt++;
      startWs();
    }, delay);
  }

  async function startWs() {
    const config = getNapCatConfig(api);
    if (!config) {
      api.logger?.warn?.("[napcat] no config, service will not connect");
      return;
    }

    try {
      api.logger?.info?.(`[napcat] connecting to ws://${config.host}:${config.port}${config.path ?? "/"}...`);
      const ws = await connectForward(config);
      setWs(ws);
      reconnectAttempt = 0;
      api.logger?.info?.("[napcat] WebSocket connected");
      startImageTempCleanup();

      ws.on("message", (data: Buffer) => {
        try {
          const payload = JSON.parse(data.toString());
          if (handleEchoResponse(payload)) return;
          if (payload.meta_event_type === "heartbeat") return;
          if (payload.meta_event_type === "lifecycle") {
            api.logger?.info?.(`[napcat] lifecycle: ${payload.sub_type}`);
            return;
          }

          const msg = payload as OneBotMessage;
          if (msg.post_type === "message" && (msg.message_type === "private" || msg.message_type === "group")) {
            processInboundMessage(api, msg).catch((e) => {
              api.logger?.error?.(`[napcat] processInboundMessage: ${e?.message}`);
            });
          }
          // 可扩展：notice 事件（群成员变动等）
        } catch (e: any) {
          api.logger?.error?.(`[napcat] parse message: ${e?.message}`);
        }
      });

      ws.on("close", (code: number, reason: Buffer) => {
        api.logger?.info?.(`[napcat] WebSocket closed (code=${code})`);
        setWs(null);
        if (!stopping) scheduleReconnect();
      });

      ws.on("error", (e: Error) => {
        api.logger?.error?.(`[napcat] WebSocket error: ${e?.message}`);
      });
    } catch (e: any) {
      api.logger?.error?.(`[napcat] connect failed: ${e?.message}`);
      if (!stopping) scheduleReconnect();
    }
  }

  api.registerService({
    id: "napcat-ws",
    start: async () => {
      stopping = false;
      await startWs();
    },
    stop: async () => {
      stopping = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      stopImageTempCleanup();
      stopConnection();
      api.logger?.info?.("[napcat] service stopped");
    },
  });
}
