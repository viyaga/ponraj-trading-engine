import { ITradeState } from "../../models/tradeState.model";
import { TradingConfig } from "./config";
import { Candle, OrderSide, TargetCandle } from "./type";
import { skipTradingLogger } from "./logger";

export class Utils {
    static parseJsonSafe(t: string): unknown { try { return JSON.parse(t); } catch { return t; } }
    static compactJson(o: unknown): string { return o ? JSON.stringify(o) : ""; }
    static sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

    static getTimeframeDurationMs(tf: string): number {
        const v = parseInt(tf.slice(0, -1));
        if (isNaN(v)) return 0;
        const map: Record<string, number> = { m: 60, h: 3600, d: 86400, w: 604800, M: 2592000 };
        return v * (map[tf.slice(-1).toLowerCase()] || 0) * 1000;
    }

    static parseStandardCandle(c: any[]): Candle { const [t, o, h, l, cl, v] = c; return { timestamp: Number(t) * 1000, open: Number(o), high: Number(h), low: Number(l), close: Number(cl), volume: Number(v ?? 0) }; }
    static parseObjectCandle(c: any): Candle { const ts = c.timestamp ?? c.time, ms = String(ts).length > 12; return { timestamp: Number(ts) * (ms ? 1 : 1000), open: Number(c.open ?? c.o), high: Number(c.high ?? c.h), low: Number(c.low ?? c.l), close: Number(c.close ?? c.c), volume: Number(c.volume ?? c.v ?? 0) }; }

    static parseCandleResponse(raw: any): Candle[] {
        if (raw?.result) raw = raw.result;
        if (raw?.timestamps) return raw.timestamps.map((t: number, i: number) => ({ timestamp: t * 1000, open: Number(raw.opens[i]), high: Number(raw.highs[i]), low: Number(raw.lows[i]), close: Number(raw.closes[i]), volume: Number(raw.volumes?.[i] ?? 0) })).sort((a: Candle, b: Candle) => b.timestamp - a.timestamp);
        return (Array.isArray(raw) ? raw : []).map(c => Array.isArray(c) ? this.parseStandardCandle(c) : typeof c === "object" ? this.parseObjectCandle(c) : null).filter((c): c is Candle => !!c).sort((a: Candle, b: Candle) => b.timestamp - a.timestamp);
    }

    /* =========================================================================
     INTERNAL HELPERS
  ========================================================================= */

    static isTradePending(s: ITradeState) { return s.tradeOutcome === "pending"; }
    static isTradeResolved(s: ITradeState) { return s.tradeOutcome !== "pending"; }

    static resolveEntryPrice(e?: any): number {
        const price =
            e?.average_fill_price ??
            e?.result?.average_fill_price ??
            e?.limit_price ??
            e?.result?.limit_price;

        if (!price) {
            throw new Error(
                `[utils] Cannot resolve entry price from order details: ${JSON.stringify(e)}`
            );
        }

        const resolvedPrice = Number(price);
        // console.debug(`[utils] Resolved entry price: ${resolvedPrice}`);
        return resolvedPrice;
    }

    static async isPriceMovingInOrderSideDirection(
        candle: TargetCandle,
        side: OrderSide,
        currentPrice: number,
        tradingBotId: string,
        userId: string,
        symbol: string,
        candleTimeframe: string
    ): Promise<boolean> {
        let isTrendValid = false;

        if (side === "sell") {
            // red candle → price should less than high
            isTrendValid = currentPrice < candle.high;
        } else {
            // green candle → price should more than low
            isTrendValid = currentPrice > candle.low;
        }

        if (!isTrendValid) {
            skipTradingLogger.info(`[PriceTrend] SKIP: Price movement not in candle direction for ${symbol}`, {
                tradingBotId,
                userId,
                symbol,
                candleTimeframe,
                targetCandleDirection: candle.color,
                currentPrice,
                candleHigh: candle.high,
                candleLow: candle.low
            });
        }

        return isTrendValid;
    }

    static clampPrice(price: number): number {
        const decimals = TradingConfig.getConfig().PRICE_DECIMAL_PLACES;
        return Number(price.toFixed(decimals));
    }

