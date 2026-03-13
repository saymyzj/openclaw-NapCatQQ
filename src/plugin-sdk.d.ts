declare module "openclaw/plugin-sdk" {
  export function buildPendingHistoryContextFromMap(opts: any): any;
  export function recordPendingHistoryEntry(opts: any): void;
  export function clearHistoryEntriesIfEnabled(opts: any): void;
}

declare module "clawdbot/plugin-sdk" {
  export function buildPendingHistoryContextFromMap(opts: any): any;
  export function recordPendingHistoryEntry(opts: any): void;
  export function clearHistoryEntriesIfEnabled(opts: any): void;
}
