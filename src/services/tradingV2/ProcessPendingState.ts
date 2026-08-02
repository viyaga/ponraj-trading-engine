import { TradingV2 } from ".";
import { ITradeState, TradeState } from "../../models/tradeState.model";
import { TradingConfig } from "./config";
import { ExchangeAdapterFactory } from "./adapters/exchange.factory";
import { tradingCycleErrorLogger, tradesLogger, getContextualLogger } from "./logger";
import { Candle, OrderDetails, OrderSide, TargetCandle } from "./type";
import { Utils } from "./utils";
import { TripleTFResult } from "./market-detector/multi-timeframe";

export class ProcessPendingState {

    static calculateMartingaleLots(netDebt: number, currentPrice: number, multiplier: number): number {
        const c = TradingConfig.getConfig();
        const targetAmount = Math.abs(netDebt) * multiplier; // Dynamic multiplier based on MTF score
        const marginRequiredPerLot = (currentPrice * c.LOT_SIZE) / c.LEVERAGE;
        return (c.INITIAL_BASE_QUANTITY ?? 0) + Math.ceil(
            targetAmount / marginRequiredPerLot
        );
    }

    static calculateMetrics(entryPrice: number, tpPrice: number, slPrice: number, leverage: number) {
        if (!entryPrice || !tpPrice || !slPrice) return {};

        const c = TradingConfig.getConfig();
        const tpDist = Math.abs(tpPrice - entryPrice);
        const rawSlDist = Math.abs(entryPrice - slPrice);

        // 🔥 Include SL buffer in risk for accurate metrics
        const slDist = rawSlDist + (slPrice * c.SL_LIMIT_BUFFER_PERCENT / 100);

        // 🔥 Include Estimated Fees in RR (Net RR)
        const feePercent = (c as any).ESTIMATED_FEE_PERCENT / 100 || 0.001;
        const entryFee = entryPrice * (feePercent / 2);
        const exitFeeTp = tpPrice * (feePercent / 2);
        const exitFeeSl = slPrice * (feePercent / 2);

        const netReward = tpDist - (entryFee + exitFeeTp);
        const netRisk = slDist + (entryFee + exitFeeSl);

        return {
            tpPercentage: (tpDist / entryPrice) * 100,
            slPercentage: (slDist / entryPrice) * 100,
            riskRewardRatio: netRisk > 0 ? netReward / netRisk : 0
        };
    }

    /* =========================================================================
       CANDLE ANALYSIS UTILITIES
     ========================================================================= */

    static resetState(s: ITradeState): ITradeState {
        const c = TradingConfig.getConfig();
        return {
            ...s,
            currentLevel: 1,
            tradeOutcome: "none",
            entryOrderId: null,
            stopLossOrderId: null,
            takeProfitOrderId: null,
            entryPrice: null,
            slPrice: null,
            tpPrice: null,
            quantity: c.INITIAL_BASE_QUANTITY ?? 0,
            pnl: 0,
            cumulativeFees: 0,
            allTimePnl: s.allTimePnl || 0,
            allTimeFees: s.allTimeFees || 0,
            side: null,
            leverage: null,
            tradeAmountInUse: null,
            pnlPercentage: null,
            riskRewardRatio: null,
            tpPercentage: null,
            slPercentage: null,
            exitPrice: null,
            finalScore: null,
            entryScore: null,
            confirmationProbability: null,
            structureProbability: null,
            tradingMode: null,
            consecutiveLowMomentumCycles: 0,
            entryFilledAt: null,
        };
    }

    static async handleWin(
        s: ITradeState,
        winPnl: number,
        tempFees: number,
        incrementalPnl: number,
        incrementalFees: number,
        exitPrice: number,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradesLogger, logContext);
        logger.info(`[StateTransition] Outcome: WIN | Symbol: ${s.symbol} | Net PnL (Session): ${winPnl.toFixed(2)} | Total Fees (Session): ${tempFees.toFixed(2)}`);
        logger.info(`[StateTransition] WIN Details: Incremental PnL: ${incrementalPnl.toFixed(2)}, Incremental Fees: ${incrementalFees.toFixed(2)}`);

        const pnlPercentage = s.tradeAmountInUse ? (incrementalPnl / s.tradeAmountInUse) * 100 : 0;

        const updated = await TradeState.findByIdAndUpdate(s.id || (s as any)._id, {
            $set: {
                status: 'closed',
                tradeOutcome: "win",
                pnl: winPnl,
                cumulativeFees: tempFees,
                dailyPnl: (s.dailyPnl || 0) + incrementalPnl - incrementalFees,
                allTimePnl: (s.allTimePnl || 0) + incrementalPnl,
                allTimeFees: (s.allTimeFees || 0) + incrementalFees,
                lastTradeSettledAt: new Date(),
                exitPrice,
                pnlPercentage
            }
        }, { new: true });

