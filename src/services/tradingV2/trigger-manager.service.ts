import { ConfigType, Candle } from './type';
import { AngelStreamService, AngelStreamTick } from './angel-stream.service';
import { UTBotStrategy } from './strategies/ut-bot-strategy';
import { MarketDataService } from './market-data.service';
import { KiteExchange } from './kite-exchange';
import { TradingConfig } from './config';
import { TradingV2 } from './index';
import { Data } from './data';
import { TradeState } from '../../models/tradeState.model';
import { isNSEMarketOpen, isUTBotTradingWindow } from './strategies/atr14-strategy';
import { tradingCronLogger, tradesLogger } from './logger';
import { env } from '../../config';
import { BulkSyncService } from '../bulkSync.service';
import { startCycleLogging, endCycleLogging } from '../../utils/cycleLogger';

export interface BotTriggerState {
    config: ConfigType;
    index: string;
    token: string;
    currentPos: number;         // 1 = LONG, -1 = SHORT, 0 = FLAT
    trailingStop: number;
    bullTrigger: number | null; // Trigger level to BUY CE (when pos is SHORT and price crosses above stop)
    bearTrigger: number | null; // Trigger level to BUY PE (when pos is LONG and price crosses below stop)
    hasOpenPosition: boolean;
    isExecuting: boolean;
    lastEvaluatedCandleTs: number;
    lastTriggeredAt: number;
    lastHeartbeatAt: number;
}

export class TriggerManagerService {
    private static instance: TriggerManagerService | null = null;
    private botStates = new Map<string, BotTriggerState>();
    private unsubscribeStream: (() => void) | null = null;
    private isInitialized = false;

    private static readonly NIFTY_TOKEN = '99926000';
    private static readonly BANKNIFTY_TOKEN = '99926009';

    private constructor() {}

    public static getInstance(): TriggerManagerService {
        if (!this.instance) {
            this.instance = new TriggerManagerService();
        }
        return this.instance;
    }

    /**
     * Initialize trigger manager with active bot configs and attach to Angel One WebSocket stream
     */
    public async initialize(configs: ConfigType[]): Promise<void> {
        tradingCronLogger.info(`[TriggerManager] ➔ Initializing Trigger Manager with ${configs.length} bot(s)...`);

        for (const cfg of configs) {
            await this.registerBot(cfg);
        }

        if (!this.isInitialized) {
            const stream = AngelStreamService.getInstance();
            this.unsubscribeStream = stream.onTick((tick) => this.handleTick(tick));
            this.isInitialized = true;
            tradingCronLogger.info('[TriggerManager] ✔ Attached to AngelStreamService tick events.');
        }
    }

    /**
     * Register or update a bot's trigger state
     */
    public async registerBot(cfg: ConfigType): Promise<void> {
        const token = (cfg.INDEX === 'BANKNIFTY')
            ? TriggerManagerService.BANKNIFTY_TOKEN
            : TriggerManagerService.NIFTY_TOKEN;

        // Check if bot already has an open position in DB
        const hasOpenPos = await Data.hasOpenPosition(cfg.id);

        let state = this.botStates.get(cfg.id);
        if (!state) {
            state = {
                config: cfg,
                index: cfg.INDEX,
                token,
                currentPos: 0,
                trailingStop: 0,
                bullTrigger: null,
                bearTrigger: null,
                hasOpenPosition: hasOpenPos,
                isExecuting: false,
                lastEvaluatedCandleTs: 0,
                lastTriggeredAt: 0,
                lastHeartbeatAt: 0,
            };
            this.botStates.set(cfg.id, state);
        } else {
            state.config = cfg;
            state.hasOpenPosition = hasOpenPos;
        }

        // Calculate initial triggers
        await this.refreshBotTriggers(cfg.id);
    }

    /**
     * Recalculate UT Bot trailing stop and crossover trigger thresholds for a bot
     */
    public async refreshBotTriggers(botId: string, isBoundaryClose: boolean = false): Promise<void> {
        const state = this.botStates.get(botId);
        if (!state) return;

        const c = state.config;
        if (!c.API_KEY || !c.ACCESS_TOKEN) return;

        try {
            const kite = new KiteExchange(c.API_KEY, c.ACCESS_TOKEN);
            // Fetch fresh 1H completed candles (delegates to boundary-aware AngelMarketDataService)
            const candles1h = await MarketDataService.get1hCandles(kite, c.INDEX);

            if (!candles1h || candles1h.length < (c.UT_BOT_ATR_PERIOD ?? 10) + 2) {
                tradingCronLogger.warn(`[TriggerManager:${c.id}] Insufficient 1H candles (${candles1h?.length ?? 0}) to set triggers`);
                return;
            }

            const sorted = [...candles1h].sort((a, b) => a.timestamp - b.timestamp);
            const calc = UTBotStrategy.calculateUTBotSeries(sorted, {
                keyValue: c.UT_BOT_KEY_VALUE ?? 1.0,
                atrPeriod: c.UT_BOT_ATR_PERIOD ?? 10,
                useHeikinAshi: c.UT_BOT_USE_HEIKIN_ASHI ?? false,
            });

            const lastIdx = calc.posSeries.length - 1;
            const currentPos = calc.posSeries[lastIdx];
            const currentStop = calc.trailingStopSeries[lastIdx];
            const lastBar = sorted[lastIdx];
            const isBuy = calc.buySignals[lastIdx];
            const isSell = calc.sellSignals[lastIdx];

            state.currentPos = currentPos;
            state.trailingStop = currentStop;
            state.lastEvaluatedCandleTs = lastBar.timestamp;

            // Trigger thresholds for live mid-candle monitoring:
            // If currentPos is SHORT (-1): price crossing ABOVE trailing stop triggers a BUY (CE).
            // If currentPos is LONG (1): price crossing BELOW trailing stop triggers a SELL (PE).
            if (currentPos === -1) {
                state.bullTrigger = currentStop;
                state.bearTrigger = null;
            } else if (currentPos === 1) {
                state.bullTrigger = null;
                state.bearTrigger = currentStop;
            } else {
                state.bullTrigger = currentStop;
                state.bearTrigger = currentStop;
            }

            const barTime = new Date(lastBar.timestamp).toLocaleTimeString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            });

