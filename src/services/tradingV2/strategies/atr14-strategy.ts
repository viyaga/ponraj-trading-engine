// =============================================================================
// ATR-14 Strategy — 3:00 PM - 3:15 PM Volatility & Direction Engine
// =============================================================================
// Rules:
//   1. Execution Window: Strictly 3:00 PM – 3:15 PM IST (15:00 - 15:15 IST)
//   2. ATR(14): Computed over 14 historical completed 15-minute candles
//   3. Forming Candle TR: TR of active 3:00 PM candle = max(H - L, |H - prevClose|, |L - prevClose|)
//   4. Signal Evaluation:
//      - LONG (Buy CE):
//          TR >= ATR14 AND Current Price > 3:00 candle Open AND Current Price > Previous Close
//      - SHORT (Buy PE):
//          TR >= ATR14 AND Current Price < 3:00 candle Open AND Current Price < Previous Close
// =============================================================================

import { Candle, TargetCandle, ATRSignalResult, TradingSignal, OptionType } from '../type';
import { tradingCronLogger, skipTradingLogger } from '../logger';

// ─── 3:00 PM - 3:15 PM Trading Window (IST) ──────────────────────────────────

export const TRADING_WINDOW_START_HOUR = 15; // 3:00 PM IST
export const TRADING_WINDOW_START_MIN  = 0;
export const TRADING_WINDOW_END_HOUR   = 15; // 3:15 PM IST
export const TRADING_WINDOW_END_MIN    = 15;

export function isNSETradingHours(): boolean {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay(); // 0=Sun, 6=Sat
    if (day === 0 || day === 6) return false;

    const totalMins = ist.getHours() * 60 + ist.getMinutes();
    const marketOpenMins  = 9 * 60 + 15;  // 9:15 AM IST
    const marketCloseMins = 15 * 60 + 30; // 3:30 PM IST

    return totalMins >= marketOpenMins && totalMins <= marketCloseMins;
}

export function is3pmTo315pmWindow(): boolean {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay(); // 0=Sun, 6=Sat
    if (day === 0 || day === 6) return false;

    const totalMins = ist.getHours() * 60 + ist.getMinutes();
    const startMins = TRADING_WINDOW_START_HOUR * 60 + TRADING_WINDOW_START_MIN;
    const endMins   = TRADING_WINDOW_END_HOUR * 60 + TRADING_WINDOW_END_MIN;

    return totalMins >= startMins && totalMins <= endMins;
}

export function isNSEMarketOpen(): boolean {
    return isNSETradingHours();
}

export function getMinutesToMarketClose(): number {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const closeMins = 15 * 60 + 30; // 3:30 PM cutoff
    const nowMins   = ist.getHours() * 60 + ist.getMinutes();
    return closeMins - nowMins;
}

// ─── ATR-14 Strategy Class ───────────────────────────────────────────────────

export class ATR14Strategy {

    /**
     * Compute True Range of a single candle relative to previous close.
     * TR = max(H - L, |H - prevClose|, |L - prevClose|)
     */
    static computeTR(candle: Candle, prevCandle: Candle): number {
        const hl  = candle.high - candle.low;
        const hpc = Math.abs(candle.high - prevCandle.close);
        const lpc = Math.abs(candle.low  - prevCandle.close);
        return Math.max(hl, hpc, lpc);
    }

    /**
     * Compute ATR(period) using Wilder's smoothing on completed 15m candles.
     */
    static computeATR(candles: Candle[], period: number = 14): number {
        if (candles.length < period + 1) {
            return 0;
        }

        const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);

        let atr = 0;
        for (let i = 1; i <= period; i++) {
            atr += this.computeTR(sorted[i], sorted[i - 1]);
        }
        atr /= period;

        for (let i = period + 1; i < sorted.length; i++) {
            const tr = this.computeTR(sorted[i], sorted[i - 1]);
            atr = (atr * (period - 1) + tr) / period;
        }

