// =============================================================================
// MarketDataService — Kite candle fetching with caching
// =============================================================================

import { Candle, TargetCandle, ConfigType } from './type';
import { KiteExchange, NIFTY_INDEX, BANKNIFTY_INDEX } from './kite-exchange';
import { tradingCycleErrorLogger, tradingCronLogger } from './logger';

export interface FetchedMarketData {
    targetCandle:              TargetCandle;
    entryCandles:              Candle[];
    confirmationTargetCandle:  TargetCandle;
    confirmationCandles:       Candle[];
    structureTargetCandle:     TargetCandle;
    structureCandles:          Candle[];
    spotPrice:                 number;
}

// Kite lookback candles per timeframe (need at least ATR_PERIOD+5 closed candles)
const CANDLE_LOOKBACK = 60; // fetch last 60 candles

// Kite interval → lookback duration multiplier (in milliseconds)
const INTERVAL_MS: Record<string, number> = {
    '1minute':  60 * 1000,
    '3minute':  3 * 60 * 1000,
    '5minute':  5 * 60 * 1000,
    '10minute': 10 * 60 * 1000,
    '15minute': 15 * 60 * 1000,
    '30minute': 30 * 60 * 1000,
    '60minute': 60 * 60 * 1000,
    'day':      24 * 60 * 60 * 1000,
};

function getIndexInstrument(index: string): string {
    return index === 'BANKNIFTY' ? BANKNIFTY_INDEX : NIFTY_INDEX;
}

function getLastClosedCandle(candles: Candle[]): TargetCandle | null {
    if (!candles.length) return null;
    const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
    const last = sorted[sorted.length - 1];
    return {
        ...last,
        color: last.close >= last.open ? 'green' : 'red',
    };
}

export class MarketDataService {
    // Cache: symbol:timeframe → candles promise
    private static candleCache = new Map<string, Promise<Candle[]>>();
    private static priceCache  = new Map<string, Promise<number>>();

    static clearCaches(): void {
        this.candleCache.clear();
        this.priceCache.clear();
        tradingCronLogger.debug('[MarketDataService] Caches cleared');
    }

    static async getCandlesForTimeframe(
        kite:       KiteExchange,
        index:      string,
        timeframe:  string
    ): Promise<Candle[]> {
        const instrument = getIndexInstrument(index);
        const cacheKey   = `${instrument}:${timeframe}`;

        if (this.candleCache.has(cacheKey)) {
            return this.candleCache.get(cacheKey)!;
        }

        const fetchPromise = (async () => {
            const intervalMs = INTERVAL_MS[timeframe] ?? (5 * 60 * 1000);
            const now  = Date.now();
            const from = new Date(now - CANDLE_LOOKBACK * intervalMs);
            const to   = new Date(now);

            const candles = await kite.getCandlestickData(instrument, timeframe, from, to);

            // Filter to only closed candles (exclude the current, incomplete candle)
            const currentCandleStart = Math.floor(now / intervalMs) * intervalMs;
            return candles.filter(c => c.timestamp < currentCandleStart);
        })();

        fetchPromise.catch(() => this.candleCache.delete(cacheKey));
        this.candleCache.set(cacheKey, fetchPromise);
        return fetchPromise;
    }

    static async getSpotPrice(kite: KiteExchange, index: string): Promise<number> {
        const instrument = getIndexInstrument(index);
        if (this.priceCache.has(instrument)) {
            return this.priceCache.get(instrument)!;
        }

        const fetchPromise = (async () => {
            const ltp = await kite.getLTP([instrument]);
            const price = ltp[instrument]?.last_price ?? 0;
            if (!price) throw new Error(`[MarketData] No LTP for ${instrument}`);
            return price;
        })();

        fetchPromise.catch(() => this.priceCache.delete(instrument));
        this.priceCache.set(instrument, fetchPromise);
        return fetchPromise;
    }

    static async fetchMarketData(
        c:           ConfigType,
        kite:        KiteExchange,
        cronLogger:  any,
        skipLogger:  any
    ): Promise<FetchedMarketData | null> {

        const [entryCandles, confirmCandles, structureCandles, spotPrice] = await Promise.all([
            this.getCandlesForTimeframe(kite, c.INDEX, c.ENTRY_TIMEFRAME),
            this.getCandlesForTimeframe(kite, c.INDEX, c.CONFIRMATION_TIMEFRAME),
            this.getCandlesForTimeframe(kite, c.INDEX, c.STRUCTURE_TIMEFRAME),
            this.getSpotPrice(kite, c.INDEX),
        ]);

        const entryTarget    = getLastClosedCandle(entryCandles);
        const confirmTarget  = getLastClosedCandle(confirmCandles);
        const structTarget   = getLastClosedCandle(structureCandles);

        if (!entryTarget || !confirmTarget || !structTarget) {
            const missing = [];
            if (!entryTarget)   missing.push(`ENTRY(${c.ENTRY_TIMEFRAME})`);
            if (!confirmTarget) missing.push(`CONFIRM(${c.CONFIRMATION_TIMEFRAME})`);
            if (!structTarget)  missing.push(`STRUCTURE(${c.STRUCTURE_TIMEFRAME})`);
            skipLogger.info(`[MarketData] SKIP: No closed candles for ${c.INDEX} on: ${missing.join(', ')}`);
            return null;
        }

        cronLogger.info(
            `[MarketData] ${c.INDEX} | Spot: ${spotPrice.toFixed(2)}\n` +
            `  ENTRY   (${c.ENTRY_TIMEFRAME}):   ${entryCandles.length} candles, ` +
                `O:${entryTarget.open} H:${entryTarget.high} L:${entryTarget.low} C:${entryTarget.close} [${entryTarget.color.toUpperCase()}]\n` +
            `  CONFIRM (${c.CONFIRMATION_TIMEFRAME}): ${confirmCandles.length} candles, ` +
                `O:${confirmTarget.open} H:${confirmTarget.high} L:${confirmTarget.low} C:${confirmTarget.close} [${confirmTarget.color.toUpperCase()}]\n` +
            `  STRUCTURE(${c.STRUCTURE_TIMEFRAME}): ${structureCandles.length} candles, ` +
                `O:${structTarget.open} H:${structTarget.high} L:${structTarget.low} C:${structTarget.close} [${structTarget.color.toUpperCase()}]`
        );

        return {
            targetCandle:             entryTarget,
            entryCandles,
            confirmationTargetCandle: confirmTarget,
            confirmationCandles:      confirmCandles,
            structureTargetCandle:    structTarget,
            structureCandles,
            spotPrice,
        };
    }
}
