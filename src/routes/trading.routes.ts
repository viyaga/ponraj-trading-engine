// =============================================================================
// Trading Routes — Manual Trigger for Zerodha Kite Trading Cycle
// =============================================================================

import { Router, Request, Response } from 'express';
import { TradingConfig } from '../services/tradingV2/config';
import { TradingV2 } from '../services/tradingV2';
import { ConfigType } from '../services/tradingV2/type';
import { tradingCronLogger } from '../services/tradingV2/logger';

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

export default router;