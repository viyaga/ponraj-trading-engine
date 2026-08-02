import { TradingConfig } from "../config";
import { BinanceExchangeAdapter } from "./binance.adapter";
import { DeltaExchangeAdapter } from "./delta.adapter";
import { IExchangeAdapter } from "./IExchangeAdapter";
import { tradingCronLogger } from "../logger";

export class ExchangeAdapterFactory {
    private static deltaAdapterInstance = new DeltaExchangeAdapter();
    private static binanceAdapterInstance = new BinanceExchangeAdapter();

    static getAdapterForExchange(exchangeName: string): IExchangeAdapter {
        const ex = (exchangeName || "delta").toLowerCase();
        switch (ex) {
            case "delta":
                return this.deltaAdapterInstance;
            case "binance":
                return this.binanceAdapterInstance;
            default:
                tradingCronLogger.warn(`[ExchangeAdapterFactory] Unrecognized exchange "${exchangeName}", falling back to default Delta adapter`);
                return this.deltaAdapterInstance;
        }
    }

    static getAdapter(): IExchangeAdapter {
        let exchange = "delta";
        try {
            const config = TradingConfig.getConfig();
            if (config?.EXCHANGE) {
                exchange = config.EXCHANGE.toLowerCase();
            }
        } catch {
            // Fallback to default exchange if no config context stored
        }

        return this.getAdapterForExchange(exchange);
    }
}
