// =============================================================================
// TradingV2 — Main Trading Cycle (Zerodha Kite / NIFTY Options)
// =============================================================================
//
// Strategy: ATR-14 + True Range expansion on NIFTY 50 index candles
//   → Evaluate signal across 3 timeframes
//   → Select best CE/PE strike based on ATR magnitude
//   → Place MIS order on Kite
//   → Monitor via open position P&L for target/SL exits
//
// DRY_RUN=true: logs signals without placing real orders (default)
// =============================================================================

import {
    ConfigType,
    KiteInstrument,
    KitePosition,
    OptionType,
    TradingSignal,
} from './type';
import { KiteExchange, NIFTY_STEP, BANKNIFTY_STEP } from './kite-exchange';
import { MarketDataService } from './market-data.service';
import { ATR14Strategy, getMinutesToMarketClose, isNSEMarketOpen, is3pmTo315pmWindow } from './strategies/atr14-strategy';
import { UTBotStrategy } from './strategies/ut-bot-strategy';
import { Data } from './data';
import { TradeState } from '../../models/tradeState.model';
import { env } from '../../config';
import {
    tradingCronLogger,
    tradingCycleErrorLogger,
    skipTradingLogger,
    tradesLogger,
} from './logger';

// Cache NFO instruments for 6 hours (refreshed at market open)
let instrumentCache: KiteInstrument[] = [];
let instrumentCacheAt = 0;
const INSTRUMENT_CACHE_TTL = 6 * 60 * 60 * 1000;

export class TradingV2 {

    static clearCaches(): void {
        MarketDataService.clearCaches();
    }

    // ─── Public entry point (called by cron per bot) ───────────────────────

