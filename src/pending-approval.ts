type PendingApprovalSurfaceEntry = {
  groupId: number;
  chatContextExcerpt: string;
  voiceAgentId: string;
  gatewayPort: number;
  gatewayToken: string;
  expiresAt: number;
};

const pendingApprovalSurfaces = new Map<string, PendingApprovalSurfaceEntry>();
const DEFAULT_PENDING_APPROVAL_TTL_MS = 10 * 60 * 1000;

function normalizeTargetKey(targetKey: string): string {
  return String(targetKey ?? "").trim().toLowerCase();
}

export function registerPendingApprovalSurface(targetKey: string, entry: Omit<PendingApprovalSurfaceEntry, "expiresAt">): void {
  const normalized = normalizeTargetKey(targetKey);
  if (!normalized) return;
  pendingApprovalSurfaces.set(normalized, {
    ...entry,
    expiresAt: Date.now() + DEFAULT_PENDING_APPROVAL_TTL_MS,
  });
}

export function takePendingApprovalSurface(targetKey: string): PendingApprovalSurfaceEntry | null {
  const normalized = normalizeTargetKey(targetKey);
  if (!normalized) return null;
  const entry = pendingApprovalSurfaces.get(normalized);
  if (!entry) return null;
  pendingApprovalSurfaces.delete(normalized);
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}
