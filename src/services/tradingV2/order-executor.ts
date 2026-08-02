import { ConfigType, OrderSide } from "./type";
import { BotError } from "../../models/botError.model";
import { TradeState } from "../../models/tradeState.model";
import { ExchangeAdapterFactory } from "./adapters/exchange.factory";
import { Utils } from "./utils";

export class OrderExecutor {
    static async placeTrade(
        c: ConfigType,
        state: any,
        side: OrderSide,
        mtf: any,
        cycleId: string,
        cronLogger: any,
        tradeLogger: any
    ): Promise<void> {
        const adapter = ExchangeAdapterFactory.getAdapter();
        const { id: tradingBotId, SYMBOL: symbol } = c;

        // ───────────────── QUANTITY ─────────────────
        const qty = c.IS_TESTING ? 1 : state.quantity;
        if (!qty) throw new Error("Quantity not found");

        if (qty && c.MAX_QUANTITY !== undefined && qty > c.MAX_QUANTITY) {
            const maxLossLimitStr = c.MAX_TRADE_SIZE
                ? `$${c.MAX_TRADE_SIZE}`
                : `${c.MAX_QUANTITY} lots`;
            const maxLossError = `Max Loss Crossed: Required trade size exceeds the configured Max Trade Size safety limit (${maxLossLimitStr}). Stopping bot to protect capital.`;
            cronLogger.error(
                `[Quantity] ${maxLossError} (Calculated Quantity: ${qty} lots, Max Quantity: ${c.MAX_QUANTITY} lots)`
            );

            // Stop the bot and set error message locally (will be synced to backend)
            await BotError.findOneAndUpdate(
                { botId: tradingBotId },
                {
                    message: maxLossError,
                    status: "stopped",
                    isActive: false,
                    updatedAt: new Date()
                },
                { upsert: true }
            );
            return;
        }

        cronLogger.info(`Quantity: ${qty} (IS_TESTING=${c.IS_TESTING})`);

        if (!qty || qty <= 0) {
            throw new Error("Invalid trade quantity");
        }

        // ───────────────── ENTRY ORDER ─────────────────
        tradeLogger.info(
            `[Trade] Placing ${side.toUpperCase()} entry order for ${qty} lots on ${symbol}...`
        );
        const entry = await adapter.placeEntryOrder(symbol, side, qty);

        cronLogger.info(
            `[Trade] Entry order response: success=${!!entry.result?.id}, OrderID=${
                entry.result?.id
            }, Status=${entry.result?.status}, AveragePrice=${entry.result?.average_fill_price}`
        );

        const entryPrice = Utils.resolveEntryPrice(entry);
        const tp = mtf.tp;
        const sl = mtf.sl;

        if (!tp || !sl) {
            cronLogger.error(`[Trade] INVALID TP/SL values generated: TP=${tp}, SL=${sl}`);
            throw new Error(`[Trade] Invalid TP/SL from MTF: TP=${tp}, SL=${sl}`);
        }

        tradeLogger.info(
            `Price levels - Entry: ${entryPrice}, TP: ${tp} (${mtf.tpPerc.toFixed(
                2
            )}%), TP Limit: ${mtf.tpLimit}, SL Trigger: ${sl} (${mtf.slPerc.toFixed(
                2
            )}%) (Market Order)`
        );

        // ───────────────── TP / SL ─────────────────
        const tpSlResult = await adapter.placeTPSLBracketOrder(tp, sl, side, {
            cycleId,
            tradingBotId
        }, entryPrice);

        if (!tpSlResult.success || !tpSlResult.ids.tp || !tpSlResult.ids.sl) {
            throw new Error(
                `[Trade] Failed to place TP/SL bracket orders after retries. TP_ID=${tpSlResult.ids.tp}, SL_ID=${tpSlResult.ids.sl}`
            );
        }

        cronLogger.info(
            `[Trade] TP/SL orders placed: TP_ID=${tpSlResult.ids.tp}, SL_ID=${tpSlResult.ids.sl}`
        );

        // ───────────────── UPDATE STATE ─────────────────
        tradeLogger.info(`[State] Updating trade state with order IDs and price levels...`);
        const updatedState = await TradeState.findOneAndUpdate(
            { tradingBotId: c.id, status: "open" },
            {
                $set: {
                    tradeOutcome: "pending",
                    entryOrderId: String(entry.result.id),
                    stopLossOrderId: String(tpSlResult.ids.sl),
                    takeProfitOrderId: String(tpSlResult.ids.tp),
                    entryPrice: entryPrice,
                    slPrice: sl,
                    tpPrice: tp,
                    quantity: qty,
                    currentLevel: state.currentLevel,
                    pnl: state.pnl,
                    cumulativeFees: state.cumulativeFees,
                    allTimePnl: state.allTimePnl,
                    allTimeFees: state.allTimeFees,
                    breakoutTimeframe: mtf.breakoutTimeframe || c.TIMEFRAME,
                    lastTradeSettledAt: new Date()
                }
            },
            { new: true }
        );

        if (!updatedState) {
            cronLogger.error(`[State] FAILED to update trade state for bot ${c.id}`);
            throw new Error("Failed to update trade state");
        }

        tradeLogger.info(
            `[State] Trade state updated successfully: Outcome=pending, Level=${updatedState.currentLevel}, BreakoutTF=${updatedState.breakoutTimeframe}`
        );

        tradeLogger.info(`✓ TRADE COMPLETED SUCCESSFULLY\n`);

        // ───────────────── CLEAR LOCAL ERROR ─────────────────
        // Mark the bot as error-free locally so it gets synced to clear on server
        // We also clear status/isActive so we don't accidentally overwrite backend state with old error status
        await BotError.findOneAndUpdate(
            { botId: tradingBotId },
            {
                message: "",
                status: "active",
                isActive: true,
                updatedAt: new Date()
            },
            { upsert: true }
        );
    }
}