    /**
     * Validates stop_price (and optional limit_price) to ensure sanity and prevent orders triggering immediately.
     */
    static validateStopLimitPrice(params: {
        type: "tp" | "sl";
        positionSide: OrderSide;
        stopPrice: number | string;
        limitPrice?: number | string;
        entryOrMarketPrice?: number;
    }): { isValid: boolean; error?: string } {
        const stopPriceNum = Number(params.stopPrice);

        if (isNaN(stopPriceNum) || stopPriceNum <= 0) {
            return {
                isValid: false,
                error: `${params.type.toUpperCase()} stop_price must be a positive number, got: ${params.stopPrice}`
            };
        }

        // 1. Verify that stop_price is on the correct side of entry/market price (if provided)
        if (params.entryOrMarketPrice !== undefined && params.entryOrMarketPrice > 0) {
            if (params.type === "tp") {
                if (params.positionSide === "buy" && stopPriceNum <= params.entryOrMarketPrice) {
                    return {
                        isValid: false,
                        error: `TP stop_price (${stopPriceNum}) must be greater than entry/market price (${params.entryOrMarketPrice}) for a buy position`
                    };
                }
                if (params.positionSide === "sell" && stopPriceNum >= params.entryOrMarketPrice) {
                    return {
                        isValid: false,
                        error: `TP stop_price (${stopPriceNum}) must be less than entry/market price (${params.entryOrMarketPrice}) for a sell position`
                    };
                }
            } else { // sl
                if (params.positionSide === "buy" && stopPriceNum >= params.entryOrMarketPrice) {
                    return {
                        isValid: false,
                        error: `SL stop_price (${stopPriceNum}) must be less than entry/market price (${params.entryOrMarketPrice}) for a buy position`
                    };
                }
                if (params.positionSide === "sell" && stopPriceNum <= params.entryOrMarketPrice) {
                    return {
                        isValid: false,
                        error: `SL stop_price (${stopPriceNum}) must be greater than entry/market price (${params.entryOrMarketPrice}) for a sell position`
                    };
                }
            }
        }

        // If no limitPrice is specified (e.g. market_order), validation passes
        if (params.limitPrice === undefined) {
            return { isValid: true };
        }

        const limitPriceNum = Number(params.limitPrice);

        if (isNaN(limitPriceNum) || limitPriceNum <= 0) {
            return {
                isValid: false,
                error: `${params.type.toUpperCase()} limit_price must be a positive number, got: ${params.limitPrice}`
            };
        }

        // 2. Verify buffer direction (limit_price relative to stop_price)
        // - For a buy position (long), TP and SL are SELL orders.
        //   A sell limit order's limit_price must be <= stop_price to ensure execution.
        // - For a sell position (short), TP and SL are BUY orders.
        //   A buy limit order's limit_price must be >= stop_price to ensure execution.
        if (params.positionSide === "buy") {
            if (limitPriceNum > stopPriceNum) {
                return {
                    isValid: false,
                    error: `${params.type.toUpperCase()} limit_price (${limitPriceNum}) cannot be greater than stop_price (${stopPriceNum}) for a buy position (sell order)`
                };
            }
        } else { // sell
            if (limitPriceNum < stopPriceNum) {
                return {
                    isValid: false,
                    error: `${params.type.toUpperCase()} limit_price (${limitPriceNum}) cannot be less than stop_price (${stopPriceNum}) for a sell position (buy order)`
                };
            }
        }

        // 3. Verify buffer amount matches configured buffer within a reasonable tolerance
        try {
            const config = TradingConfig.getConfig();
            const triggerPct = params.type === "tp" ? config.TP_TRIGGER_BUFFER_PERCENT : config.SL_TRIGGER_BUFFER_PERCENT;
            const limitPct = params.type === "tp" ? config.TP_LIMIT_BUFFER_PERCENT : config.SL_LIMIT_BUFFER_PERCENT;

            // Unadjusted ratio
            const factorTriggerUnadj = 1 - (params.positionSide === "buy" ? triggerPct : -triggerPct) / 100;
            const factorLimitUnadj = 1 - (params.positionSide === "buy" ? limitPct : -limitPct) / 100;
            const expectedRatioUnadj = factorTriggerUnadj !== 0 ? factorLimitUnadj / factorTriggerUnadj : 1;

            // Adjusted ratio (with 0.01% minimum limit check)
            const adjTriggerPct = Math.max(triggerPct, 0.01);
            const adjLimitPct = Math.max(limitPct, 0.01);
            const factorTriggerAdj = 1 - (params.positionSide === "buy" ? adjTriggerPct : -adjTriggerPct) / 100;
            const factorLimitAdj = 1 - (params.positionSide === "buy" ? adjLimitPct : -adjLimitPct) / 100;
            const expectedRatioAdj = factorTriggerAdj !== 0 ? factorLimitAdj / factorTriggerAdj : 1;

            const actualRatio = limitPriceNum / stopPriceNum;

            const diffUnadj = Math.abs(actualRatio - expectedRatioUnadj);
            const diffAdj = Math.abs(actualRatio - expectedRatioAdj);

            if (diffUnadj > 0.005 && diffAdj > 0.005) {
                return {
                    isValid: false,
                    error: `${params.type.toUpperCase()} buffer ratio deviation too high. Expected ratio: ${expectedRatioUnadj.toFixed(6)} (or ${expectedRatioAdj.toFixed(6)}), Got: ${actualRatio.toFixed(6)}`
                };
            }
        } catch {
            // Skip config validation if config context is not set (e.g. during standalone tests)
        }

        return { isValid: true };
    }