    static async runTradingCycle(c: ConfigType): Promise<void> {
        const cycleId = `cycle-${Date.now().toString(36)}`;
        const tag     = `[TradingCycle:${c.id}:${c.INDEX}]`;

        tradingCronLogger.info(`${tag} ========== START (DRY_RUN: ${c.DRY_RUN}${env.isTesting ? ' | IS_TESTING' : ''}) ==========`);

        try {
            // ── 1. Market Hours Guard ─────────────────────────────────────
            if (!isNSEMarketOpen()) {
                if (env.isTesting) {
                    tradingCronLogger.info(`${tag} ⚠️ [IS_TESTING=true] Overriding NSE market hours guard — proceeding with cycle in test mode`);
                } else {
                    skipTradingLogger.info(`${tag} SKIP: NSE market is closed`);
                    return;
                }
            }

            // ── 2. Initialize Kite client for this bot ────────────────────
            if (!c.API_KEY || !c.ACCESS_TOKEN) {
                tradingCycleErrorLogger.error(`${tag} Missing API_KEY or ACCESS_TOKEN — skipping`);
                return;
            }
            const kite = new KiteExchange(c.API_KEY, c.ACCESS_TOKEN);

            // ── 3. Fetch market data (1h & 15m NIFTY/BANKNIFTY index candles + spot LTP) ─
            const marketData = await MarketDataService.fetchMarketData(
                c, kite, tradingCronLogger, skipTradingLogger
            );
            if (!marketData) return;

            const { candles15m, candles1h, spotPrice } = marketData;

            // ── 4. Signal Evaluation: Multi-Strategy Priority Orchestration ──
            let chosenSignal: TradingSignal = 'NONE';
            let chosenOptionType: OptionType | null = null;
            let chosenATR: number = 0;
            let chosenScore: number = 0;
            let strategyName: string = '';
            let reasons: string[] = [];
            let skipReasons: string[] = [];

            // ── 4A. PRIORITY 1: UT Bot Strategy (1-Hour Timeframe) ────────
            const isUtBotEnabled = c.UT_BOT_ENABLED ?? true;
            if (isUtBotEnabled) {
                const utResult = UTBotStrategy.evaluateSignal(
                    candles1h,
                    spotPrice,
                    {
                        keyValue: c.UT_BOT_KEY_VALUE ?? 1.0,
                        atrPeriod: c.UT_BOT_ATR_PERIOD ?? 10,
                        useHeikinAshi: c.UT_BOT_USE_HEIKIN_ASHI ?? false,
                    }
                );

                tradingCronLogger.info(
                    `${tag} [UTBot 1H] Signal: ${utResult.signal} | ` +
                    `ATR: ${utResult.atr.toFixed(1)} | ` +
                    `TrailingStop: ${utResult.trailingStop.toFixed(1)} | ` +
                    `Reasons: ${utResult.reasons.join('; ')}`
                );

                if (utResult.signal !== 'NONE') {
                    chosenSignal = utResult.signal;
                    chosenOptionType = utResult.optionType;
                    chosenATR = utResult.atr;
                    chosenScore = utResult.score;
                    strategyName = 'UT_BOT_1H';
                    reasons = utResult.reasons;
                } else if (utResult.skipReasons.length) {
                    skipReasons.push(...utResult.skipReasons);
                }
            }

            // ── 4B. PRIORITY 2: ATR-14 Strategy (15-Minute 3:00 PM Window) ─
            if (chosenSignal === 'NONE' && (is3pmTo315pmWindow() || env.isTesting)) {
                if (env.isTesting && !is3pmTo315pmWindow()) {
                    tradingCronLogger.info(`${tag} ⚠️ [IS_TESTING=true] Overriding 3:00 PM - 3:15 PM window for ATR14 evaluation`);
                }
                const atrResult = ATR14Strategy.evaluateSignal(
                    candles15m,
                    spotPrice,
                    undefined,
                    c.ATR_PERIOD
                );

                tradingCronLogger.info(
                    `${tag} [ATR14 15m] Signal: ${atrResult.signal} | ` +
                    `ATR14: ${atrResult.atr14.toFixed(1)} | ` +
                    `TR: ${atrResult.tr.toFixed(1)} | ` +
                    `Reasons: ${atrResult.reasons.join('; ')}`
                );

                if (atrResult.signal !== 'NONE') {
                    chosenSignal = atrResult.signal;
                    chosenOptionType = atrResult.optionType;
                    chosenATR = atrResult.atr14;
                    chosenScore = atrResult.score;
                    strategyName = 'ATR14_15M';
                    reasons = atrResult.reasons;
                } else if (atrResult.skipReasons.length) {
                    skipReasons.push(...atrResult.skipReasons);
                }
            }

            if (skipReasons.length && chosenSignal === 'NONE') {
                skipTradingLogger.info(`${tag} Skip reasons: ${skipReasons.join('; ')}`);
            }

            // ── 5. Daily loss & open position checks ──────────────────────
            const [dailyLossHit, hasOpenPos] = await Promise.all([
                Data.isDailyLossLimitReached(c.id, c.MAX_LOSS_PER_DAY),
                Data.hasOpenPosition(c.id),
            ]);

            // ── 6. Filter checks (Open position, daily loss, signal present) ──
            if (chosenSignal === 'NONE' || !chosenOptionType) {
                return;
            }
            if (hasOpenPos) {
                skipTradingLogger.info(`${tag} SKIP: Open position already exists for this bot`);
                return;
            }
            if (dailyLossHit) {
                skipTradingLogger.info(`${tag} SKIP: Max daily loss limit (₹${c.MAX_LOSS_PER_DAY}) reached`);
                return;
            }

            tradingCronLogger.info(
                `${tag} 🚀 Selected Signal: ${chosenSignal} (${chosenOptionType}) from [${strategyName}] | ` +
                `ATR: ${chosenATR.toFixed(1)} | Reasons: ${reasons.join('; ')}`
            );

            // ── 7. Strike selection ───────────────────────────────────────
            const stepSize   = c.INDEX === 'BANKNIFTY' ? BANKNIFTY_STEP : NIFTY_STEP;
            const optionType = chosenOptionType; // 'CE' or 'PE'
            const strike     = kite.selectStrike(spotPrice, optionType, chosenATR, stepSize);

            tradingCronLogger.info(
                `${tag} Strike selected: ${strike} ${optionType} | ` +
                `Spot: ${spotPrice.toFixed(2)} | ATR: ${chosenATR.toFixed(1)}`
            );

            // ── 8. Load NFO instruments (cached) ──────────────────────────
            if (!instrumentCache.length || Date.now() - instrumentCacheAt > INSTRUMENT_CACHE_TTL) {
                tradingCronLogger.info(`${tag} Refreshing NFO instrument list...`);
                instrumentCache   = await kite.getInstruments('NFO');
                instrumentCacheAt = Date.now();
                tradingCronLogger.info(`${tag} Loaded ${instrumentCache.length} NFO instruments`);
            }

            // ── 9. Find target option instrument ─────────────────────────
            const instrument = kite.findOptionInstrument(
                instrumentCache,
                c.INDEX,
                strike,
                optionType,
                c.EXPIRY_TYPE
            );

            if (!instrument) {
                tradingCycleErrorLogger.error(
                    `${tag} No instrument found for ${c.INDEX} ${strike} ${optionType} ` +
                    `(${c.EXPIRY_TYPE} expiry) — skipping`
                );
                return;
            }

            tradingCronLogger.info(
                `${tag} Instrument: ${instrument.tradingsymbol} | ` +
                `Expiry: ${instrument.expiry} | LotSize: ${instrument.lot_size}`
            );

            const quantity = c.LOT_SIZE * (c.NUMBER_OF_LOTS ?? 1);

            // ── 10. DRY RUN / IS_TESTING GUARD: Stop before placing real trade ──
            if (env.isTesting) {
                tradesLogger.info(
                    `${tag} 🛑 [IS_TESTING=true] Trade stopped before placing real order on Zerodha:\n` +
                    `  Strategy:  ${strategyName}\n` +
                    `  Symbol:    ${instrument.tradingsymbol}\n` +
                    `  Quantity:  ${quantity} (${c.NUMBER_OF_LOTS} lot × ${c.LOT_SIZE})\n` +
                    `  OrderType: ${c.ORDER_TYPE}\n` +
                    `  Product:   ${c.PRODUCT}\n` +
                    `  Spot:      ₹${spotPrice.toFixed(2)}\n` +
                    `  Signal:    ${chosenSignal} (score: ${chosenScore})\n` +
                    `  ATR:       ${chosenATR.toFixed(2)} pts\n` +
                    `  Reasons:   ${reasons.join('; ')}`
                );
                return;
            }

            if (c.DRY_RUN) {
                tradesLogger.info(
                    `${tag} [DRY RUN] Would place BUY order (${strategyName}):\n` +
                    `  Symbol:    ${instrument.tradingsymbol}\n` +
                    `  Quantity:  ${quantity} (${c.NUMBER_OF_LOTS} lot × ${c.LOT_SIZE})\n` +
                    `  OrderType: ${c.ORDER_TYPE}\n` +
                    `  Product:   ${c.PRODUCT}\n` +
                    `  Spot:      ₹${spotPrice.toFixed(2)}\n` +
                    `  Signal:    ${chosenSignal} (score: ${chosenScore})\n` +
                    `  ATR:       ${chosenATR.toFixed(2)} pts\n` +
                    `  Reasons:   ${reasons.join('; ')}`
                );
                return;
            }

            // ── 11. Place real entry order ────────────────────────────────
            const orderResult = await kite.placeOrder({
                exchange:         'NFO',
                tradingsymbol:    instrument.tradingsymbol,
                transaction_type: 'BUY',
                quantity,
                order_type:       c.ORDER_TYPE,
                product:          c.PRODUCT,
                validity:         'DAY',
                tag:              c.id.substring(0, 20), // Kite tag max 20 chars
            });

            const orderId = orderResult.order_id;
            tradesLogger.info(`${tag} ✅ Order placed: ${orderId} | ${instrument.tradingsymbol} | Qty: ${quantity} | Strategy: ${strategyName}`);

            // ── 12. Save trade state ──────────────────────────────────────
            const state = await Data.getOrCreateState(c.id, c.USER_ID, instrument.tradingsymbol);
            state.entryOrderId = orderId;
            state.symbol       = instrument.tradingsymbol;
            state.side         = 'buy';
            state.quantity     = quantity;
            state.tradeOutcome = 'pending';
            state.finalScore   = chosenScore;
            state.tradingMode  = strategyName;
            await (state as any).save();

            tradingCronLogger.info(`${tag} Trade state saved (${strategyName}). Monitoring exit via position P&L.`);

        } catch (err: any) {
            tradingCycleErrorLogger.error(`${tag} UNCAUGHT ERROR: ${err.message}`, { stack: err.stack });
        } finally {
            tradingCronLogger.info(`${tag} ========== END ==========`);
        }
    }