        return atr;
    }

    /**
     * Evaluate trading signal strictly from 15m candles using TR, ATR(14), 3:00 Open, and Previous Close.
     */
    static evaluateSignal(
        completedCandles15m: Candle[],
        spotPrice: number,
        formingCandle?: Candle,
        atrPeriod: number = 14
    ): ATRSignalResult {
        const result: ATRSignalResult = {
            signal: 'NONE',
            optionType: null,
            atr14: 0,
            tr: 0,
            score: 0,
            reasons: [],
            skipReasons: [],
        };

        if (completedCandles15m.length < atrPeriod + 1) {
            result.skipReasons.push(`Insufficient completed 15m candles (${completedCandles15m.length}/${atrPeriod + 1})`);
            return result;
        }

        const sorted = [...completedCandles15m].sort((a, b) => a.timestamp - b.timestamp);
        const prevCandle = sorted[sorted.length - 1]; // Previous 15m candle (e.g. 2:45 PM candle)

        // Determine 3:00 PM forming candle Open, High, Low, Close
        const openPrice  = formingCandle ? formingCandle.open : spotPrice;
        const highPrice  = formingCandle ? Math.max(formingCandle.high, spotPrice) : Math.max(openPrice, spotPrice);
        const lowPrice   = formingCandle ? Math.min(formingCandle.low, spotPrice) : Math.min(openPrice, spotPrice);
        const prevClose  = prevCandle.close;

        // 1. Calculate TR of forming candle & ATR(14) on completed candles
        const trCandle: Candle = {
            timestamp: Date.now(),
            open: openPrice,
            high: highPrice,
            low: lowPrice,
            close: spotPrice,
            volume: 0,
        };
        const tr    = this.computeTR(trCandle, prevCandle);
        const atr14 = this.computeATR(sorted, atrPeriod);

        result.tr    = tr;
        result.atr14 = atr14;

        if (atr14 === 0) {
            result.skipReasons.push('ATR(14) calculation returned 0');
            return result;
        }

        // 2. Check Volatility Expansion: TR >= ATR(14)
        if (tr < atr14) {
            result.skipReasons.push(
                `TR (${tr.toFixed(1)}) < ATR14 (${atr14.toFixed(1)}) — True Range does not beat ATR(14)`
            );
            return result;
        }

        // 3. Directional Rules:
        // LONG:  TR >= ATR14 AND Current Price > 3:00 Open AND Current Price > Previous Close
        // SHORT: TR >= ATR14 AND Current Price < 3:00 Open AND Current Price < Previous Close
        const isLongCondition  = spotPrice > openPrice && spotPrice > prevClose;
        const isShortCondition = spotPrice < openPrice && spotPrice < prevClose;

        if (isLongCondition) {
            result.signal     = 'BULL';
            result.optionType = 'CE';
            result.score      = 100;
            result.reasons.push(
                `LONG Signal: TR (${tr.toFixed(1)}) >= ATR14 (${atr14.toFixed(1)}), ` +
                `Spot (₹${spotPrice.toFixed(2)}) > 3:00 Open (₹${openPrice.toFixed(2)}) & > Prev Close (₹${prevClose.toFixed(2)})`
            );
        } else if (isShortCondition) {
            result.signal     = 'BEAR';
            result.optionType = 'PE';
            result.score      = 100;
            result.reasons.push(
                `SHORT Signal: TR (${tr.toFixed(1)}) >= ATR14 (${atr14.toFixed(1)}), ` +
                `Spot (₹${spotPrice.toFixed(2)}) < 3:00 Open (₹${openPrice.toFixed(2)}) & < Prev Close (₹${prevClose.toFixed(2)})`
            );
        } else {
            result.skipReasons.push(
                `Price directional conflict: Spot ₹${spotPrice.toFixed(2)}, ` +
                `3:00 Open ₹${openPrice.toFixed(2)}, Prev Close ₹${prevClose.toFixed(2)}`
            );
        }

        return result;
    }

    /**
     * Calculate percentage PnL from entry to current price.
     */
    static calculatePnLPct(entryPrice: number, currentPrice: number): number {
        if (entryPrice <= 0) return 0;
        return ((currentPrice - entryPrice) / entryPrice) * 100;
    }

    /**
     * Calculate Trailing Stop Loss price based on peak price and SL percentage.
     */
    static calculateTrailingSL(peakPrice: number, slPct: number): number {
        return peakPrice * (1 - slPct / 100);
    }
}