            tradingCronLogger.info(
                `[TriggerManager:${c.id}:${c.INDEX}] 🎯 Trigger Thresholds Updated (Bar: ${barTime} IST):\n` +
                `  Indicator State: ${currentPos === 1 ? 'LONG' : currentPos === -1 ? 'SHORT' : 'FLAT'}\n` +
                `  Trailing Stop:   ₹${currentStop.toFixed(2)}\n` +
                `  Bull Trigger:    ${state.bullTrigger ? '≥ ₹' + state.bullTrigger.toFixed(2) + ' (BUY CE)' : 'NONE'}\n` +
                `  Bear Trigger:    ${state.bearTrigger ? '≤ ₹' + state.bearTrigger.toFixed(2) + ' (BUY PE)' : 'NONE'}\n` +
                `  Signal On Close: ${isBuy ? '🟢 BUY' : isSell ? '🔴 SELL' : 'NONE'}\n` +
                `  Open Position:   ${state.hasOpenPosition ? 'YES' : 'NO'}`
            );

            // ── Check if the candle that JUST CLOSED produced an actionable crossover ──
            if (isBoundaryClose && (isBuy || isSell) && !state.hasOpenPosition && !state.isExecuting) {
                if (!isUTBotTradingWindow(c) && !env.isTesting) {
                    tradingCronLogger.info(`[TriggerManager:${c.id}] ⏸️ Candle-close signal on [${barTime} IST] detected, but outside UT Bot trading window — skipping.`);
                } else {
                    const alreadyTraded = await TradeState.exists({
                        tradingBotId: c.id,
                        signalCandleTimestamp: lastBar.timestamp,
                    });

                    if (alreadyTraded && !env.isTesting) {
                        tradingCronLogger.info(`[TriggerManager:${c.id}] ⏸️ Candle [${barTime} IST] already executed — skipping duplicate candle-close trade.`);
                    } else {
                        tradesLogger.info(
                            `⚡ [TriggerManager:${c.id}:${c.INDEX}] 1-HOUR CANDLE CLOSE CROSSOVER DETECTED!\n` +
                            `  Candle:          [${barTime} IST]\n` +
                            `  Close:           ₹${lastBar.close.toFixed(2)}\n` +
                            `  Trailing Stop:   ₹${currentStop.toFixed(2)}\n` +
                            `  Signal:          ${isBuy ? 'BUY (CE)' : 'SELL (PE)'}\n` +
                            `  Triggering trade execution pipeline...`
                        );

                        state.isExecuting = true;
                        startCycleLogging();
                        try {
                            await TradingConfig.configStore.run(
                                c,
                                () => TradingV2.runTradingCycle(c)
                            );
                            state.hasOpenPosition = await Data.hasOpenPosition(c.id);
                        } catch (err: any) {
                            tradingCronLogger.error(`[TriggerManager:${c.id}] ✖ Error executing candle-close trade: ${err.message}`, { error: err });
                        } finally {
                            if (BulkSyncService.hasPendingChanges()) {
                                await BulkSyncService.runFullSync();
                            }
                            state.isExecuting = false;
                            endCycleLogging();
                        }
                    }
                }
            }

        } catch (err: any) {
            tradingCronLogger.error(`[TriggerManager:${c.id}] ✖ Failed to refresh triggers: ${err.message}`, { error: err });
        }
    }

    /**
     * Called when a 1-hour candle boundary is crossed (e.g. at 10:15, 11:15, 12:15, 13:15, 14:15, 15:15 IST).
     * Recalculates indicators for all bots and checks for candle-close crossover signals.
     */
    public async onHourCandleBoundary(boundaryTs: number): Promise<void> {
        const timeStr = new Date(boundaryTs).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        tradingCronLogger.info(`[TriggerManager] 🔔 Evaluating 1H candle boundary [${timeStr} IST] for ${this.botStates.size} bot(s)...`);
        for (const botId of this.botStates.keys()) {
            await this.refreshBotTriggers(botId, true);
        }
    }

    /**
     * Refresh triggers for all registered bots
     */
    public async refreshAllTriggers(): Promise<void> {
        for (const botId of this.botStates.keys()) {
            await this.refreshBotTriggers(botId, false);
        }
    }

    /**
     * Mark open position status for a bot
     */
    public setOpenPosition(botId: string, hasPosition: boolean): void {
        const state = this.botStates.get(botId);
        if (state) {
            state.hasOpenPosition = hasPosition;
        }
    }

    /**
     * Core event-driven tick handler
     */
    private async handleTick(tick: AngelStreamTick): Promise<void> {
        // Only evaluate during market trading hours
        if (!isNSEMarketOpen() && !env.isTesting) {
            return;
        }

        for (const [botId, state] of this.botStates.entries()) {
            if (state.token !== tick.token) continue;
            if (state.isExecuting) continue; // Concurrency guard

            // ── Case A: Bot has an open position ──
            if (state.hasOpenPosition) {
                // If open position exists, high-priority monitoring is handled
                continue;
            }

            // ── Case B: Seeking new entry signal via mid-candle threshold ──
            if (!isUTBotTradingWindow(state.config) && !env.isTesting) {
                continue;
            }

            let isBreached = false;
            let breachType: 'BULL' | 'BEAR' = 'BULL';

            if (state.bullTrigger !== null && tick.ltp >= state.bullTrigger) {
                isBreached = true;
                breachType = 'BULL';
            } else if (state.bearTrigger !== null && tick.ltp <= state.bearTrigger) {
                isBreached = true;
                breachType = 'BEAR';
            }

            // If not breached, discard immediately (<0.01ms overhead)
            if (!isBreached) {
                // Throttled real-time monitoring heartbeat (logged every 60s per bot)
                const now = Date.now();
                if (now - state.lastHeartbeatAt > 60000) {
                    const target = state.bullTrigger ? `Bull ≥ ₹${state.bullTrigger.toFixed(2)}` : state.bearTrigger ? `Bear ≤ ₹${state.bearTrigger.toFixed(2)}` : 'None';
                    const gap = state.bullTrigger ? (state.bullTrigger - tick.ltp) : state.bearTrigger ? (tick.ltp - state.bearTrigger) : 0;
                    tradingCronLogger.info(
                        `[TriggerManager:${state.config.id}:${state.index}] 🎯 Monitoring: Spot ₹${tick.ltp.toFixed(2)} | ` +
                        `Target: ${target} | Gap: ${gap >= 0 ? '+' : ''}${gap.toFixed(2)} pts | Trend: ${state.currentPos === 1 ? 'LONG' : state.currentPos === -1 ? 'SHORT' : 'FLAT'}`
                    );
                    state.lastHeartbeatAt = now;
                }
                continue;
            }

            // Debounce: prevent firing repeatedly within 10 seconds on tick noise
            const now = Date.now();
            if (now - state.lastTriggeredAt < 10000) {
                continue;
            }

            // ── THRESHOLD BREACH DETECTED: Instant Trade Execution ──
            state.isExecuting = true;
            state.lastTriggeredAt = now;

            // Start dedicated cycle log file for this triggered trade execution
            startCycleLogging();

            const triggerPrice = breachType === 'BULL' ? state.bullTrigger : state.bearTrigger;
            tradesLogger.info(
                `⚡ [TriggerManager:${state.config.id}:${state.index}] REAL-TIME THRESHOLD BREACH DETECTED!\n` +
                `  Tick LTP:        ₹${tick.ltp.toFixed(2)}\n` +
                `  Trigger Level:   ₹${triggerPrice?.toFixed(2)}\n` +
                `  Signal:          ${breachType} (${breachType === 'BULL' ? 'BUY CE' : 'BUY PE'})\n` +
                `  Triggering instant trade execution pipeline...`
            );

            try {
                // Run full trading cycle with context
                await TradingConfig.configStore.run(
                    state.config,
                    () => TradingV2.runTradingCycle(state.config)
                );

                // Update position state after cycle run
                state.hasOpenPosition = await Data.hasOpenPosition(state.config.id);

                // Refresh triggers if crossover occurred
                await this.refreshBotTriggers(botId);

            } catch (err: any) {
                tradingCronLogger.error(`[TriggerManager:${state.config.id}] ✖ Error executing triggered cycle: ${err.message}`, { error: err });
            } finally {
                // Instantly sync any trade state changes with backend
                if (BulkSyncService.hasPendingChanges()) {
                    await BulkSyncService.runFullSync();
                }
                state.isExecuting = false;
                endCycleLogging();
            }
        }
    }

    public cleanup(): void {
        if (this.unsubscribeStream) {
            this.unsubscribeStream();
            this.unsubscribeStream = null;
        }
        this.botStates.clear();
        this.isInitialized = false;
    }
}
