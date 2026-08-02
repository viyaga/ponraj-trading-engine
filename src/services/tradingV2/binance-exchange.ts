import crypto from "crypto";
import { TradingConfig } from "./config";
import { Utils } from "./utils";
import { tradingCycleErrorLogger, tradingCronLogger, getContextualLogger, placedOrdersLogger } from "./logger";
import { CancelAllOrdersFilter, OrderDetails, OrderSide, Position, TickerData } from "./type";

export class BinanceExchange {
    private timeOffset = 0;

    private getBaseUrl(): string {
        const c = TradingConfig.getConfig();
        if (c.BASE_URL && c.BASE_URL.includes("binance")) {
            return c.BASE_URL.replace(/\/+$/, "");
        }
        return c.IS_TESTING ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
    }

    private formatSymbol(symbol: string): string {
        if (!symbol) return "";
        return symbol.replace(/[-_]/g, "").toUpperCase();
    }

    private mapResolutionToInterval(r: string): string {
        const lower = r.toLowerCase();
        if (lower.endsWith("m") || lower.endsWith("h") || lower.endsWith("d") || lower.endsWith("w") || lower.endsWith("M")) {
            return lower;
        }
        const num = parseInt(r, 10);
        if (!isNaN(num)) {
            return `${num}m`;
        }
        return "5m";
    }

