import { SyncStatus } from '../models/syncStatus.model';
import { TradeState } from '../models/tradeState.model';
import { BotError } from '../models/botError.model';
import { PayloadClient } from './payload.client';
import errorLogger from '../utils/errorLogger';

export class BulkSyncService {
    private static isSyncing = false;

    /**
     * Syncs latest PNL values for all active bots using DB-level aggregation streaming.
     */
    static async syncBotPnl() {
        const collectionKey = 'trading-bot-pnl';
        const now = new Date();

        let status = await SyncStatus.findOne({ collectionName: collectionKey });
        if (!status) {
            status = await SyncStatus.create({
                collectionName: collectionKey,
                lastSyncedAt: new Date(0)
            });
        }

        const lastSync = status.lastSyncedAt;

        // 🚀 Stream aggregation to avoid loading all stats into memory
        const cursor = TradeState.aggregate([
            {
                $match: {
                    updatedAt: { $gt: lastSync, $lte: now }
                }
            },
            {
                $sort: { updatedAt: -1 } // Latest first for each group
            },
            {
                $group: {
                    _id: "$tradingBotId",
                    allTimePnl: { $first: "$allTimePnl" },
                }
            }
        ]).cursor();

        const chunkSize = 1000;
        let batch: any[] = [];
        const syncPromises: Promise<any>[] = [];

        try {
            for await (const doc of cursor) {
                batch.push({
                    botId: doc._id,
                    allTimePnl: doc.allTimePnl
                });

                if (batch.length === chunkSize) {
                    syncPromises.push(PayloadClient.updatePnl([...batch]));
                    batch = [];
                }
            }

            if (batch.length > 0) {
                syncPromises.push(PayloadClient.updatePnl(batch));
            }

            // 🚀 Parallelize chunk updates to the backend
            await Promise.all(syncPromises);

            status.lastSyncedAt = now;
            await status.save();

            return syncPromises.length * chunkSize; // Approximation for logging

        } catch (err: any) {
            errorLogger.error('[BulkSync] PNL Sync Failed:', err);
            return 0;
        }
    }

    /**
     * Syncs full trade states with the backend using a high-performance cursor.
     */
    static async syncTradeStates() {
        const collectionKey = 'trade-states';
        const now = new Date();

        let status = await SyncStatus.findOne({ collectionName: collectionKey });
        if (!status) {
            status = await SyncStatus.create({
                collectionName: collectionKey,
                lastSyncedAt: new Date(0)
            });
        }

        const lastSync = status.lastSyncedAt;

        const cursor = TradeState.find({
            updatedAt: { $gt: lastSync, $lte: now }
        })
        .select({
            _id: 1,
            userId: 1,
            tradingBotId: 1,
            symbol: 1,
            side: 1,
            tradeOutcome: 1,
            entryPrice: 1,
            slPrice: 1,
            tpPrice: 1,
            quantity: 1,
            leverage: 1,
            pnl: 1,
            pnlPercentage: 1,
            riskRewardRatio: 1,
            tpPercentage: 1,
            slPercentage: 1,
            finalScore: 1,
            entryScore: 1,
            confirmationProbability: 1,
            structureProbability: 1,
            tradingMode: 1,
            exitPrice: 1,
            dailyPnl: 1,
            tradeAmountInUse: 1,
            breakoutTimeframe: 1,
            entryFilledAt: 1,
            createdAt: 1,
            updatedAt: 1
        })
        .lean()
        .cursor();

        const chunkSize = 500; // Smaller chunk for larger payloads
        let batch: any[] = [];
        const syncPromises: Promise<any>[] = [];
        let total = 0;

        try {
            for await (const doc of cursor) {
                batch.push({
                    tradeId: String(doc._id),
                    ...doc
                });
                total++;

                if (batch.length === chunkSize) {
                    syncPromises.push(PayloadClient.bulkUpsertTradeStates([...batch]));
                    batch = [];
                }
            }

            if (batch.length > 0) {
                syncPromises.push(PayloadClient.bulkUpsertTradeStates(batch));
            }

            // 🚀 Flush all chunks in parallel
            await Promise.all(syncPromises);

            status.lastSyncedAt = now;
            await status.save();

            return total;

        } catch (err: any) {
            errorLogger.error('[BulkSync] TradeStates Sync Failed:', err);
            return 0;
        }
    }

    /**
     * Syncs bot error states and activation status.
     */
    static async syncBotStates() {
        const collectionKey = 'bot-states';
        const now = new Date();

        let status = await SyncStatus.findOne({ collectionName: collectionKey });
        if (!status) {
            status = await SyncStatus.create({
                collectionName: collectionKey,
                lastSyncedAt: new Date(0)
            });
        }

        const lastSync = status.lastSyncedAt;

        const cursor = BotError.find({
            updatedAt: { $gt: lastSync, $lte: now }
        }).lean().cursor();

        const chunkSize = 1000;
        let batch: any[] = [];
        const syncPromises: Promise<any>[] = [];
        let total = 0;

        try {
            for await (const doc of cursor) {
                batch.push({
                    botId: doc.botId,
                    errorMessage: doc.message,
                    status: doc.status,
                    isActive: doc.isActive
                });
                total++;

                if (batch.length === chunkSize) {
                    syncPromises.push(PayloadClient.bulkUpdateBots([...batch]));
                    batch = [];
                }
            }

            if (batch.length > 0) {
                syncPromises.push(PayloadClient.bulkUpdateBots(batch));
            }

            await Promise.all(syncPromises);

            status.lastSyncedAt = now;
            await status.save();

            return total;

        } catch (err: any) {
            errorLogger.error('[BulkSync] BotStates Sync Failed:', err);
            return 0;
        }
    }

    /**
     * Executes all sync tasks in parallel with concurrency locking.
     */
    static async runFullSync() {
        if (this.isSyncing) {
            console.log('[BulkSync] Sync already in progress, skipping...');
            return;
        }

        this.isSyncing = true;
        const startTime = Date.now();

        try {
            // 🚀 Run all sync methods in parallel for maximum throughput
            const [pnlCount, tradeCount, stateCount] = await Promise.all([
                this.syncBotPnl(),
                this.syncTradeStates(),
                this.syncBotStates()
            ]);

            if (pnlCount > 0 || tradeCount > 0 || stateCount > 0) {
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                console.log(`[BulkSync] Success: ${pnlCount} PNL, ${tradeCount} trades, ${stateCount} bot states in ${duration}s`);
            }
        } catch (err) {
            errorLogger.error('[BulkSync] Critical Error:', err);
        } finally {
            this.isSyncing = false;
        }
    }
}