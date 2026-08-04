// =============================================================================
// ATR-14 Strategy — Pure 15-Minute Candle True Range Expansion Engine
// =============================================================================
// Strategy Rule:
//   1. Evaluate exclusively 15-minute candles (sorted oldest -> newest)
//   2. Compute TR = max(H - L, |H - prevClose|, |L - prevClose|)
//   3. Compute ATR(14) over 15m candles
//   4. Breakout Condition: TR > atrMultiplier * ATR(14)
//   5. Signal Direction:
//      - 15m Close >= Open (Bullish) -> BUY_CALL (CE)
//      - 15m Close < Open (Bearish)  -> BUY_PUT (PE)
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
     * Compute ATR(period) using Wilder's smoothing on 15m candles.
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
     * Evaluate trading signal strictly from 15m candles using TR & ATR(14).
     */
    static evaluateSignal(
        candles15m: Candle[],
        spotPrice: number,
        atrMultiplier: number = 1.25,
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

        if (candles15m.length < atrPeriod + 1) {
            result.skipReasons.push(`Insufficient 15m candles (${candles15m.length}/${atrPeriod + 1})`);
            return result;
        }

        const sorted = [...candles15m].sort((a, b) => a.timestamp - b.timestamp);
        const latestCandle = sorted[sorted.length - 1];
        const prevCandle   = sorted[sorted.length - 2];

        // 1. Calculate TR and ATR(14)
        const tr    = this.computeTR(latestCandle, prevCandle);
        const atr14 = this.computeATR(sorted, atrPeriod);

        result.tr    = tr;
        result.atr14 = atr14;

        if (atr14 === 0) {
            result.skipReasons.push('ATR(14) calculation returned 0');
            return result;
        }

        const trThreshold = atr14 * atrMultiplier;

        // 2. Volatility Expansion Filter: TR > atrMultiplier * ATR(14)
        if (tr <= trThreshold) {
            result.skipReasons.push(
                `TR (${tr.toFixed(1)}) <= ${atrMultiplier}x ATR14 (${trThreshold.toFixed(1)}) — no volatility spurt`
            );
            return result;
        }

        // 3. Directional Breakout on 15m candle
        const isBullish = latestCandle.close >= latestCandle.open;
        const isBearish = latestCandle.close < latestCandle.open;

        if (isBullish) {
            result.signal     = 'BULL';
            result.optionType = 'CE';
            result.score      = 100;
            result.reasons.push(
                `15m Bullish Spurt: TR ${tr.toFixed(1)} > ${atrMultiplier}x ATR14 (${trThreshold.toFixed(1)})`
            );
        } else if (isBearish) {
            result.signal     = 'BEAR';
            result.optionType = 'PE';
            result.score      = 100;
            result.reasons.push(
                `15m Bearish Spurt: TR ${tr.toFixed(1)} > ${atrMultiplier}x ATR14 (${trThreshold.toFixed(1)})`
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
