// =============================================================================
// Utils — Generic helpers for the Kite/NIFTY trading engine
// =============================================================================

import { ITradeState } from '../../models/tradeState.model';
import { TradingConfig } from './config';
import { Candle, TargetCandle, OrderSide } from './type';
import { skipTradingLogger } from './logger';

export class Utils {

    // ─── JSON Helpers ─────────────────────────────────────────────────────────

    static parseJsonSafe(t: string): unknown {
        try { return JSON.parse(t); } catch { return t; }
    }

    static compactJson(o: unknown): string {
        return o ? JSON.stringify(o) : '';
    }

    static sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ─── Candle Parsing ───────────────────────────────────────────────────────

    /**
     * Parse a Kite historical data candle array [date, o, h, l, c, v].
     */
    static parseKiteCandle(c: any[]): Candle {
        const [date, o, h, l, cl, v] = c;
        return {
            timestamp: new Date(date).getTime(),
            open:   Number(o),
            high:   Number(h),
            low:    Number(l),
            close:  Number(cl),
            volume: Number(v ?? 0),
        };
    }

    /**
     * Parse a Kite candle object { date, open, high, low, close, volume }.
     */
    static parseKiteCandleObject(c: any): Candle {
        return {
            timestamp: new Date(c.date ?? c.timestamp).getTime(),
            open:   Number(c.open  ?? c.o),
            high:   Number(c.high  ?? c.h),
            low:    Number(c.low   ?? c.l),
            close:  Number(c.close ?? c.c),
            volume: Number(c.volume ?? c.v ?? 0),
        };
    }

    // ─── Trade State Helpers ──────────────────────────────────────────────────

    static isTradePending(s: ITradeState): boolean {
        return s.tradeOutcome === 'pending';
    }

    static isTradeResolved(s: ITradeState): boolean {
        return s.tradeOutcome !== 'pending';
    }

    // ─── Price Direction Check ────────────────────────────────────────────────

    /**
     * Check if price is moving in the direction of the option order.
     * For CE (buy call): price should be above candle low (bullish momentum retained).
     * For PE (buy put):  price should be below candle high (bearish momentum retained).
     */
    static isPriceMovingInSignalDirection(
        candle:        TargetCandle,
        side:          OrderSide,
        currentPrice:  number,
        symbol:        string,
        botId:         string
    ): boolean {
        const isTrendValid =
            side === 'sell'
                ? currentPrice < candle.high    // bear signal: price below high
                : currentPrice > candle.low;    // bull signal: price above low

        if (!isTrendValid) {
            skipTradingLogger.info(`[PriceTrend] SKIP: Price not in signal direction for ${symbol}`, {
                botId, side, currentPrice,
                candleHigh: candle.high,
                candleLow:  candle.low,
            });
        }

        return isTrendValid;
    }

    // ─── Candle Analysis ──────────────────────────────────────────────────────

    /** Body size as a % of the high-low range */
    static getBodyPercent(c: Candle): number {
        const range = c.high - c.low;
        return range === 0 ? 0 : (Math.abs(c.close - c.open) / range) * 100;
    }

    /** Body move as % of the open price */
    static getBodyMovePercent(c: Candle): number {
        return c.open === 0 ? 0 : (Math.abs(c.close - c.open) / c.open) * 100;
    }

    /** High-low range as % of the low */
    static getRangePercent(candles: Candle[]): number {
        const high = Math.max(...candles.map(c => c.high));
        const low  = Math.min(...candles.map(c => c.low));
        return low === 0 ? 0 : ((high - low) / low) * 100;
    }

    static getCandleColor(c: Candle): 'red' | 'green' {
        return c.close >= c.open ? 'green' : 'red';
    }

    /** True if current candle volume is 1.8× the 5-candle average */
    static isVolumeSpike(candles: Candle[], index: number): boolean {
        if (index < 5) return false;
        const avg = candles.slice(index - 5, index).reduce((a, b) => a + b.volume, 0) / 5;
        return candles[index].volume > avg * 1.8;
    }

    // ─── Technical Indicators ─────────────────────────────────────────────────

    static calculateEMA(candles: Candle[], period: number): number {
        if (candles.length < period) return 0;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((a, b) => a + b.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = (candles[i].close - ema) * k + ema;
        }
        return ema;
    }

    static roundToTick(price: number, tickSize: number = 0.05): number {
        return Math.round(price / tickSize) * tickSize;
    }
}