    private generateSignature(queryString: string): string {
        const c = TradingConfig.getConfig();
        return crypto.createHmac("sha256", c.SECRET_KEY).update(queryString).digest("hex");
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
                tradingCronLogger.warn(`[binance-api] Fetch attempt ${attempt} failed: ${error.message}`);

                if (attempt === retries) {
                    throw error;
                }

                await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            }
        }
        throw new Error("Fetch failed after retries");
    }

    async signedRequest(
        method: string,
        endpoint: string,
        params: Record<string, any> = {},
        isPrivate = true
    ): Promise<any> {
        const c = TradingConfig.getConfig();
        const baseUrl = this.getBaseUrl();

        if (!isPrivate) {
            const query = new URLSearchParams();
            for (const [k, v] of Object.entries(params)) {
                if (v !== undefined && v !== null) {
                    query.append(k, String(v));
                }
            }
            const qStr = query.toString() ? `?${query.toString()}` : "";
            const url = `${baseUrl}${endpoint}${qStr}`;

            try {
                const r = await this.fetchWithRetry(url, {
                    method,
                    headers: { Accept: "application/json" },
                });
                const text = await r.text();
                const json: any = Utils.parseJsonSafe(text);
                if (!r.ok) {
                    throw new Error(`Binance API error ${r.status}: ${JSON.stringify(json)}`);
                }
                return json;
            } catch (err: any) {
                tradingCycleErrorLogger.error(`[binance-api] PUBLIC REQUEST FAILED: ${method} ${endpoint}`, { error: err });
                throw err;
            }
        }

        const maxSignatureRetries = 2;
        for (let attempt = 0; attempt <= maxSignatureRetries; attempt++) {
            const ts = Date.now() + this.timeOffset;
            const queryParams = new URLSearchParams();
            for (const [k, v] of Object.entries(params)) {
                if (v !== undefined && v !== null) {
                    queryParams.append(k, String(v));
                }
            }
            queryParams.append("timestamp", String(ts));
            queryParams.append("recvWindow", "10000");

            const queryString = queryParams.toString();
            const signature = this.generateSignature(queryString);
            const finalQueryString = `${queryString}&signature=${signature}`;

            let url = `${baseUrl}${endpoint}`;
            let headers: Record<string, string> = {
                Accept: "application/json",
                "X-MBX-APIKEY": c.API_KEY,
            };

            let options: RequestInit = { method, headers };

            if (["POST", "PUT"].includes(method)) {
                headers["Content-Type"] = "application/x-www-form-urlencoded";
                options.body = finalQueryString;
            } else {
                url += `?${finalQueryString}`;
            }

            try {
                const r = await this.fetchWithRetry(url, options);
                const text = await r.text();
                const json: any = Utils.parseJsonSafe(text);

                if (!r.ok) {
                    tradingCycleErrorLogger.error(`[binance-api] ERROR RESPONSE: ${r.status} ${method} ${endpoint}`, { response: json, payload: params });

                    // Handle timestamp out of sync / server time error (code -1021)
                    if (json && (json.code === -1021 || (r.status === 400 && String(json.msg).includes("Timestamp")))) {
                        if (attempt < maxSignatureRetries) {
                            try {
                                const serverTimeRes = await this.signedRequest("GET", "/fapi/v1/time", {}, false);
                                if (serverTimeRes?.serverTime) {
                                    const localTime = Date.now();
                                    this.timeOffset = Number(serverTimeRes.serverTime) - localTime;
                                    tradingCronLogger.warn(`[binance-api] Timestamp sync error. Local time: ${localTime}, Server time: ${serverTimeRes.serverTime}. Adjusted timeOffset to ${this.timeOffset}ms. Retrying attempt ${attempt + 1}...`);
                                    continue;
                                }
                            } catch (timeErr) {
                                tradingCronLogger.warn(`[binance-api] Failed to fetch server time for timestamp sync:`, timeErr);
                            }
                        }
                    }

                    throw new Error(`Binance API error ${r.status}: ${JSON.stringify(json)}`);
                }

                return json;
            } catch (err: any) {
                if (attempt === maxSignatureRetries) {
                    tradingCycleErrorLogger.error(`[binance-api] REQUEST FAILED: ${method} ${endpoint}`, { error: err, payload: params });
                    throw err;
                }

                const isTimeError = err.message && (
                    err.message.includes("-1021") ||
                    err.message.includes("Timestamp")
                );

                if (!isTimeError) {
                    tradingCycleErrorLogger.error(`[binance-api] REQUEST FAILED (Non-timestamp): ${method} ${endpoint}`, { error: err, payload: params });
                    throw err;
                }
            }
        }
    }

    async getCandlestickData(s: string, r: string, start: number, end: number) {
        const symbol = this.formatSymbol(s);
        const interval = this.mapResolutionToInterval(r);
        const params: Record<string, any> = {
            symbol,
            interval,
            startTime: Math.floor(start),
            endTime: Math.floor(end),
            limit: 1000,
        };

        const raw = await this.signedRequest("GET", "/fapi/v1/klines", params, false);

        if (Array.isArray(raw)) {
            return raw.map((k: any[]) => ({
                timestamp: Number(k[0]),
                open: Number(k[1]),
                high: Number(k[2]),
                low: Number(k[3]),
                close: Number(k[4]),
                volume: Number(k[5]),
            }));
        }
        return [];
    }

    async getTickerData(s: string): Promise<TickerData | null> {
        const symbol = this.formatSymbol(s);

        const [ticker24h, premIndex] = await Promise.all([
            this.signedRequest("GET", "/fapi/v1/ticker/24hr", { symbol }, false).catch(() => null),
            this.signedRequest("GET", "/fapi/v1/premiumIndex", { symbol }, false).catch(() => null),
        ]);

        if (!ticker24h && !premIndex) return null;

        const markPrice = String(premIndex?.markPrice ?? ticker24h?.lastPrice ?? "0");
        const spotPrice = String(premIndex?.indexPrice ?? ticker24h?.lastPrice ?? markPrice);

        return {
            symbol,
            product_id: 0,
            description: `${symbol} Perpetual Futures`,
            contract_type: "perpetual_futures",
            open: Number(ticker24h?.openPrice ?? 0),
            high: Number(ticker24h?.highPrice ?? 0),
            low: Number(ticker24h?.lowPrice ?? 0),
            close: Number(ticker24h?.lastPrice ?? 0),
            mark_price: markPrice,
            spot_price: spotPrice,
            best_ask: String(ticker24h?.askPrice ?? ticker24h?.lastPrice ?? markPrice),
            best_bid: String(ticker24h?.bidPrice ?? ticker24h?.lastPrice ?? markPrice),
            volume: Number(ticker24h?.volume ?? 0),
            size: Number(ticker24h?.count ?? 0),
            turnover: Number(ticker24h?.quoteVolume ?? 0),
            turnover_usd: Number(ticker24h?.quoteVolume ?? 0),
            turnover_symbol: "USDT",
            oi: "0",
            oi_contracts: "0",
            oi_value: "0",
            oi_value_usd: "0",
            oi_value_symbol: "USDT",
            oi_change_usd_6h: "0",
            funding_rate: String(premIndex?.lastFundingRate ?? "0"),
            leverage: 1,
            contract_value: "1",
            product_trading_status: "operational",
            sort_priority: 1,
            tags: [],
            timestamp: Date.now() * 1000,
            time: new Date().toISOString(),
            price_band: {
                lower_limit: "0",
                upper_limit: "0",
            },
            mark_basis: "0",
            mark_change_24h: String(ticker24h?.priceChangePercent ?? "0"),
            ltp_change_24h: String(ticker24h?.priceChangePercent ?? "0"),
            tick_size: "0.01",
            underlying_asset_symbol: symbol.replace("USDT", "").replace("USDC", ""),
            quotes: {
                best_ask: String(ticker24h?.askPrice ?? ticker24h?.lastPrice ?? markPrice),
                best_bid: String(ticker24h?.bidPrice ?? ticker24h?.lastPrice ?? markPrice),
                ask_size: "0",
                bid_size: "0",
                ask_iv: null,
                bid_iv: null,
                mark_iv: "0",
                impact_mid_price: null,
            },
            greeks: null,
        };
    }

    async getOrderDetails(id: string, s?: string): Promise<OrderDetails | null> {
        const c = TradingConfig.getConfig();
        const symbol = this.formatSymbol(s || c.SYMBOL);

        try {
            const params: Record<string, any> = { symbol };
            if (/^\d+$/.test(id)) {
                params.orderId = id;
            } else {
                params.origClientOrderId = id;
            }

            const raw = await this.signedRequest("GET", "/fapi/v1/order", params);
            if (!raw) return null;

            let status = "OPEN";
            const bState = String(raw.status).toUpperCase();
            if (bState === "FILLED") {
                status = "CLOSED";
            } else if (["CANCELED", "EXPIRED", "REJECTED"].includes(bState)) {
                status = "CANCELLED";
            } else if (["NEW", "PARTIALLY_FILLED"].includes(bState)) {
                status = "OPEN";
            }

            const side: OrderSide = String(raw.side).toLowerCase() === "buy" ? "buy" : "sell";
            const avgPrice = raw.avgPrice && Number(raw.avgPrice) > 0 ? String(raw.avgPrice) : String(raw.price || "0");
            const cumCommission = String(raw.cumCommission ?? "0");

            return {
                id: String(raw.orderId),
                status,
                product_id: 0,
                product_symbol: symbol,
                side,
                size: Number(raw.origQty ?? raw.executedQty ?? 0),
                limit_price: raw.price ? String(raw.price) : null,
                average_fill_price: avgPrice,
                stop_price: raw.stopPrice ? String(raw.stopPrice) : null,
                client_order_id: raw.clientOrderId ?? null,
                paid_commission: cumCommission,
                meta_data: {
                    pnl: "0",
                    roe: "0",
                    entry_price: avgPrice,
                    trigger_price: raw.stopPrice ? String(raw.stopPrice) : undefined,
                },
            };
        } catch (err) {
            tradingCycleErrorLogger.error(`[binance-api] Failed to get order details for ${id}:`, err);
            return null;
        }
    }

    async placeEntryOrder(symbol: string, side: OrderSide, qty: number, cid?: string) {
        const formattedSymbol = this.formatSymbol(symbol);
        const bSide = side === "buy" ? "BUY" : "SELL";
        const clientOrderId = cid || `viy-${Date.now()}`;

        const params: Record<string, any> = {
            symbol: formattedSymbol,
            side: bSide,
            type: "MARKET",
            quantity: qty,
            newClientOrderId: clientOrderId,
        };

        const res = await this.signedRequest("POST", "/fapi/v1/order", params);

        return {
            ...res,
            id: String(res.orderId),
            client_order_id: res.clientOrderId,
            average_fill_price: res.avgPrice ? String(res.avgPrice) : null,
        };
    }

    async cancelStopOrders(f: CancelAllOrdersFilter, logContext?: any): Promise<{ success: boolean }> {
        const c = TradingConfig.getConfig();
        const symbol = this.formatSymbol(f.product_id ? String(f.product_id) : c.SYMBOL);

        try {
            await this.signedRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol });
            const plLogger = getContextualLogger(placedOrdersLogger, logContext);
            plLogger.info(`[CANCEL_ORDERS] Cancelled all open orders for Binance symbol ${symbol}`);
            return { success: true };
        } catch (err: any) {
            tradingCycleErrorLogger.error(`[binance-api] Failed to cancel open orders for ${symbol}:`, err);
            return { success: false };
        }
    }

    async getPositions(productId?: number | string): Promise<Position | Position[] | null> {
        const c = TradingConfig.getConfig();
        const symbol = this.formatSymbol(productId ? String(productId) : c.SYMBOL);

        const res = await this.signedRequest("GET", "/fapi/v2/positionRisk", { symbol });

        if (Array.isArray(res)) {
            const match = res.find((p: any) => this.formatSymbol(p.symbol) === symbol) || res[0];
            if (!match) return null;
            return {
                entry_price: match.entryPrice ? String(match.entryPrice) : null,
                size: Number(match.positionAmt ?? 0),
            };
        }

        if (res && res.positionAmt !== undefined) {
            return {
                entry_price: res.entryPrice ? String(res.entryPrice) : null,
                size: Number(res.positionAmt ?? 0),
            };
        }

        return null;
    }

    async placeTPSLBracketOrder(
        tp: number,
        sl: number,
        positionSide: OrderSide,
        logContext?: any,
        entryPrice?: number
    ): Promise<{ success: boolean; ids: { tp: string; sl: string }; isNoPosition?: boolean }> {
        const c = TradingConfig.getConfig();
        const symbol = this.formatSymbol(c.SYMBOL);
        const logger = getContextualLogger(tradingCronLogger, logContext);
        const plLogger = getContextualLogger(placedOrdersLogger, logContext);

        let resolvedEntryPrice = entryPrice;
        if (!resolvedEntryPrice) {
            try {
                const pos = await this.getPositions(symbol);
                if (pos) {
                    const position = Array.isArray(pos) ? pos[0] : pos;
                    if (position?.entry_price) {
                        resolvedEntryPrice = Number(position.entry_price);
                    }
                }
            } catch (err) {
                // proceed without entryPrice
            }
        }

        // Clean slate: cancel existing open orders
        try {
            await this.cancelStopOrders({ product_id: symbol }, logContext);
        } catch (cancelErr) {
            logger.warn("Failed to cancel existing orders before placing bracket:", cancelErr);
        }

        const bSide = positionSide === "buy" ? "SELL" : "BUY";
        let tpOrderId = "";
        let slOrderId = "";

        // Place Take Profit Market Order
        if (tp && tp > 0) {
            try {
                const tpParams: Record<string, any> = {
                    symbol,
                    side: bSide,
                    type: "TAKE_PROFIT_MARKET",
                    stopPrice: Utils.clampPrice(tp),
                    closePosition: "true",
                    workingType: "MARK_PRICE",
                };
                const tpRes = await this.signedRequest("POST", "/fapi/v1/order", tpParams);
                if (tpRes?.orderId) {
                    tpOrderId = String(tpRes.orderId);
                }
            } catch (tpErr: any) {
                logger.error("Failed to place Binance TP order:", tpErr);
            }
        }

        // Place Stop Loss Market Order
        if (sl && sl > 0) {
            try {
                const slParams: Record<string, any> = {
                    symbol,
                    side: bSide,
                    type: "STOP_MARKET",
                    stopPrice: Utils.clampPrice(sl),
                    closePosition: "true",
                    workingType: "MARK_PRICE",
                };
                const slRes = await this.signedRequest("POST", "/fapi/v1/order", slParams);
                if (slRes?.orderId) {
                    slOrderId = String(slRes.orderId);
                }
            } catch (slErr: any) {
                logger.error("Failed to place Binance SL order:", slErr);
            }
        }

        const success = Boolean(tpOrderId || slOrderId);

        if (success) {
            plLogger.info(
                `[INITIAL_BRACKET] Symbol: ${symbol} | ` +
                `TP ID: ${tpOrderId || 'N/A'}, TP Trigger: ${tp} | ` +
                `SL ID: ${slOrderId || 'N/A'}, SL Trigger: ${sl}`
            );
        }

        return {
            success,
            ids: {
                tp: tpOrderId,
                sl: slOrderId,
            },
        };
    }

    async updateStopLossOrder(
        id: number | string,
        slPrice: number,
        productId: number | string,
        productSymbol: string,
        orderSide: OrderSide,
        sl: number,
        logContext?: any
    ): Promise<{ success: boolean; slPrice: number; isSlSame?: boolean; isSlReversed?: boolean; isAlreadyTriggered?: boolean }> {
        const logger = getContextualLogger(tradingCronLogger, logContext);
        const plLogger = getContextualLogger(placedOrdersLogger, logContext);
        const symbol = this.formatSymbol(productSymbol);

        const ticker = await this.getTickerData(symbol);
        const marketPrice = Number(ticker?.mark_price ?? ticker?.spot_price ?? 0);

        let slTriggerPrice = sl;
        if (marketPrice) {
            if (
                (orderSide === "buy" && Number(slTriggerPrice) >= marketPrice) ||
                (orderSide === "sell" && Number(slTriggerPrice) <= marketPrice)
            ) {
                const adjustment = marketPrice * 0.001;
                const adjustedStop =
                    orderSide === "buy"
                        ? marketPrice - adjustment
                        : marketPrice + adjustment;

                slTriggerPrice = adjustedStop;
            }
        }

        const stopPrice = Utils.clampPrice(slTriggerPrice);
        const validation = Utils.validateStopLimitPrice({
            type: "sl",
            positionSide: orderSide,
            stopPrice,
            entryOrMarketPrice: marketPrice || undefined,
        });

        if (!validation.isValid) {
            const errMsg = `[updateStopLossOrder] Validation failed: ${validation.error}`;
            logger.error(errMsg);
            plLogger.error(errMsg);
            throw new Error(errMsg);
        }

        const newSlTrigger = stopPrice;
        const oldSlTrigger = Number(slPrice);

        if (stopPrice === Utils.clampPrice(slPrice)) {
            plLogger.info(`[SL_UPDATE_SKIPPED] SL prices unchanged | Order ID: ${id} | Trigger: ${stopPrice}`);
            return { success: false, slPrice: sl, isSlSame: true };
        }

        const isSlReversed =
            (orderSide === "buy" && newSlTrigger < oldSlTrigger) ||
            (orderSide === "sell" && newSlTrigger > oldSlTrigger);

        if (isSlReversed) {
            plLogger.warn(`[SL_UPDATE_SKIPPED] SL moved in wrong direction | Order ID: ${id}`);
            return { success: false, slPrice: sl, isSlReversed: true };
        }

        const bSide = orderSide === "buy" ? "SELL" : "BUY";

        // Try modifying existing order via PUT /fapi/v1/order
        try {
            const putParams: Record<string, any> = {
                symbol,
                side: bSide,
                stopPrice,
            };
            if (/^\d+$/.test(String(id))) {
                putParams.orderId = id;
            } else {
                putParams.origClientOrderId = id;
            }

            const res = await this.signedRequest("PUT", "/fapi/v1/order", putParams);
            if (res?.orderId) {
                plLogger.info(`[SL_UPDATE] Symbol: ${symbol} | Order ID: ${res.orderId} | New SL: ${stopPrice}`);
                return { success: true, slPrice: stopPrice };
            }
        } catch (modifyErr: any) {
            logger.warn(`Binance PUT order modify failed for SL ${id}, falling back to cancel & replace:`, modifyErr?.message || modifyErr);
        }

        // Fallback: Cancel old order & place new STOP_MARKET order
        try {
            const deleteParams: Record<string, any> = { symbol };
            if (/^\d+$/.test(String(id))) {
                deleteParams.orderId = id;
            } else {
                deleteParams.origClientOrderId = id;
            }
            await this.signedRequest("DELETE", "/fapi/v1/order", deleteParams).catch(() => null);

            const newSlParams: Record<string, any> = {
                symbol,
                side: bSide,
                type: "STOP_MARKET",
                stopPrice,
                closePosition: "true",
                workingType: "MARK_PRICE",
            };
            const newRes = await this.signedRequest("POST", "/fapi/v1/order", newSlParams);

            if (newRes?.orderId) {
                plLogger.info(`[SL_UPDATE] (Replaced) Symbol: ${symbol} | New Order ID: ${newRes.orderId} | SL: ${stopPrice}`);
                return { success: true, slPrice: stopPrice };
            }
        } catch (err: any) {
            const errMsg = err?.message || String(err);
            plLogger.warn(`[SL_UPDATE_FAILED] Symbol: ${symbol} | Order ID: ${id} | Error: ${errMsg}`);
            if (
                errMsg.includes("Order does not exist") ||
                errMsg.includes("Unknown order") ||
                errMsg.includes("-2011")
            ) {
                return { success: false, slPrice: sl, isAlreadyTriggered: true };
            }
            throw err;
        }

        return { success: false, slPrice: sl };
    }

    async updateTakeProfitOrder(
        id: number | string,
        tpPrice: number,
        productId: number | string,
        productSymbol: string,
        orderSide: OrderSide,
        tp: number,
        logContext?: any
    ): Promise<{ success: boolean; tpPrice: number; isTpSame?: boolean; isAlreadyTriggered?: boolean }> {
        const logger = getContextualLogger(tradingCronLogger, logContext);
        const plLogger = getContextualLogger(placedOrdersLogger, logContext);
        const symbol = this.formatSymbol(productSymbol);

        const stopPrice = Utils.clampPrice(tp);

        if (stopPrice === Utils.clampPrice(tpPrice)) {
            plLogger.info(`[TP_UPDATE_SKIPPED] TP prices unchanged | Order ID: ${id} | Target Trigger: ${stopPrice}`);
            return { success: false, tpPrice: tp, isTpSame: true };
        }

        const bSide = orderSide === "buy" ? "SELL" : "BUY";

        // Try modifying existing order via PUT /fapi/v1/order
        try {
            const putParams: Record<string, any> = {
                symbol,
                side: bSide,
                stopPrice,
            };
            if (/^\d+$/.test(String(id))) {
                putParams.orderId = id;
            } else {
                putParams.origClientOrderId = id;
            }

            const res = await this.signedRequest("PUT", "/fapi/v1/order", putParams);
            if (res?.orderId) {
                plLogger.info(`[TP_UPDATE] Symbol: ${symbol} | Order ID: ${res.orderId} | New TP: ${stopPrice}`);
                return { success: true, tpPrice: stopPrice };
            }
        } catch (modifyErr: any) {
            logger.warn(`Binance PUT order modify failed for TP ${id}, falling back to cancel & replace:`, modifyErr?.message || modifyErr);
        }

        // Fallback: Cancel old order & place new TAKE_PROFIT_MARKET order
        try {
            const deleteParams: Record<string, any> = { symbol };
            if (/^\d+$/.test(String(id))) {
                deleteParams.orderId = id;
            } else {
                deleteParams.origClientOrderId = id;
            }
            await this.signedRequest("DELETE", "/fapi/v1/order", deleteParams).catch(() => null);

            const newTpParams: Record<string, any> = {
                symbol,
                side: bSide,
                type: "TAKE_PROFIT_MARKET",
                stopPrice,
                closePosition: "true",
                workingType: "MARK_PRICE",
            };
            const newRes = await this.signedRequest("POST", "/fapi/v1/order", newTpParams);

            if (newRes?.orderId) {
                plLogger.info(`[TP_UPDATE] (Replaced) Symbol: ${symbol} | New Order ID: ${newRes.orderId} | TP: ${stopPrice}`);
                return { success: true, tpPrice: stopPrice };
            }
        } catch (err: any) {
            const errMsg = err?.message || String(err);
            plLogger.warn(`[TP_UPDATE_FAILED] Symbol: ${symbol} | Order ID: ${id} | Error: ${errMsg}`);
            if (
                errMsg.includes("Order does not exist") ||
                errMsg.includes("Unknown order") ||
                errMsg.includes("-2011")
            ) {
                return { success: false, tpPrice: tp, isAlreadyTriggered: true };
            }
            throw err;
        }

        return { success: false, tpPrice: tp };
    }

    async getOrderLeverage(productId: number | string): Promise<{ success: boolean; result?: { leverage: number; order_margin: string; product_id: number } }> {
        const c = TradingConfig.getConfig();
        const symbol = this.formatSymbol(productId ? String(productId) : c.SYMBOL);

        const res = await this.signedRequest("GET", "/fapi/v2/positionRisk", { symbol });
        let leverage = 1;

        if (Array.isArray(res) && res.length > 0) {
            const match = res.find((p: any) => this.formatSymbol(p.symbol) === symbol) || res[0];
            leverage = Number(match.leverage ?? 1);
        } else if (res && res.leverage) {
            leverage = Number(res.leverage);
        }

        return {
            success: true,
            result: {
                leverage,
                order_margin: "0",
                product_id: Number(productId) || 0,
            },
        };
    }

    async changeOrderLeverage(productId: number | string, leverage: number): Promise<{ success: boolean; result?: { leverage: number; order_margin: string; product_id: number } }> {
        const c = TradingConfig.getConfig();
        const symbol = this.formatSymbol(productId ? String(productId) : c.SYMBOL);

        const res = await this.signedRequest("POST", "/fapi/v1/leverage", {
            symbol,
            leverage: Math.floor(leverage),
        });

        return {
            success: true,
            result: {
                leverage: Number(res?.leverage ?? leverage),
                order_margin: "0",
                product_id: Number(productId) || 0,
            },
        };
    }
}

export const binanceExchange = new BinanceExchange();
