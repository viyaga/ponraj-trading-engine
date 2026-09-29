import cron from "node-cron";
import { env } from "../config";
import errorLogger from "../utils/errorLogger";
import { TradingV2 } from "../services/tradingV2";
import { Data } from "../services/tradingV2/data";
import { TradingConfig } from "../services/tradingV2/config";
import { ConfigType } from "../services/tradingV2/type";
import { tradingCronLogger } from "../services/tradingV2/logger";
import { BulkSyncService } from "../services/bulkSync.service";
import { isNSETradingHours, is3pmTo315pmWindow } from "../services/tradingV2/strategies/atr14-strategy";
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

// ── Candle Boundary Trackers ────────────────────────────────────────────────
let lastRefreshed1hBoundary = 0;
let lastRefreshed15mBoundary = 0;

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

    // Initialize boundary tracker to prevent immediate duplicate fetch
    if (lastRefreshed1hBoundary === 0) {
        lastRefreshed1hBoundary = AngelMarketDataService.candleBoundary1h(Date.now());
    }
    if (lastRefreshed15mBoundary === 0) {
        lastRefreshed15mBoundary = AngelMarketDataService.candleBoundary15m(Date.now());
    }

    tradingCronLogger.info(`[TradingCron] ✔ On-demand refresh cached ${cachedConfigs.length} bot config(s) (TTL: 15m)`);
    return cachedConfigs;
};

let isCycleRunning = false;

/**
 * Execute a single trading cycle run
 */
