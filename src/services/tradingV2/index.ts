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
    Candle,
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
import { OptionSelectorService } from './option-selector.service';
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
        const cycleStartTime = Date.now();
        const cycleId = `cycle-${Date.now().toString(36)}`;
        const tag     = `[TradingCycle:${c.id}:${c.INDEX}]`;
        const istTimeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

        tradingCronLogger.info(
            `\n${tag} ╔══════════════════════════════════════════════════════════════════════════\n` +
            `${tag} ║ TRADING CYCLE START: ${cycleId}\n` +
            `${tag} ║ Time (IST):      ${istTimeStr}\n` +
            `${tag} ║ Bot ID:          ${c.id}\n` +
            `${tag} ║ Index:           ${c.INDEX}\n` +
            `${tag} ║ Mode:            ${c.DRY_RUN ? '🧪 DRY RUN (Simulation Only)' : (env.isTesting ? '⚡ TEST MODE (Live Smallest Lot)' : '🚀 LIVE PRODUCTION')}\n` +
            `${tag} ║ Market Open:     ${isNSEMarketOpen() ? '🟢 YES (Trading Hours)' : '🔴 NO (Closed)'}\n` +
            `${tag} ║ Order Config:    ${c.ORDER_TYPE} | ${c.PRODUCT} | Lots: ${c.NUMBER_OF_LOTS ?? 1} (LotSize: ${c.LOT_SIZE ?? 25})\n` +
            `${tag} ║ Premium Target:  ₹${c.OPTION_MIN_PREMIUM}–₹${c.OPTION_MAX_PREMIUM} (${c.EXPIRY_TYPE})\n` +
            `${tag} ║ Risk Limits:     Max Daily Loss: ₹${c.MAX_LOSS_PER_DAY ?? 2500} | Base TP: +${c.TARGET_PROFIT_PCT}% | Base SL: -${c.STOP_LOSS_PCT}%\n` +
            `${tag} ╚══════════════════════════════════════════════════════════════════════════`
        );

        try {
            // ── 1. Market Hours Guard ─────────────────────────────────────
            if (!isNSEMarketOpen()) {
                if (env.isTesting) {
                    tradingCronLogger.info(`${tag} ⚠️ [IS_TESTING=true] Overriding NSE market hours guard — proceeding with cycle in test mode`);
                } else {
                    skipTradingLogger.info(
                        `${tag} ⏸️ SKIP: NSE market is currently CLOSED. Regular trading hours are Mon-Fri 09:15 to 15:30 IST. (Current IST: ${istTimeStr})`
                    );
                    return;
                }
            }

            // ── 2. Initialize Kite client for this bot ────────────────────
            if (!c.API_KEY || !c.ACCESS_TOKEN) {
                tradingCycleErrorLogger.error(`${tag} ✖ Missing API_KEY (${c.API_KEY ? 'Present' : 'MISSING'}) or ACCESS_TOKEN (${c.ACCESS_TOKEN ? 'Present' : 'MISSING'}) — skipping bot execution`);
                return;
            }
            const kite = new KiteExchange(c.API_KEY, c.ACCESS_TOKEN);
            tradingCronLogger.info(`${tag} ✔ Kite exchange client initialized for API key ${c.API_KEY.substring(0, 4)}****`);

            // ── 2B. Check and monitor any open/pending position first ─────
            tradingCronLogger.info(`${tag} ➔ [Phase 1/5] Checking database for active open/pending positions...`);
            const existingOpenState = await TradeState.findOne({ tradingBotId: c.id, status: { $in: ['open', 'entry_pending'] } });
            if (existingOpenState) {
                tradingCronLogger.info(
                    `${tag} 🔍 Found active ${existingOpenState.status} trade in DB: Symbol=${existingOpenState.symbol} | ` +
                    `Qty=${existingOpenState.quantity} | EntryPrice=₹${existingOpenState.entryPrice ?? 'N/A'} | ` +
                    `OrderId=${existingOpenState.entryOrderId ?? 'N/A'}. Evaluating exit/reconciliation conditions...`
                );
                await this.monitorAndExit(c, kite);

                // If position is still open, do not enter a new position
                const stillOpen = await Data.hasOpenPosition(c.id);
                if (stillOpen) {
                    tradingCronLogger.info(
                        `${tag} ⏸️ Active position (${existingOpenState.symbol}) is still open and holding. ` +
                        `Skipping new signal scan for this cycle to maintain single-position discipline.`
                    );
                    return;
                } else {
                    tradingCronLogger.info(`${tag} ✔ Position was closed during exit monitor. Clear to scan for new setups.`);
                }
            } else {
                tradingCronLogger.info(`${tag} ✔ No existing open position in DB.`);
            }

            // ── 3. Fetch market data (1h & 15m NIFTY/BANKNIFTY index candles + spot LTP) ─
            tradingCronLogger.info(`${tag} ➔ [Phase 2/5] Fetching market data (15m, 1h candles & spot LTP for ${c.INDEX})...`);
            const marketData = await MarketDataService.fetchMarketData(
                c, kite, tradingCronLogger, skipTradingLogger
            );
            if (!marketData) {
                tradingCycleErrorLogger.error(`${tag} ✖ Market data unavailable for ${c.INDEX} — aborting cycle for this bot`);
                return;
            }

            const { candles15m, candles1h, spotPrice } = marketData;
            const last15m = candles15m[candles15m.length - 1];
            const last1h  = candles1h[candles1h.length - 1];
            const formatBar = (b: Candle) =>
                `[${new Date(b.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}] ` +
                `O: ₹${b.open.toFixed(1)} | H: ₹${b.high.toFixed(1)} | L: ₹${b.low.toFixed(1)} | C: ₹${b.close.toFixed(1)} (Vol: ${b.volume})`;

            tradingCronLogger.info(
                `${tag} 📊 Market Snapshot (${c.INDEX}):\n` +
                `  Spot LTP:       ₹${spotPrice.toFixed(2)}\n` +
                (last15m ? `  Latest 15m Bar: ${formatBar(last15m)}\n` : '') +
                (last1h  ? `  Latest 1h Bar:  ${formatBar(last1h)}` : '')
            );

            // ── 4. Signal Evaluation: Multi-Strategy Priority Orchestration ──
            tradingCronLogger.info(`${tag} ➔ [Phase 3/5] Evaluating trading strategy signals...`);
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
                tradingCronLogger.info(
                    `${tag} [UTBot 1H] Evaluating signal (key=${c.UT_BOT_KEY_VALUE ?? 1.0}, atrPeriod=${c.UT_BOT_ATR_PERIOD ?? 10}, HeikinAshi=${c.UT_BOT_USE_HEIKIN_ASHI ?? false})...`
                );
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
                    `${tag} [UTBot 1H] Result → Signal: ${utResult.signal} | Option: ${utResult.optionType ?? 'NONE'} | ` +
                    `Score: ${utResult.score} | ATR: ${utResult.atr.toFixed(1)} | ` +
                    `TrailingStop: ₹${utResult.trailingStop.toFixed(1)} | ` +
                    `Reasons: [${utResult.reasons.join('; ') || 'None'}]` +
                    (utResult.skipReasons.length ? ` | Skip: [${utResult.skipReasons.join('; ')}]` : '')
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
            } else {
                tradingCronLogger.info(`${tag} [UTBot 1H] Disabled in bot configuration`);
            }

            // ── 4B. PRIORITY 2: ATR-14 Strategy (15-Minute 3:00 PM Window) ─
            if (chosenSignal === 'NONE' && (is3pmTo315pmWindow() || env.isTesting)) {
                if (env.isTesting && !is3pmTo315pmWindow()) {
                    tradingCronLogger.info(`${tag} ⚠️ [IS_TESTING=true] Overriding 3:00 PM - 3:15 PM window for ATR14 evaluation`);
                }
                tradingCronLogger.info(`${tag} [ATR14 15m] Evaluating 15m signal (ATR Period: ${c.ATR_PERIOD ?? 14})...`);
                const atrResult = ATR14Strategy.evaluateSignal(
                    candles15m,
                    spotPrice,
                    undefined,
                    c.ATR_PERIOD
                );

                tradingCronLogger.info(
                    `${tag} [ATR14 15m] Result → Signal: ${atrResult.signal} | Option: ${atrResult.optionType ?? 'NONE'} | ` +
                    `Score: ${atrResult.score} | ATR14: ${atrResult.atr14.toFixed(1)} | ` +
                    `TR: ${atrResult.tr.toFixed(1)} | ` +
                    `Reasons: [${atrResult.reasons.join('; ') || 'None'}]` +
                    (atrResult.skipReasons.length ? ` | Skip: [${atrResult.skipReasons.join('; ')}]` : '')
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

            tradingCronLogger.info(
                `${tag} 🏁 Strategy Decision: Signal=${chosenSignal} | Direction=${chosenOptionType ?? 'NONE'} | ` +
                `Strategy=${strategyName || 'NONE'} | Score=${chosenScore}`
            );

            if (skipReasons.length && chosenSignal === 'NONE') {
                skipTradingLogger.info(`${tag} Signal evaluation complete (NO SIGNAL). Skip reasons: ${skipReasons.join('; ')}`);
            }

            // ── 5. Daily loss & open position checks ──────────────────────
            tradingCronLogger.info(`${tag} ➔ [Phase 4/5] Checking risk limits & account constraints...`);
            const [dailyLossHit, hasOpenPos] = await Promise.all([
                Data.isDailyLossLimitReached(c.id, c.MAX_LOSS_PER_DAY),
                Data.hasOpenPosition(c.id),
            ]);

            tradingCronLogger.info(
                `${tag} 🛡️ Risk Check: DailyLossHit=${dailyLossHit} (Max: ₹${c.MAX_LOSS_PER_DAY ?? 2500}) | HasOpenPosition=${hasOpenPos}`
            );

            // ── 6. Filter checks (Open position, daily loss, signal present) ──
            if (chosenSignal === 'NONE' || !chosenOptionType) {
                tradingCronLogger.info(`${tag} ⏹️ Cycle finished: No trade action (Signal: NONE for ${c.INDEX}).`);
                return;
            }
            if (hasOpenPos) {
                if (env.isTesting) {
                    tradingCronLogger.warn(`${tag} ⚠️ [IS_TESTING=true] Overriding open position check (open position exists) — continuing test cycle`);
                } else {
                    skipTradingLogger.info(`${tag} ⏸️ SKIP: Open position already exists for this bot (cannot open multiple concurrent positions)`);
                    return;
                }
            }
            if (dailyLossHit) {
                if (env.isTesting) {
                    tradingCronLogger.warn(`${tag} ⚠️ [IS_TESTING=true] Overriding max daily loss limit (limit ₹${c.MAX_LOSS_PER_DAY} reached) — continuing test cycle`);
                } else {
                    skipTradingLogger.info(`${tag} 🛑 SKIP: Max daily loss limit (₹${c.MAX_LOSS_PER_DAY}) reached for bot ${c.id}`);
                    return;
                }
            }

            tradingCronLogger.info(
                `${tag} 🚀 Signal Confirmed: ${chosenSignal} (${chosenOptionType}) via [${strategyName}] | ` +
                `ATR: ${chosenATR.toFixed(1)} | Reasons: ${reasons.join('; ')}`
            );

            // ── 7. Resolve per-strategy TP / SL ─────────────────────────────
            const effectiveTP = strategyName === 'UT_BOT_1H'
                ? (c.UT_BOT_STRATEGY_TP_PCT ?? c.TARGET_PROFIT_PCT)
                : (c.ATR_STRATEGY_TP_PCT    ?? c.TARGET_PROFIT_PCT);
            const effectiveSL = strategyName === 'UT_BOT_1H'
                ? (c.UT_BOT_STRATEGY_SL_PCT ?? c.STOP_LOSS_PCT)
                : (c.ATR_STRATEGY_SL_PCT    ?? c.STOP_LOSS_PCT);

            tradingCronLogger.info(
                `${tag} ➔ [Phase 5/5] Strike selection & order preparation:\n` +
                `  Configured Risk: TP: +${effectiveTP}% | SL: -${effectiveSL}%\n` +
                `  Premium Target:  ₹${c.OPTION_MIN_PREMIUM}–₹${c.OPTION_MAX_PREMIUM} (${c.EXPIRY_TYPE})`
            );

            // ── 8. Load NFO instruments (cached) ─────────────────────────────
            const cacheAgeMs   = instrumentCacheAt ? Date.now() - instrumentCacheAt : null;
            const cacheAgeMins = cacheAgeMs != null ? (cacheAgeMs / 60000).toFixed(1) : 'N/A';
            const cacheExpired = !instrumentCache.length || (cacheAgeMs != null && cacheAgeMs > INSTRUMENT_CACHE_TTL);

            tradingCronLogger.info(
                `${tag} [InstrumentCache] Status: ${cacheExpired ? '🔄 STALE — refreshing' : '✅ VALID — reusing'} | ` +
                `Size: ${instrumentCache.length} instruments | Age: ${cacheAgeMins} min | ` +
                `TTL: ${(INSTRUMENT_CACHE_TTL / 60000).toFixed(0)} min`
            );

            if (cacheExpired) {
                tradingCronLogger.info(`${tag} Refreshing NFO instrument list from Zerodha...`);
                instrumentCache   = await kite.getInstruments('NFO');
                instrumentCacheAt = Date.now();
                tradingCronLogger.info(`${tag} Loaded ${instrumentCache.length} NFO instruments into cache`);
            }

            // ── 9. Smart option selection (LTP-filtered) ──────────────────────
            const stepSize = c.INDEX === 'BANKNIFTY' ? BANKNIFTY_STEP : NIFTY_STEP;
            const optionType = chosenOptionType; // 'CE' | 'PE'

            const selected = await OptionSelectorService.selectBestOption(
                instrumentCache,
                kite,
                c,
                optionType,
                spotPrice,
                stepSize,
                tag
            );

            if (!selected) {
                // Logged inside selectBestOption — just abort the cycle
                return;
            }

            const { instrument, ltp: optionLTP } = selected;

            tradingCronLogger.info(
                `${tag} Selected Instrument: ${instrument.tradingsymbol} (Token: ${instrument.instrument_token}) | ` +
                `Expiry: ${instrument.expiry} | LotSize: ${instrument.lot_size}`
            );

            // In testing mode: execute trade ONLY for the smallest amount possible (strictly 1 lot)
            const numLots  = env.isTesting ? 1 : (c.NUMBER_OF_LOTS ?? 1);
            const lotSize  = instrument.lot_size || c.LOT_SIZE || (c.INDEX === 'BANKNIFTY' ? 15 : 25);
            const quantity = lotSize * numLots;
            const capitalOutlay = optionLTP * quantity;

            if (env.isTesting) {
                tradingCronLogger.warn(
                    `${tag} 🛡️ [IS_TESTING=true] Smallest amount enforced:\n` +
                    `  Lots:         1 lot (minimum possible, config was ${c.NUMBER_OF_LOTS ?? 1})\n` +
                    `  LotSize:      ${lotSize} units\n` +
                    `  Quantity:     ${quantity} units\n` +
                    `  Total Outlay: ₹${capitalOutlay.toFixed(2)} (at ₹${optionLTP.toFixed(2)} LTP)`
                );
            }

            tradingCronLogger.info(
                `${tag} ─── Pre-Order Summary ──────────────────────────────────────\n` +
                `  Strategy:    ${strategyName}\n` +
                `  Signal:      ${chosenSignal} (score: ${chosenScore}) | ATR: ${chosenATR.toFixed(2)} pts\n` +
                `  Instrument:  ${instrument.tradingsymbol} (token: ${instrument.instrument_token})\n` +
                `  Expiry:      ${instrument.expiry}\n` +
                `  Spot:        ₹${spotPrice.toFixed(2)}\n` +
                `  Option LTP:  ₹${optionLTP.toFixed(2)} (at scan time)\n` +
                `  Strike:      ${instrument.strike} (${instrument.instrument_type})\n` +
                `  Qty:         ${quantity} units (${numLots} lot × ${lotSize})\n` +
                `  Est Capital: ₹${capitalOutlay.toFixed(2)}\n` +
                `  Order type:  ${c.ORDER_TYPE} | Product: ${c.PRODUCT}\n` +
                `  TP target:   +${effectiveTP}% → exit above ₹${(optionLTP * (1 + effectiveTP / 100)).toFixed(2)}\n` +
                `  SL floor:    -${effectiveSL}% → exit below ₹${(optionLTP * (1 - effectiveSL / 100)).toFixed(2)}\n` +
                `  DRY_RUN:     ${c.DRY_RUN} | IS_TESTING: ${env.isTesting}\n` +
                `${tag} ────────────────────────────────────────────────────────────`
            );
            // ── 10. DRY RUN GUARD ─────────────────────────────────────────────
            if (c.DRY_RUN) {
                tradesLogger.info(
                    `${tag} [DRY RUN] Would place BUY order (${strategyName}):\n` +
                    `  Symbol:    ${instrument.tradingsymbol}\n` +
                    `  Quantity:  ${quantity} (${numLots} lot × ${lotSize})\n` +
                    `  OrderType: ${c.ORDER_TYPE}\n` +
                    `  Product:   ${c.PRODUCT}\n` +
                    `  Spot:      ₹${spotPrice.toFixed(2)}\n` +
                    `  Option LTP: ₹${optionLTP.toFixed(2)}\n` +
                    `  Est Capital: ₹${capitalOutlay.toFixed(2)}\n` +
                    `  TP:        +${effectiveTP}% → exit above ₹${(optionLTP * (1 + effectiveTP / 100)).toFixed(2)}\n` +
                    `  SL:        -${effectiveSL}% → exit below ₹${(optionLTP * (1 - effectiveSL / 100)).toFixed(2)}\n` +
                    `  Signal:    ${chosenSignal} (score: ${chosenScore})\n` +
                    `  ATR:       ${chosenATR.toFixed(2)} pts\n` +
                    `  Reasons:   ${reasons.join('; ')}`
                );
                return;
            }

            // ── 11. Prepare Order Parameters ──────────────────────────────────
            const roundTick = (val: number) => Math.round(val * 20) / 20;
            const isMarketOpen = isNSEMarketOpen();
            const variety = (!isMarketOpen && env.isTesting) ? 'amo' : 'regular';

            // Zerodha strictly restricts AMO on index options to LIMIT orders only:
            // "Market orders are blocked for index options using after market orders(AMO)."
            const orderType = (variety === 'amo' && c.ORDER_TYPE === 'MARKET') ? 'LIMIT' : c.ORDER_TYPE;
            const orderPrice = orderType === 'LIMIT' ? roundTick(optionLTP) : undefined;

            tradingCronLogger.info(
                `${tag} ➔ ${env.isTesting ? '🧪 [IS_TESTING=true] Placing order on Zerodha (Smallest Amount)' : 'Placing real entry order'}:\n` +
                `  Symbol:    ${instrument.tradingsymbol}\n` +
                `  Quantity:  ${quantity} (${numLots} lot × ${lotSize})\n` +
                `  Est Outlay: ₹${capitalOutlay.toFixed(2)}\n` +
                `  Entry LTP: ₹${optionLTP.toFixed(2)}\n` +
                `  Variety:   ${variety} (Market open: ${isMarketOpen})\n` +
                `  Type:      ${orderType} (configured: ${c.ORDER_TYPE})${orderPrice ? ` @ ₹${orderPrice}` : ''} | Product: ${c.PRODUCT}`
            );

            // ── 11A. Place Primary Entry BUY Order on Zerodha ─────────────────
            let orderId: string | null = null;
            try {
                const orderResult = await kite.placeOrder({
                    exchange:         'NFO',
                    tradingsymbol:    instrument.tradingsymbol,
                    transaction_type: 'BUY',
                    quantity,
                    order_type:       orderType,
                    product:          c.PRODUCT,
                    validity:         'DAY',
                    price:            orderPrice,
                    variety:          variety as any,
                    tag:              c.id.substring(0, 20), // Kite tag max 20 chars
                });
                orderId = orderResult.order_id;
                tradesLogger.info(`${tag} ✅ Entry BUY order submitted to Zerodha: order_id=${orderId} | ${instrument.tradingsymbol} | Qty: ${quantity} | Strategy: ${strategyName}`);
            } catch (orderErr: any) {
                tradesLogger.error(
                    `${tag} ✖ Entry order FAILED on Zerodha: ${orderErr.message}. ` +
                    `ABORTING cycle — GTT will NOT be created and trade state will NOT be marked open.`,
                    {
                        error: orderErr,
                        variety,
                        symbol: instrument.tradingsymbol,
                    }
                );
                return; // STOP IMMEDIATELY! NO GTT! NO OPEN TRADE!
            }

            if (!orderId) {
                tradesLogger.error(`${tag} ✖ No order_id returned by Zerodha for entry order. Aborting cycle.`);
                return;
            }

            // ── 11B. Verify Order Execution & Fill Details ────────────────────
            let actualEntryPrice = optionLTP;
            let actualQuantity   = quantity;

            if (variety === 'regular') {
                const fill = await this.waitForOrderFill(kite, orderId, tag);
                if (!fill || fill.status !== 'COMPLETE' || fill.filledQuantity <= 0) {
                    tradesLogger.error(
                        `${tag} ✖ Entry order ${orderId} was not completed (status: ${fill?.status ?? 'TIMEOUT'}). ` +
                        `ABORTING — GTT will NOT be created and trade state will NOT be marked open.`
                    );
                    return; // STOP IMMEDIATELY!
                }

                actualEntryPrice = fill.averagePrice;
                actualQuantity   = fill.filledQuantity;
                tradingCronLogger.info(
                    `${tag} ✔ Confirmed execution: ${actualQuantity} units @ ₹${actualEntryPrice.toFixed(2)} (scan LTP was ₹${optionLTP.toFixed(2)})`
                );
            } else {
                // variety === 'amo': order queued for market open
                tradingCronLogger.info(
                    `${tag} 📋 AMO order queued for market open (order_id: ${orderId}). ` +
                    `GTT will not be placed until fill confirmation at market open.`
                );
            }

            // ── 11C. Calculate TP and SL from Confirmed Execution Price ───────
            const tpPrice = roundTick(actualEntryPrice * (1 + effectiveTP / 100));
            const slTriggerPrice = roundTick(actualEntryPrice * (1 - effectiveSL / 100));
            // Apply a small slippage buffer to the SL Limit sell price so it fills during rapid gap downs
            const slLimitPrice = roundTick(slTriggerPrice * 0.99);

            // ── 11D. Place GTT OCO (TP + SL) Order on Zerodha (Only for filled regular orders)
            let gttTriggerId: number | null = null;
            if (variety === 'regular') {
                try {
                    tradingCronLogger.info(
                        `${tag} ➔ Placing native GTT OCO (TP/SL) on Zerodha: ` +
                        `SL Trigger=₹${slTriggerPrice} (Limit=₹${slLimitPrice}), TP Trigger/Limit=₹${tpPrice}...`
                    );
                    const gttResult = await kite.placeGTT({
                        trigger_type:   'two-leg',
                        tradingsymbol:  instrument.tradingsymbol,
                        exchange:       'NFO',
                        trigger_values: [slTriggerPrice, tpPrice], // sorted: [stoploss, target]
                        last_price:     actualEntryPrice,
                        orders: [
                            {
                                transaction_type: 'SELL',
                                quantity:         actualQuantity,
                                order_type:       'LIMIT',
                                product:          c.PRODUCT,
                                price:            slLimitPrice, // buffered limit price
                            },
                            {
                                transaction_type: 'SELL',
                                quantity:         actualQuantity,
                                order_type:       'LIMIT',
                                product:          c.PRODUCT,
                                price:            tpPrice,
                            },
                        ],
                    });
                    gttTriggerId = gttResult.trigger_id;
                    tradesLogger.info(
                        `${tag} 🎯 Zerodha GTT OCO (TP + SL) order placed successfully! ` +
                        `Trigger ID: ${gttTriggerId} | SL: ₹${slTriggerPrice} (-${effectiveSL}%) | TP: ₹${tpPrice} (+${effectiveTP}%)`
                    );
                } catch (gttErr: any) {
                    tradesLogger.error(
                        `${tag} 🚨 CRITICAL: Position filled (Qty: ${actualQuantity} @ ₹${actualEntryPrice}), ` +
                        `but GTT placement failed on Zerodha: ${gttErr.message}. ` +
                        `Engine monitorAndExit will actively monitor and execute TP/SL via cron.`
                    );
                }
            }

            // ── 12. Save Trade State to Database ──────────────────────────────
            const state = await Data.getOrCreateState(c.id, c.USER_ID, instrument.tradingsymbol);
            state.entryOrderId    = orderId;
            state.symbol          = instrument.tradingsymbol;
            state.side            = 'buy';
            state.quantity        = actualQuantity;
            state.entryPrice      = variety === 'amo' ? null : actualEntryPrice;
            state.tpPrice         = tpPrice;
            state.slPrice         = slTriggerPrice;
            state.effectiveTP     = effectiveTP;
            state.effectiveSL     = effectiveSL;
            state.tpPercentage    = effectiveTP;
            state.slPercentage    = effectiveSL;
            state.stopLossOrderId = gttTriggerId ? String(gttTriggerId) : null;
            state.tradeOutcome    = 'pending';
            state.status          = variety === 'amo' ? 'entry_pending' : 'open';
            state.finalScore      = chosenScore;
            state.tradingMode     = strategyName;
            await (state as any).save();

            tradingCronLogger.info(
                `${tag} ✔ Trade state saved (${strategyName}, Status: ${state.status.toUpperCase()}, OrderId: ${state.entryOrderId}, GTT: ${gttTriggerId ?? (variety === 'amo' ? 'Pending market open' : 'Software-monitored')}). ` +
                `Target: ₹${tpPrice} (+${effectiveTP}%), SL: ₹${slTriggerPrice} (-${effectiveSL}%).`
            );

        } catch (err: any) {
            tradingCycleErrorLogger.error(`${tag} ✖ UNCAUGHT CYCLE ERROR: ${err.message}`, {
                error: err,
                stack: err.stack,
                botId: c.id,
                index: c.INDEX
            });
            throw err;
        } finally {
            const durationMs = Date.now() - cycleStartTime;
            tradingCronLogger.info(`${tag} 🏁 ========== END TRADING CYCLE (${durationMs}ms) ==========\n`);
        }
    }

    /**
     * Poll order history to check for execution status (COMPLETE, REJECTED, CANCELLED, AMO REQ RECEIVED).
     */
    private static async waitForOrderFill(
        kite: KiteExchange,
        orderId: string,
        tag: string,
        maxRetries: number = 5,
        delayMs: number = 1000
    ): Promise<{
        status: string;
        averagePrice: number;
        filledQuantity: number;
    } | null> {
        for (let i = 1; i <= maxRetries; i++) {
            tradingCronLogger.info(`${tag} ⏳ Checking order fill status (${i}/${maxRetries}) for orderId: ${orderId}...`);
            const history = await kite.getOrderHistory(orderId);
            if (history && history.length > 0) {
                const latest = history[history.length - 1];
                tradingCronLogger.info(
                    `${tag} ➔ Order ${orderId} status: ${latest.status} | filled: ${latest.filled_quantity} | avgPrice: ₹${latest.average_price}`
                );

                if (latest.status === 'COMPLETE') {
                    tradingCronLogger.info(
                        `${tag} ✅ Order ${orderId} is COMPLETE! Filled: ${latest.filled_quantity} units @ avg price ₹${latest.average_price}`
                    );
                    return {
                        status: 'COMPLETE',
                        averagePrice: Number(latest.average_price),
                        filledQuantity: Number(latest.filled_quantity),
                    };
                }

                if (latest.status === 'REJECTED' || latest.status === 'CANCELLED') {
                    tradingCronLogger.error(
                        `${tag} ✖ Order ${orderId} was ${latest.status}: ${latest.status_message || 'No status message'}`
                    );
                    return {
                        status: latest.status,
                        averagePrice: 0,
                        filledQuantity: 0,
                    };
                }

                if ((latest.status as string) === 'AMO REQ RECEIVED') {
                    tradingCronLogger.info(`${tag} 📋 Order ${orderId} is AMO REQ RECEIVED (accepted by broker for next market open)`);
                    return {
                        status: 'AMO REQ RECEIVED',
                        averagePrice: Number(latest.price || 0),
                        filledQuantity: 0,
                    };
                }
            }

            if (i < maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }

        tradingCronLogger.warn(`${tag} ⚠️ Timed out waiting for order ${orderId} to complete after ${maxRetries * (delayMs / 1000)}s`);
        return null;
    }

    // ─── Exit monitoring (called per cycle if bot has open position) ───────

    static async monitorAndExit(c: ConfigType, kite: KiteExchange): Promise<void> {
        const tag = `[ExitMonitor:${c.id}]`;

        const state = await TradeState.findOne({ tradingBotId: c.id, status: { $in: ['open', 'entry_pending'] } });
        if (!state) {
            tradingCronLogger.info(`${tag} No active 'open' or 'entry_pending' trade state found in database.`);
            return;
        }
        if (!state.entryOrderId) {
            tradingCronLogger.warn(`${tag} ⚠️ Active trade state exists for ${state.symbol} but has no entryOrderId.`);
            return;
        }

        tradingCronLogger.info(`${tag} ➔ Monitoring active trade (${state.status.toUpperCase()}): ${state.symbol} (OrderId: ${state.entryOrderId}, Qty: ${state.quantity})...`);

        // Get current order status
        const history = await kite.getOrderHistory(state.entryOrderId);
        const latest  = history ? history[history.length - 1] : null;

        // If broker rejected or cancelled order: mark trade closed/cancelled, NO GTT
        if (latest && (latest.status === 'REJECTED' || latest.status === 'CANCELLED')) {
            tradingCronLogger.error(
                `${tag} ✖ Entry order ${state.entryOrderId} was ${latest.status}: ${latest.status_message || 'Broker rejected/cancelled'}. ` +
                `Marking trade as closed (cancelled) and skipping GTT.`
            );
            state.status = 'closed';
            state.tradeOutcome = 'cancelled';
            await (state as any).save();
            return;
        }

        // If entry not yet filled (e.g. AMO REQ RECEIVED, OPEN, TRIGGER PENDING), wait:
        if (!latest || latest.status !== 'COMPLETE') {
            tradingCronLogger.info(
                `${tag} ⏳ Entry order ${state.entryOrderId} is pending fill (status: ${latest?.status ?? 'UNKNOWN'}). Skipping exit evaluation until filled.`
            );
            if (state.status !== 'entry_pending') {
                state.status = 'entry_pending';
                await (state as any).save();
            }
            return;
        }

        // Execution confirmed COMPLETE: Reconcile actual execution price & quantity
        const actualEntryPrice = Number(latest.average_price);
        const actualQuantity = Number(latest.filled_quantity);
        let stateNeedsSave = false;

        // Transition from ENTRY_PENDING to OPEN only after confirmed fill!
        if (state.status !== 'open') {
            state.status = 'open';
            stateNeedsSave = true;
            tradingCronLogger.info(`${tag} 🟢 Order filled on Zerodha! Status transitioned: ENTRY_PENDING → OPEN`);
        }

        if (state.entryPrice !== actualEntryPrice || state.quantity !== actualQuantity) {
            state.entryPrice = actualEntryPrice;
            state.quantity = actualQuantity;
            stateNeedsSave = true;
            tradingCronLogger.info(
                `${tag} ✔ Reconciled execution from Zerodha: Qty=${actualQuantity}, AvgPrice=₹${actualEntryPrice.toFixed(2)}`
            );
        }

        // Recalculate TP and SL strictly from actual confirmed fill price
        const effectiveTP = (state as any).effectiveTP ?? c.TARGET_PROFIT_PCT;
        const effectiveSL = (state as any).effectiveSL ?? c.STOP_LOSS_PCT;
        const roundTick = (val: number) => Math.round(val * 20) / 20;
        const targetPrice = roundTick(actualEntryPrice * (1 + effectiveTP / 100));
        const stopPrice   = roundTick(actualEntryPrice * (1 - effectiveSL / 100));
        const slLimitPrice = roundTick(stopPrice * 0.99);

        if (state.tpPrice !== targetPrice || state.slPrice !== stopPrice) {
            state.tpPrice = targetPrice;
            state.slPrice = stopPrice;
            stateNeedsSave = true;
        }

        // Place GTT OCO if not yet created (e.g. for AMO fills or recovered trades)
        if (!state.stopLossOrderId) {
            try {
                tradingCronLogger.info(
                    `${tag} ➔ Placing native GTT OCO (TP/SL) on Zerodha for filled order ${state.entryOrderId}: ` +
                    `SL Trigger=₹${stopPrice} (Limit=₹${slLimitPrice}), TP Trigger/Limit=₹${targetPrice}...`
                );
                const gttResult = await kite.placeGTT({
                    trigger_type:   'two-leg',
                    tradingsymbol:  state.symbol,
                    exchange:       'NFO',
                    trigger_values: [stopPrice, targetPrice],
                    last_price:     actualEntryPrice,
                    orders: [
                        {
                            transaction_type: 'SELL',
                            quantity:         actualQuantity,
                            order_type:       'LIMIT',
                            product:          c.PRODUCT,
                            price:            slLimitPrice,
                        },
                        {
                            transaction_type: 'SELL',
                            quantity:         actualQuantity,
                            order_type:       'LIMIT',
                            product:          c.PRODUCT,
                            price:            targetPrice,
                        },
                    ],
                });
                state.stopLossOrderId = String(gttResult.trigger_id);
                stateNeedsSave = true;
                tradesLogger.info(
                    `${tag} 🎯 Zerodha GTT OCO (TP + SL) order placed successfully! ` +
                    `Trigger ID: ${state.stopLossOrderId} | SL: ₹${stopPrice} (-${effectiveSL}%) | TP: ₹${targetPrice} (+${effectiveTP}%)`
                );
            } catch (gttErr: any) {
                tradesLogger.error(
                    `${tag} 🚨 Position filled (Qty: ${actualQuantity} @ ₹${actualEntryPrice}), ` +
                    `but GTT placement failed on Zerodha: ${gttErr.message}. ` +
                    `Engine will actively monitor and execute TP/SL via software cron.`
                );
            }
        }

        if (stateNeedsSave) {
            await (state as any).save();
        }

        // Get current option LTP
        const fullSymbol = `NFO:${state.symbol}`;
        let currentPrice = 0;
        try {
            const ltpResult  = await kite.getLTP([fullSymbol]);
            currentPrice = ltpResult[fullSymbol]?.last_price ?? 0;
        } catch (ltpErr: any) {
            tradingCronLogger.warn(`${tag} ⚠️ Failed to fetch live LTP for ${fullSymbol}: ${ltpErr.message}`);
        }

        if (!currentPrice || !actualEntryPrice) {
            tradingCronLogger.warn(
                `${tag} ⚠️ Unable to evaluate exit conditions: currentPrice=₹${currentPrice}, entryPrice=₹${actualEntryPrice}`
            );
            return;
        }

        const pnlPct = ATR14Strategy.calculatePnLPct(actualEntryPrice, currentPrice);
        const unrealizedPnlInr = (currentPrice - actualEntryPrice) * (state.quantity ?? 1);

        tradingCronLogger.info(
            `${tag} 📊 Open Position Health Check:\n` +
            `  Symbol:          ${state.symbol} (${state.quantity} units)\n` +
            `  Entry Price:     ₹${actualEntryPrice.toFixed(2)}\n` +
            `  Current LTP:     ₹${currentPrice.toFixed(2)}\n` +
            `  Unrealized P&L:  ₹${unrealizedPnlInr.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)\n` +
            `  Target Profit:   +${effectiveTP}% → exit above ₹${targetPrice.toFixed(2)}\n` +
            `  Stop Loss:       -${effectiveSL}% → exit below ₹${stopPrice.toFixed(2)}`
        );

        // Update trailing SL if enabled
        if (c.IS_TRAILING_SL_ENABLED) {
            const peakPrice = Math.max(currentPrice, state.entryPrice ?? currentPrice);
            const trailSL   = ATR14Strategy.calculateTrailingSL(peakPrice, effectiveSL);
            tradingCronLogger.info(
                `${tag} 📈 Trailing SL check: Peak=₹${peakPrice.toFixed(2)} | Trail SL=₹${trailSL.toFixed(2)} | Current=₹${currentPrice.toFixed(2)}`
            );

            if (currentPrice <= trailSL) {
                tradingCronLogger.info(`${tag} 🛑 Trailing SL hit at ₹${currentPrice} (trailSL: ₹${trailSL.toFixed(2)}) — exiting position`);
                await this.exitPosition(c, kite, state, 'trailing_sl', currentPrice);
                return;
            }
        }

        // Target hit
        if (pnlPct >= effectiveTP) {
            tradesLogger.info(`${tag} 🎯 TARGET HIT! P&L: +${pnlPct.toFixed(2)}% (Target: +${effectiveTP}%) — exiting position`);
            await this.exitPosition(c, kite, state, 'target', currentPrice);
            return;
        }

        // Stop loss hit
        if (pnlPct <= -effectiveSL) {
            tradesLogger.info(`${tag} 🛑 STOP LOSS HIT! P&L: ${pnlPct.toFixed(2)}% (SL: -${effectiveSL}%) — exiting position`);
            await this.exitPosition(c, kite, state, 'stop_loss', currentPrice);
            return;
        }

        tradingCronLogger.info(
            `${tag} ✔ Position is within safe bounds (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%). Maintaining position.`
        );
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
            const pnlInr = (currentPrice - (state.entryPrice ?? 0)) * (state.quantity ?? 1);
            state.exitOrderId  = `dry-exit-${Date.now().toString(36)}`;
            state.exitPrice    = currentPrice;
            state.pnl          = pnlInr;
            state.dailyPnl     = (state.dailyPnl ?? 0) + pnlInr;
            state.allTimePnl   = (state.allTimePnl ?? 0) + pnlInr;
            state.tradeOutcome = reason === 'target' ? 'win' : 'loss';
            state.status       = 'closed';
            await state.save();

            tradesLogger.info(
                `${tag} [DRY RUN] Simulating exit for ${state.symbol} @ ₹${currentPrice} (${reason}) | ` +
                `P&L: ₹${pnlInr.toFixed(2)} | Outcome: ${state.tradeOutcome}`
            );
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