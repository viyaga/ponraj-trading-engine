import { DeltaExchange, deltaExchange } from "../delta-exchange";
import { ActiveSubscribedBot, CancelAllOrdersFilter, ConfigType, OrderDetails, OrderSide, TickerData } from "../type";
import { IExchangeAdapter } from "./IExchangeAdapter";
import { decrypt } from "../../../utils/crypto";
import { tradingCronLogger } from "../logger";

export class DeltaExchangeAdapter implements IExchangeAdapter {
    readonly exchangeName = "delta";
    private readonly client: DeltaExchange;

    constructor(client: DeltaExchange = deltaExchange) {
        this.client = client;
    }

    mapSymbol(symbol: string): string {
        if (!symbol) return symbol;
        return symbol.endsWith("USDT") ? symbol.replace("USDT", "USD") : symbol;
    }

    prepareConfig(
        bot: ActiveSubscribedBot,
        defaultConfig: Partial<ConfigType>,
        productDataMap: Map<string, any>
    ): ConfigType {
        const rawSymbol = bot.SYMBOL;
        const mappedSymbol = this.mapSymbol(rawSymbol);
        const deltaBaseUrl = defaultConfig.BASE_URL || "https://api.india.delta.exchange/v2";

        const config: ConfigType = {
            ...defaultConfig,
            ...bot,
            id: bot.id,
            EXCHANGE: this.exchangeName,
            API_KEY: decrypt(bot.API_KEY),
            SECRET_KEY: decrypt(bot.SECRET_KEY),
            TRADING_MODE: bot.TRADING_MODE === ("safe" as any) ? "conservative" : bot.TRADING_MODE,
            IS_WEEKEND_SAFETY_ENABLED: bot.IS_WEEKEND_SAFETY_ENABLED !== false,
            BASE_URL: deltaBaseUrl,
        } as ConfigType;

        const p = productDataMap.get(mappedSymbol);
        if (p) {
            const decimals = p.tick_size && p.tick_size.includes('.')
                ? p.tick_size.split('.')[1].length
                : 0;

            config.PRICE_DECIMAL_PLACES = decimals;
            config.LOT_SIZE = Number(p.contract_value);
            config.PRODUCT_ID = Number(p.id || bot.PRODUCT_ID);
            config.SYMBOL = p.symbol;

            tradingCronLogger.info(`[DeltaAdapter] ✓ Configured bot ${config.id} [${rawSymbol}] (ID: ${p.id}, Decimals: ${decimals}, Lot: ${config.LOT_SIZE})`);
        } else {
            tradingCronLogger.warn(`[DeltaAdapter] ⚠ No product metadata available for bot ${config.id} [${rawSymbol}]`);
        }

        return config;
    }

    async getCandlestickData(symbol: string, resolution: string, start: number, end: number): Promise<any> {
        return this.client.getCandlestickData(symbol, resolution, start, end);
    }

    async getTickerData(symbol: string): Promise<TickerData | null> {
        return this.client.getTickerData(symbol);
    }

    async getOrderDetails(id: string): Promise<OrderDetails | null> {
        return this.client.getOrderDetails(id);
    }

    async placeEntryOrder(symbol: string, side: OrderSide, qty: number, cid?: string): Promise<any> {
        return this.client.placeEntryOrder(symbol, side, qty, cid);
    }

    async placeTPSLBracketOrder(
        tp: number,
        sl: number,
        side: OrderSide,
        logContext?: any,
        entryPrice?: number
    ): Promise<{ success: boolean; ids: { tp: string; sl: string }; isNoPosition?: boolean }> {
        return this.client.placeTPSLBracketOrder(tp, sl, side, logContext, entryPrice);
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
        return this.client.updateStopLossOrder(id, slPrice, productId, productSymbol, orderSide, sl, logContext);
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
        return this.client.updateTakeProfitOrder(id, tpPrice, productId, productSymbol, orderSide, tp, logContext);
    }

    async cancelStopOrders(filter: CancelAllOrdersFilter, logContext?: any): Promise<{ success: boolean }> {
        return this.client.cancelStopOrders(filter, logContext);
    }

    async getPositions(productId?: number | string): Promise<any> {
        return this.client.getPositions(productId);
    }

    async getOrderLeverage(productId: number | string): Promise<any> {
        return this.client.getOrderLeverage(productId);
    }

    async changeOrderLeverage(productId: number | string, leverage: number): Promise<any> {
        return this.client.changeOrderLeverage(productId, leverage);
    }
}