        if (!updated) throw new Error("Failed to close trade state on win");
        return updated as ITradeState;
    }

    static async handleLoss(
        s: ITradeState,
        netDebt: number,
        pnl: number,
        fees: number,
        currentPrice: number,
        incrementalPnl: number,
        incrementalFees: number,
        multiplier: number,
        exitPrice: number,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradesLogger, logContext);

        const c = TradingConfig.getConfig();

        const pnlPercentage = s.tradeAmountInUse ? (incrementalPnl / s.tradeAmountInUse) * 100 : 0;

        const nextLevel = s.currentLevel + 1;
        logger.info(`[StateTransition] Outcome: LOSS | Symbol: ${s.symbol} | Net Debt: ${netDebt.toFixed(2)} | Next Level: ${nextLevel}`);
        logger.info(`[StateTransition] LOSS Details: Incremental PnL: ${incrementalPnl.toFixed(2)}, Incremental Fees: ${incrementalFees.toFixed(2)}`);

        const updated = await TradeState.findByIdAndUpdate(s.id || (s as any)._id, {
            $set: {
                status: 'closed',
                currentLevel: nextLevel,
                tradeOutcome: "loss",
                pnl,
                cumulativeFees: fees,
                dailyPnl: (s.dailyPnl || 0) + incrementalPnl - incrementalFees,
                allTimePnl: (s.allTimePnl || 0) + incrementalPnl,
                allTimeFees: (s.allTimeFees || 0) + incrementalFees,
                lastTradeSettledAt: new Date(),
                exitPrice,
                pnlPercentage
            }
        }, { new: true });

        if (!updated) throw new Error("Failed to update trade state on loss");
        return updated as ITradeState;
    }

    static async markCancelled(s: ITradeState): Promise<ITradeState> {
        const updated = await TradeState.findByIdAndUpdate(s.id || (s as any)._id, {
            $set: { tradeOutcome: "cancelled" }
        }, { new: true });

        if (!updated) throw new Error("Failed to update trade state to cancelled");
        return updated as ITradeState;
    }

    /* =========================================================================
        PENDING ORDER HANDLING
    ========================================================================= */

    private static async handleCanceledEntryOrder(s: ITradeState): Promise<ITradeState> {
        return this.markCancelled(s);
    }

    /* =========================================================================
        CLOSED POSITION OUTCOME
    ========================================================================= */

    static async processClosedPosition(
        s: ITradeState,
        entryCommission: number,
        currentPrice: number,
        multiplier: number,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradesLogger, logContext);

        if (!s.stopLossOrderId || !s.takeProfitOrderId) {
            logger.warn(`[PositionOutcome] Missing TP/SL order IDs for ${s.symbol} in state. Entry was CLOSED but bracket orders are unknown. Recovering status while PRESERVING trade metrics (Level, PnL, Fees).`);

            const updated = await TradeState.findByIdAndUpdate(
                s.id || (s as any)._id,
                {
                    $set: {
                        entryOrderId: null,
                        stopLossOrderId: null,
                        takeProfitOrderId: null,
                        tradeOutcome: "none",
                        cumulativeFees: s.cumulativeFees + entryCommission,
                        allTimeFees: (s.allTimeFees || 0) + entryCommission,
                    }
                },
                { new: true }
            );

            if (!updated) throw new Error("Failed to update trade state when bracket orders are missing");
            return updated as ITradeState;
        }

        const adapter = ExchangeAdapterFactory.getAdapter();
        const cfg = TradingConfig.getConfig();
        const tp = await adapter.getOrderDetails(s.takeProfitOrderId);
        if (tp && tp.status === "CLOSED") {
            const exitPrice = Number(tp.average_fill_price || tp.limit_price || 0);
            let incrementalPnl = Number(tp.meta_data?.pnl || 0);
            if (!incrementalPnl && exitPrice > 0 && s.entryPrice) {
                const qty = Number(s.quantity || 1);
                const isBuy = s.side === "buy";
                const priceDiff = isBuy ? exitPrice - s.entryPrice : s.entryPrice - exitPrice;
                incrementalPnl = priceDiff * qty * cfg.LOT_SIZE;
            }
            const incrementalFees = Number(tp.paid_commission || 0) + entryCommission;
            const netPnl = s.pnl + incrementalPnl;
            const fees = s.cumulativeFees + incrementalFees;
            const netDebt = netPnl - fees;

            logger.info(`[PositionOutcome] TAKE PROFIT reached for ${s.symbol}. Incremental PnL: ${incrementalPnl.toFixed(4)}, Fees: ${incrementalFees.toFixed(4)}, Exit Price: ${exitPrice}, Net Debt: ${netDebt.toFixed(4)}`);

            return netDebt >= 0
                ? await this.handleWin(s, netPnl, fees, incrementalPnl, incrementalFees, exitPrice, logContext)
                : await this.handleLoss(s, netDebt, netPnl, fees, currentPrice, incrementalPnl, incrementalFees, multiplier, exitPrice, logContext);
        }

        const sl = await adapter.getOrderDetails(s.stopLossOrderId);
        if (sl && sl.status === "CLOSED") {
            const exitPrice = Number(sl.average_fill_price || sl.limit_price || 0);
            let incrementalPnl = Number(sl?.meta_data?.pnl || 0);
            if (!incrementalPnl && exitPrice > 0 && s.entryPrice) {
                const qty = Number(s.quantity || 1);
                const isBuy = s.side === "buy";
                const priceDiff = isBuy ? exitPrice - s.entryPrice : s.entryPrice - exitPrice;
                incrementalPnl = priceDiff * qty * cfg.LOT_SIZE;
            }
            const incrementalFees = Number(sl?.paid_commission || 0) + entryCommission;
            const netPnl = s.pnl + incrementalPnl;
            const fees = s.cumulativeFees + incrementalFees;
            const netDebt = netPnl - fees;

            logger.info(`[PositionOutcome] STOP LOSS hit for ${s.symbol}. Incremental PnL: ${incrementalPnl.toFixed(4)}, Fees: ${incrementalFees.toFixed(4)}, Exit Price: ${exitPrice}, Net Debt: ${netDebt.toFixed(4)}`);

            return netDebt >= 0
                ? await this.handleWin(s, netPnl, fees, incrementalPnl, incrementalFees, exitPrice, logContext)
                : await this.handleLoss(s, netDebt, netPnl, fees, currentPrice, incrementalPnl, incrementalFees, multiplier, exitPrice, logContext);
        }

        if (tp?.status === "CANCELLED" && sl?.status === "CANCELLED") {
            const logger = getContextualLogger(tradesLogger, logContext);
            logger.warn("TP and SL orders were cancelled by user. Treating as LOSS.");

            const incrementalPnl = 0;
            const incrementalFees = entryCommission;
            const netPnl = s.pnl;
            const fees = s.cumulativeFees + incrementalFees;
            const netDebt = netPnl - fees;
            const exitPrice = currentPrice;
            return await this.handleLoss(s, netDebt, netPnl, fees, currentPrice, incrementalPnl, incrementalFees, multiplier, exitPrice, logContext);
        }

        throw new Error("[processClosedPosition] Neither TP nor SL orders are filled/closed.");
    }

    static async placeCancelledBracketOrders(
        state: ITradeState,
        e: OrderDetails,
        sl: number,
        logContext?: any,
        forceReplace: boolean = false
    ): Promise<ITradeState> {
        const adapter = ExchangeAdapterFactory.getAdapter();
        if (!forceReplace) {
            const slOrder = await adapter.getOrderDetails(
                state.stopLossOrderId!
            );

            if (slOrder?.status !== "CANCELLED") {
                throw new Error("SL update failed");
            }
        }

        const cancelRes = await adapter.cancelStopOrders({
            product_id: TradingConfig.getConfig().PRODUCT_ID,
            cancel_limit_orders: true,
        });
        getContextualLogger(tradesLogger, logContext).debug("Cancelled existing stop orders during bracket replacement", { cancelRes });

        const entryPriceValue = Number(e.average_fill_price ?? e.meta_data?.entry_price ?? 0);

        if (!entryPriceValue) {
            throw new Error("Entry price not found");
        }

        let tp = state.tpPrice;
        if (!tp) {
            const c = TradingConfig.getConfig();
            const side = e.side || state.side || "buy";
            const isBuy = side.toLowerCase() === "buy";

            const minTpPerc = c.MIN_TP_PRICE_MOVEMENT_PERCENT ?? 0.5;
            const maxTpPerc = c.MAX_TP_PRICE_MOVEMENT_PERCENT ?? 3.0;
            const tpPercent = (minTpPerc + maxTpPerc) / 2;

            let baseTp: number;
            if (isBuy) {
                baseTp = entryPriceValue * (1 + tpPercent / 100);
            } else {
                baseTp = entryPriceValue * (1 - tpPercent / 100);
            }

            const tpTriggerFactor = 1 - (isBuy ? c.TP_TRIGGER_BUFFER_PERCENT : -c.TP_TRIGGER_BUFFER_PERCENT) / 100;
            tp = baseTp * tpTriggerFactor;

            if (tp <= 0) {
                tp = parseFloat((1 / Math.pow(10, c.PRICE_DECIMAL_PLACES)).toFixed(c.PRICE_DECIMAL_PLACES));
            } else {
                tp = parseFloat(tp.toFixed(c.PRICE_DECIMAL_PLACES));
            }

            getContextualLogger(tradesLogger, logContext).warn(
                `[placeCancelledBracketOrders] TP price was missing in state. Recalculated dynamic fallback TP: ${tp} using entryPrice: ${entryPriceValue}, side: ${side}, dynamic tpPercent: ${tpPercent.toFixed(4)}%`
            );
        }

        const bracketRes =
            await ExchangeAdapterFactory.getAdapter().placeTPSLBracketOrder(tp, sl, e.side, logContext, entryPriceValue);

        if (!bracketRes.success) {
            if (bracketRes.isNoPosition) {
                getContextualLogger(tradesLogger, logContext).warn(`[Recovery] Bracket order placement failed because position is already closed. Skipping recovery.`);
                return state;
            }
            throw new Error("TP/SL placement failed");
        }

        const metrics = this.calculateMetrics(entryPriceValue, tp, sl, TradingConfig.getConfig().LEVERAGE);

        const updated = await TradeState.findOneAndUpdate(
            {
                tradingBotId: state.tradingBotId,
                userId: state.userId,
                symbol: state.symbol,
                status: "open",
            },
            {
                $set: {
                    slPrice: sl,
                    tpPrice: tp,
                    stopLossOrderId: bracketRes.ids.sl,
                    takeProfitOrderId: bracketRes.ids.tp,
                    ...metrics
                },
            },
            { new: true }
        );

        if (!updated) {
            throw new Error("Trade state not found");
        }

        return updated as ITradeState;
    }

    static async updateStatePrices(
        state: ITradeState,
        sl: number,
        tp: number
    ): Promise<ITradeState> {
        const metrics = state.entryPrice
            ? this.calculateMetrics(state.entryPrice, tp, sl, state.leverage || TradingConfig.getConfig().LEVERAGE)
            : {};

        const updated = await TradeState.findOneAndUpdate(
            {
                tradingBotId: state.tradingBotId,
                status: 'open',
            },
            { $set: { slPrice: sl, tpPrice: tp, ...metrics } },
            { new: true }
        );

        if (!updated) {
            throw new Error("Trade state not found");
        }

        return updated as ITradeState;
    }

    static async manageOpenPosition(
        sym: string,
        s: ITradeState,
        e: OrderDetails,
        mtf: TripleTFResult,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradesLogger, logContext);
        try {
            let slPrice = s.slPrice;
            let tpPrice = s.tpPrice;

            logger.info(`[PriceTrailing] Managing open position for ${sym} | State SL: ${slPrice}, State TP: ${tpPrice} | Target SL: ${mtf.sl}, Target TP: ${mtf.tp}`);

            // 🔍 Query TP and SL order details to check if either was manually cancelled
            const adapter = ExchangeAdapterFactory.getAdapter();
            const slOrder = s.stopLossOrderId ? await adapter.getOrderDetails(s.stopLossOrderId) : null;
            const tpOrder = s.takeProfitOrderId ? await adapter.getOrderDetails(s.takeProfitOrderId) : null;

            // 🔥 Recovery & Sync: Ensure DB state matches the actual active order prices on the exchange
            if (slOrder) {
                const stopPriceVal = slOrder.stop_price ? Number(slOrder.stop_price) : (slOrder.limit_price ? Number(slOrder.limit_price) : 0);
                if (stopPriceVal && slPrice !== stopPriceVal) {
                    logger.info(`[Recovery/Sync] Syncing slPrice for ${sym} to actual exchange order price: ${stopPriceVal} (was ${slPrice})`);
                    slPrice = stopPriceVal;
                    await TradeState.findByIdAndUpdate(s.id || (s as any)._id, { $set: { slPrice } });
                    s.slPrice = slPrice;
                }
            }

            if (tpOrder) {
                const limitPriceVal = tpOrder.limit_price ? Number(tpOrder.limit_price) : (tpOrder.stop_price ? Number(tpOrder.stop_price) : 0);
                if (limitPriceVal && tpPrice !== limitPriceVal) {
                    logger.info(`[Recovery/Sync] Syncing tpPrice for ${sym} to actual exchange order price: ${limitPriceVal} (was ${tpPrice})`);
                    tpPrice = limitPriceVal;
                    await TradeState.findByIdAndUpdate(s.id || (s as any)._id, { $set: { tpPrice } });
                    s.tpPrice = tpPrice;
                }
            }

            if (!s.stopLossOrderId || !slPrice) throw new Error("SL order or price missing in state");

            const isSlCancelled = !slOrder || slOrder.status === "CANCELLED";
            const isTpCancelled = s.takeProfitOrderId && (!tpOrder || tpOrder.status === "CANCELLED");

            if (isSlCancelled || isTpCancelled) {
                logger.warn(`[Recovery] Detected manually cancelled TP/SL order for ${sym} (SL Cancelled: ${isSlCancelled}, TP Cancelled: ${isTpCancelled}). Re-placing bracket orders...`);
                return this.placeCancelledBracketOrders(s, e, slPrice, logContext, true);
            }

            const isTrailingSlEnabled = TradingConfig.getConfig().IS_TRAILING_SL_ENABLED ?? true;
            const isTpReductionEnabled = TradingConfig.getConfig().IS_TP_REDUCTION_ENABLED ?? false;
            const sl = isTrailingSlEnabled ? mtf.sl : slPrice;
            let tp = tpPrice || mtf.tp;

            if (isTpReductionEnabled && mtf.tp && tpPrice) {
                const isBuy = e.side === "buy";
                const isTargetReduced = isBuy ? mtf.tp < tpPrice : mtf.tp > tpPrice;
                if (isTargetReduced) {
                    const minTpPerc = TradingConfig.getConfig().MIN_TP_PRICE_MOVEMENT_PERCENT ?? 0.4;
                    const entryPrice = s.entryPrice || 0;
                    let safeReducedTp = mtf.tp;

                    if (entryPrice > 0) {
                        const minProfitDist = entryPrice * (minTpPerc / 100);
                        const minAllowedTp = isBuy ? entryPrice + minProfitDist : entryPrice - minProfitDist;
                        if (isBuy && safeReducedTp < minAllowedTp) {
                            safeReducedTp = minAllowedTp;
                        } else if (!isBuy && safeReducedTp > minAllowedTp) {
                            safeReducedTp = minAllowedTp;
                        }
                    }

                    const decimals = TradingConfig.getConfig().PRICE_DECIMAL_PLACES || 4;
                    safeReducedTp = parseFloat(safeReducedTp.toFixed(decimals));

                    if (isBuy ? safeReducedTp < tpPrice : safeReducedTp > tpPrice) {
                        logger.info(`[PriceTrailing] Dynamic TP reduction enabled for ${sym}. Lowering target TP from ${tpPrice} to ${safeReducedTp}`);
                        tp = safeReducedTp;
                    }
                }
            }

            let updateRes = { success: false, slPrice: slPrice, isSlSame: true, isSlReversed: false, isAlreadyTriggered: false };
            if (isTrailingSlEnabled) {
                const slUpdate = await adapter.updateStopLossOrder(
                    s.stopLossOrderId,
                    slPrice,
                    TradingConfig.getConfig().PRODUCT_ID,
                    sym,
                    e.side,
                    sl,
                    logContext
                );
                updateRes = {
                    success: slUpdate.success,
                    slPrice: slUpdate.slPrice,
                    isSlSame: slUpdate.isSlSame ?? false,
                    isSlReversed: slUpdate.isSlReversed ?? false,
                    isAlreadyTriggered: slUpdate.isAlreadyTriggered ?? false
                };
            } else {
                logger.info(`[PriceTrailing] Trailing stop loss is disabled for ${sym}. Skipping stop-loss update.`);
            }

            let tpUpdatedValue = tpPrice || 0;
            let isTpAlreadyTriggered = false;
            if (s.takeProfitOrderId && tpPrice && tp) {
                const updateTpRes = await adapter.updateTakeProfitOrder(
                    s.takeProfitOrderId,
                    tpPrice,
                    TradingConfig.getConfig().PRODUCT_ID,
                    sym,
                    e.side,
                    tp,
                    logContext
                );
                if (updateTpRes.success) {
                    tpUpdatedValue = updateTpRes.tpPrice;
                } else if (updateTpRes.isAlreadyTriggered) {
                    isTpAlreadyTriggered = true;
                }
            }

            if (!updateRes.success && updateRes.isAlreadyTriggered) {
                logger.warn(`Stop loss order for ${sym} is already triggered. Skipping trailing updates.`);
                return s;
            }

            if (isTpAlreadyTriggered) {
                logger.warn(`Take profit order for ${sym} is already triggered. Skipping trailing updates.`);
                return s;
            }

            if (!updateRes.success && updateRes.isSlSame && tpUpdatedValue === tpPrice) {
                logger.info(`[PriceTrailing] SL and TP unchanged for ${sym}. Skipping update.`);
                return s;
            }
            if (!updateRes.success && updateRes.isSlReversed) {
                logger.info(`[PriceTrailing] SL update skipped for ${sym} (new SL would move in reverse/wrong direction).`);
                return s;
            }

            if (!updateRes.success && !updateRes.isSlSame && !updateRes.isSlReversed) {
                logger.warn(`[PriceTrailing] SL update failed for ${sym} (not same/reversed). Re-placing bracket orders...`);
                return this.placeCancelledBracketOrders(s, e, sl, logContext);
            }

            const updated = await this.updateStatePrices(s, updateRes.slPrice, tpUpdatedValue || tpPrice || 0);

            if (!updated) throw new Error("Trade state not found");

            logger.info(`[PriceTrailing] Successfully updated SL/TP for ${sym}: SL=${updateRes.slPrice}, TP=${tpUpdatedValue}`);

            return updated as ITradeState;

        } catch (err) {
            logger.error("Error in manageOpenPosition", { error: err });
            throw err;
        }
    }


    static async recoverMissingBracketOrders(
        s: ITradeState,
        e: OrderDetails,
        mtf: TripleTFResult,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradesLogger, logContext);
        logger.info(`[Recovery] Detected open position for ${s.symbol} but missing TP/SL IDs in state. Re-placing bracket orders...`);

        // Use existing prices from state if available, otherwise fallback to MTF
        const tp = s.tpPrice || mtf.tp;
        const sl = s.slPrice || mtf.sl;

        if (!tp || !sl) {
            throw new Error(`[Recovery] Invalid TP/SL during recovery: TP=${tp}, SL=${sl}`);
        }

        const entryPrice = Utils.resolveEntryPrice(e);
        const tpSlResult = await ExchangeAdapterFactory.getAdapter().placeTPSLBracketOrder(tp, sl, e.side, logContext, entryPrice);

        if (!tpSlResult.success || !tpSlResult.ids.tp || !tpSlResult.ids.sl) {
            throw new Error(`[Recovery] Failed to re-place TP/SL bracket orders during recovery. TP_ID=${tpSlResult.ids.tp}, SL_ID=${tpSlResult.ids.sl}`);
        }

        const updated = await TradeState.findOneAndUpdate(
            { tradingBotId: s.tradingBotId, userId: s.userId, symbol: s.symbol, status: "open" },
            {
                $set: {
                    stopLossOrderId: tpSlResult.ids.sl,
                    takeProfitOrderId: tpSlResult.ids.tp,
                    slPrice: sl,
                    tpPrice: tp
                }
            },
            { new: true }
        );

        if (!updated) throw new Error("[Recovery] Failed to update state after bracket recovery");

        logger.info(`[Recovery] Successfully re-placed TP/SL bracket orders: TP_ID=${tpSlResult.ids.tp}, SL_ID=${tpSlResult.ids.sl}`);

        return updated as ITradeState;
    }

    static async processStateOfPendingTrade(
        sym: string,
        state: ITradeState,
        order: OrderDetails,
        mtf: TripleTFResult,
        currentPrice: number,
        multiplier: number,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradingCycleErrorLogger, logContext);
        try {

            switch (order.status.toUpperCase()) {
                case "CANCELLED":
                    return await this.handleCanceledEntryOrder(state);
                case "CLOSED":
                    return await this.handleClosedEntryOrder(sym, state, order, mtf, currentPrice, multiplier, logContext);
                default:
                    return state;
            }

        } catch (err) {
            logger.error("Error in processStateOfPendingTrade", { error: err });
            throw err;
        }
    }

    static async evaluateCandleLimitAndReversal(
        sym: string,
        s: ITradeState,
        e: OrderDetails,
        mtf: TripleTFResult,
        currentPrice: number,
        logContext?: any
    ): Promise<{ shouldExit: boolean; reason: string }> {
        const logger = getContextualLogger(tradesLogger, logContext);
        const cfg = TradingConfig.getConfig();

        if (!cfg.IS_CANDLE_LIMIT_EXIT_ENABLED) {
            return { shouldExit: false, reason: "Candle limit exit disabled" };
        }

        // 1. Determine breakout timeframe (fallback to entry TIMEFRAME if not recorded)
        const breakoutTf = s.breakoutTimeframe || mtf.breakoutTimeframe || cfg.TIMEFRAME || "5m";
        const maxCandlesMap = cfg.MAX_HOLDING_CANDLES_MAP || { "5m": 12, "15m": 8, "1h": 6, "4h": 4 };
        const maxAllowedCandles = maxCandlesMap[breakoutTf] ?? 12;

        // 2. Calculate elapsed holding time & candle count using entryFilledAt (or entry order timestamp / Date.now() as fallback)
        const fillTimeMs = s.entryFilledAt
            ? new Date(s.entryFilledAt).getTime()
            : e.created_at
                ? new Date(e.created_at).getTime()
                : e.updated_at
                    ? new Date(e.updated_at).getTime()
                    : Date.now();
        const tfDurationMs = Utils.getTimeframeDurationMs(breakoutTf);
        const elapsedMs = Date.now() - fillTimeMs;
        const elapsedCandles = Math.floor(elapsedMs / tfDurationMs);

        logger.info(
            `[CandleLimitCheck] ${sym} | Breakout TF: ${breakoutTf} | Elapsed: ${elapsedCandles} candles (${(elapsedMs / 60000).toFixed(1)} mins) | ` +
            `Limits: Normal=${maxAllowedCandles} candles, HardCap=${maxAllowedCandles * 2} candles | ` +
            `Filled At: ${s.entryFilledAt ? new Date(s.entryFilledAt).toISOString() : (s.createdAt ? new Date(s.createdAt).toISOString() : "now")}`
        );

        // 3. HARD SAFETY CAP: If position reaches 2x max candles, force exit regardless of profit to prevent stagnation
        const hardMaxCandles = maxAllowedCandles * 2;
        if (elapsedCandles >= hardMaxCandles) {
            const hardCapReason = `Absolute hard holding limit reached on ${breakoutTf} (Elapsed: ${elapsedCandles} candles / ${(elapsedMs / 60000).toFixed(0)} mins | Hard Cap: ${hardMaxCandles} candles | Normal Limit: ${maxAllowedCandles} candles)`;
            logger.warn(`[CandleLimitExit] HARD CAP EXCEEDED for ${sym} | Reason: ${hardCapReason}`);
            return { shouldExit: true, reason: hardCapReason };
        }

        if (elapsedCandles < maxAllowedCandles) {
            return { shouldExit: false, reason: `Elapsed candles (${elapsedCandles}) within limit (${maxAllowedCandles})` };
        }

        // 4. Candle limit reached -> Check if market has REVERSED, lost momentum, or score decayed
        const posSide = e.side; // "buy" or "sell"
        const entryPrice = s.entryPrice || Number(e.average_fill_price || e.limit_price || currentPrice);
        const mtfDirection = mtf.direction; // "BUY", "SELL", or "NONE"

        let isReversalDetected = false;
        let reversalReason = "";

        // Check A: Price Reversal
        if (posSide === "buy") {
            if (currentPrice < entryPrice) {
                isReversalDetected = true;
                reversalReason = `Mark price (${currentPrice}) dropped below entry price (${entryPrice}) after ${elapsedCandles} candles on ${breakoutTf}`;
            } else if (mtfDirection === "SELL") {
                isReversalDetected = true;
                reversalReason = `MTF signal flipped to SELL after ${elapsedCandles} candles on ${breakoutTf}`;
            }
        } else if (posSide === "sell") {
            if (currentPrice > entryPrice) {
                isReversalDetected = true;
                reversalReason = `Mark price (${currentPrice}) rose above entry price (${entryPrice}) after ${elapsedCandles} candles on ${breakoutTf}`;
            } else if (mtfDirection === "BUY") {
                isReversalDetected = true;
                reversalReason = `MTF signal flipped to BUY after ${elapsedCandles} candles on ${breakoutTf}`;
            }
        }

        if (isReversalDetected) {
            logger.warn(`[CandleLimitExit] REVERSAL DETECTED for ${sym} (${posSide.toUpperCase()}) | Reason: ${reversalReason}`);
            return { shouldExit: true, reason: reversalReason };
        }

        logger.info(`[CandleLimitCheck] ${sym} (${posSide.toUpperCase()}) | Max candles (${maxAllowedCandles}) reached, but trade is moving in favorable direction. Position maintained.`);
        return { shouldExit: false, reason: "Trade in favorable direction" };
    }

    static async executeCandleLimitExit(
        s: ITradeState,
        e: OrderDetails,
        currentPrice: number,
        multiplier: number,
        reason: string,
        logContext?: any
    ): Promise<ITradeState> {
        const logger = getContextualLogger(tradesLogger, logContext);
        const cfg = TradingConfig.getConfig();
        const adapter = ExchangeAdapterFactory.getAdapter();

        logger.info(`[CandleLimitExit] Executing market close for ${s.symbol} due to candle limit reversal. Reason: ${reason}`);

        try {
            await adapter.cancelStopOrders({
                product_id: cfg.PRODUCT_ID,
                cancel_limit_orders: true,
            });
            logger.info(`[CandleLimitExit] Cancelled open TP/SL orders for ${s.symbol}`);
        } catch (err) {
            logger.warn(`[CandleLimitExit] Error cancelling bracket orders: ${err}`);
        }

        const exitSide: OrderSide = e.side === "buy" ? "sell" : "buy";
        const qty = Number(s.quantity || e.size || 1);

        let exitCommission = 0;
        let exitPrice = currentPrice;

        try {
            const exitOrder = await adapter.placeEntryOrder(s.symbol, exitSide, qty);

            if (exitOrder && exitOrder.result) {
                exitPrice = Number(exitOrder.result.average_fill_price || currentPrice);
                exitCommission = Number(exitOrder.result.paid_commission || 0);
            }
            logger.info(`[CandleLimitExit] Market exit order executed for ${s.symbol}. Exit Price: ${exitPrice}, Commission: ${exitCommission}`);
        } catch (err) {
            logger.error(`[CandleLimitExit] Failed to execute market exit order for ${s.symbol}: ${err}`);
        }

        const entryCommission = Number(e.paid_commission || 0);
        const incrementalFees = entryCommission + exitCommission;
        const totalFees = s.cumulativeFees + incrementalFees;
        const entryPrice = Number(e.average_fill_price || e.limit_price || s.entryPrice || currentPrice);

        const isBuy = e.side === "buy";
        const priceDiff = isBuy ? exitPrice - entryPrice : entryPrice - exitPrice;
        const rawPnl = (priceDiff * qty * cfg.LOT_SIZE);
        const netPnl = s.pnl + rawPnl;
        const netDebt = netPnl - totalFees;

        logger.info(`[CandleLimitExit] Trade outcome calculated for ${s.symbol}: Raw PnL: ${rawPnl.toFixed(4)}, Total Fees: ${totalFees.toFixed(4)}, Net Debt/PnL: ${netDebt.toFixed(4)}, Outcome: ${netDebt >= 0 ? "WIN" : "LOSS"}`);

        return netDebt >= 0
            ? await this.handleWin(
                s,
                netPnl,
                totalFees,
                rawPnl,
                incrementalFees,
                exitPrice,
                logContext
            )
            : await this.handleLoss(
                s,
                netDebt,
                netPnl,
                totalFees,
                exitPrice,
                rawPnl,
                incrementalFees,
                multiplier,
                exitPrice,
                logContext
            );
    }

    static async handleClosedEntryOrder(
        sym: string,
        s: ITradeState,
        e: OrderDetails,
        mtf: TripleTFResult,
        currentPrice: number,
        multiplier: number,
        logContext?: any
    ): Promise<ITradeState> {
        const cfg = TradingConfig.getConfig();
        const positions = await ExchangeAdapterFactory.getAdapter().getPositions(cfg.PRODUCT_ID);
        const hasOpenPosition = Array.isArray(positions)
            ? positions.some(p => Number(p.size) !== 0)
            : positions && Number(positions.size) !== 0;

        const cronLogger = getContextualLogger(tradesLogger, logContext);
        cronLogger.info(`[PendingState] Checking for open positions for ${sym}. hasOpenPosition: ${hasOpenPosition}`);
        if (!hasOpenPosition) {
            cronLogger.debug(`[PendingState] No open positions found for ${sym}. Raw positions data: ${JSON.stringify(positions)}`);
        }

        if (hasOpenPosition) {
            const entryPrice = Number(e.average_fill_price || e.limit_price || 0);
            const tradeAmountInUse = (Number(s.quantity || 0) * cfg.LOT_SIZE * entryPrice) / cfg.LEVERAGE;

            const tpPrice = s.tpPrice || null;
            const slPrice = s.slPrice || null;

            const metrics = this.calculateMetrics(entryPrice, s.tpPrice || mtf.tp, s.slPrice || mtf.sl, cfg.LEVERAGE);

            // 🔥 MOMENTUM INVALIDATION CHECK (2-3 consecutive cycles of weak scores)
            const isMomentumExitEnabled = cfg.IS_MOMENTUM_INVALIDATION_EXIT_ENABLED ?? true;
            const scoreThresh = cfg.MOMENTUM_INVALIDATION_SCORE_THRESHOLD ?? 20;
            const confThresh = cfg.MOMENTUM_INVALIDATION_CONFIRMATION_THRESHOLD ?? 40;
            const structThresh = cfg.MOMENTUM_INVALIDATION_STRUCTURE_THRESHOLD ?? 15;
            const maxLowCycles = cfg.MOMENTUM_INVALIDATION_CONSECUTIVE_CYCLES ?? 2;

            const isScoreWeak =
                mtf.finalScore < scoreThresh &&
                mtf.confirmationProbability < confThresh &&
                mtf.structureProbability < structThresh;

            const lowMomentumCycles = isScoreWeak ? (s.consecutiveLowMomentumCycles || 0) + 1 : 0;

            if (isMomentumExitEnabled && isScoreWeak) {
                cronLogger.warn(
                    `[MomentumInvalidationCheck] ${sym} | Weak scores detected (${lowMomentumCycles}/${maxLowCycles} consecutive cycles) | ` +
                    `FinalScore: ${mtf.finalScore} (below ${scoreThresh}), ConfProb: ${mtf.confirmationProbability} (below ${confThresh}), StructProb: ${mtf.structureProbability} (below ${structThresh})`
                );
            } else if (s.consecutiveLowMomentumCycles && s.consecutiveLowMomentumCycles > 0 && !isScoreWeak) {
                cronLogger.info(`[MomentumInvalidationCheck] ${sym} | Momentum recovered (FinalScore: ${mtf.finalScore}). Resetting consecutive low momentum count to 0.`);
            }

            const updateData: any = {
                side: e.side,
                leverage: cfg.LEVERAGE,
                entryPrice,
                tradeAmountInUse,
                finalScore: mtf.finalScore,
                entryScore: mtf.entryScore,
                confirmationProbability: mtf.confirmationProbability,
                structureProbability: mtf.structureProbability,
                tradingMode: cfg.TRADING_MODE,
                consecutiveLowMomentumCycles: lowMomentumCycles,
                ...metrics
            };

            if (tpPrice !== null) updateData.tpPrice = tpPrice;
            if (slPrice !== null) updateData.slPrice = slPrice;
            if (!s.entryFilledAt) {
                const entryFillTime = e.created_at ? new Date(e.created_at) : (e.updated_at ? new Date(e.updated_at) : new Date());
                s.entryFilledAt = entryFillTime;
                updateData.entryFilledAt = entryFillTime;
            }

            // 🔥 MOMENTUM INVALIDATION EXIT TRIGGER
            if (isMomentumExitEnabled && lowMomentumCycles >= maxLowCycles) {
                const exitReason = `Persistent Momentum Invalidation: Scores below threshold (FinalScore below ${scoreThresh}, ConfProb below ${confThresh}, StructProb below ${structThresh}) for ${lowMomentumCycles} consecutive cycles`;
                cronLogger.warn(`[MomentumInvalidationExit] TRIGGERED EXIT for ${sym} | ${exitReason}`);
                await TradeState.findByIdAndUpdate(s.id || (s as any)._id, { $set: updateData });
                return this.executeCandleLimitExit(s, e, currentPrice, multiplier, exitReason, logContext);
            }

            // 🔥 CANDLE LIMIT & REVERSAL EXIT CHECK
            const limitCheck = await this.evaluateCandleLimitAndReversal(sym, s, e, mtf, currentPrice, logContext);
            if (limitCheck.shouldExit) {
                await TradeState.findByIdAndUpdate(s.id || (s as any)._id, { $set: updateData });
                return this.executeCandleLimitExit(s, e, currentPrice, multiplier, limitCheck.reason, logContext);
            }

            // Optimization: Only update if anything meaningful changed
            const isUnchanged =
                s.entryPrice === entryPrice &&
                s.tradeAmountInUse === tradeAmountInUse &&
                s.finalScore === mtf.finalScore &&
                s.tpPrice === (s.tpPrice || mtf.tp) &&
                s.slPrice === (s.slPrice || mtf.sl) &&
                (s.consecutiveLowMomentumCycles || 0) === lowMomentumCycles;

            if (isUnchanged && (s.stopLossOrderId && s.takeProfitOrderId)) {
                cronLogger.info(`[PendingState] Core state unchanged for ${sym}, proceeding to manage open position (trailing).`);
                // If core data is unchanged, still attempt price trailing
                return this.manageOpenPosition(sym, s, e, mtf, logContext);
            }

            // Safety Check: If position is open but TP/SL IDs are missing, re-place them
            if (!s.stopLossOrderId || !s.takeProfitOrderId) {
                const recovered = await this.recoverMissingBracketOrders(s, e, mtf, logContext);
                await TradeState.findByIdAndUpdate(s.id || (s as any)._id, { $set: updateData });
                return { ...recovered, ...updateData };
            }

            // Normal update
            const updated = await TradeState.findByIdAndUpdate(s.id || (s as any)._id, { $set: updateData }, { new: true });
            const finalState = (updated as ITradeState) || s;

            // Chain to trailing logic
            return this.manageOpenPosition(sym, finalState, e, mtf, logContext);
        }

        return this.processClosedPosition(s, Number(e.paid_commission || 0), currentPrice, multiplier, logContext);
    }
}