    static constructBracketOrderPayload(
        tp: number,
        sl: number,
        positionSide: OrderSide,
        entryPrice?: number,
    ) {
        const c = TradingConfig.getConfig();

        const tpTriggerFactor = 1 - (positionSide === "buy" ? c.TP_TRIGGER_BUFFER_PERCENT : -c.TP_TRIGGER_BUFFER_PERCENT) / 100;
        const tpLimitFactor = 1 - (positionSide === "buy" ? c.TP_LIMIT_BUFFER_PERCENT : -c.TP_LIMIT_BUFFER_PERCENT) / 100;

        const slTriggerPrice = this.clampPrice(sl);
        const tpTriggerPrice = this.clampPrice(tp);
        const tpLimitPrice = this.clampPrice(tpTriggerFactor !== 0 ? tp * (tpLimitFactor / tpTriggerFactor) : tp);

        // Perform validations
        if (tp) {
            const validation = this.validateStopLimitPrice({
                type: "tp",
                positionSide,
                stopPrice: tpTriggerPrice,
                entryOrMarketPrice: entryPrice
            });
            if (!validation.isValid) {
                const errMsg = `[constructBracketOrderPayload] TP validation failed: ${validation.error}`;
                skipTradingLogger.error(errMsg);
                throw new Error(errMsg);
            }
        }

        if (sl) {
            const validation = this.validateStopLimitPrice({
                type: "sl",
                positionSide,
                stopPrice: slTriggerPrice,
                entryOrMarketPrice: entryPrice
            });
            if (!validation.isValid) {
                const errMsg = `[constructBracketOrderPayload] SL validation failed: ${validation.error}`;
                skipTradingLogger.error(errMsg);
                throw new Error(errMsg);
            }
        }

        const payload = {
            product_id: Number(c.PRODUCT_ID),
            product_symbol: c.SYMBOL,
            bracket_stop_trigger_method: "last_traded_price",

            ...(tp && {
                take_profit_order: {
                    order_type: "market_order",
                    stop_price: String(tpTriggerPrice),
                },
            }),

            ...(sl && {
                stop_loss_order: {
                    order_type: "market_order",
                    stop_price: String(slTriggerPrice),                 // trigger
                },
            }),
        };

        // console.debug(`[utils] Constructed bracket order payload:`, JSON.stringify(payload));
        return payload;
    }

    static getBodyPercent(c: Candle): number {
        const range = c.high - c.low;
        return range === 0 ? 0 : (Math.abs(c.close - c.open) / range) * 100;
    }

    static getBodyMovePercent(c: Candle): number {
        return (Math.abs(c.close - c.open) / c.open) * 100;
    }

    static getRangePercent(candles: Candle[]): number {
        const high = Math.max(...candles.map(c => c.high));
        const low = Math.min(...candles.map(c => c.low));
        return low === 0 ? 0 : ((high - low) / low) * 100;
    }

    static getCandleColor(c: Candle): "red" | "green" {
        return c.close >= c.open ? "green" : "red";
    }

    static isVolumeSpike(candles: Candle[], index: number): boolean {
        if (index < 5) return false;
        const avg =
            candles
                .slice(index - 5, index)
                .reduce((a, b) => a + b.volume, 0) / 5;
        return candles[index].volume > avg * 1.8;
    }

    static calculateEMA(candles: Candle[], period: number): number {
        if (candles.length < period) return 0;
        const k = 2 / (period + 1);
        let ema = candles.slice(0, period).reduce((a, b) => a + b.close, 0) / period;
        for (let i = period; i < candles.length; i++) {
            ema = (candles[i].close - ema) * k + ema;
        }
        return ema;
    }
}
