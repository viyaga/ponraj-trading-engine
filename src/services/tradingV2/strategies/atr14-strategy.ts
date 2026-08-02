// =============================================================================
// ATR-14 Strategy — NIFTY Options
// =============================================================================
// Signal logic:
//   1. Compute ATR(14) + True Range on NIFTY 50 index candles
//   2. Require TR > ATR × multiplier (volatility expansion filter)
//   3. Triple-timeframe alignment (5m entry + 15m confirm + 1h structure)
//   4. Smart strike selection based on ATR magnitude
//   5. Win-rate filters (time, concurrency, daily loss)
// =============================================================================

import { Candle, TargetCandle, ATRSignalResult, TradingSignal, OptionType } from '../type';
import { tradingCronLogger, skipTradingLogger } from '../logger';

// ─── NSE Market Hours (IST) ──────────────────────────────────────────────────

export const NSE_OPEN_HOUR   = 9;
export const NSE_OPEN_MIN    = 15;
export const NSE_CLOSE_HOUR  = 15;
export const NSE_CLOSE_MIN   = 20;  // 3:20 PM cutoff (MIS square-off at 3:30)

export function isNSEMarketOpen(): boolean {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay(); // 0=Sun, 6=Sat
    if (day === 0 || day === 6) return false;

    const totalMins = ist.getHours() * 60 + ist.getMinutes();
    const openMins  = NSE_OPEN_HOUR  * 60 + NSE_OPEN_MIN;
    const closeMins = NSE_CLOSE_HOUR * 60 + NSE_CLOSE_MIN;

    return totalMins >= openMins && totalMins <= closeMins;
}

export function getMinutesToMarketClose(): number {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const closeMins = NSE_CLOSE_HOUR * 60 + NSE_CLOSE_MIN;
    const nowMins   = ist.getHours() * 60 + ist.getMinutes();
    return closeMins - nowMins;
}

// ─── ATR Calculations ────────────────────────────────────────────────────────

export class ATR14Strategy {

    /**
     * Compute True Range of a single candle relative to previous close.
     * TR = max(H - L, |H - prevClose|, |L - prevClose|)
     */
    static computeTR(candle: Candle, prevCandle: Candle): number {
        const hl   = candle.high - candle.low;
        const hpc  = Math.abs(candle.high - prevCandle.close);
        const lpc  = Math.abs(candle.low  - prevCandle.close);
        return Math.max(hl, hpc, lpc);
    }

    /**
     * Compute ATR(period) using Wilder's smoothing.
     * Requires at least period+1 candles (sorted oldest→newest).
     */
    static computeATR(candles: Candle[], period: number = 14): number {
        if (candles.length < period + 1) {
            return 0;
        }

        // Sort oldest → newest
        const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);

        // First ATR = simple average of first `period` TRs
        let atr = 0;
        for (let i = 1; i <= period; i++) {
            atr += this.computeTR(sorted[i], sorted[i - 1]);
        }
        atr /= period;

        // Wilder's smoothing for remaining candles
        for (let i = period + 1; i < sorted.length; i++) {
            const tr = this.computeTR(sorted[i], sorted[i - 1]);
            atr = (atr * (period - 1) + tr) / period;
        }

