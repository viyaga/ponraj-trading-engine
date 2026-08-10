import cron from "node-cron";
import { env } from "../config";
import errorLogger from "../utils/errorLogger";
import { TradingV2 } from "../services/tradingV2";
import { Data } from "../services/tradingV2/data";
import { TradingConfig } from "../services/tradingV2/config";
import { tradingCronLogger } from "../services/tradingV2/logger";
import { BulkSyncService } from "../services/bulkSync.service";
import { is3pmTo315pmWindow } from "../services/tradingV2/strategies/atr14-strategy";
import { startCycleLogging, endCycleLogging } from "../utils/cycleLogger";

/* ============================================================================
 * Cron Scheduler — 3:00 PM – 3:15 PM IST Execution Window (Mon–Fri)
 * ============================================================================ */

const tradingCycleCronJob = (): void => {

    // Default schedule: every 1 minute during 15:00-15:15 IST, Monday–Friday
    cron.schedule(env.cronSchedule ?? "*/1 15 * * 1-5", async () => {

        // ── 3:00 PM - 3:15 PM IST Window Guard ──────────────────────────────
        if (!is3pmTo315pmWindow()) {
            tradingCronLogger.debug("[TradingCron] Outside 3:00 PM - 3:15 PM trading window — skipping cycle");
            return;
        }

        startCycleLogging();
        const startTime = Date.now();
        let totalProcessed = 0;
        let totalSucceeded = 0;
        let totalFailed    = 0;
        let offset         = 0;
        const LIMIT       = 100;
        const CONCURRENCY = 2;

        tradingCronLogger.info(`${"=".repeat(80)}`);
        tradingCronLogger.info(`[TradingCron] ========== CYCLE START (3:00 PM - 3:15 PM) ==========`);
        tradingCronLogger.info(`${"=".repeat(80)}`);

        TradingV2.clearCaches();

        try {
            while (true) {
                const configs = await Data.fetchTradingConfigs({ limit: LIMIT, offset });

                tradingCronLogger.info(`[TradingCron] Fetched ${configs.length} configs at offset=${offset}`);

                if (!configs.length) {
                    tradingCronLogger.info("[TradingCron] No more configs. Breaking loop.");
                    break;
                }

                const processWithLimit = async (cfgs: typeof configs) => {
                    const results: Promise<any>[] = [];
                    const executing = new Set<Promise<any>>();

                    for (const cfg of cfgs) {
                        const p = (async () => {
                            tradingCronLogger.info(`[TradingCron] Starting cycle: bot ${cfg.id} (${cfg.INDEX} | DRY_RUN: ${cfg.DRY_RUN})`);
                            try {
                                const res = await TradingConfig.configStore.run(
                                    cfg,
                                    () => TradingV2.runTradingCycle(cfg)
                                );
                                return { status: "fulfilled" as const, value: res };
                            } catch (err) {
                                return { status: "rejected" as const, reason: err };
                            }
                        })();

                        results.push(p);
                        executing.add(p);
                        p.finally(() => executing.delete(p));

                        if (executing.size >= CONCURRENCY) {
                            await Promise.race(executing);
                        }
                    }
                    return Promise.all(results);
                };

                const results = await processWithLimit(configs);

                results.forEach((result, index) => {
                    const config = configs[index];
                    if (result.status === "fulfilled") {
                        totalSucceeded++;
                        tradingCronLogger.info(`[TradingCron] ✓ Bot ${config.id} (${config.INDEX}) completed`);
                    } else {
                        totalFailed++;
                        tradingCronLogger.error(`[TradingCron] ✗ Bot ${config.id} (${config.INDEX}) failed:`, {
                            reason: (result as any).reason?.message ?? (result as any).reason,
                        });
                    }
                });

                totalProcessed += configs.length;
                offset         += LIMIT;

                if (configs.length < LIMIT) break;
            }

        } catch (error) {
            tradingCronLogger.error("[TradingCron] CRITICAL ERROR:", { error });
            errorLogger.error("[TradingCron] Cron cycle failed", error);
        } finally {
            const duration = Date.now() - startTime;
            tradingCronLogger.info(`${"=".repeat(80)}`);
            tradingCronLogger.info("[TradingCron] ========== CYCLE COMPLETE ==========");
            tradingCronLogger.info(`[TradingCron] Processed: ${totalProcessed} | ✓ ${totalSucceeded} | ✗ ${totalFailed}`);
            tradingCronLogger.info(`[TradingCron] Duration: ${(duration / 1000).toFixed(2)}s`);
            tradingCronLogger.info(`${"=".repeat(80)}`);

            await BulkSyncService.runFullSync();
            endCycleLogging();
        }
    });

    tradingCronLogger.info(`[CronScheduler] Cron scheduled: "${env.cronSchedule ?? "*/1 15 * * 1-5"}" (3:00 PM - 3:15 PM IST guard active)`);
};

export default tradingCycleCronJob;