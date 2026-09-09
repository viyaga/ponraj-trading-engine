import { Candle } from './type';
import { CandleModel } from '../../models/candle.model';
import { tradingCronLogger } from './logger';

export class CandleStorageService {
    /**
     * Persist completed candles into MongoDB using bulk upsert.
     * Non-blocking and idempotent — duplicate timestamps update safely.
     */
    static async saveCandles(
        symbol: string,
        interval: string,
        candles: Candle[]
    ): Promise<void> {
        if (!candles || candles.length === 0) return;

        try {
            const ops = candles.map((c) => ({
                updateOne: {
                    filter: {
                        symbol,
                        interval,
                        timestamp: c.timestamp,
                    },
                    update: {
                        $set: {
                            symbol,
                            interval,
                            timestamp:  c.timestamp,
                            candleTime: new Date(c.timestamp),
                            open:       c.open,
                            high:       c.high,
                            low:        c.low,
                            close:      c.close,
                            volume:     c.volume ?? 0,
                        },
                    },
                    upsert: true,
                },
            }));

            // Execute in chunks of 200 if necessary
            const CHUNK_SIZE = 200;
            for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
                const chunk = ops.slice(i, i + CHUNK_SIZE);
                await CandleModel.bulkWrite(chunk, { ordered: false });
            }

            tradingCronLogger.debug(
                `[CandleStorage] ✔ Saved ${candles.length} ${interval} candles for ${symbol} into MongoDB`
            );
        } catch (err: any) {
            tradingCronLogger.warn(
                `[CandleStorage] ⚠️ Failed to save ${interval} candles for ${symbol}: ${err.message}`
            );
        }
    }

    /**
     * Load completed historical candles from MongoDB.
     * Returns candles sorted ascending by timestamp.
     */
    static async getCandles(
        symbol: string,
        interval: string,
        limit: number = 150
    ): Promise<Candle[]> {
        try {
            const docs = await CandleModel.find({ symbol, interval })
                .sort({ timestamp: -1 })
                .limit(limit)
                .lean();

            if (!docs || docs.length === 0) {
                return [];
            }

            // Convert docs to Candle interface and sort ascending
            const candles: Candle[] = docs.map((d) => ({
                timestamp: d.timestamp,
                open:      d.open,
                high:      d.high,
                low:       d.low,
                close:     d.close,
                volume:    d.volume ?? 0,
            })).sort((a, b) => a.timestamp - b.timestamp);

            tradingCronLogger.info(
                `[CandleStorage] 📂 Loaded ${candles.length} ${interval} candles for ${symbol} from DB ` +
                `[${new Date(candles[0].timestamp).toLocaleDateString('en-IN')} → ${new Date(candles[candles.length - 1].timestamp).toLocaleDateString('en-IN')}]`
            );

            return candles;
        } catch (err: any) {
            tradingCronLogger.warn(
                `[CandleStorage] ⚠️ DB query failed for ${symbol} ${interval}: ${err.message}`
            );
            return [];
        }
    }

    /**
     * Explicit cleanup to prune unwanted old candles older than `daysToKeep`.
     * Note: MongoDB TTL index also auto-prunes in the background, but this provides immediate manual pruning.
     */
    static async pruneOldCandles(daysToKeep: number = 45): Promise<number> {
        try {
            const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
            const result = await CandleModel.deleteMany({ candleTime: { $lt: cutoff } });
            if (result.deletedCount > 0) {
                tradingCronLogger.info(
                    `[CandleStorage] 🧹 Pruned ${result.deletedCount} old candles older than ${daysToKeep} days (before ${cutoff.toLocaleDateString('en-IN')})`
                );
            }
            return result.deletedCount;
        } catch (err: any) {
            tradingCronLogger.warn(`[CandleStorage] ⚠️ Failed to prune old candles: ${err.message}`);
            return 0;
        }
    }
}
