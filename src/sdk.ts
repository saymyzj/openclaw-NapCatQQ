/**
 * OpenClaw Plugin SDK 懒加载
 */

let sdkLoaded = false;
let buildPendingHistoryContextFromMap: any;
let recordPendingHistoryEntry: any;
let clearHistoryEntriesIfEnabled: any;

export async function loadPluginSdk(): Promise<void> {
  if (sdkLoaded) return;
  try {
    const sdk = await import("openclaw/plugin-sdk");
    buildPendingHistoryContextFromMap = sdk.buildPendingHistoryContextFromMap;
    recordPendingHistoryEntry = sdk.recordPendingHistoryEntry;
    clearHistoryEntriesIfEnabled = sdk.clearHistoryEntriesIfEnabled;
  } catch {
    try {
      const sdk = await import("clawdbot/plugin-sdk");
      buildPendingHistoryContextFromMap = sdk.buildPendingHistoryContextFromMap;
      recordPendingHistoryEntry = sdk.recordPendingHistoryEntry;
      clearHistoryEntriesIfEnabled = sdk.clearHistoryEntriesIfEnabled;
    } catch {
      console.warn("[napcat] plugin-sdk not found, history features disabled");
    }
  }
  sdkLoaded = true;
}

export function getSdk() {
  return { buildPendingHistoryContextFromMap, recordPendingHistoryEntry, clearHistoryEntriesIfEnabled };
}