        return atr;
    }

    /**
     * Get the last closed candle (sorted oldest→newest).
     */
    static getLastClosedCandle(candles: Candle[]): TargetCandle | null {
        if (!candles.length) return null;
        const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
        const last = sorted[sorted.length - 1];
        return {
            ...last,
            color: last.close >= last.open ? 'green' : 'red',
        };
    }

    /**
     * Determine if 1h structure is bullish or bearish.
     * Bullish: close > midpoint of candle (close > (open+close)/2)
     * This is a simple but robust structural bias.
     */
    static getStructureBias(structureCandles: Candle[]): 'bullish' | 'bearish' | 'neutral' {
        if (!structureCandles.length) return 'neutral';
        const sorted = [...structureCandles].sort((a, b) => a.timestamp - b.timestamp);
        const last = sorted[sorted.length - 1];
        const midpoint = (last.open + last.close) / 2;
        if (last.close > midpoint && last.close > last.open) return 'bullish';
        if (last.close < midpoint && last.close < last.open) return 'bearish';
        return 'neutral';
    }

    /**
     * Evaluate the ATR-14 + True Range signal.
     *
     * Returns a composite signal (BULL / BEAR / NONE) with a score 0–100.
     *
     * Score breakdown:
     *   - 5m candle direction:       30 pts
     *   - TR > ATR × multiplier:     25 pts
     *   - 15m confirmation:          25 pts
     *   - 1h structure alignment:    20 pts
     */
    static evaluateSignal(
        entryCandles:    Candle[],
        confirmCandles:  Candle[],
        structureCandles: Candle[],
        spotPrice:       number,
        atrMultiplier:   number = 1.25,
        atrPeriod:       number = 14
    ): ATRSignalResult {
        const noSignal = (reason: string): ATRSignalResult => ({
            signal: 'NONE', optionType: null, atr14: 0, tr: 0, score: 0,
            reasons: [], skipReasons: [reason]
        });

        // ── Compute ATR & TR ─────────────────────────────────────────────────
        if (entryCandles.length < atrPeriod + 2) {
            return noSignal(`Insufficient candles: ${entryCandles.length} (need ${atrPeriod + 2})`);
        }

        const sortedEntry = [...entryCandles].sort((a, b) => a.timestamp - b.timestamp);
        const lastCandle  = sortedEntry[sortedEntry.length - 1];
        const prevCandle  = sortedEntry[sortedEntry.length - 2];

        const atr14 = this.computeATR(sortedEntry, atrPeriod);
        const tr    = this.computeTR(lastCandle, prevCandle);

        const entryTarget   = this.getLastClosedCandle(entryCandles);
        const confirmTarget = this.getLastClosedCandle(confirmCandles);
        const structure     = this.getStructureBias(structureCandles);

        if (!entryTarget || !confirmTarget) {
            return noSignal('Missing target candles');
        }

        // ── Score components ─────────────────────────────────────────────────

        const reasons: string[]    = [];
        const skipReasons: string[] = [];

        let score    = 0;
        let signal:  TradingSignal = 'NONE';
        const isBullEntry  = entryTarget.color === 'green';
        const isBearEntry  = entryTarget.color === 'red';
        const isBullConfirm = confirmTarget.color === 'green';
        const isBearConfirm = confirmTarget.color === 'red';

        // 1. Entry candle direction (30 pts)
        if (isBullEntry) {
            signal = 'BULL';
            score += 30;
            reasons.push(`5m candle GREEN (+30)`);
        } else if (isBearEntry) {
            signal = 'BEAR';
            score += 30;
            reasons.push(`5m candle RED (+30)`);
        } else {
            return noSignal('Entry candle has no clear direction');
        }

        // 2. True Range expansion (25 pts)
        const trExpanded = tr >= atr14 * atrMultiplier;
        if (trExpanded) {
            score += 25;
            reasons.push(`TR(${tr.toFixed(1)}) > ATR14(${atr14.toFixed(1)}) × ${atrMultiplier} (+25)`);
        } else {
            skipReasons.push(`TR(${tr.toFixed(1)}) < ATR14(${atr14.toFixed(1)}) × ${atrMultiplier} (no volatility expansion)`);
            // TR filter is mandatory — abort if not met
            return {
                signal: 'NONE', optionType: null,
                atr14, tr, score,
                reasons, skipReasons
            };
        }

        // 3. 15m confirmation (25 pts)
        const confirmAligned =
            (signal === 'BULL' && isBullConfirm) ||
            (signal === 'BEAR' && isBearConfirm);

        if (confirmAligned) {
            score += 25;
            reasons.push(`15m candle confirms ${signal === 'BULL' ? 'GREEN' : 'RED'} (+25)`);
        } else {
            skipReasons.push(`15m candle disagrees with ${signal} signal`);
            score = 0; // Confirmation required — zero the score
            return {
                signal: 'NONE', optionType: null,
                atr14, tr, score,
                reasons, skipReasons
            };
        }

        // 4. 1h structure alignment (20 pts — optional boost, not a hard block)
        const structureAligned =
            (signal === 'BULL' && structure === 'bullish') ||
            (signal === 'BEAR' && structure === 'bearish');

        if (structureAligned) {
            score += 20;
            reasons.push(`1h structure ${structure} (+20)`);
        } else if (structure === 'neutral') {
            score += 10;
            reasons.push(`1h structure neutral (+10)`);
        } else {
            skipReasons.push(`1h structure ${structure} disagrees with signal (no structure bonus)`);
        }

        // 5. Momentum confirm: spot direction
        const priceAbovePrevHigh = spotPrice > prevCandle.high;
        const priceBelowPrevLow  = spotPrice < prevCandle.low;
        if (signal === 'BULL' && priceAbovePrevHigh) {
            score += 5;
            reasons.push(`Spot(${spotPrice}) > prev high(${prevCandle.high}) (+5)`);
        } else if (signal === 'BEAR' && priceBelowPrevLow) {
            score += 5;
            reasons.push(`Spot(${spotPrice}) < prev low(${prevCandle.low}) (+5)`);
        }

        const optionType: OptionType = signal === 'BULL' ? 'CE' : 'PE';

        return { signal, optionType, atr14, tr, score, reasons, skipReasons };
    }

    /**
     * Apply win-rate filters before entering a trade.
     * Returns { pass: true } or { pass: false, reason: string }
     */
    static applyWinRateFilters(ctx: {
        signal:             TradingSignal;
        score:              number;
        minScore:           number;
        atr14:              number;
        spotPrice:          number;
        isWeekendSafety:    boolean;
        minsToClose:        number;
        hasOpenPosition:    boolean;
        dailyLossHit:       boolean;
    }): { pass: boolean; reason?: string } {

        const { signal, score, minScore, isWeekendSafety, minsToClose, hasOpenPosition, dailyLossHit } = ctx;

        if (signal === 'NONE') {
            return { pass: false, reason: 'No signal generated' };
        }

        if (score < minScore) {
            return { pass: false, reason: `Score ${score} < minScore ${minScore}` };
        }

        if (hasOpenPosition) {
            return { pass: false, reason: 'Open position already exists for this bot' };
        }

        if (dailyLossHit) {
            return { pass: false, reason: 'Daily loss limit reached — bot halted for today' };
        }

        if (isWeekendSafety) {
            const now = new Date();
            const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
            const day = ist.getDay();
            if (day === 0 || day === 6) {
                return { pass: false, reason: 'Weekend safety: market closed' };
            }
        }

        if (minsToClose < 15) {
            return { pass: false, reason: `Only ${minsToClose} min to close — too late to enter` };
        }

        if (!isNSEMarketOpen()) {
            return { pass: false, reason: 'NSE market is closed' };
        }

        return { pass: true };
    }

    /**
     * Calculate the P&L percentage on an open option position.
     * Used for exit logic.
     */
    static calculatePnLPct(entryPrice: number, currentPrice: number): number {
        if (!entryPrice || entryPrice === 0) return 0;
        return ((currentPrice - entryPrice) / entryPrice) * 100;
    }

    /**
     * Calculate trailing SL price.
     * Trail = peakPrice - (atr14 × trailingMultiplier / lot_size)
     * Note: ATR14 is in NIFTY index points; option premium moves differently.
     * We use a percentage-based trail instead:
     * trailStop = peakPrice × (1 - stopLossPct/100)
     */
    static calculateTrailingSL(
        peakPrice:     number,
        stopLossPct:   number
    ): number {
        return peakPrice * (1 - stopLossPct / 100);
    }
}