export const executeTradingCycle = async (): Promise<void> => {
    if (isCycleRunning) {
        tradingCronLogger.debug("[TradingCron] Previous cycle still executing — skipping tick.");
        return;
    }
    isCycleRunning = true;

    // ── 1. Market Hours Guard ───────────────────────────────────────────
    if (!isNSETradingHours()) {
        if (env.isTesting) {
            tradingCronLogger.info("[TradingCron] ⚠️ [IS_TESTING=true] Overriding bot trading hours guard — running cycle in testing mode");
        } else {
            tradingCronLogger.debug("[TradingCron] Outside bot trading hours (9:30 AM - 3:15 PM IST) — skipping cycle");
            isCycleRunning = false;
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

                    // Initialize boundary trackers to avoid duplicate initial REST fetch
                    if (lastRefreshed1hBoundary === 0) {
                        lastRefreshed1hBoundary = AngelMarketDataService.candleBoundary1h(Date.now());
                    }
                    if (lastRefreshed15mBoundary === 0) {
                        lastRefreshed15mBoundary = AngelMarketDataService.candleBoundary15m(Date.now());
                    }

                } catch (err: any) {
                    tradingCronLogger.error(`[TradingCron] ✖ Failed to fetch bot configs: ${err.message}`, { error: err });
                }
            }

            // ── 3. Hourly Candle Boundary Recalculation (at close of every 1H bar: 10:15, 11:15, 12:15, 13:15, 14:15, 15:15 IST) ──
            const current1hBoundary = AngelMarketDataService.candleBoundary1h(Date.now());
            if (current1hBoundary > lastRefreshed1hBoundary) {
                const boundaryTimeStr = new Date(current1hBoundary).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
                lastRefreshed1hBoundary = current1hBoundary;
                const triggerMgr = TriggerManagerService.getInstance();
                if (triggerMgr.hasActiveBots()) {
                    tradingCronLogger.info(`[TradingCron] 🔔 New 1-Hour candle boundary reached [${boundaryTimeStr} IST] — refreshing UT Bot trigger thresholds and evaluating bar close...`);
                    TradingV2.clearCaches();
                    await triggerMgr.onHourCandleBoundary(current1hBoundary);
                }
            }

            // ── 3B. 15-Minute Candle Boundary Detection (for Candle Pattern Strategy) ──
            const current15mBoundary = AngelMarketDataService.candleBoundary15m(Date.now());
            const isNew15mBoundary = current15mBoundary > lastRefreshed15mBoundary;
            if (isNew15mBoundary) {
                lastRefreshed15mBoundary = current15mBoundary;
                const boundary15mStr = new Date(current15mBoundary).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
                tradingCronLogger.info(`[TradingCron] 🔔 New 15-Minute candle boundary reached [${boundary15mStr} IST] — evaluating 15m strategies...`);
            }

            // ── 4. Check if any active positions exist (0-latency In-Memory Cache) ──
            const hasOpenPos = await ActivePositionTracker.hasActivePositions();
            const stream = AngelStreamService.getInstance();
            const isStreamConnected = stream.isConnected();

            // ── 5. Strategy Execution Check ──────────────────────────────────────
            // Check if any bots need cycle execution:
            // - Any bot with UT_BOT_ENABLED === false (not guarded by TriggerManagerService real-time stream!)
            // - Any bot on a completed 15m candle boundary (for Candle Pattern Strategy)
            // - Any bot with ATR_STRATEGY_ENABLED in the 3:00 PM – 3:15 PM window
            const hasNonUtGuardedBots = cachedConfigs.some(c => !c.UT_BOT_ENABLED);
            const hasCandlePatternBots = cachedConfigs.some(c => c.CANDLE_PATTERN_STRATEGY_ENABLED !== false);
            const hasAtrStrategyBots = is3pmTo315pmWindow() && cachedConfigs.some(c => c.ATR_STRATEGY_ENABLED);

            const needsCycleRun =
                hasOpenPos ||
                !isStreamConnected ||
                hasNonUtGuardedBots ||
                (isNew15mBoundary && hasCandlePatternBots) ||
                hasAtrStrategyBots ||
                env.isTesting;

            // ── 6. Efficiency Guard: Real-Time Stream vs Fallback Polling ────────
            // If NO bot needs standard cycle execution AND stream is actively guarding UT Bot:
            if (!needsCycleRun) {
                const niftyLtp = AngelStreamService.getLtp('99926000');
                const liveCandle = niftyLtp ? LiveCandleBuilder.getLive1hCandle('99926000', niftyLtp) : null;
                const barTime = liveCandle ? new Date(liveCandle.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : 'N/A';
                const candleInfo = liveCandle
                    ? `1H Bar [${barTime} IST] O: ₹${liveCandle.open.toFixed(1)} H: ₹${liveCandle.high.toFixed(1)} L: ₹${liveCandle.low.toFixed(1)} C: ₹${liveCandle.close.toFixed(1)}`
                    : 'Forming';

                tradingCronLogger.info(
                    `[TradingCron] ⚡ STREAM ACTIVE: Spot: ₹${niftyLtp ? niftyLtp.toFixed(2) : 'Awaiting tick'} | ` +
                    `${candleInfo} | Bots: ${cachedConfigs.length} (UT Guarded: ${TriggerManagerService.getInstance().getActiveBotCount()}) | Open Pos: 0 | Threshold Guard Active`
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

            // ── 7. Strategy Execution / Fallback / Active Position Cycle ──────────
            const startTime = Date.now();
            let totalProcessed = 0;
            let totalSucceeded = 0;
            let totalFailed    = 0;
            const CONCURRENCY = 2;

            const mode = hasOpenPos
                ? 'POSITION_MONITOR'
                : !isStreamConnected
                    ? 'FALLBACK_POLL'
                    : isNew15mBoundary
                        ? '15M_CANDLE_CLOSE'
                        : 'STRATEGY_POLL';

            tradingCronLogger.info(`${"=".repeat(80)}`);
            tradingCronLogger.info(`[TradingCron] ========== CYCLE START (Mode: ${mode}) ==========`);
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
        } catch (err: any) {
            tradingCronLogger.error(`[TradingCron] Uncaught error in executeTradingCycle: ${err.message}`, { error: err });
        } finally {
            endCycleLogging();
            isCycleRunning = false;
        }
    };

const tradingCycleCronJob = (): void => {
    // Schedule recurring cron
    cron.schedule(env.cronSchedule ?? "*/1 9-15 * * 1-5", async () => {
        await executeTradingCycle();
    });

    tradingCronLogger.info(`[CronScheduler] Optimized Cron scheduled: "${env.cronSchedule ?? "*/1 9-15 * * 1-5"}" (WebSocket + Threshold Guard Active)`);

    // Immediate startup execution (after 2s delay for WebSocket auto-login & DB connection to stabilize)
    setTimeout(async () => {
        tradingCronLogger.info("[TradingCron] ➔ Triggering immediate startup trading cycle check...");
        await executeTradingCycle().catch((err) => {
            tradingCronLogger.error(`[TradingCron] Startup cycle failed: ${err.message}`, { error: err });
        });
    }, 2000);
};

export default tradingCycleCronJob;