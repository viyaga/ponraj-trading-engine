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
import { isIndianMarketTime, getISTDetails, isNSEMarketOpen } from "../utils/indianMarketTime";
import { startCycleLogging, endCycleLogging } from "../utils/cycleLogger";
import { AngelStreamService } from "../services/tradingV2/angel-stream.service";
import { AngelMarketDataService } from "../services/tradingV2/angel-market-data.service";
import { TriggerManagerService } from "../services/tradingV2/trigger-manager.service";
import { LiveCandleBuilder } from "../services/tradingV2/live-candle-builder";
import { TradeState } from "../models/tradeState.model";
import { ActivePositionTracker } from "../services/tradingV2/active-position-tracker";

/* ============================================================================
 * Cron Scheduler — Execution Window (Mon–Fri 9:15 AM - 3:30 PM IST)
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
let isInitialStartupCyclePending = true;

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

    // ── 1. Indian Market Hours Guard (Strictly Mon-Fri 09:15 - 15:30 IST, non-holiday) ──
    if (!isIndianMarketTime()) {
        if (env.isTesting || env.useCacheCandle) {
            tradingCronLogger.info(`[TradingCron] ⚠️ [TEST/CACHE_CANDLE OVERRIDE] Indian market is officially closed — proceeding in test/cache mode`);
        } else {
            const ist = getISTDetails();
            tradingCronLogger.debug(`[TradingCron] Outside Indian market hours (09:15 AM - 03:30 PM IST Mon-Fri). Current IST: ${ist.isoDate} ${ist.displayTime}. Skipping cycle.`);
            isCycleRunning = false;
            return;
        }
    }

    // ── 1B. Bot Trading Entry Window Check (09:30 AM - 03:15 PM IST) ──
    if (!isNSETradingHours()) {
        if (env.isTesting || env.useCacheCandle) {
            tradingCronLogger.info("[TradingCron] ⚠️ [TEST/CACHE_CANDLE OVERRIDE] Outside 9:30-15:15 bot entry window — proceeding in test/cache mode");
        } else {
            const hasOpenPos = await ActivePositionTracker.hasActivePositions();
            if (!hasOpenPos) {
                tradingCronLogger.debug("[TradingCron] Within market hours, but outside bot entry window (9:30 AM - 3:15 PM IST) and 0 open positions — skipping cycle");
                isCycleRunning = false;
                return;
            }
            tradingCronLogger.info("[TradingCron] Outside bot entry window but active positions exist — running position monitoring cycle");
        }
    }

    startCycleLogging();
    try {
        const ist = getISTDetails();
        const istMinutes = ist.totalMinutes;
        const istMinute = ist.minutes;

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
            // - Initial startup cycle (runs once after boot to evaluate current bar)
            // - Active open positions exist (monitored every tick for trailing SL & targets)
            // - Stream disconnected (fallback polling)
            // - Completed 15m candle boundary crossed (for Candle Pattern Strategy)
            // - Completed 1h candle boundary crossed for UT Bot
            // - ATR Strategy active in 3:00 PM – 3:15 PM window
            // - Any generic bots that don't have UT Bot or Candle Pattern strategy
            const isInitialRun = isInitialStartupCyclePending;
            isInitialStartupCyclePending = false;

            const hasCandlePatternBotsToEvaluate = isNew15mBoundary && cachedConfigs.some(c => c.CANDLE_PATTERN_STRATEGY_ENABLED !== false);
            const hasUtBoundaryBotsToEvaluate = (current1hBoundary > lastRefreshed1hBoundary) && cachedConfigs.some(c => c.UT_BOT_ENABLED !== false);
            const hasAtrStrategyBots = is3pmTo315pmWindow() && cachedConfigs.some(c => c.ATR_STRATEGY_ENABLED);
            const hasGenericPollBots = cachedConfigs.some(c => !c.UT_BOT_ENABLED && c.CANDLE_PATTERN_STRATEGY_ENABLED === false && !c.ATR_STRATEGY_ENABLED);

            const needsCycleRun =
                isInitialRun ||
                hasOpenPos ||
                env.useCacheCandle ||
                !isStreamConnected ||
                hasCandlePatternBotsToEvaluate ||
                hasUtBoundaryBotsToEvaluate ||
                hasAtrStrategyBots ||
                hasGenericPollBots;

            // ── 6. Efficiency Guard: Real-Time Stream vs Fallback Polling ────────
            // If NO bot needs standard cycle execution AND stream is actively guarding:
            if (!needsCycleRun) {
                const niftyLtp = AngelStreamService.getLtp('99926000');
                const hasUtBotActive = cachedConfigs.some(c => c.UT_BOT_ENABLED !== false);
                const next15mBoundary = AngelMarketDataService.candleBoundary15m(Date.now()) + 15 * 60 * 1000;
                const next15mStr = new Date(next15mBoundary).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

                const currentIstStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
                const minsLeft = Math.max(0, Math.ceil((next15mBoundary - Date.now()) / 60000));

                let candleInfo: string;
                if (hasUtBotActive) {
                    const live1h = niftyLtp ? LiveCandleBuilder.getLive1hCandle('99926000', niftyLtp) : null;
                    const barTime = live1h ? new Date(live1h.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : 'N/A';
                    candleInfo = live1h
                        ? `1H Bar [${barTime} IST] O: ₹${live1h.open.toFixed(1)} H: ₹${live1h.high.toFixed(1)} L: ₹${live1h.low.toFixed(1)} C: ₹${live1h.close.toFixed(1)}`
                        : 'Forming';
                } else {
                    const live15m = niftyLtp ? LiveCandleBuilder.getLive15mCandle('99926000', niftyLtp) : null;
                    const barTime = live15m ? new Date(live15m.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : 'N/A';
                    candleInfo = live15m
                        ? `15m Forming Bar [${barTime} IST] O: ₹${live15m.open.toFixed(2)} H: ₹${live15m.high.toFixed(2)} L: ₹${live15m.low.toFixed(2)} C: ₹${live15m.close.toFixed(2)}`
                        : 'Forming';
                }

                tradingCronLogger.info(
                    `[TradingCron] ⚡ STREAM HEARTBEAT [${currentIstStr} IST] | Spot: ₹${niftyLtp ? niftyLtp.toFixed(2) : 'Awaiting tick'} | ` +
                    `${candleInfo} | Next Close: ${next15mStr} IST (in ~${minsLeft}m) | Open Pos: 0`
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
                : isInitialRun
                    ? 'STARTUP_EVALUATION'
                    : !isStreamConnected
                        ? 'FALLBACK_POLL'
                        : isNew15mBoundary
                            ? '15M_CANDLE_CLOSE'
                            : 'STRATEGY_POLL';

            const nowIstStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
            const boundary15mStr = new Date(current15mBoundary).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
            const triggerReason = hasOpenPos
                ? '🔍 Active Position Monitoring (Trailing Stop / Target check)'
                : isInitialRun
                    ? '🚀 Engine Startup Boot Cycle'
                    : !isStreamConnected
                        ? '⚠️ WebSocket Stream Disconnected (Fallback Polling)'
                        : isNew15mBoundary
                            ? `🔔 15M Candle Boundary [${boundary15mStr} IST] — Closed Bar Evaluation`
                            : '⚡ On-Demand / Heartbeat Strategy Scan';

            tradingCronLogger.info(`${"=".repeat(80)}`);
            tradingCronLogger.info(`[TradingCron] 🚀 CYCLE START: ${mode} [${nowIstStr} IST]`);
            tradingCronLogger.info(`[TradingCron] Trigger Reason:  ${triggerReason}`);
            tradingCronLogger.info(`[TradingCron] Configured Bots: ${cachedConfigs.length} (Index: ${cachedConfigs.map(c => c.INDEX).join(', ')})`);
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
                const next15mTs = current15mBoundary + 15 * 60 * 1000;
                const next15mStr = new Date(next15mTs).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
                tradingCronLogger.info(`${"=".repeat(80)}`);
                tradingCronLogger.info(`[TradingCron] 🏁 CYCLE COMPLETE: ${mode}`);
                tradingCronLogger.info(`[TradingCron] Results: Processed: ${totalProcessed} | Succeeded: ${totalSucceeded} | Failed: ${totalFailed} | Duration: ${(duration / 1000).toFixed(2)}s`);
                tradingCronLogger.info(`[TradingCron] Next 15M Candle Close: ${next15mStr} IST (Live tick accumulation in progress)`);
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
    // Schedule recurring cron strictly in Asia/Kolkata timezone
    const cronSchedule = env.cronSchedule ?? "*/1 9-15 * * 1-5";
    cron.schedule(cronSchedule, async () => {
        await executeTradingCycle();
    }, {
        timezone: "Asia/Kolkata",
    });

    tradingCronLogger.info(`[CronScheduler] Recurring cron scheduled: "${cronSchedule}" with timezone: "Asia/Kolkata" (Indian Market: 09:15–15:30 IST Mon–Fri)`);

    // Immediate startup execution check (delayed 2s for WebSocket auto-login & DB connection to stabilize)
    setTimeout(async () => {
        if (isIndianMarketTime()) {
            tradingCronLogger.info("[TradingCron] ➔ Indian Market is OPEN — Triggering immediate startup trading cycle check...");
            await executeTradingCycle().catch((err) => {
                tradingCronLogger.error(`[TradingCron] Startup cycle failed: ${err.message}`, { error: err });
            });
        } else {
            const ist = getISTDetails();
            tradingCronLogger.info(
                `[TradingCron] ➔ Indian Market is currently CLOSED (Current IST: ${ist.isoDate} ${ist.displayTime}, Day: ${ist.dayOfWeek}). ` +
                `Cycle execution and cycle logging will remain idle until next market session (09:15–15:30 IST Mon–Fri).`
            );
        }
    }, 2000);
};

export default tradingCycleCronJob;