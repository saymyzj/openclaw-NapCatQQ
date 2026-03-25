import { getNapCatConfig } from "./config.js";
import { runDailyMemoryBatch } from "./memory-job.js";
import { runReflectionBatch } from "./reflection-runner.js";

export function createMaintenanceLoop(api: any): {
  start: () => void;
  stop: () => void;
} {
  let reflectionTimer: ReturnType<typeof setInterval> | null = null;
  let dailyMemoryTimer: ReturnType<typeof setInterval> | null = null;
  let reflectionRunning = false;
  let dailyMemoryRunning = false;

  async function runReflectionHeartbeat(): Promise<void> {
    if (reflectionRunning) return;

    const runtime = api.runtime;
    if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) return;

    const cfg = api.config;
    const napCatCfg = cfg?.channels?.napcat ?? {};
    const maintenanceCfg = getNapCatConfig(api)?.maintenance;
    if (!maintenanceCfg?.enabled || !maintenanceCfg.reflectionEnabled) return;

    reflectionRunning = true;
    try {
      const adminUserId = getPrimaryAdminUserId(napCatCfg);
      const replyTarget = adminUserId ? `napcat:${adminUserId}` : "napcat:0";
      const result = await runReflectionBatch(api, {
        runtime,
        cfg,
        napCatCfg,
        limit: maintenanceCfg.reflectionBatchSize ?? 5,
        userId: adminUserId ?? 0,
        senderName: "maintenance-heartbeat",
        replyTarget,
        triggerSource: "heartbeat",
      });
      if (result.processedCount > 0) {
        api.logger?.info?.(
          `[napcat] maintenance reflection processed=${result.processedCount} trigger=${result.triggerSource}`,
        );
      }
    } catch (err: any) {
      api.logger?.error?.(`[napcat] maintenance reflection failed: ${err?.message}`);
    } finally {
      reflectionRunning = false;
    }
  }

  async function runDailyMemoryHeartbeat(): Promise<void> {
    if (dailyMemoryRunning) return;

    const runtime = api.runtime;
    if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) return;

    const cfg = api.config;
    const napCatCfg = cfg?.channels?.napcat ?? {};
    const maintenanceCfg = getNapCatConfig(api)?.maintenance;
    if (!maintenanceCfg?.enabled || !maintenanceCfg.dailyMemoryEnabled) return;

    dailyMemoryRunning = true;
    try {
      const adminUserId = getPrimaryAdminUserId(napCatCfg);
      const replyTarget = adminUserId ? `napcat:${adminUserId}` : "napcat:0";
      const result = await runDailyMemoryBatch(api, {
        runtime,
        cfg,
        napCatCfg,
        limit: maintenanceCfg.dailyMemoryBatchSize ?? 2,
        userId: adminUserId ?? 0,
        senderName: "maintenance-daily-memory",
        replyTarget,
        triggerSource: "heartbeat",
      });
      if (result.processedGroups > 0) {
        api.logger?.info?.(
          `[napcat] maintenance daily-memory processed=${result.processedGroups} date=${result.dateKey}`,
        );
      }
    } catch (err: any) {
      api.logger?.error?.(`[napcat] maintenance daily-memory failed: ${err?.message}`);
    } finally {
      dailyMemoryRunning = false;
    }
  }

  function start(): void {
    stop();
    const maintenanceCfg = getNapCatConfig(api)?.maintenance;
    if (!maintenanceCfg?.enabled) return;

    if (maintenanceCfg.reflectionEnabled) {
      const intervalMs = Math.max(60_000, Number(maintenanceCfg.reflectionIntervalMs ?? 43_200_000));
      reflectionTimer = setInterval(() => {
        runReflectionHeartbeat().catch((err: any) => {
          api.logger?.error?.(`[napcat] maintenance loop failure: ${err?.message}`);
        });
      }, intervalMs);
      api.logger?.info?.(`[napcat] maintenance reflection heartbeat started interval=${intervalMs}ms`);
    }

    if (maintenanceCfg.dailyMemoryEnabled) {
      const dailyMemoryIntervalMs = Math.max(60_000, Number(maintenanceCfg.dailyMemoryIntervalMs ?? 900_000));
      dailyMemoryTimer = setInterval(() => {
        runDailyMemoryHeartbeat().catch((err: any) => {
          api.logger?.error?.(`[napcat] maintenance daily-memory loop failure: ${err?.message}`);
        });
      }, dailyMemoryIntervalMs);
      setTimeout(() => {
        runDailyMemoryHeartbeat().catch((err: any) => {
          api.logger?.error?.(`[napcat] maintenance daily-memory bootstrap failure: ${err?.message}`);
        });
      }, 30_000);
      api.logger?.info?.(`[napcat] maintenance daily-memory heartbeat started interval=${dailyMemoryIntervalMs}ms`);
    }
  }

  function stop(): void {
    if (reflectionTimer) {
      clearInterval(reflectionTimer);
      reflectionTimer = null;
    }
    if (dailyMemoryTimer) {
      clearInterval(dailyMemoryTimer);
      dailyMemoryTimer = null;
    }
  }

  return { start, stop };
}

function getPrimaryAdminUserId(napCatCfg: any): number | null {
  const admins = Array.isArray(napCatCfg?.admins) ? napCatCfg.admins : [];
  for (const admin of admins) {
    const asNumber = Number(admin);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  }
  return null;
}
