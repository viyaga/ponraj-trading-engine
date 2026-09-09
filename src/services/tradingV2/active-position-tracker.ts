import { TradeState, tradeStateEvents } from '../../models/tradeState.model';
import { tradingCronLogger } from './logger';

export class ActivePositionTracker {
    // In-memory cache of whether any bot has an 'open' or 'entry_pending' trade
    private static hasActivePositionsCached: boolean | null = null;
    private static activeCount: number = 0;
    private static isInitialized = false;

    /**
     * Initializes the in-memory tracker by reading MongoDB once on startup
     * and listening to TradeState change events.
     */
    public static async initialize(): Promise<void> {
        if (this.isInitialized) return;

        // Auto-invalidate cache whenever a trade document is saved, created, or closed
        tradeStateEvents.on('change', () => {
            tradingCronLogger.debug('[ActivePositionTracker] TradeState change event detected — invalidating in-memory position cache.');
            this.hasActivePositionsCached = null;
        });

        await this.refresh();
        this.isInitialized = true;
    }

    /**
     * Reconciles current active position count directly with MongoDB.
     */
    public static async refresh(): Promise<boolean> {
        try {
            this.activeCount = await TradeState.countDocuments({
                status: { $in: ['open', 'entry_pending'] },
            });
            this.hasActivePositionsCached = this.activeCount > 0;
            tradingCronLogger.debug(
                `[ActivePositionTracker] In-memory active position count refreshed: ${this.activeCount} (hasActive: ${this.hasActivePositionsCached})`
            );
            return this.hasActivePositionsCached;
        } catch (err: any) {
            tradingCronLogger.warn(`[ActivePositionTracker] Failed to query active positions from DB: ${err.message}`);
            // In case of transient DB error, fall back to true so monitoring safety checks run
            return true;
        }
    }

    /**
     * Ultra-fast in-memory check (< 0.0001ms).
     * If cached, returns immediately without making ANY MongoDB network calls.
     */
    public static async hasActivePositions(): Promise<boolean> {
        if (!this.isInitialized) {
            await this.initialize();
        }
        if (this.hasActivePositionsCached === null) {
            return await this.refresh();
        }
        return this.hasActivePositionsCached;
    }

    /**
     * Manually invalidate cache to force a fresh DB lookup on next check.
     */
    public static invalidate(): void {
        this.hasActivePositionsCached = null;
    }

    /**
     * Manually mark that an order has been entered.
     */
    public static markPositionOpened(): void {
        this.activeCount++;
        this.hasActivePositionsCached = true;
    }

    /**
     * Manually mark that an order has been closed or cancelled.
     */
    public static markPositionClosed(): void {
        if (this.activeCount > 0) this.activeCount--;
        this.hasActivePositionsCached = this.activeCount > 0;
    }
}
