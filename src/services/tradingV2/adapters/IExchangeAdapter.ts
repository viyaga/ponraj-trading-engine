import { ActiveSubscribedBot, CancelAllOrdersFilter, ConfigType, OrderDetails, OrderSide, Position, TickerData } from "../type";

export interface IExchangeAdapter {
    readonly exchangeName: string;

    mapSymbol(symbol: string): string;
    prepareConfig(
        bot: ActiveSubscribedBot,
        defaultConfig: Partial<ConfigType>,
        productDataMap: Map<string, any>
    ): ConfigType;

    getCandlestickData(symbol: string, resolution: string, start: number, end: number): Promise<any>;
    getTickerData(symbol: string): Promise<TickerData | null>;
    getOrderDetails(id: string): Promise<OrderDetails | null>;

    placeEntryOrder(symbol: string, side: OrderSide, qty: number, cid?: string): Promise<any>;
    placeTPSLBracketOrder(
        tp: number,
        sl: number,
        side: OrderSide,
        logContext?: any,
        entryPrice?: number
    ): Promise<{ success: boolean; ids: { tp: string; sl: string }; isNoPosition?: boolean }>;

    updateStopLossOrder(
        id: number | string,
        slPrice: number,
        productId: number | string,
        productSymbol: string,
        orderSide: OrderSide,
        sl: number,
        logContext?: any
    ): Promise<{ success: boolean; slPrice: number; isSlSame?: boolean; isSlReversed?: boolean; isAlreadyTriggered?: boolean }>;

    updateTakeProfitOrder(
        id: number | string,
        tpPrice: number,
        productId: number | string,
        productSymbol: string,
        orderSide: OrderSide,
        tp: number,
        logContext?: any
    ): Promise<{ success: boolean; tpPrice: number; isTpSame?: boolean; isAlreadyTriggered?: boolean }>;

    cancelStopOrders(filter: CancelAllOrdersFilter, logContext?: any): Promise<{ success: boolean }>;
    getPositions(productId?: number | string): Promise<any>;
    getOrderLeverage(productId: number | string): Promise<any>;
    changeOrderLeverage(productId: number | string, leverage: number): Promise<any>;
}
