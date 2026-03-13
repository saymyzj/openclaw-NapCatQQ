/**
 * NapCat OneBot v11 类型定义
 */

/** OneBot v11 消息段 */
export interface MessageSegment {
  type: string;
  data?: Record<string, unknown>;
}

/** OneBot v11 消息事件 */
export interface OneBotMessage {
  post_type: string;
  message_type?: "private" | "group";
  sub_type?: string;
  message_id?: number;
  user_id?: number;
  group_id?: number;
  message?: MessageSegment[];
  raw_message?: string;
  self_id?: number;
  time?: number;
  sender?: {
    user_id?: number;
    nickname?: string;
    card?: string;
    role?: string;
  };
  notice_type?: string;
  [key: string]: unknown;
}

/** NapCat 连接配置 */
export interface NapCatConfig {
  accountId?: string;
  host: string;
  port: number;
  accessToken?: string;
  path?: string;
  enabled?: boolean;
  monitorGroups?: number[];
  autoIntervene?: boolean;
  autoInterveneKeywords?: string[];
  autoIntervenePrompt?: string;
  requireMention?: boolean;
  historyLimit?: number;
  rateLimitMs?: number;
  renderMarkdownToPlain?: boolean;
  whitelistUserIds?: number[];
  admins?: number[];
}

/** 发送结果 */
export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/** 群聊消息历史条目 */
export interface HistoryEntry {
  sender: string;
  senderName: string;
  body: string;
  timestamp: number;
  messageId: string;
}
