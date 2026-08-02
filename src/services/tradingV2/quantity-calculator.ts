import { ConfigType } from "./type";

export class QuantityCalculator {
    static convertTradeSizes(
        c: ConfigType,
        currentPrice: number,
        cronLogger: any,
        skipLogger: any
    ): boolean {
        // ───────────────── CONVERT USD TO LOTS ─────────────────
        if (c.MIN_TRADE_SIZE && currentPrice > 0) {
            const oldQty = c.INITIAL_BASE_QUANTITY;
            c.INITIAL_BASE_QUANTITY = Math.max(
                1,
                Math.floor((c.MIN_TRADE_SIZE * c.LEVERAGE) / (currentPrice * c.LOT_SIZE))
            );
            cronLogger.info(
                `[Config] Converted MIN_TRADE_SIZE margin ($${c.MIN_TRADE_SIZE}) to INITIAL_BASE_QUANTITY (${c.INITIAL_BASE_QUANTITY} lots) using ${c.LEVERAGE}x leverage. Previous: ${oldQty}`
            );
        }
        if (c.MAX_TRADE_SIZE && currentPrice > 0) {
            const oldMaxQty = c.MAX_QUANTITY;
            c.MAX_QUANTITY = Math.max(
                1,
                Math.floor((c.MAX_TRADE_SIZE * c.LEVERAGE) / (currentPrice * c.LOT_SIZE))
            );
            cronLogger.info(
                `[Config] Converted MAX_TRADE_SIZE margin ($${c.MAX_TRADE_SIZE}) to MAX_QUANTITY (${c.MAX_QUANTITY} lots) using ${c.LEVERAGE}x leverage. Previous: ${oldMaxQty}`
            );
        }

        cronLogger.info(
            `[Config] Quantities after conversion: INITIAL_BASE_QUANTITY = ${
                c.INITIAL_BASE_QUANTITY ?? "undefined"
            }, MAX_QUANTITY = ${c.MAX_QUANTITY ?? "undefined"}`
        );

        if (
            !c.INITIAL_BASE_QUANTITY ||
            c.INITIAL_BASE_QUANTITY <= 0 ||
            !c.MAX_QUANTITY ||
            c.MAX_QUANTITY <= 0
        ) {
            skipLogger.warn(
                `[SKIP] Trade not allowed: INITIAL_BASE_QUANTITY (${
                    c.INITIAL_BASE_QUANTITY
                }) or MAX_QUANTITY (${c.MAX_QUANTITY}) is invalid or missing.`
            );
            return false;
        }

        return true;
    }
}
