/**
 * 回复目标上下文管理
 */

let activeReplyTarget: string | null = null;
let activeReplySessionId: string | null = null;

export function setActiveReplyTarget(to: string): void { activeReplyTarget = to; }
export function clearActiveReplyTarget(): void { activeReplyTarget = null; }
export function getActiveReplyTarget(): string | null { return activeReplyTarget; }

export function setActiveReplySessionId(id: string | null): void { activeReplySessionId = id; }
export function getActiveReplySessionId(): string | null { return activeReplySessionId; }

export function resolveTargetForReply(to: string): string {
  const stored = activeReplyTarget;
  if (!stored) return to;
  const m = stored.match(/group:(\d+)$/i);
  if (!m) return to;
  const groupId = m[1];
  const normalizedTo = to.replace(/^(napcat|onebot|qq):/i, "").trim();
  const numericPart = normalizedTo.replace(/^user:/i, "");
  if (numericPart === groupId || normalizedTo === groupId) return stored;
  return to;
}
