// =============================================================================
// MarketDataService — Kite 15-Minute Candle Fetcher
// =============================================================================

import { Candle, TargetCandle, ConfigType } from './type';
import { KiteExchange, NIFTY_INDEX, BANKNIFTY_INDEX } from './kite-exchange';
import { tradingCycleErrorLogger, tradingCronLogger } from './logger';
import { AngelMarketDataService } from './angel-market-data.service';

export interface FetchedMarketData {
    candles15m:   Candle[];
    candles1h:    Candle[];
    targetCandle: TargetCandle;
    spotPrice:    number;
}

// Fetch lookback constants
const CANDLE_LOOKBACK = 60;
const FIFTEEN_MIN_MS  = 15 * 60 * 1000;
const ONE_HOUR_MS     = 60 * 60 * 1000;

function getIndexInstrument(index: string): string {
    return index === 'BANKNIFTY' ? BANKNIFTY_INDEX : NIFTY_INDEX;
}

export class MarketDataService {
    private static candleCache = new Map<string, Promise<Candle[]>>();
    private static priceCache  = new Map<string, Promise<number>>();

    static clearCaches(): void {
        this.candleCache.clear();
        this.priceCache.clear();
        tradingCronLogger.debug('[MarketDataService] Caches cleared');
    }

    /**
     * Fetch 15-minute candles for the index instrument.
     * Prefers Angel One SmartAPI (100% Free Candles) if configured,
     * falling back to Zerodha Kite historical API.
     */
    static async get15mCandles(
        kite:  KiteExchange,
        index: string
    ): Promise<Candle[]> {
        const instrument = getIndexInstrument(index);
        const cacheKey   = `${instrument}:15minute`;

        if (this.candleCache.has(cacheKey)) {
            return this.candleCache.get(cacheKey)!;
        }

        const fetchPromise = (async () => {
            const now  = Date.now();
            const currentCandleStart = Math.floor(now / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;

            // 1. Try Angel One SmartAPI (Free)
            try {
                const angelCandles = await AngelMarketDataService.get15mCandles(index);
                if (angelCandles && angelCandles.length > 0) {
                    return angelCandles.filter(c => c.timestamp < currentCandleStart);
                }
            } catch (err: any) {
                tradingCronLogger.debug(`[MarketDataService] Angel One 15m candle fetch fallback to Zerodha: ${err.message}`);
            }

            // 2. Fallback to Zerodha Kite API
            const from = new Date(now - CANDLE_LOOKBACK * FIFTEEN_MIN_MS);
            const to   = new Date(now);

            const candles = await kite.getCandlestickData(instrument, '15minute', from, to);
            return candles.filter(c => c.timestamp < currentCandleStart);
        })();

        fetchPromise.catch(() => this.candleCache.delete(cacheKey));
        this.candleCache.set(cacheKey, fetchPromise);
        return fetchPromise;
    }

    /**
     * Fetch 1-hour (60-minute) candles for the index instrument.
     * Prefers Angel One SmartAPI if configured, falling back to Zerodha Kite.
     */
    static async get1hCandles(
        kite:  KiteExchange,
        index: string
    ): Promise<Candle[]> {
        const instrument = getIndexInstrument(index);
        const cacheKey   = `${instrument}:60minute`;

        if (this.candleCache.has(cacheKey)) {
            return this.candleCache.get(cacheKey)!;
        }

        const fetchPromise = (async () => {
            const now  = Date.now();
            const currentCandleStart = Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS;

            // 1. Try Angel One SmartAPI (Free)
            try {
                const angelCandles = await AngelMarketDataService.get1hCandles(index);
                if (angelCandles && angelCandles.length > 0) {
                    return angelCandles.filter(c => c.timestamp < currentCandleStart);
                }
            } catch (err: any) {
                tradingCronLogger.debug(`[MarketDataService] Angel One 1h candle fetch fallback to Zerodha: ${err.message}`);
            }

            // 2. Fallback to Zerodha Kite API
            const from = new Date(now - 100 * ONE_HOUR_MS);
            const to   = new Date(now);

            const candles = await kite.getCandlestickData(instrument, '60minute', from, to);
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
        c: ConfigType,
        kite: KiteExchange,
        logger: typeof tradingCronLogger,
        skipLogger: typeof tradingCronLogger
    ): Promise<FetchedMarketData | null> {
        try {
            const [candles15m, candles1h, spotPrice] = await Promise.all([
                this.get15mCandles(kite, c.INDEX),
                this.get1hCandles(kite, c.INDEX),
                this.getSpotPrice(kite, c.INDEX),
            ]);

            if (!candles15m.length && !candles1h.length) {
                skipLogger.warn(`[MarketData] No candles returned for ${c.INDEX}`);
                return null;
            }

            const sorted15m = [...candles15m].sort((a, b) => a.timestamp - b.timestamp);
            const last15m   = sorted15m[sorted15m.length - 1];
            const targetCandle: TargetCandle = last15m ? {
                ...last15m,
                color: last15m.close >= last15m.open ? 'green' : 'red',
            } : {
                timestamp: Date.now(),
                open: spotPrice,
                high: spotPrice,
                low: spotPrice,
                close: spotPrice,
                volume: 0,
                color: 'green',
            };

            return {
                candles15m,
                candles1h,
                targetCandle,
                spotPrice,
            };
        } catch (err: any) {
            tradingCycleErrorLogger.error(`[MarketData] Failed to fetch market data: ${err.message}`);
            return null;
        }
    }
}
