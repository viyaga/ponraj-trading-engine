import { Candle, TargetCandle, ConfigType } from "./type";
import { Utils } from "./utils";
import { ExchangeAdapterFactory } from "./adapters/exchange.factory";
import { tradingCycleErrorLogger, tradingCronLogger } from "./logger";

export interface FetchedMarketData {
    targetCandle: TargetCandle;
    entryCandles: Candle[];
    confirmationTargetCandle: TargetCandle;
    confirmationCandles: Candle[];
    structureTargetCandle: TargetCandle;
    structureCandles: Candle[];
    currentPrice: number;
}

export class MarketDataService {
    private static candleCache = new Map<string, Promise<{ target: TargetCandle; candles: Candle[] } | null>>();
    private static priceCache = new Map<string, Promise<number>>();

    static clearCaches(): void {
        this.candleCache.clear();
        this.priceCache.clear();
        tradingCronLogger.debug(`[TradingV2] Market data caches cleared`);
    }

    static async getTargetCandle(
        c: {
            SYMBOL: string;
            TIMEFRAME: string;
            CONFIRMATION_TIMEFRAME: string;
            STRUCTURE_TIMEFRAME: string;
        },
        timeframeType: 'ENTRY' | 'CONFIRMATION' | 'STRUCTURE'
    ): Promise<{ target: TargetCandle; candles: Candle[] } | null> {
        const timeframe = timeframeType === 'ENTRY' 
            ? c.TIMEFRAME 
            : timeframeType === 'CONFIRMATION' 
                ? c.CONFIRMATION_TIMEFRAME 
                : c.STRUCTURE_TIMEFRAME;
        const cacheKey = `${c.SYMBOL}:${timeframe}`;

        if (this.candleCache.has(cacheKey)) {
            return this.candleCache.get(cacheKey)!;
        }

        const fetchPromise = (async () => {
            const dur = Utils.getTimeframeDurationMs(timeframe);
            const now = Date.now();
            const currentCandleStart = Math.floor(now / dur) * dur;
            const adapter = ExchangeAdapterFactory.getAdapter();

            const cd = await adapter.getCandlestickData(
                c.SYMBOL,
                timeframe,
                currentCandleStart - 80 * dur,
                now
            );

            const candles = Utils.parseCandleResponse(cd);
            if (!candles.length) return null;

            candles.sort((a, b) => a.timestamp - b.timestamp);
            const closedCandles = candles.filter(
                candle => candle.timestamp < currentCandleStart
            );

            if (!closedCandles.length) {
                tradingCycleErrorLogger.error(`[getTargetCandle:${c.SYMBOL}] No closed candles found`);
                return null;
            }

            const target = closedCandles[closedCandles.length - 1];
            return {
                target: {
                    ...target,
                    color: Utils.getCandleColor(target)
                },
                candles: closedCandles
            };
        })();

        fetchPromise.catch(() => {
            this.candleCache.delete(cacheKey);
        });
        this.candleCache.set(cacheKey, fetchPromise);
        return fetchPromise;
    }

    static async getCurrentPrice(sym: string): Promise<number> {
        if (this.priceCache.has(sym)) {
            return this.priceCache.get(sym)!;
        }

        const fetchPromise = (async () => {
            const adapter = ExchangeAdapterFactory.getAdapter();
            const ticker = await adapter.getTickerData(sym);
            if (!ticker) {
                throw new Error(`[workflow] No ticker data for ${sym}`);
            }
            return Number(ticker.mark_price);
        })();

        fetchPromise.catch(() => {
            this.priceCache.delete(sym);
        });
        this.priceCache.set(sym, fetchPromise);
        return fetchPromise;
    }

    static async fetchMarketData(
        c: ConfigType,
        cronLogger: any,
        skipLogger: any
    ): Promise<FetchedMarketData | null> {
        const targetDataEntry = await this.getTargetCandle(c, 'ENTRY');
        const targetDataConfirmation = await this.getTargetCandle(c, 'CONFIRMATION');
        const targetDataStructure = await this.getTargetCandle(c, 'STRUCTURE');

        if (!targetDataEntry || !targetDataConfirmation || !targetDataStructure) {
            const missing = [];
            if (!targetDataEntry) missing.push('ENTRY');
            if (!targetDataConfirmation) missing.push('CONFIRMATION');
            if (!targetDataStructure) missing.push('STRUCTURE');

            skipLogger.info(`[MarketData] SKIP: Missing closed candles for ${c.SYMBOL} on: ${missing.join(', ')}`);
            return null;
        }

        cronLogger.info(`[MarketData] Candlestick Data Fetched:
          ENTRY (${c.TIMEFRAME}): ${targetDataEntry.candles.length} candles, Target: [O:${targetDataEntry.target.open}, H:${targetDataEntry.target.high}, L:${targetDataEntry.target.low}, C:${targetDataEntry.target.close}, Color:${targetDataEntry.target.color}]
          CONFIRMATION (${c.CONFIRMATION_TIMEFRAME}): ${targetDataConfirmation.candles.length} candles, Target: [O:${targetDataConfirmation.target.open}, H:${targetDataConfirmation.target.high}, L:${targetDataConfirmation.target.low}, C:${targetDataConfirmation.target.close}, Color:${targetDataConfirmation.target.color}]
          STRUCTURE (${c.STRUCTURE_TIMEFRAME}): ${targetDataStructure.candles.length} candles, Target: [O:${targetDataStructure.target.open}, H:${targetDataStructure.target.high}, L:${targetDataStructure.target.low}, C:${targetDataStructure.target.close}, Color:${targetDataStructure.target.color}]`);

        cronLogger.debug(`[MarketPrice] Fetching latest price for ${c.SYMBOL}...`);
        const currentPrice = await this.getCurrentPrice(c.SYMBOL);
        cronLogger.info(`[MarketPrice] Current Mark Price: ${currentPrice}`);

        return {
            targetCandle: targetDataEntry.target,
            entryCandles: targetDataEntry.candles,
            confirmationTargetCandle: targetDataConfirmation.target,
            confirmationCandles: targetDataConfirmation.candles,
            structureTargetCandle: targetDataStructure.target,
            structureCandles: targetDataStructure.candles,
            currentPrice
        };
    }
}
