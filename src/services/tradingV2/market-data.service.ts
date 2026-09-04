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
        // Clear price cache every minute to get fresh LTP, but keep candle cache across cycles
        this.priceCache.clear();
        tradingCronLogger.debug('[MarketDataService] Spot price cache cleared (candle cache preserved)');
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
            tradingCronLogger.debug(`[MarketDataService] Cache HIT for 15m candles (${instrument})`);
            return this.candleCache.get(cacheKey)!;
        }

        const fetchPromise = (async () => {
            const now  = Date.now();
            const currentCandleStart = Math.floor(now / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;

            // 1. Try Angel One SmartAPI (Free)
            try {
                const angelCandles = await AngelMarketDataService.get15mCandles(index);
                if (angelCandles && angelCandles.length > 0) {
                    const filtered = angelCandles.filter(c => c.timestamp < currentCandleStart);
                    tradingCronLogger.info(`[MarketDataService] ✔ Using Angel One 15m candles: ${filtered.length} completed candles for ${index}`);
                    return filtered;
                }
                tradingCronLogger.warn(`[MarketDataService] ⚠️ Angel One returned 0 15m candles for ${index}, attempting Zerodha fallback`);
            } catch (err: any) {
                tradingCronLogger.warn(`[MarketDataService] ⚠️ Angel One 15m candle fetch failed, falling back to Zerodha: ${err.message}`, { error: err });
            }

            // 2. Fallback to Zerodha Kite API
            const from = new Date(now - CANDLE_LOOKBACK * FIFTEEN_MIN_MS);
            const to   = new Date(now);

            tradingCronLogger.info(`[MarketDataService] ➔ Fetching 15m candles from Zerodha Kite: ${instrument} (${from.toISOString()} to ${to.toISOString()})`);
            const candles = await kite.getCandlestickData(instrument, '15minute', from, to);
            const filtered = candles.filter(c => c.timestamp < currentCandleStart);
            tradingCronLogger.info(`[MarketDataService] ✔ Received ${candles.length} raw 15m candles from Zerodha (${filtered.length} completed candles)`);
            return filtered;
        })();

        fetchPromise.catch((err) => {
            tradingCycleErrorLogger.error(`[MarketDataService] ✖ Failed to fetch 15m candles for ${index}: ${err.message}`, { error: err });
            this.candleCache.delete(cacheKey);
        });
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
            tradingCronLogger.debug(`[MarketDataService] Cache HIT for 1h candles (${instrument})`);
            return this.candleCache.get(cacheKey)!;
        }

        const fetchPromise = (async () => {
            const now  = Date.now();
            const currentCandleStart = Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS;

            // 1. Try Angel One SmartAPI (Free)
            try {
                const angelCandles = await AngelMarketDataService.get1hCandles(index);
                if (angelCandles && angelCandles.length > 0) {
                    const filtered = angelCandles.filter(c => c.timestamp < currentCandleStart);
                    tradingCronLogger.info(`[MarketDataService] ✔ Using Angel One 1h candles: ${filtered.length} completed candles for ${index}`);
                    return filtered;
                }
                tradingCronLogger.warn(`[MarketDataService] ⚠️ Angel One returned 0 1h candles for ${index}, attempting Zerodha fallback`);
            } catch (err: any) {
                tradingCronLogger.warn(`[MarketDataService] ⚠️ Angel One 1h candle fetch failed, falling back to Zerodha: ${err.message}`, { error: err });
            }

            // 2. Fallback to Zerodha Kite API
            const from = new Date(now - 100 * ONE_HOUR_MS);
            const to   = new Date(now);

            tradingCronLogger.info(`[MarketDataService] ➔ Fetching 1h candles from Zerodha Kite: ${instrument} (${from.toISOString()} to ${to.toISOString()})`);
            const candles = await kite.getCandlestickData(instrument, '60minute', from, to);
            const filtered = candles.filter(c => c.timestamp < currentCandleStart);
            tradingCronLogger.info(`[MarketDataService] ✔ Received ${candles.length} raw 1h candles from Zerodha (${filtered.length} completed candles)`);
            return filtered;
        })();

        fetchPromise.catch((err) => {
            tradingCycleErrorLogger.error(`[MarketDataService] ✖ Failed to fetch 1h candles for ${index}: ${err.message}`, { error: err });
            this.candleCache.delete(cacheKey);
        });
        this.candleCache.set(cacheKey, fetchPromise);
        return fetchPromise;
    }

    static async getSpotPrice(kite: KiteExchange, index: string): Promise<number> {
        const instrument = getIndexInstrument(index);
        if (this.priceCache.has(instrument)) {
            tradingCronLogger.debug(`[MarketDataService] Cache HIT for spot price (${instrument})`);
            return this.priceCache.get(instrument)!;
        }

        const fetchPromise = (async () => {
            // 1. Try Angel One SmartAPI (Free)
            try {
                const angelPrice = await AngelMarketDataService.getLTP(index);
                if (angelPrice && angelPrice > 0) {
                    tradingCronLogger.info(`[MarketDataService] ✔ Using Angel One spot LTP for ${index}: ₹${angelPrice.toFixed(2)}`);
                    return angelPrice;
                }
                tradingCronLogger.warn(`[MarketDataService] ⚠️ Angel One returned no LTP for ${index}, attempting Zerodha fallback`);
            } catch (err: any) {
                tradingCronLogger.warn(`[MarketDataService] ⚠️ Angel One spot LTP fetch failed: ${err.message}`, { error: err });
            }

            // 2. Fallback to Zerodha Kite API
            tradingCronLogger.info(`[MarketDataService] ➔ Fetching spot LTP from Zerodha Kite for ${instrument}`);
            const ltp = await kite.getLTP([instrument]);
            const price = ltp[instrument]?.last_price ?? 0;
            if (!price) {
                throw new Error(`[MarketData] No LTP returned for ${instrument}. Received: ${JSON.stringify(ltp)}`);
            }
            tradingCronLogger.info(`[MarketDataService] ✔ Spot LTP for ${instrument}: ₹${price.toFixed(2)}`);
            return price;
        })();

        fetchPromise.catch((err) => {
            tradingCycleErrorLogger.error(`[MarketDataService] ✖ Failed to fetch spot price for ${instrument}: ${err.message}`, { error: err });
            this.priceCache.delete(instrument);
        });
        this.priceCache.set(instrument, fetchPromise);
        return fetchPromise;
    }

    static async fetchMarketData(
        c: ConfigType,
        kite: KiteExchange,
        logger: typeof tradingCronLogger,
        skipLogger: typeof tradingCronLogger
    ): Promise<FetchedMarketData | null> {
        const tag = `[MarketData:${c.id}:${c.INDEX}]`;
        try {
            logger.info(`${tag} ➔ Starting market data fetch (15m candles, 1h candles, spot price)...`);
            const startTime = Date.now();

            // Fetch sequentially with rate-limit delays instead of firing simultaneously via Promise.all
            const candles15m = await this.get15mCandles(kite, c.INDEX);
            const candles1h  = await this.get1hCandles(kite, c.INDEX);
            const spotPrice  = await this.getSpotPrice(kite, c.INDEX);

            const elapsed = Date.now() - startTime;
            logger.info(
                `${tag} ✔ Market data fetched successfully in ${elapsed}ms: ` +
                `15m candles: ${candles15m.length}, 1h candles: ${candles1h.length}, Spot: ₹${spotPrice.toFixed(2)}`
            );

            if (!candles15m.length && !candles1h.length) {
                skipLogger.warn(`${tag} ✖ No candles returned for ${c.INDEX} across both 15m and 1h intervals`);
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
            tradingCycleErrorLogger.error(`${tag} ✖ Failed to fetch market data: ${err.message}`, { error: err, botId: c.id, index: c.INDEX });
            return null;
        }
    }
}
