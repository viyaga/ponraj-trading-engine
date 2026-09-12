import cron from "node-cron";
import { env } from "../config";
import errorLogger from "../utils/errorLogger";
import { TradingV2 } from "../services/tradingV2";
import { Data } from "../services/tradingV2/data";
import { TradingConfig } from "../services/tradingV2/config";
import { ConfigType } from "../services/tradingV2/type";
import { tradingCronLogger } from "../services/tradingV2/logger";
import { BulkSyncService } from "../services/bulkSync.service";
import { isNSETradingHours } from "../services/tradingV2/strategies/atr14-strategy";
import { startCycleLogging, endCycleLogging } from "../utils/cycleLogger";
import { AngelStreamService } from "../services/tradingV2/angel-stream.service";
import { AngelMarketDataService } from "../services/tradingV2/angel-market-data.service";
import { TriggerManagerService } from "../services/tradingV2/trigger-manager.service";
import { LiveCandleBuilder } from "../services/tradingV2/live-candle-builder";
import { TradeState } from "../models/tradeState.model";
import { ActivePositionTracker } from "../services/tradingV2/active-position-tracker";

/* ============================================================================
 * Cron Scheduler — Execution Window (Mon–Fri 9:30 AM - 3:15 PM IST)
 * ============================================================================ */

// ── In-Memory Config Cache (15 min TTL) ──────────────────────────────────────
let cachedConfigs: ConfigType[] = [];
let lastConfigFetchTime = 0;
const CONFIG_CACHE_TTL = 15 * 60 * 1000; // 15 minutes to prevent backend load

// ── BulkSync Interval (5 min TTL) ────────────────────────────────────────────
let lastBulkSyncTime = 0;
const BULK_SYNC_INTERVAL = 5 * 60 * 1000;

// ── 1-Hour Candle Boundary Tracker ───────────────────────────────────────────
let lastRefreshed1hBoundary = 0;

/**
 * Manually invalidate bot config cache (e.g., when called from admin API)
 */
export const invalidateConfigCache = (): void => {
    lastConfigFetchTime = 0;
    tradingCronLogger.info('[TradingCron] Bot config cache invalidated.');
};

/**
 * Fetch and refresh bot configs on-demand (e.g., admin webhook/endpoint)
 */
export const refreshConfigsOnDemand = async (): Promise<ConfigType[]> => {
    invalidateConfigCache();
    tradingCronLogger.info('[TradingCron] ➔ Refreshing bot configs on demand...');
    const freshConfigs: ConfigType[] = [];
    let offset = 0;
    const LIMIT = 100;
    while (true) {
        const cfgs = await Data.fetchTradingConfigs({ limit: LIMIT, offset });
        if (!cfgs.length) break;
        freshConfigs.push(...cfgs);
        offset += LIMIT;
        if (cfgs.length < LIMIT) break;
    }
    cachedConfigs = freshConfigs;
    lastConfigFetchTime = Date.now();
    const triggerMgr = TriggerManagerService.getInstance();
    await triggerMgr.initialize(cachedConfigs);
    tradingCronLogger.info(`[TradingCron] ✔ On-demand refresh cached ${cachedConfigs.length} bot config(s) (TTL: 15m)`);
    return cachedConfigs;
};