    // ─── Exit monitoring (called per cycle if bot has open position) ───────

    static async monitorAndExit(c: ConfigType, kite: KiteExchange): Promise<void> {
        const tag = `[ExitMonitor:${c.id}]`;

        const state = await TradeState.findOne({ tradingBotId: c.id, status: 'open' });
        if (!state?.entryOrderId) return;

        // Get current order status
        const history = await kite.getOrderHistory(state.entryOrderId);
        const latest  = history[history.length - 1];

        // If entry not yet filled, skip
        if (!latest || latest.status !== 'COMPLETE') {
            tradingCronLogger.debug(`${tag} Entry order ${state.entryOrderId} not yet complete (${latest?.status})`);
            return;
        }

        // Get entry price
        const entryPrice = latest.average_price;
        if (!state.entryPrice && entryPrice) {
            state.entryPrice = entryPrice;
            await (state as any).save();
        }

        // Get current option LTP
        const fullSymbol = `NFO:${state.symbol}`;
        const ltpResult  = await kite.getLTP([fullSymbol]);
        const currentPrice = ltpResult[fullSymbol]?.last_price ?? 0;

        if (!currentPrice || !entryPrice) return;

        const pnlPct = ATR14Strategy.calculatePnLPct(entryPrice, currentPrice);

        tradingCronLogger.debug(
            `${tag} Position: ${state.symbol} | Entry: ₹${entryPrice} | ` +
            `Current: ₹${currentPrice} | P&L: ${pnlPct.toFixed(2)}%`
        );

        // Update trailing SL if enabled
        if (c.IS_TRAILING_SL_ENABLED) {
            const peakPrice = Math.max(currentPrice, state.entryPrice ?? currentPrice);
            const trailSL   = ATR14Strategy.calculateTrailingSL(peakPrice, c.STOP_LOSS_PCT);

            if (currentPrice <= trailSL) {
                tradingCronLogger.info(`${tag} Trailing SL hit at ₹${currentPrice} (trailSL: ₹${trailSL.toFixed(2)}) — exiting`);
                await this.exitPosition(c, kite, state, 'trailing_sl', currentPrice);
                return;
            }
        }

        // Target hit
        if (pnlPct >= c.TARGET_PROFIT_PCT) {
            tradesLogger.info(`${tag} 🎯 TARGET hit! P&L: +${pnlPct.toFixed(2)}% — exiting`);
            await this.exitPosition(c, kite, state, 'target', currentPrice);
            return;
        }

        // Stop loss hit
        if (pnlPct <= -c.STOP_LOSS_PCT) {
            tradesLogger.info(`${tag} 🛑 STOP LOSS hit! P&L: ${pnlPct.toFixed(2)}% — exiting`);
            await this.exitPosition(c, kite, state, 'stop_loss', currentPrice);
            return;
        }
    }

