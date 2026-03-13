/**
 * NapCat WebSocket 连接与 OneBot v11 API 调用
 */

import WebSocket from "ws";
import https from "https";
import http from "http";
import { writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { NapCatConfig } from "./types.js";

const IMAGE_TEMP_DIR = join(tmpdir(), "openclaw-napcat");
const DOWNLOAD_TIMEOUT_MS = 30000;
const IMAGE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const IMAGE_TEMP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let ws: WebSocket | null = null;
const pendingEcho = new Map<string, { resolve: (v: any) => void }>();
let echoCounter = 0;
let connectionReadyResolve: (() => void) | null = null;
const connectionReadyPromise = new Promise<void>((r) => { connectionReadyResolve = r; });
let imageTempCleanupTimer: ReturnType<typeof setInterval> | null = null;

function getLogger(): { info?: (s: string) => void; warn?: (s: string) => void; error?: (s: string) => void } {
  return (globalThis as any).__napCatApi?.logger ?? {};
}

function nextEcho(): string {
  return `napcat-${Date.now()}-${++echoCounter}`;
}

// ─── 图片工具 ───

function downloadUrl(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadUrl(res.headers.location.startsWith("http") ? res.headers.location : new URL(res.headers.location, url).href)
          .then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => { req.destroy(); reject(new Error("Download timeout")); });
  });
}

function cleanupImageTemp(): void {
  try {
    const files = readdirSync(IMAGE_TEMP_DIR);
    const now = Date.now();
    for (const f of files) {
      const p = join(IMAGE_TEMP_DIR, f);
      try {
        const st = statSync(p);
        if (st.isFile() && now - st.mtimeMs > IMAGE_TEMP_MAX_AGE_MS) unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

export async function resolveMediaToFile(media: string): Promise<string> {
  const trimmed = media?.trim();
  if (!trimmed) throw new Error("Empty media path");

  if (/^https?:\/\//i.test(trimmed)) {
    const buf = await downloadUrl(trimmed);
    const ext = (trimmed.match(/\.(png|jpg|jpeg|gif|webp|bmp|mp4|mp3|wav|pdf|doc|zip)(?:\?|$)/i)?.[1] ?? "bin").toLowerCase();
    mkdirSync(IMAGE_TEMP_DIR, { recursive: true });
    const tmpPath = join(IMAGE_TEMP_DIR, `media-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
    writeFileSync(tmpPath, buf);
    return tmpPath;
  }
  if (trimmed.startsWith("base64://")) {
    const buf = Buffer.from(trimmed.slice(9), "base64");
    mkdirSync(IMAGE_TEMP_DIR, { recursive: true });
    const tmpPath = join(IMAGE_TEMP_DIR, `media-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    writeFileSync(tmpPath, buf);
    return tmpPath;
  }
  if (trimmed.startsWith("file://")) return trimmed.slice(7);
  return trimmed;
}

export async function resolveMediaToBase64(media: string): Promise<string> {
  const trimmed = media?.trim();
  if (!trimmed) throw new Error("Empty media");
  if (trimmed.startsWith("base64://")) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    const buf = await downloadUrl(trimmed);
    return `base64://${buf.toString("base64")}`;
  }
  const buf = readFileSync(trimmed.startsWith("file://") ? trimmed.slice(7) : trimmed);
  return `base64://${buf.toString("base64")}`;
}

export function startImageTempCleanup(): void {
  if (imageTempCleanupTimer) clearInterval(imageTempCleanupTimer);
  imageTempCleanupTimer = setInterval(cleanupImageTemp, IMAGE_TEMP_CLEANUP_INTERVAL_MS);
}

export function stopImageTempCleanup(): void {
  if (imageTempCleanupTimer) { clearInterval(imageTempCleanupTimer); imageTempCleanupTimer = null; }
}

// ─── WebSocket 连接 ───

export function handleEchoResponse(payload: any): boolean {
  if (payload?.echo && pendingEcho.has(payload.echo)) {
    pendingEcho.get(payload.echo)?.resolve(payload);
    return true;
  }
  return false;
}

function sendOneBotAction(socket: WebSocket, action: string, params: Record<string, unknown>): Promise<any> {
  const echo = nextEcho();
  const payload = { action, params, echo };
  const log = getLogger();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingEcho.delete(echo);
      log.warn?.(`[napcat] action ${action} timeout`);
      reject(new Error(`OneBot action ${action} timeout`));
    }, 15000);

    pendingEcho.set(echo, {
      resolve: (v) => {
        clearTimeout(timeout);
        pendingEcho.delete(echo);
        if (v?.retcode !== 0) log.warn?.(`[napcat] action ${action} retcode=${v?.retcode} msg=${v?.msg ?? ""}`);
        resolve(v);
      },
    });

    socket.send(JSON.stringify(payload), (err: Error | undefined) => {
      if (err) { pendingEcho.delete(echo); clearTimeout(timeout); reject(err); }
    });
  });
}