const tradingCycleCronJob = (): void => {

    // Default schedule: every 1 minute during trading hours, Monday–Friday
    cron.schedule(env.cronSchedule ?? "*/1 9-15 * * 1-5", async () => {

        // ── 1. Market Hours Guard ───────────────────────────────────────────
        if (!isNSETradingHours()) {
            if (env.isTesting) {
                tradingCronLogger.info("[TradingCron] ⚠️ [IS_TESTING=true] Overriding bot trading hours guard — running cycle in testing mode");
            } else {
                tradingCronLogger.debug("[TradingCron] Outside bot trading hours (9:30 AM - 3:15 PM IST) — skipping cycle");
                return;
            }
        }

        startCycleLogging();
        try {
            const now = new Date();
            const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
            const istMinute = istMinutes % 60;

            // ── 2. Fetch or Refresh Bot Configs (cached for 15 minutes) ──────────
            const isConfigStale = (Date.now() - lastConfigFetchTime > CONFIG_CACHE_TTL) || cachedConfigs.length === 0;
            if (isConfigStale) {
                try {
                    tradingCronLogger.info("[TradingCron] ➔ Refreshing bot configs from backend (cache expired or cold start)...");
                    const freshConfigs: ConfigType[] = [];
                    let offset = 0;
                    const LIMIT = 100;
                    while (true) {
                        const cfgs = await Data.fetchTradingConfigs({ limit: LIMIT, offset });
                        if (!cfgs.length) break;
                        freshConfigs.push(...cfgs);
                        offset += LIMIT;
                        if (cfgs.length < LIMIT) break;
                    }

                    cachedConfigs = freshConfigs;
                    lastConfigFetchTime = Date.now();
                    tradingCronLogger.info(`[TradingCron] ✔ Cached ${cachedConfigs.length} bot config(s) (TTL: 15m)`);

                    // Update Trigger Manager with fresh configs
                    const triggerMgr = TriggerManagerService.getInstance();
                    await triggerMgr.initialize(cachedConfigs);

                } catch (err: any) {
                    tradingCronLogger.error(`[TradingCron] ✖ Failed to fetch bot configs: ${err.message}`, { error: err });
                }
            }

            // ── 3. Hourly Candle Boundary Recalculation (at close of every 1H bar: 10:15, 11:15, 12:15, 13:15, 14:15, 15:15 IST) ──
            const current1hBoundary = AngelMarketDataService.candleBoundary1h(Date.now());
            if (current1hBoundary > lastRefreshed1hBoundary) {
                const boundaryTimeStr = new Date(current1hBoundary).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
                tradingCronLogger.info(`[TradingCron] 🔔 New 1-Hour candle boundary reached [${boundaryTimeStr} IST] — refreshing UT Bot trigger thresholds and evaluating bar close...`);
                lastRefreshed1hBoundary = current1hBoundary;
                TradingV2.clearCaches();
                await TriggerManagerService.getInstance().onHourCandleBoundary(current1hBoundary);
            }

            // ── 4. Check if any active positions exist (0-latency In-Memory Cache) ──
            const hasOpenPos = await ActivePositionTracker.hasActivePositions();
            const stream = AngelStreamService.getInstance();
            const isStreamConnected = stream.isConnected();

            // ── 5. Efficiency Guard: Real-Time Stream vs Fallback Polling ────────
            // If NO open position exists AND Angel One WebSocket is actively streaming:
            // WebSocket ticks are already checking the price thresholds with <100ms latency.
            // We do NOT need to execute heavy REST/DB queries, candle calculations, and disk logs every 60 seconds!
            if (!hasOpenPos && isStreamConnected && !env.isTesting) {
                const niftyLtp = AngelStreamService.getLtp('99926000');
                const liveCandle = niftyLtp ? LiveCandleBuilder.getLive1hCandle('99926000', niftyLtp) : null;
                const barTime = liveCandle ? new Date(liveCandle.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : 'N/A';
                const candleInfo = liveCandle
                    ? `1H Bar [${barTime} IST] O: ₹${liveCandle.open.toFixed(1)} H: ₹${liveCandle.high.toFixed(1)} L: ₹${liveCandle.low.toFixed(1)} C: ₹${liveCandle.close.toFixed(1)}`
                    : 'Forming';

                tradingCronLogger.info(
                    `[TradingCron] ⚡ STREAM ACTIVE: Spot: ₹${niftyLtp ? niftyLtp.toFixed(2) : 'Awaiting tick'} | ` +
                    `${candleInfo} | Bots: ${cachedConfigs.length} | Open Pos: 0 | Threshold Guard Active`
                );

                // Sync with backend ONLY if there are pending trade changes
                if (BulkSyncService.hasPendingChanges()) {
                    await BulkSyncService.runFullSync();
                    lastBulkSyncTime = Date.now();
                }
                return;
            }

            // If stream is disconnected, attempt to reconnect (only if not already connecting)
            if (!isStreamConnected && !stream.isConnectingNow()) {
                tradingCronLogger.warn('[TradingCron] ⚠️ AngelStreamService disconnected — attempting auto-reconnect and running fallback cycle...');
                stream.connect().catch(() => {});
            }

            // ── 6. Fallback or Active Position Reconciliation Cycle ──────────────
            const startTime = Date.now();
            let totalProcessed = 0;
            let totalSucceeded = 0;
            let totalFailed    = 0;
            const CONCURRENCY = 2;

            tradingCronLogger.info(`${"=".repeat(80)}`);
            tradingCronLogger.info(`[TradingCron] ========== CYCLE START (Mode: ${hasOpenPos ? 'POSITION_MONITOR' : 'FALLBACK_POLL'}) ==========`);
            tradingCronLogger.info(`${"=".repeat(80)}`);

            TradingV2.clearCaches();

            try {
                const configsToRun = cachedConfigs.length > 0 ? cachedConfigs : await Data.fetchTradingConfigs({ limit: 100, offset: 0 });

                const executing = new Set<Promise<any>>();
                for (const cfg of configsToRun) {
                    const p = (async () => {
                        tradingCronLogger.info(`[TradingCron] Starting cycle: bot ${cfg.id} (${cfg.INDEX} | DRY_RUN: ${cfg.DRY_RUN})`);
                        try {
                            const res = await TradingConfig.configStore.run(
                                cfg,
                                () => TradingV2.runTradingCycle(cfg)
                            );
                            totalSucceeded++;
                            return res;
                        } catch (err) {
                            totalFailed++;
                            tradingCronLogger.error(`[TradingCron] ✗ Bot ${cfg.id} failed:`, { error: err });
                        }
                    })();

                    executing.add(p);
                    p.finally(() => executing.delete(p));
                    if (executing.size >= CONCURRENCY) {
                        await Promise.race(executing);
                    }
                }

                await Promise.all(Array.from(executing));
                totalProcessed = configsToRun.length;

            } catch (error) {
                tradingCronLogger.error("[TradingCron] CRITICAL ERROR in fallback cycle:", { error });
                errorLogger.error("[TradingCron] Cron cycle failed", error);
            } finally {
                const duration = Date.now() - startTime;
                tradingCronLogger.info(`${"=".repeat(80)}`);
                tradingCronLogger.info("[TradingCron] ========== CYCLE COMPLETE ==========");
                tradingCronLogger.info(`[TradingCron] Processed: ${totalProcessed} | ✓ ${totalSucceeded} | ✗ ${totalFailed} | Duration: ${(duration / 1000).toFixed(2)}s`);
                tradingCronLogger.info(`${"=".repeat(80)}`);

                await BulkSyncService.runFullSync();
                lastBulkSyncTime = Date.now();
            }
        } finally {
            endCycleLogging();
        }
    });

    tradingCronLogger.info(`[CronScheduler] Optimized Cron scheduled: "${env.cronSchedule ?? "*/1 9-15 * * 1-5"}" (WebSocket + Threshold Guard Active)`);
};

export default tradingCycleCronJob;