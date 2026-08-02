import crypto from "crypto";
import { TradingConfig } from "./config";
import { Utils } from "./utils";
import { tradingCycleErrorLogger, tradingCronLogger, getContextualLogger, placedOrdersLogger } from "./logger";
tradingCronLogger.debug('Searched for "DeltaExchange"');
import { CancelAllOrdersFilter, CancelAllOrdersPayload, OrderDetails, OrderSide, Position, TickerData } from "./type";

export class DeltaExchange {
    private timeOffset = 0;

    private generateSignature(method: string, path: string, ts: number, body = ""): string {
        const c = TradingConfig.getConfig();
        return crypto.createHmac("sha256", c.SECRET_KEY).update(`${method}${ts}${path}${body}`).digest("hex");
    }

    private buildSignedHeaders(method: string, sig: string, ts: number): Record<string, string> {
        const c = TradingConfig.getConfig(), h: Record<string, string> = { Accept: "application/json", "api-key": c.API_KEY, signature: sig, timestamp: String(ts) };
        if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) h["Content-Type"] = "application/json";
        return h;
    }

    private async fetchWithRetry(url: string, options: RequestInit = {}, retries = 3): Promise<Response> {
        for (let attempt = 1; attempt <= retries; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => {
                controller.abort();
            }, 30000); // 30 seconds

            try {
                const response = await fetch(url, {
                    ...options,
                    signal: controller.signal,
                });

                clearTimeout(timeout);
                return response;
            } catch (error: any) {
                clearTimeout(timeout);
                tradingCronLogger.warn(`[delta-api] Fetch attempt ${attempt} failed: ${error.message}`);

                if (attempt === retries) {
                    throw error;
                }

                await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            }
        }
        throw new Error("Fetch failed after retries");
    }

    async signedRequest(method: string, endpoint: string, bodyObj?: any, query?: URLSearchParams, isPrivate = true): Promise<any> {
        const c = TradingConfig.getConfig();
        const qStr = query?.toString() ? `?${query.toString()}` : "";
        const body = bodyObj ? Utils.compactJson(bodyObj) : "";
        const url = `${c.BASE_URL}${endpoint}${qStr}`;

        if (!isPrivate) {
            try {
                const r = await this.fetchWithRetry(url, {
                    method,
                    headers: { Accept: "application/json" }
                });
                const text = await r.text();
                const json: any = Utils.parseJsonSafe(text);
                if (!r.ok) {
                    throw new Error(`Delta API error ${r.status}: ${JSON.stringify(json)}`);
                }
                return json;
            } catch (err: any) {
                tradingCycleErrorLogger.error(`[delta-api] PUBLIC REQUEST FAILED: ${method} ${endpoint}`, { error: err });
                throw err;
            }
        }

        const maxSignatureRetries = 2;
        for (let attempt = 0; attempt <= maxSignatureRetries; attempt++) {
            let ts = Math.floor(Date.now() / 1000) + this.timeOffset;
            const sig = this.generateSignature(method, `/v2${endpoint}${qStr}`, ts, body);

            try {
                ts = Math.floor(Date.now() / 1000) + this.timeOffset;

                const r = await this.fetchWithRetry(url, {
                    method,
                    headers: this.buildSignedHeaders(method, sig, ts),
                    body: (body && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) ? body : undefined
                });

                const text = await r.text();
                const json: any = Utils.parseJsonSafe(text);

                if (!r.ok) {
                    tradingCycleErrorLogger.error(`[delta-api] ERROR RESPONSE: ${r.status} ${method} ${endpoint}`, { response: json, payload: bodyObj });

                    // Handle expired_signature error and adjust timeOffset dynamically
                    if (r.status === 401 && json?.error?.code === "expired_signature" && attempt < maxSignatureRetries) {
                        const serverTime = json.error.context?.server_time;
                        if (serverTime) {
                            const localTime = Math.floor(Date.now() / 1000);
                            // We want: localTime + newOffset - 2 = serverTime
                            // So: newOffset = serverTime - localTime + 2
                            this.timeOffset = serverTime - localTime + 2;
                            tradingCronLogger.warn(`[delta-api] Signature expired. Computed local time: ${localTime}, server time: ${serverTime}. Adjusted timeOffset to ${this.timeOffset}s. Retrying attempt ${attempt + 1}...`);
                            continue;
                        }
                    }

                    throw new Error(`Delta API error ${r.status}: ${JSON.stringify(json)}`);
                }

                return json;
            } catch (err: any) {
                if (attempt === maxSignatureRetries) {
                    tradingCycleErrorLogger.error(`[delta-api] REQUEST FAILED: ${method} ${endpoint}`, { error: err, payload: bodyObj });
                    throw err;
                }

                // Propagate non-signature errors immediately to avoid unnecessary retries
                const isSignatureError = err.message && (
                    err.message.includes("expired_signature") ||
                    err.message.includes("Delta API error 401")
                );

                if (!isSignatureError) {
                    tradingCycleErrorLogger.error(`[delta-api] REQUEST FAILED (Non-signature): ${method} ${endpoint}`, { error: err, payload: bodyObj });
                    throw err;
                }
            }
        }
    }

    async getCandlestickData(s: string, r: string, start: number, end: number) {
        return this.signedRequest("GET", "/history/candles", undefined, new URLSearchParams({ symbol: s, resolution: r, start: String(Math.floor(start / 1000)), end: String(Math.floor(end / 1000)) }), false);
    }

    async getTickerData(sym: string): Promise<TickerData | null> {
        const r = (await this.signedRequest("GET", `/tickers/${sym}`, undefined, undefined, false))?.result ?? null;
        if (r?.quotes) {
            if (r.quotes.best_ask && r.best_ask === undefined) r.best_ask = r.quotes.best_ask;
            if (r.quotes.best_bid && r.best_bid === undefined) r.best_bid = r.quotes.best_bid;
        }
        return r;
    }

    async getOrderDetails(id: string): Promise<OrderDetails | null> {
        const raw = await this.signedRequest("GET", `/orders/${id}`);
        if (!raw?.result) return null;
        const o = raw.result, s = (o.state || o.status)?.toUpperCase();
        if (!s) return null;
        return { id: String(o.id), status: s, meta_data: o.meta_data, paid_commission: o.paid_commission, product_id: o.product_id, side: o.side, client_order_id: o.client_order_id, product_symbol: o.product_symbol, average_fill_price: o.average_fill_price, limit_price: o.limit_price, stop_price: o.stop_price ?? null, size: o.size, bracket_order: o.bracket_order ?? null };
    }


    async updateStopLossOrder(
        id: number | string,
        slPrice: number,
        productId: number | string,
        productSymbol: string,
        orderSide: OrderSide,
        sl: number,
        logContext?: any
    ): Promise<{ success: boolean, slPrice: number, isSlSame?: boolean, isSlReversed?: boolean, isAlreadyTriggered?: boolean }> {

        // NOTE: This method now validates the stop‑loss direction against the current market price
        // and ensures a non‑zero safety buffer so the order cannot be executed immediately.
        const logger = getContextualLogger(tradingCronLogger, logContext);

        const c = TradingConfig.getConfig();

        // ---------------------------------------------------------------------
        // 1️⃣ Get the latest market price for the symbol.
        // ---------------------------------------------------------------------
        const ticker = await this.getTickerData(productSymbol);
        const marketPrice = Number(
            ticker?.mark_price ?? ticker?.spot_price ?? ticker?.best_bid ?? ticker?.best_ask ?? 0
        );
        if (!marketPrice) {
            logger.warn(
                "Unable to fetch market price for stop‑loss validation – proceeding without check",
                { productSymbol }
            );
        }

        // ---------------------------------------------------------------------
        // 2️⃣ Compute the trigger price.
        // ---------------------------------------------------------------------
        let slTriggerPrice = sl; 

        if (marketPrice) {
            if (
                (orderSide === "buy" && Number(slTriggerPrice) >= marketPrice) ||
                (orderSide === "sell" && Number(slTriggerPrice) <= marketPrice)
            ) {
                const adjustment = (marketPrice * 0.001).toFixed(5); 
                const adjustedStop =
                    orderSide === "buy"
                        ? marketPrice - Number(adjustment)
                        : marketPrice + Number(adjustment);
                logger.warn(
                    "Stop‑loss price would trigger immediately – adjusting",
                    {
                        originalStop: slTriggerPrice,
                        adjustedStop,
                        marketPrice,
                        side: orderSide,
                    }
                );
                
                const plLogger = getContextualLogger(placedOrdersLogger, logContext);
                plLogger.warn(
                    `[SL_ADJUSTMENT] Stop‑loss price would trigger immediately – adjusted | ` +
                    `Original SL Trigger: ${slTriggerPrice} | Adjusted SL Trigger: ${adjustedStop} | MarketPrice: ${marketPrice}`
                );

                slTriggerPrice = adjustedStop;
            }
        }

        const stopPrice = String(Utils.clampPrice(slTriggerPrice));

        // Perform validation check
        const validation = Utils.validateStopLimitPrice({
            type: "sl",
            positionSide: orderSide,
            stopPrice,
            entryOrMarketPrice: marketPrice || undefined
        });
        if (!validation.isValid) {
            const errMsg = `[updateStopLossOrder] Validation failed: ${validation.error}`;
            logger.error(errMsg);
            const plLogger = getContextualLogger(placedOrdersLogger, logContext);
            plLogger.error(errMsg);
            throw new Error(errMsg);
        }

        const newSlTrigger = Number(stopPrice);
        const oldSlTrigger = Number(slPrice);

        if (stopPrice === String(Utils.clampPrice(slPrice))) {
            logger.debug("SL prices unchanged. Skipping update.");
            const plLogger = getContextualLogger(placedOrdersLogger, logContext);
            plLogger.info(`[SL_UPDATE_SKIPPED] SL prices unchanged | Order ID: ${id} | Current Trigger: ${slPrice} | Target Trigger: ${stopPrice}`);
            return { success: false, slPrice: sl, isSlSame: true };
        }

        const isSlReversed =
            (orderSide === "buy" && newSlTrigger < oldSlTrigger) ||
            (orderSide === "sell" && newSlTrigger > oldSlTrigger);

        if (isSlReversed) {
            logger.warn("SL moved in wrong direction. Skipping update.");
            const plLogger = getContextualLogger(placedOrdersLogger, logContext);
            plLogger.warn(`[SL_UPDATE_SKIPPED] SL moved in wrong direction | Order ID: ${id} | Current Trigger: ${slPrice} | Target Trigger: ${stopPrice}`);
            return { success: false, slPrice: sl, isSlReversed: true };
        }

        const payload = {
            id,
            product_id: Number(productId),
            product_symbol: productSymbol,
            stop_price: stopPrice,
        };

        logger.info("Updating Stop Loss Order", { payload });

        try {
            const updateRes: any = await this.signedRequest("PUT", "/orders", payload);
            logger.debug("Updated Stop Loss Order response", { updateRes });
            if (updateRes?.success) {
                const order = updateRes.result || payload;
                const plLogger = getContextualLogger(placedOrdersLogger, logContext);
                plLogger.info(`[SL_UPDATE] Symbol: ${productSymbol} | Order ID: ${order.id || id} | SL Trigger (Stop Price): ${order.stop_price}`);
            }
            return { success: updateRes?.success ?? false, slPrice: Number(stopPrice) };
        } catch (error: any) {
            const errMsg = error?.message || String(error);
            const errLower = errMsg.toLowerCase();
            
            const plLogger = getContextualLogger(placedOrdersLogger, logContext);
            plLogger.warn(`[SL_UPDATE_FAILED] Symbol: ${productSymbol} | Order ID: ${id} | Error: ${errMsg}`);

            if (
                errLower.includes("stop_price_change_not_supported") ||
                errLower.includes("order_already_triggered") ||
                errLower.includes("no_position_left_for_reduce_only") ||
                errLower.includes("insufficient_position") ||
                errLower.includes("no_open_position")
            ) {
                logger.warn(`Stop loss order ${id} is already triggered or position is closed. Skipping trailing.`);
                return { success: false, slPrice: sl, isAlreadyTriggered: true };
            }
            throw error;
        }
    }

    async updateTakeProfitOrder(
        id: number | string,
        tpPrice: number,
        productId: number | string,
        productSymbol: string,
        orderSide: OrderSide,
        tp: number,
        logContext?: any
    ): Promise<{ success: boolean, tpPrice: number, isTpSame?: boolean, isAlreadyTriggered?: boolean }> {

        const logger = getContextualLogger(tradingCronLogger, logContext);
        const c = TradingConfig.getConfig();

        const triggerBufferPct = Math.max(c.TP_TRIGGER_BUFFER_PERCENT, 0.01);
        const limitBufferPct = Math.max(c.TP_LIMIT_BUFFER_PERCENT, 0.01);
        const triggerFactor =
            1 - (orderSide === "buy" ? triggerBufferPct : -triggerBufferPct) / 100;
        const limitFactor =
            1 - (orderSide === "buy" ? limitBufferPct : -limitBufferPct) / 100;

        const tpTriggerPrice = tp;
        const tpLimitPriceVal = triggerFactor !== 0 ? tp * (limitFactor / triggerFactor) : tp;

        const stopPrice = String(Utils.clampPrice(tpTriggerPrice));
        const limitPrice = String(Utils.clampPrice(tpLimitPriceVal));

        // Get market price for validation if needed
        let marketPrice: number | undefined;
        try {
            const ticker = await this.getTickerData(productSymbol);
            marketPrice = Number(
                ticker?.mark_price ?? ticker?.spot_price ?? ticker?.best_bid ?? ticker?.best_ask ?? 0
            );
        } catch {
            // ignore
        }

        // Perform validation check
        const validation = Utils.validateStopLimitPrice({
            type: "tp",
            positionSide: orderSide,
            stopPrice,
            limitPrice,
            entryOrMarketPrice: marketPrice || undefined
        });
        if (!validation.isValid) {
            const errMsg = `[updateTakeProfitOrder] Validation failed: ${validation.error}`;
            logger.error(errMsg);
            const plLogger = getContextualLogger(placedOrdersLogger, logContext);
            plLogger.error(errMsg);
            throw new Error(errMsg);
        }

        const oldTpTrigger = String(Utils.clampPrice(tpPrice));

        logger.debug("TP price calculation", { stopPrice, limitPrice, oldTpTrigger, tp, tpPrice });

        // TP unchanged
        if (stopPrice === oldTpTrigger) {
            logger.debug("TP prices unchanged. Skipping update.");
            const plLogger = getContextualLogger(placedOrdersLogger, logContext);
            plLogger.info(`[TP_UPDATE_SKIPPED] TP prices unchanged | Order ID: ${id} | Current Trigger: ${tpPrice} | Target Trigger: ${stopPrice}`);
            return { success: false, tpPrice: tp, isTpSame: true };
        }

        const payload = {
            id,
            product_id: Number(productId),
            product_symbol: productSymbol,
            limit_price: limitPrice,
            stop_price: stopPrice,
        };

        logger.info("Updating Take Profit Order", { payload });

        try {
            const updateRes: any = await this.signedRequest("PUT", "/orders", payload);
            logger.debug("Updated Take Profit Order response", { updateRes });
            if (updateRes?.success) {
                const order = updateRes.result || payload;
                const plLogger = getContextualLogger(placedOrdersLogger, logContext);
                plLogger.info(`[TP_UPDATE] Symbol: ${productSymbol} | Order ID: ${order.id || id} | TP Trigger (Stop Price): ${order.stop_price} | TP Limit: ${order.limit_price}`);
            }
            return { success: updateRes?.success ?? false, tpPrice: Number(stopPrice) };
        } catch (error: any) {
            const errMsg = error?.message || String(error);
            const errLower = errMsg.toLowerCase();
            
            const plLogger = getContextualLogger(placedOrdersLogger, logContext);
            plLogger.warn(`[TP_UPDATE_FAILED] Symbol: ${productSymbol} | Order ID: ${id} | Error: ${errMsg}`);

            if (
                errLower.includes("stop_price_change_not_supported") ||
                errLower.includes("order_already_triggered") ||
                errLower.includes("no_position_left_for_reduce_only") ||
                errLower.includes("insufficient_position") ||
                errLower.includes("no_open_position")
            ) {
                logger.warn(`Take profit order ${id} is already triggered or position is closed. Skipping trailing.`);
                return { success: false, tpPrice: tp, isAlreadyTriggered: true };
            }
            throw error;
        }
    }

    async placeEntryOrder(symbol: string, side: OrderSide, qty: number, cid?: string) {
        const c = TradingConfig.getConfig();
        return this.signedRequest("POST", "/orders", { product_id: Number(c.PRODUCT_ID), product_symbol: symbol, side, size: Math.floor(qty), order_type: "market_order", time_in_force: "gtc", client_order_id: cid || `viy-${Date.now()}` });
    }

    async cancelStopOrders(f: CancelAllOrdersFilter, logContext?: any): Promise<{ success: boolean }> {
        const p: CancelAllOrdersPayload = {
            contract_types: f.contract_types || "perpetual_futures",
            cancel_limit_orders: f.cancel_limit_orders ?? false,
            cancel_stop_orders: f.cancel_stop_orders ?? true,
            cancel_reduce_only_orders: f.cancel_reduce_only_orders ?? true
        };
        if (f.product_id) p.product_id = f.product_id;
        const success = (await this.signedRequest("DELETE", "/orders/all", p))?.success ? { success: true } : { success: false };
        
        const plLogger = getContextualLogger(placedOrdersLogger, logContext);
        plLogger.info(`[CANCEL_ORDERS] Cancelled existing open orders | Filters: ${JSON.stringify(f)} | Success: ${success.success}`);
        
        return success;
    }

    async getPositions(pid?: number | string): Promise<Position | Position[] | null> {
        return (await this.signedRequest("GET", "/positions", undefined, pid ? new URLSearchParams({ product_id: String(pid) }) : undefined))?.result ?? null;
    }

    async placeTPSLBracketOrder(
        tp: number,
        sl: number,
        positionSide: OrderSide,
        logContext?: any,
        entryPrice?: number
    ): Promise<{ success: boolean; ids: { tp: string; sl: string }; isNoPosition?: boolean }> {
        let resolvedEntryPrice = entryPrice;
        if (!resolvedEntryPrice) {
            try {
                const pos = await this.getPositions(TradingConfig.getConfig().PRODUCT_ID);
                if (pos) {
                    const position = Array.isArray(pos) ? pos[0] : pos;
                    if (position?.entry_price) {
                        resolvedEntryPrice = Number(position.entry_price);
                    }
                }
            } catch (err) {
                // If it fails to fetch positions, we still proceed without entryPrice check
            }
        }

        const payload = Utils.constructBracketOrderPayload(tp, sl, positionSide, resolvedEntryPrice);
        const logger = getContextualLogger(tradingCronLogger, logContext);
        if (!payload.stop_loss_order && !payload.take_profit_order) return { success: false, ids: { tp: "", sl: "" } };

        // Clean slate: cancel any existing stop or limit orders for this product to prevent reduce-only conflicts
        try {
            const cleanRes = await this.cancelStopOrders({
                product_id: TradingConfig.getConfig().PRODUCT_ID,
                cancel_limit_orders: true,
            }, logContext);
            logger.info("Successfully cancelled existing open orders on exchange before placing new bracket.", { cleanRes });
        } catch (cancelErr) {
            logger.warn("Failed to cancel existing open orders on exchange before placing bracket:", cancelErr);
        }

        logger.info("Placing TP/SL orders", { tp, sl, payload });

        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const raw = await this.signedRequest("POST", "/orders/bracket", payload);
                logger.info("Bracket order placement raw response from exchange:", { raw });
                if (raw?.result) {
                    const tpOrder = raw.result.take_profit_order;
                    const slOrder = raw.result.stop_loss_order;
                    const symbol = TradingConfig.getConfig().SYMBOL;
                    const c = TradingConfig.getConfig();

                    const plLogger = getContextualLogger(placedOrdersLogger, logContext);
                    plLogger.info(
                        `[INITIAL_BRACKET] Symbol: ${symbol} | ` +
                        `TP ID: ${tpOrder?.id || 'N/A'}, TP Trigger (Stop Price): ${tpOrder?.stop_price || 'N/A'} (Market Order) | ` +
                        `SL ID: ${slOrder?.id || 'N/A'}, SL Trigger (Stop Price): ${slOrder?.stop_price || 'N/A'} (Market Order) | ` +
                        `Config - SL Trigger Buffer: ${c.SL_TRIGGER_BUFFER_PERCENT}%, TP Trigger Buffer: ${c.TP_TRIGGER_BUFFER_PERCENT}%`
                    );
                    plLogger.info("Bracket order raw response details:", { raw });

                    return {
                        success: true,
                        ids: {
                            tp: tpOrder?.id?.toString(),
                            sl: slOrder?.id?.toString(),
                        },
                    };
                }

                logger.warn(`Bracket order attempt ${attempt} failed: Empty result (raw: ${JSON.stringify(raw)})`);
            } catch (err: any) {
                const errorStr = String(err);
                
                const plLogger = getContextualLogger(placedOrdersLogger, logContext);
                plLogger.warn(`[INITIAL_BRACKET_FAILED] Symbol: ${TradingConfig.getConfig().SYMBOL} | Attempt: ${attempt}/${maxRetries} | Error: ${errorStr}`);

                const isNoPosition = errorStr.toLowerCase().includes("no_open_position") ||
                    errorStr.toLowerCase().includes("insufficient_position") ||
                    errorStr.toLowerCase().includes("no_position_left_for_reduce_only");

                if (isNoPosition && attempt < maxRetries) {
                    logger.warn(`Bracket order attempt ${attempt} failed due to no open position. Retrying in 1s...`);
                    await Utils.sleep(1000);
                    continue;
                }

                logger.error(`Bracket order attempt ${attempt} failed with error:`, err);
                if (attempt === maxRetries) {
                    if (isNoPosition) {
                        return { success: false, ids: { tp: "", sl: "" }, isNoPosition: true };
                    }
                    throw new Error(`Failed to place TPSL bracket order after ${maxRetries} attempts: ${err}`);
                }
            }

            if (attempt < maxRetries) {
                logger.info(`Retrying bracket order (attempt ${attempt + 1}/${maxRetries})...`);
                await Utils.sleep(1000);
            }
        }

        return { success: false, ids: { tp: "", sl: "" } };
    }

    async getOrderLeverage(productId: number | string): Promise<{ success: boolean; result?: { leverage: number; order_margin: string; product_id: number } }> {
        return this.signedRequest("GET", `/products/${productId}/orders/leverage`);
    }

    async changeOrderLeverage(productId: number | string, leverage: number): Promise<{ success: boolean; result?: { leverage: number; order_margin: string; product_id: number } }> {
        return this.signedRequest("POST", `/products/${productId}/orders/leverage`, { leverage });
    }
}

export const deltaExchange = new DeltaExchange();
