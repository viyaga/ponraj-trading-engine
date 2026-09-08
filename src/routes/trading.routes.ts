// =============================================================================
// Trading Routes — Manual Trigger for Zerodha Kite Trading Cycle
// =============================================================================

import { Router, Request, Response } from 'express';
import { TradingConfig } from '../services/tradingV2/config';
import { TradingV2 } from '../services/tradingV2';
import { ConfigType } from '../services/tradingV2/type';
import { tradingCronLogger } from '../services/tradingV2/logger';
import { refreshConfigsOnDemand } from '../cron/trading-cycle.cron';
import { BulkSyncService } from '../services/bulkSync.service';

const router: Router = Router();

/**
 * POST /api/trading/trigger-cycle
 *
 * Manually trigger the trading cycle for a specific bot (testing/debugging).
 *
 * Request Body:
 * {
 *   "config": {
 *     "id": "botId",
 *     "USER_ID": "userId",
 *     "INDEX": "NIFTY",
 *     "API_KEY": "...",
 *     "ACCESS_TOKEN": "...",
 *     "DRY_RUN": true
 *   }
 * }
 */
router.post('/trigger-cycle', async (req: Request, res: Response) => {
    const timestamp = new Date().toISOString();

    try {
        const customConfig: Partial<ConfigType> = req.body.config || {};

        const mergedConfig = TradingConfig.buildConfig(customConfig);

        tradingCronLogger.info(`[API] Manual trigger at ${timestamp} | INDEX: ${mergedConfig.INDEX} | DRY_RUN: ${mergedConfig.DRY_RUN}`);

        await TradingConfig.configStore.run(mergedConfig, async () => {
            await TradingV2.runTradingCycle(mergedConfig);
        });

        res.status(200).json({
            success: true,
            message: 'Trading cycle executed successfully',
            timestamp,
            config: {
                id:        mergedConfig.id,
                USER_ID:   mergedConfig.USER_ID,
                INDEX:     mergedConfig.INDEX,
                DRY_RUN:   mergedConfig.DRY_RUN,
            },
        });

    } catch (error) {
        tradingCronLogger.error('[API] Manual trigger failed:', { error });

        res.status(500).json({
            success: false,
            message: 'Trading cycle execution failed',
            timestamp,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

/**
 * POST /api/trading/refresh-configs
 *
 * Forces an immediate cache invalidation and refresh of bot configurations
 * from the backend Payload CMS, updating the in-memory trigger thresholds.
 */
router.post('/refresh-configs', async (req: Request, res: Response) => {
    try {
        const configs = await refreshConfigsOnDemand();
        res.status(200).json({
            success: true,
            message: `Successfully refreshed ${configs.length} bot configuration(s)`,
            count: configs.length,
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Failed to refresh bot configurations',
            error: error.message,
        });
    }
});

/**
 * POST /api/trading/sync
 *
 * Manually force a full bulk synchronization with the backend.
 */
router.post('/sync', async (req: Request, res: Response) => {
    try {
        await BulkSyncService.runFullSync({ force: true });
        res.status(200).json({
            success: true,
            message: 'Full sync executed successfully',
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Bulk sync failed',
            error: error.message,
        });
    }
});

export default router;