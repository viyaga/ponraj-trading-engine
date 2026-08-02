import { Router, Request, Response } from 'express';
import { TradingConfig } from '../services/tradingV2/config';
import { runTradingCycle } from '../services/tradingV2';
import { ConfigType } from '../services/tradingV2/type';
import { tradingCronLogger } from '../services/tradingV2/logger';

const router: Router = Router();

/**
 * POST /api/trading/trigger-cycle
 * 
 * Manually trigger the trading cycle with custom configuration.
 * 
 * Request Body:
 * {
 *   "config": {
 *     "USER_ID": "optional",
 *     "PRODUCT_ID": 3136,
 *     "SYMBOL": "ETHUSD",
 *     // ... any other ConfigType fields to override
 *   }
 * }
 * 
 * Response (Success):
 * {
 *   "success": true,
 *   "message": "Trading cycle executed successfully",
 *   "timestamp": "2026-02-03T16:03:01+05:30",
 *   "config": { ... }
 * }
 * 
 * Response (Failure):
 * {
 *   "success": false,
 *   "message": "Trading cycle execution failed",
 *   "timestamp": "2026-02-03T16:03:01+05:30",
 *   "error": "Error details",
 *   "config": { ... }
 * }
 */
router.post('/trigger-cycle', async (req: Request, res: Response) => {
    const timestamp = new Date().toISOString();

    try {
        // Extract config from request body
        const customConfig: Partial<ConfigType> = req.body.config || {};

        // Get base config and merge with custom config
        const baseConfig = TradingConfig.getConfig();
        const mergedConfig: ConfigType = {
            ...baseConfig,
            ...customConfig
        };

        tradingCronLogger.info(`[API] Manual trigger received at ${timestamp}`);
        tradingCronLogger.debug(`[API] Using config:`, {
            USER_ID: mergedConfig.USER_ID,
            PRODUCT_ID: mergedConfig.PRODUCT_ID,
            SYMBOL: mergedConfig.SYMBOL,
            TIMEFRAME: mergedConfig.TIMEFRAME
        });

        // Execute trading cycle with merged config in AsyncLocalStorage context
        await TradingConfig.configStore.run(mergedConfig, async () => {
            await runTradingCycle(mergedConfig);
        });

        // Return success response
        res.status(200).json({
            success: true,
            message: 'Trading cycle executed successfully',
            timestamp,
            config: {
                USER_ID: mergedConfig.USER_ID,
                PRODUCT_ID: mergedConfig.PRODUCT_ID,
                SYMBOL: mergedConfig.SYMBOL,
                TIMEFRAME: mergedConfig.TIMEFRAME,
                INITIAL_BASE_QUANTITY: mergedConfig.INITIAL_BASE_QUANTITY,
                DRY_RUN: mergedConfig.DRY_RUN
            }
        });

    } catch (error) {
        tradingCronLogger.error('[API] Error triggering trading cycle:', { error });

        // Return error response
        res.status(500).json({
            success: false,
            message: 'Trading cycle execution failed',
            timestamp,
            error: error instanceof Error ? error.message : String(error),
            config: req.body.config || {}
        });
    }
});

export default router;