    private static async exitPosition(
        c:     ConfigType,
        kite:  KiteExchange,
        state: any,
        reason: 'target' | 'stop_loss' | 'trailing_sl',
        currentPrice: number
    ): Promise<void> {
        const tag = `[Exit:${c.id}]`;

        if (c.DRY_RUN) {
            tradesLogger.info(`${tag} [DRY RUN] Would exit ${state.symbol} @ ₹${currentPrice} (${reason})`);
            return;
        }

        try {
            tradesLogger.info(`${tag} ➔ Placing EXIT SELL order on Zerodha: ${state.symbol} | Qty: ${state.quantity} | Reason: ${reason}`);
            const exitResult = await kite.placeOrder({
                exchange:         'NFO',
                tradingsymbol:    state.symbol,
                transaction_type: 'SELL',
                quantity:         state.quantity!,
                order_type:       'MARKET',
                product:          c.PRODUCT,
                validity:         'DAY',
                tag:              c.id.substring(0, 20),
            });

            const pnlInr = (currentPrice - (state.entryPrice ?? 0)) * state.quantity!;

            state.exitOrderId  = exitResult.order_id;
            state.exitPrice    = currentPrice;
            state.pnl          = pnlInr;
            state.dailyPnl     = (state.dailyPnl ?? 0) + pnlInr;
            state.allTimePnl   = (state.allTimePnl ?? 0) + pnlInr;
            state.tradeOutcome = reason === 'target' ? 'win' : 'loss';
            state.status       = 'closed';
            await state.save();

            tradesLogger.info(
                `${tag} ✔ Exit complete on Zerodha (order_id: ${exitResult.order_id}). Reason: ${reason} | ` +
                `P&L: ₹${pnlInr.toFixed(2)} | Outcome: ${state.tradeOutcome}`
            );

        } catch (err: any) {
            tradingCycleErrorLogger.error(`${tag} ✖ Exit order failed on Zerodha: ${err.message}`, { error: err });
        }
    }
}