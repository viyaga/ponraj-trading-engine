import { ExchangeAdapterFactory } from "./adapters/exchange.factory";
import { ConfigType } from "./type";

export class LeverageManager {
    static async syncLeverage(c: ConfigType, logger: any): Promise<void> {
        logger.info(`[LeverageSync] Checking leverage for product ${c.PRODUCT_ID}...`);
        try {
            const adapter = ExchangeAdapterFactory.getAdapter();
            const leverageData = await adapter.getOrderLeverage(c.PRODUCT_ID);
            if (leverageData && leverageData.success && leverageData.result) {
                const currentLeverage = leverageData.result.leverage;
                logger.info(`[LeverageSync] Current leverage on Delta: ${currentLeverage}, Configured leverage: ${c.LEVERAGE}`);
                if (Number(currentLeverage) !== Number(c.LEVERAGE)) {
                    logger.info(`[LeverageSync] Leverage mismatch. Changing leverage to ${c.LEVERAGE}...`);
                    const changeRes = await adapter.changeOrderLeverage(c.PRODUCT_ID, c.LEVERAGE);
                    if (changeRes && changeRes.success) {
                        logger.info(`[LeverageSync] Leverage changed successfully to ${c.LEVERAGE}`);
                    } else {
                        throw new Error(`Failed to change leverage: ${JSON.stringify(changeRes)}`);
                    }
                } else {
                    logger.info(`[LeverageSync] Leverage is already set correctly to ${c.LEVERAGE}`);
                }
            } else {
                throw new Error(`Failed to retrieve leverage: ${JSON.stringify(leverageData)}`);
            }
        } catch (err: any) {
            logger.error(`[LeverageSync] Error during leverage sync: ${err.message || err}`);
            throw new Error(`Leverage sync failed: ${err.message || err}`);
        }
    }
}