export function getWs(): WebSocket | null { return ws; }

export function setWs(socket: WebSocket | null): void {
  ws = socket;
  if (socket && socket.readyState === WebSocket.OPEN && connectionReadyResolve) {
    connectionReadyResolve();
    connectionReadyResolve = null;
  }
}

export async function waitForConnection(timeoutMs = 30000): Promise<WebSocket> {
  if (ws && ws.readyState === WebSocket.OPEN) return ws;
  return Promise.race([
    connectionReadyPromise.then(() => {
      if (ws && ws.readyState === WebSocket.OPEN) return ws;
      throw new Error("NapCat WebSocket not connected");
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`NapCat WebSocket not connected after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

export async function ensureConnection(getConfig: () => NapCatConfig | null): Promise<WebSocket> {
  if (ws && ws.readyState === WebSocket.OPEN) return ws;
  const config = getConfig();
  if (!config) throw new Error("NapCat not configured");
  const socket = await connectForward(config);
  setWs(socket);
  return socket;
}

export async function connectForward(config: NapCatConfig): Promise<WebSocket> {
  const path = config.path ?? "/";
  const pathNorm = path.startsWith("/") ? path : `/${path}`;
  const addr = `ws://${config.host}:${config.port}${pathNorm}`;
  const headers: Record<string, string> = {};
  if (config.accessToken) headers["Authorization"] = `Bearer ${config.accessToken}`;

  const w = new WebSocket(addr, { headers });
  await new Promise<void>((resolve, reject) => {
    w.on("open", () => resolve());
    w.on("error", reject);
  });
  return w;
}

export function stopConnection(): void {
  if (ws) { ws.close(); ws = null; }
}

// ─── 消息发送 API ───

export async function sendPrivateMsg(userId: number, text: string, getConfig?: () => NapCatConfig | null): Promise<number | undefined> {
  const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
  const res = await sendOneBotAction(socket, "send_private_msg", { user_id: userId, message: text });
  if (res?.retcode !== 0) throw new Error(res?.msg ?? `send_private_msg failed (retcode=${res?.retcode})`);
  return res?.data?.message_id;
}

export async function sendGroupMsg(groupId: number, text: string, getConfig?: () => NapCatConfig | null): Promise<number | undefined> {
  const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
  const res = await sendOneBotAction(socket, "send_group_msg", { group_id: groupId, message: text });
  if (res?.retcode !== 0) throw new Error(res?.msg ?? `send_group_msg failed (retcode=${res?.retcode})`);
  return res?.data?.message_id;
}

export async function sendGroupImage(groupId: number, image: string, getConfig?: () => NapCatConfig | null): Promise<number | undefined> {
  const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
  const fileStr = await resolveMediaToBase64(image);
  const seg = [{ type: "image", data: { file: fileStr } }];
  const res = await sendOneBotAction(socket, "send_group_msg", { group_id: groupId, message: seg });
  if (res?.retcode !== 0) throw new Error(res?.msg ?? `send_group_msg (image) failed`);
  return res?.data?.message_id;
}

export async function sendPrivateImage(userId: number, image: string, getConfig?: () => NapCatConfig | null): Promise<number | undefined> {
  const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
  const fileStr = await resolveMediaToBase64(image);
  const seg = [{ type: "image", data: { file: fileStr } }];
  const res = await sendOneBotAction(socket, "send_private_msg", { user_id: userId, message: seg });
  if (res?.retcode !== 0) throw new Error(res?.msg ?? `send_private_msg (image) failed`);
  return res?.data?.message_id;
}

export async function sendGroupVideo(groupId: number, video: string, getConfig?: () => NapCatConfig | null): Promise<number | undefined> {
  const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
  const fileStr = await resolveMediaToBase64(video);
  const seg = [{ type: "video", data: { file: fileStr } }];
  const res = await sendOneBotAction(socket, "send_group_msg", { group_id: groupId, message: seg });
  if (res?.retcode !== 0) throw new Error(res?.msg ?? `send_group_msg (video) failed`);
  return res?.data?.message_id;
}

export async function sendPrivateVideo(userId: number, video: string, getConfig?: () => NapCatConfig | null): Promise<number | undefined> {
  const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
  const fileStr = await resolveMediaToBase64(video);
  const seg = [{ type: "video", data: { file: fileStr } }];
  const res = await sendOneBotAction(socket, "send_private_msg", { user_id: userId, message: seg });
  if (res?.retcode !== 0) throw new Error(res?.msg ?? `send_private_msg (video) failed`);
  return res?.data?.message_id;
}

export async function uploadGroupFile(groupId: number, file: string, name: string, getConfig?: () => NapCatConfig | null): Promise<void> {
  const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
  const res = await sendOneBotAction(socket, "upload_group_file", { group_id: groupId, file, name });
  if (res?.retcode !== 0) throw new Error(res?.msg ?? `upload_group_file failed`);
}

export async function uploadPrivateFile(userId: number, file: string, name: string, getConfig?: () => NapCatConfig | null): Promise<void> {
  const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
  const res = await sendOneBotAction(socket, "upload_private_file", { user_id: userId, file, name });
  if (res?.retcode !== 0) throw new Error(res?.msg ?? `upload_private_file failed`);
}

export async function deleteMsg(messageId: number): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("NapCat not connected");
  await sendOneBotAction(ws, "delete_msg", { message_id: messageId });
}

export async function getMsg(messageId: number): Promise<any | null> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return null;
  try {
    const res = await sendOneBotAction(ws, "get_msg", { message_id: messageId });
    return res?.retcode === 0 ? res.data : null;
  } catch { return null; }
}

export async function getGroupMemberInfo(groupId: number, userId: number): Promise<{ nickname: string; card: string } | null> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return null;
  try {
    const res = await sendOneBotAction(ws, "get_group_member_info", { group_id: groupId, user_id: userId, no_cache: false });
    if (res?.retcode === 0 && res?.data) {
      return { nickname: String(res.data.nickname ?? ""), card: String(res.data.card ?? "") };
    }
    return null;
  } catch { return null; }
}

export async function getGroupInfo(groupId: number): Promise<{ group_name: string } | null> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return null;
  try {
    const res = await sendOneBotAction(ws, "get_group_info", { group_id: groupId, no_cache: false });
    return res?.retcode === 0 ? { group_name: String(res.data?.group_name ?? "") } : null;
  } catch { return null; }
}

export async function getLoginInfo(): Promise<{ user_id: number; nickname: string } | null> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return null;
  try {
    const res = await sendOneBotAction(ws, "get_login_info", {});
    return res?.retcode === 0 ? res.data : null;
  } catch { return null; }
}

export async function setMsgEmojiLike(messageId: number, emojiId: number, isSet = true): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    await sendOneBotAction(ws, "set_msg_emoji_like", { message_id: messageId, emoji_id: emojiId, is_set: isSet });
  } catch { /* ignore - not all implementations support this */ }
}
