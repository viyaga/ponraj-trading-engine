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
} from './type';
import { KiteExchange, NIFTY_STEP, BANKNIFTY_STEP } from './kite-exchange';
import { MarketDataService } from './market-data.service';
import { ATR14Strategy, getMinutesToMarketClose, isNSEMarketOpen } from './strategies/atr14-strategy';
import { Data } from './data';
import { TradeState } from '../../models/tradeState.model';
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

        tradingCronLogger.info(`${tag} ========== START (DRY_RUN: ${c.DRY_RUN}) ==========`);

        try {
            // ── 1. Market Hours Guard ─────────────────────────────────────
            if (!isNSEMarketOpen()) {
                skipTradingLogger.info(`${tag} SKIP: NSE market is closed`);
                return;
            }

            // ── 2. Initialize Kite client for this bot ────────────────────
            if (!c.API_KEY || !c.ACCESS_TOKEN) {
                tradingCycleErrorLogger.error(`${tag} Missing API_KEY or ACCESS_TOKEN — skipping`);
                return;
            }
            const kite = new KiteExchange(c.API_KEY, c.ACCESS_TOKEN);

            // ── 3. Fetch market data (15m NIFTY index candles + spot LTP) ─
            const marketData = await MarketDataService.fetchMarketData(
                c, kite, tradingCronLogger, skipTradingLogger
            );
            if (!marketData) return;

            const { candles15m, spotPrice } = marketData;

            // ── 4. ATR-14 Signal Evaluation (15m True Range Expansion) ─────
            const signalResult = ATR14Strategy.evaluateSignal(
                candles15m,
                spotPrice,
                c.ATR_MULTIPLIER,
                c.ATR_PERIOD
            );

            tradingCronLogger.info(
                `${tag} Signal: ${signalResult.signal} | ` +
                `ATR14: ${signalResult.atr14.toFixed(1)} | ` +
                `TR: ${signalResult.tr.toFixed(1)} | ` +
                `Reasons: ${signalResult.reasons.join('; ')}`
            );

            if (signalResult.skipReasons.length) {
                skipTradingLogger.info(`${tag} Skip reasons: ${signalResult.skipReasons.join('; ')}`);
            }

            // ── 5. Daily loss & open position checks ──────────────────────
            const [dailyLossHit, hasOpenPos] = await Promise.all([
                Data.isDailyLossLimitReached(c.id, c.MAX_LOSS_PER_DAY),
                Data.hasOpenPosition(c.id),
            ]);

            // ── 6. Filter checks (Open position, daily loss, signal present) ──
            if (signalResult.signal === 'NONE') {
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

            // ── 7. Strike selection ───────────────────────────────────────
            const stepSize   = c.INDEX === 'BANKNIFTY' ? BANKNIFTY_STEP : NIFTY_STEP;
            const optionType = signalResult.optionType!; // 'CE' or 'PE'
            const strike     = kite.selectStrike(spotPrice, optionType, signalResult.atr14, stepSize);

            tradingCronLogger.info(
                `${tag} Strike selected: ${strike} ${optionType} | ` +
                `Spot: ${spotPrice.toFixed(2)} | ATR14: ${signalResult.atr14.toFixed(1)}`
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

            // ── 10. DRY RUN: Log only, no real order ──────────────────────
            if (c.DRY_RUN) {
                tradesLogger.info(
                    `${tag} [DRY RUN] Would place BUY order:\n` +
                    `  Symbol:    ${instrument.tradingsymbol}\n` +
                    `  Quantity:  ${quantity} (${c.NUMBER_OF_LOTS} lot × ${c.LOT_SIZE})\n` +
                    `  OrderType: ${c.ORDER_TYPE}\n` +
                    `  Product:   ${c.PRODUCT}\n` +
                    `  Spot:      ₹${spotPrice.toFixed(2)}\n` +
                    `  Signal:    ${signalResult.signal} (score: ${signalResult.score})\n` +
                    `  ATR14:     ${signalResult.atr14.toFixed(2)} pts\n` +
                    `  TR:        ${signalResult.tr.toFixed(2)} pts`
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
            tradesLogger.info(`${tag} ✅ Order placed: ${orderId} | ${instrument.tradingsymbol} | Qty: ${quantity}`);

            // ── 12. Save trade state ──────────────────────────────────────
            const state = await Data.getOrCreateState(c.id, c.USER_ID, instrument.tradingsymbol);
            state.entryOrderId = orderId;
            state.symbol       = instrument.tradingsymbol;
            state.side         = 'buy';
            state.quantity     = quantity;
            state.tradeOutcome = 'pending';
            state.finalScore   = signalResult.score;
            await (state as any).save();

            tradingCronLogger.info(`${tag} Trade state saved. Monitoring exit via position P&L.`);

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
            await kite.placeOrder({
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

            state.exitPrice    = currentPrice;
            state.pnl          = pnlInr;
            state.dailyPnl     = (state.dailyPnl ?? 0) + pnlInr;
            state.allTimePnl   = (state.allTimePnl ?? 0) + pnlInr;
            state.tradeOutcome = reason === 'target' ? 'win' : 'loss';
            state.status       = 'closed';
            await state.save();

            tradesLogger.info(
                `${tag} Exit complete. Reason: ${reason} | ` +
                `P&L: ₹${pnlInr.toFixed(2)} | Outcome: ${state.tradeOutcome}`
            );

        } catch (err: any) {
            tradingCycleErrorLogger.error(`${tag} Exit order failed: ${err.message}`);
        }
    }
}