// =============================================================================
// MarketDataService — Kite 15-Minute Candle Fetcher
// =============================================================================

import fs from 'fs';
import path from 'path';
import { Candle, TargetCandle, ConfigType } from './type';
import { KiteExchange, NIFTY_INDEX, BANKNIFTY_INDEX } from './kite-exchange';
import { tradingCycleErrorLogger, tradingCronLogger } from './logger';
import { AngelMarketDataService } from './angel-market-data.service';
import { AngelStreamService } from './angel-stream.service';
import { LiveCandleBuilder } from './live-candle-builder';
import { env } from '../../config';

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
    private static priceCache  = new Map<string, Promise<number>>();

    static clearCaches(): void {
        // Clear price cache every minute to fetch fresh LTP
        this.priceCache.clear();
        tradingCronLogger.debug('[MarketDataService] Intra-cycle spot price cache reset (LTP refreshed)');
    }

    /**
     * Fetch 15-minute candles for the index instrument.
     * Uses cached candles if USE_CACHE_CANDLE is enabled, else Angel One SmartAPI.
     */
    static async get15mCandles(
        kite:    KiteExchange,
        index:   string,
        config?: ConfigType
    ): Promise<Candle[]> {
        const useCache = config?.USE_CACHE_CANDLE ?? env.useCacheCandle;
        if (useCache) {
            const cacheFile = path.join(process.cwd(), 'cache', 'nifty_15m_cached.json');
            if (fs.existsSync(cacheFile)) {
                try {
                    const raw = fs.readFileSync(cacheFile, 'utf8');
                    const cachedCandles: Candle[] = JSON.parse(raw);
                    const sorted = [...cachedCandles].sort((a, b) => a.timestamp - b.timestamp);

                    // If user specified a target time, slice candles up to that target:
                    const targetTime = config?.CACHE_CANDLE_TARGET_TIME ?? env.cacheCandleTargetTime;
                    if (targetTime) {
                        const targetIdx = sorted.findIndex(c => {
                            const ist = new Date(c.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
                            const iso = new Date(c.timestamp).toISOString();
                            return ist.includes(targetTime) || iso.includes(targetTime);
                        });

                        if (targetIdx !== -1) {
                            // Include target candle and next candle so that breakdown/breakout confirmation is present
                            const endIdx = Math.min(sorted.length, targetIdx + 2);
                            const sliced = sorted.slice(0, endIdx);
                            const targetCandle = sorted[targetIdx];
                            const candleTimeStr = new Date(targetCandle.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
                            tradingCronLogger.info(`[MarketDataService] 📁 USE_CACHE_CANDLE=true: Loaded ${sliced.length} cached candles up to target [${candleTimeStr} IST] for ${index}`);
                            return sliced;
                        } else {
                            tradingCronLogger.warn(`[MarketDataService] ⚠️ USE_CACHE_CANDLE=true: Target time "${targetTime}" not found in cache. Using all ${sorted.length} candles.`);
                        }
                    }

                    tradingCronLogger.info(`[MarketDataService] 📁 USE_CACHE_CANDLE=true: Loaded ${sorted.length} cached candles from ${cacheFile}`);
                    return sorted;
                } catch (e: any) {
                    tradingCycleErrorLogger.error(`[MarketDataService] ✖ Failed reading candle cache: ${e.message}`);
                }
            } else {
                tradingCronLogger.warn(`[MarketDataService] ⚠️ USE_CACHE_CANDLE=true but cache file not found at ${cacheFile}`);
            }
        }

        const now = Date.now();
        const currentCandleStart = AngelMarketDataService.candleBoundary15m(now);

        try {
            const angelCandles = await AngelMarketDataService.get15mCandles(index);
            if (angelCandles && angelCandles.length > 0) {
                const filtered = angelCandles.filter(c => c.timestamp < currentCandleStart);
                tradingCronLogger.info(`[MarketDataService] ✔ Using Angel One 15m candles: ${filtered.length} completed candles for ${index}`);
                return filtered;
            }
            tradingCronLogger.warn(`[MarketDataService] ⚠️ Angel One returned 0 completed 15m candles for ${index}`);
            return [];
        } catch (err: any) {
            tradingCycleErrorLogger.error(`[MarketDataService] ✖ Angel One 15m candle fetch error: ${err.message}`, { error: err });
            return [];
        }
    }

    /**
     * Fetch 1-hour (60-minute) candles for the index instrument.
     * Uses Angel One SmartAPI (Free Historical Candles).
     * Zerodha historical fallback is disabled because Kite historical data requires a paid add-on.
     *
     * Returns only COMPLETED candles (timestamp < current 1H boundary).
     */
    static async get1hCandles(
        kite:   KiteExchange,
        index:  string,
        config?: ConfigType
    ): Promise<Candle[]> {
        const useCache = config?.USE_CACHE_CANDLE ?? env.useCacheCandle;
        if (useCache) {
            const candles15m = await this.get15mCandles(kite, index, config);
            if (candles15m.length > 0) {
                const groups = new Map<number, Candle[]>();
                for (const c of candles15m) {
                    const b1h = AngelMarketDataService.candleBoundary1h(c.timestamp);
                    if (!groups.has(b1h)) groups.set(b1h, []);
                    groups.get(b1h)!.push(c);
                }
                const candles1h: Candle[] = [];
                for (const [timestamp, bars] of groups.entries()) {
                    bars.sort((a, b) => a.timestamp - b.timestamp);
                    candles1h.push({
                        timestamp,
                        open: bars[0].open,
                        high: Math.max(...bars.map(b => b.high)),
                        low: Math.min(...bars.map(b => b.low)),
                        close: bars[bars.length - 1].close,
                        volume: bars.reduce((acc, b) => acc + (b.volume || 0), 0),
                    });
                }
                const sorted1h = candles1h.sort((a, b) => a.timestamp - b.timestamp);
                tradingCronLogger.info(`[MarketDataService] 📁 USE_CACHE_CANDLE=true: Synthesized ${sorted1h.length} 1H candles from cached 15m candles for ${index}`);
                return sorted1h;
            }
            return [];
        }

        const now = Date.now();
        const boundary1h = AngelMarketDataService.candleBoundary1h(now);

        try {
            const angelCandles = await AngelMarketDataService.get1hCandles(index);
            if (angelCandles && angelCandles.length > 0) {
                const filtered = angelCandles.filter(c => c.timestamp < boundary1h);
                tradingCronLogger.info(`[MarketDataService] ✔ Using Angel One 1h candles: ${filtered.length} completed candles for ${index}`);
                return filtered;
            }
            tradingCronLogger.warn(`[MarketDataService] ⚠️ Angel One returned 0 1h candles for ${index}`);
            return [];
        } catch (err: any) {
            tradingCycleErrorLogger.error(`[MarketDataService] ✖ Angel One 1h candle fetch failed: ${err.message}`, { error: err });
            return [];
        }
    }

    /**
     * Fetch 1-hour candles INCLUDING the current live (forming) candle.
     *
     * Used when UT_BOT_TRADE_ON_CANDLE_CLOSE = false.
     * The live candle is appended with a synthetic close = current spot price,
     * so the UT Bot can detect a mid-candle trailing-stop crossover immediately.
     * This is NOT cached because the live candle changes every minute.
     */
    static async get1hCandlesWithLive(
        kite:   KiteExchange,
        index:  string,
        spotPrice: number,
        config?: ConfigType
    ): Promise<Candle[]> {
        const completedCandles = await this.get1hCandles(kite, index, config);

        // Fetch completed 15m candles from cache to seed high/low if cold start
        const completed15m = await this.get15mCandles(kite, index, config).catch(() => []);

        const token = (index === 'BANKNIFTY') ? '99926009' : '99926000';
        const liveCandle = LiveCandleBuilder.getLive1hCandle(token, spotPrice, completed15m);

        tradingCronLogger.info(
            `[MarketDataService] 🔴 LIVE CANDLE included (LiveCandleBuilder): ` +
            `boundary=${new Date(liveCandle.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST | ` +
            `O: ₹${liveCandle.open.toFixed(2)} | H: ₹${liveCandle.high.toFixed(2)} | L: ₹${liveCandle.low.toFixed(2)} | C: ₹${liveCandle.close.toFixed(2)}`
        );

        return [...completedCandles, liveCandle];
    }

    static async getSpotPrice(
        kite: KiteExchange,
        index: string,
        config?: ConfigType,
        candles15m?: Candle[]
    ): Promise<number> {
        const useCache = config?.USE_CACHE_CANDLE ?? env.useCacheCandle;
        if (useCache) {
            // Read spot price from the latest candle in the cached candle list
            if (candles15m && candles15m.length > 0) {
                const latestCandle = candles15m[candles15m.length - 1];
                tradingCronLogger.info(
                    `[MarketDataService] 📁 USE_CACHE_CANDLE=true: Using latest cached candle close price for ${index}: ₹${latestCandle.close.toFixed(2)}`
                );
                return latestCandle.close;
            }

            const cacheFile = path.join(process.cwd(), 'cache', 'nifty_15m_cached.json');
            if (fs.existsSync(cacheFile)) {
                try {
                    const raw = fs.readFileSync(cacheFile, 'utf8');
                    const cachedCandles: Candle[] = JSON.parse(raw);
                    if (cachedCandles.length > 0) {
                        const sorted = [...cachedCandles].sort((a, b) => a.timestamp - b.timestamp);
                        const latestCandle = sorted[sorted.length - 1];
                        tradingCronLogger.info(
                            `[MarketDataService] 📁 USE_CACHE_CANDLE=true: Using latest cached candle close price for ${index}: ₹${latestCandle.close.toFixed(2)}`
                        );
                        return latestCandle.close;
                    }
                } catch (e: any) {
                    tradingCycleErrorLogger.error(`[MarketDataService] ✖ Failed reading candle cache for spot price: ${e.message}`);
                }
            }
        }

        const instrument = getIndexInstrument(index);
        if (this.priceCache.has(instrument)) {
            tradingCronLogger.debug(`[MarketDataService] Cache HIT for spot price (${instrument})`);
            return this.priceCache.get(instrument)!;
        }

        // 0. Check real-time WebSocket tick in memory (< 1ms zero-latency)
        const streamToken = (index === 'BANKNIFTY' || index === 'NIFTY BANK') ? '99926009' : '99926000';
        const streamLtp = AngelStreamService.getLtp(streamToken);
        if (streamLtp && streamLtp > 0) {
            tradingCronLogger.info(`[MarketDataService] ⚡ Instant spot LTP from AngelStream for ${index}: ₹${streamLtp.toFixed(2)}`);
            this.priceCache.set(instrument, Promise.resolve(streamLtp));
            return streamLtp;
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
            const isUtBotEnabled = c.UT_BOT_ENABLED !== false;
            const tradeOnClose   = c.UT_BOT_TRADE_ON_CANDLE_CLOSE !== false; // default true

            logger.info(
                `${tag} ➤ Starting market data fetch (15m, spot${isUtBotEnabled ? ', 1h' : ''}) | ` +
                (isUtBotEnabled ? `UT entry mode: ${tradeOnClose ? '⏳ CANDLE CLOSE' : '⚡ IMMEDIATE (live candle)'}` : 'Candle Pattern 15m mode')
            );
            const startTime = Date.now();

            // Fetch 15m candles and spot price first
            const candles15m = await this.get15mCandles(kite, c.INDEX, c);
            const spotPrice  = await this.getSpotPrice(kite, c.INDEX, c, candles15m);

            // Fetch 1H candles ONLY if UT Bot is enabled
            let candles1h: Candle[] = [];
            if (isUtBotEnabled) {
                candles1h = tradeOnClose
                    ? await this.get1hCandles(kite, c.INDEX, c)
                    : await this.get1hCandlesWithLive(kite, c.INDEX, spotPrice, c);
            }

            const elapsed = Date.now() - startTime;
            logger.info(
                `${tag} ✔ Market data fetched in ${elapsed}ms: ` +
                `15m=${candles15m.length} candles` +
                (isUtBotEnabled ? `, 1h=${candles1h.length} candles (${tradeOnClose ? 'closed' : 'live+closed'})` : ', 1h=skipped (UT Bot disabled)') +
                `, Spot=₹${spotPrice.toFixed(2)}`
            );

            if (!candles15m.length) {
                skipLogger.warn(`${tag} ✖ No 15m candles returned for ${c.INDEX}`);
                return null;
            }
            if (isUtBotEnabled && !candles1h.length) {
                skipLogger.warn(`${tag} ✖ No 1h candles returned for ${c.INDEX} for UT Bot`);
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
