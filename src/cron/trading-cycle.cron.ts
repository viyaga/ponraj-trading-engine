import cron from "node-cron";
import { env } from "../config";
import errorLogger from "../utils/errorLogger";
import { TradingV2 } from "../services/tradingV2";
import { Data } from "../services/tradingV2/data";
import { TradingConfig } from "../services/tradingV2/config";
import { tradingCronLogger } from "../services/tradingV2/logger";
import { BulkSyncService } from "../services/bulkSync.service";
import { startCycleLogging, endCycleLogging } from "../utils/cycleLogger";

/* ============================================================================
 * Cron Scheduler
 * ============================================================================ */

const tradingCycleCronJob = (): void => {

    cron.schedule(env.cronSchedule, async () => {
        startCycleLogging();
        const startTime = Date.now();
        let totalProcessed = 0;
        let totalSucceeded = 0;
        let totalFailed = 0;
        let offset = 0;
        const LIMIT = 100; // Reduced for better stability
        const CONCURRENCY = 2; // Max parallel bots (Reduced to prevent API timeouts)

        tradingCronLogger.info(`${'='.repeat(80)}`);
        tradingCronLogger.info(`[TradingCron] ========== CYCLE START ==========`);
        tradingCronLogger.info(`${'='.repeat(80)}`);

        // Clear market data caches for the new cycle
        TradingV2.clearCaches();

        try {
            tradingCronLogger.info(`[TradingCron] Fetching trading configs with LIMIT=${LIMIT}, starting at offset=${offset}...`);

            while (true) {
                const configs = await Data.fetchTradingConfigs({
                    limit: LIMIT,
                    offset: offset
                });

                tradingCronLogger.info(`[TradingCron] Fetched ${configs.length} configs at offset=${offset}`);

                if (configs.length === 0) {
                    tradingCronLogger.info(`[TradingCron] No more configs found. Breaking loop.`);
                    break;
                }

                tradingCronLogger.info(`[TradingCron] Processing batch of ${configs.length} configs with CONCURRENCY=${CONCURRENCY}...`);

                // 🚀 Concurrency-limited execution pool
                const processWithLimit = async (cfgs: any[]) => {
                    const results: any[] = [];
                    const executing = new Set<Promise<any>>();

                    for (const cfg of cfgs) {
                        const p = (async () => {
                            tradingCronLogger.info(`[TradingCron] Starting cycle for config: ${cfg.id} (${cfg.SYMBOL})`);
                            try {
                                const res = await TradingConfig.configStore.run(cfg, () => TradingV2.runTradingCycle(cfg));
                                return { status: 'fulfilled' as const, value: res };
                            } catch (err) {
                                return { status: 'rejected' as const, reason: err };
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

                // Count successes and failures
                results.forEach((result, index) => {
                    const config = configs[index];
                    if (result.status === 'fulfilled') {
                        totalSucceeded++;
                        tradingCronLogger.info(`[TradingCron] ✓ Config ${config.id} (${config.SYMBOL}) completed successfully`);
                    } else {
                        totalFailed++;
                        tradingCronLogger.error(`[TradingCron] ✗ Config ${config.id} (${config.SYMBOL}) failed:`, { reason: result.reason?.message || result.reason });
                    }
                });

                totalProcessed += configs.length;
                offset += LIMIT;

                tradingCronLogger.info(`[TradingCron] Batch summary: ${configs.length} configs, ${totalSucceeded} succeeded, ${totalFailed} failed`);
                tradingCronLogger.info(`[TradingCron] Total processed so far: ${totalProcessed}`);

                if (configs.length < LIMIT) {
                    tradingCronLogger.info(`[TradingCron] All configs processed. Breaking loop.`);
                    break;
                }
            }

        } catch (error) {
            tradingCronLogger.error(`[TradingCron] CRITICAL ERROR occurred:`, { error });
            errorLogger.error("[TradingCron] Cron cycle failed", error);
        } finally {
            const duration = Date.now() - startTime;
            tradingCronLogger.info(`${'='.repeat(80)}`);
            tradingCronLogger.info(`[TradingCron] ========== CYCLE COMPLETE =========="`);
            tradingCronLogger.info(`[TradingCron] Total Processed: ${totalProcessed}`);
            tradingCronLogger.info(`[TradingCron] Succeeded: ${totalSucceeded} | Failed: ${totalFailed}`);
            tradingCronLogger.info(`[TradingCron] Duration: ${duration}ms (${(duration / 1000).toFixed(2)}s)`);
            tradingCronLogger.info(`${'='.repeat(80)}`);
            
            // 🚀 Trigger Payload sync after the cycle finishes
            tradingCronLogger.info(`[TradingCron] Chaining Payload synchronization...`);
            await BulkSyncService.runFullSync();
            
            tradingCronLogger.info(`${'='.repeat(80)}`);
            endCycleLogging();
        }
    });

    tradingCronLogger.info(`[CronScheduler] Trading cycle cron job scheduled: "${env.cronSchedule}"`);
    tradingCronLogger.info(`[CronScheduler] Next execution will be triggered based on the schedule.`);
};

export default tradingCycleCronJob;