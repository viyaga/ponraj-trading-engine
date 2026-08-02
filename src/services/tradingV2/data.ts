import { env } from "../../config";

import { ITradeState, TradeState } from "../../models/tradeState.model";
import { TradingConfig } from "./config";
import { configDebugLogger, tradingCronLogger } from "./logger";
import { ConfigType, ActiveSubscribedBot } from "./type";
import { ProcessPendingState } from "./ProcessPendingState";
import { decrypt } from "../../utils/crypto";

import { ExchangeAdapterFactory } from "./adapters/exchange.factory";

export class Data {
    // Static in-memory cache for exchange product specs (1 hour TTL)
    private static productCache = new Map<string, { data: any; timestamp: number }>();
    private static PRODUCT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

    // Static in-memory cache for bot configs (30 seconds TTL)
    private static configCache: { data: ConfigType[]; timestamp: number } | null = null;
    private static CONFIG_CACHE_TTL_MS = 30 * 1000; // 30 seconds

    static async getOrCreateState(
        tradingBotId: string,
        userId: string,
        sym: string,
        pid: number | string,
        multiplier: number = 0,
        currentPrice: number = 0
    ): Promise<ITradeState> {
        // 1. Try to find existing active (open) state
        let st = await TradeState.findOne({
            tradingBotId,
            status: 'open'
        });

        if (st) {
            // Only update if fields actually differ (migration/sync safety)
            if (st.symbol !== sym || Number(st.productId) !== Number(pid) || st.userId !== userId) {
                tradingCronLogger.info(`[Data] Updating active state metadata for ${sym}`, {
                    old: { symbol: st.symbol, pid: st.productId, userId: st.userId },
                    new: { symbol: sym, pid, userId }
                });
                st.symbol = sym;
                st.productId = Number(pid);
                st.userId = userId;
                await st.save();
            }

            // If we have an active open state but haven't placed an entry order yet,
            // recalculate the quantity based on the current price, current config, and multiplier.
            if (!st.entryOrderId) {
                const lastClosed = await TradeState.findOne({ tradingBotId, status: 'closed' })
                    .sort({ updatedAt: -1 });
                const isLoss = lastClosed?.tradeOutcome === 'loss';

                let quantity = TradingConfig.getConfig().INITIAL_BASE_QUANTITY || 1;
                if (isLoss && currentPrice > 0) {
                    const netDebt = (lastClosed?.pnl || 0) - (lastClosed?.cumulativeFees || 0);
                    quantity = ProcessPendingState.calculateMartingaleLots(netDebt, currentPrice, multiplier);
                    tradingCronLogger.info(`[Data] Recalculated recovery quantity for pending entry on ${sym}: ${quantity} (Level: ${st.currentLevel}, NetDebt: ${netDebt.toFixed(2)}, Multiplier: ${multiplier})`);
                } else {
                    quantity = TradingConfig.getConfig().INITIAL_BASE_QUANTITY || 1;
                }

                if (!quantity || isNaN(quantity) || quantity <= 0) {
                    quantity = Math.max(1, TradingConfig.getConfig().INITIAL_BASE_QUANTITY || 1);
                }

                if (st.quantity !== quantity) {
                    tradingCronLogger.info(`[Data] Updating pending entry quantity from ${st.quantity} to ${quantity} for ${sym}`);
                    st.quantity = quantity;
                    await st.save();
                }
            }

            tradingCronLogger.debug(`[Data] Loaded active state for ${sym}`, { id: st._id });
            return st;
        }

        // 2. No active state found. Look for the latest closed state to inherit lifetime stats.
        const lastClosed = await TradeState.findOne({ tradingBotId, status: 'closed' })
            .sort({ updatedAt: -1 });

        const allTimePnl = lastClosed?.allTimePnl || 0;
        const allTimeFees = lastClosed?.allTimeFees || 0;

        // 🗓 Daily PnL Reset Logic (UTC)
        const now = new Date();
        const lastUpdate = lastClosed?.updatedAt ? new Date(lastClosed.updatedAt) : null;
        const isSameDay = lastUpdate &&
            lastUpdate.getUTCDate() === now.getUTCDate() &&
            lastUpdate.getUTCMonth() === now.getUTCMonth() &&
            lastUpdate.getUTCFullYear() === now.getUTCFullYear();

        const dailyPnl = isSameDay ? (lastClosed?.dailyPnl || 0) : 0;

        const cfg = TradingConfig.getConfig();
        const dailyLossLimitUSD = cfg.CAPITAL_AMOUNT * (cfg.DAILY_LOSS_LIMIT / 100);

        // If the last session was a loss, we inherit its level and calculate next recovery quantity
        const isLoss = lastClosed?.tradeOutcome === 'loss';
        const currentLevel = isLoss ? (lastClosed?.currentLevel || 1) : 1;
        const sessionPnl = isLoss ? (lastClosed?.pnl || 0) : 0;
        const sessionFees = isLoss ? (lastClosed?.cumulativeFees || 0) : 0;

        let quantity = TradingConfig.getConfig().INITIAL_BASE_QUANTITY || 1;
        if (isLoss && currentPrice > 0) {
            const netDebt = sessionPnl - sessionFees;
            quantity = ProcessPendingState.calculateMartingaleLots(netDebt, currentPrice, multiplier);
            tradingCronLogger.info(`[Data] Calculated recovery quantity for ${sym}: ${quantity} (Level: ${currentLevel}, NetDebt: ${netDebt.toFixed(2)}, Multiplier: ${multiplier})`);
        } else if (isLoss) {
            // Fallback to previous quantity if currentPrice is not available (safety)
            quantity = lastClosed?.quantity || quantity;
            tradingCronLogger.warn(`[Data] Falling back to previous quantity for ${sym} due to missing price: ${quantity}`);
        }

        // Final safety check to ensure quantity is never 0/NaN/falsy
        if (!quantity || isNaN(quantity) || quantity <= 0) {
            quantity = Math.max(1, TradingConfig.getConfig().INITIAL_BASE_QUANTITY || 1);
        }

        // 3. Create a new open state
        st = await TradeState.create({
            tradingBotId,
            userId,
            symbol: sym,
            productId: Number(pid),
            status: 'open',
            currentLevel,
            tradeOutcome: "none",
            pnl: sessionPnl,
            cumulativeFees: sessionFees,
            dailyPnl,
            dailyLossLimitUSD,
            allTimePnl,
            allTimeFees,
            quantity
        });

        tradingCronLogger.info(`[Data] Created new active state for ${sym} (Inherited PnL: ${allTimePnl}, Quantity: ${quantity})`, { id: st._id });
        return st;
    }

    private static async fetchDeltaProduct(mappedSymbol: string, baseUrl: string): Promise<any> {
        const cacheKey = `delta:${mappedSymbol}`;
        const cached = this.productCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < this.PRODUCT_CACHE_TTL_MS)) {
            return cached.data;
        }

        const productUrl = `${baseUrl}/products/${mappedSymbol}`;
        const maxProductRetries = 3;

        for (let attempt = 1; attempt <= maxProductRetries; attempt++) {
            try {
                tradingCronLogger.debug(`[fetchTradingConfigs] Fetching Delta product data for: ${mappedSymbol} from: ${productUrl} (Attempt ${attempt}/${maxProductRetries})`);
                const productRes = await fetch(productUrl);
                if (productRes.ok) {
                    const productData: any = await productRes.json();
                    if (productData.success && productData.result) {
                        this.productCache.set(cacheKey, { data: productData.result, timestamp: Date.now() });
                        tradingCronLogger.info(`[fetchTradingConfigs] ✓ Successfully fetched and cached Delta product data for ${mappedSymbol}`);
                        return productData.result;
                    }
                }
            } catch (err) {
                tradingCronLogger.error(`[fetchTradingConfigs] Error fetching Delta product for ${mappedSymbol} (Attempt ${attempt}/${maxProductRetries}):`, err);
            }
            if (attempt < maxProductRetries) {
                await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
            }
        }
        return null;
    }

    static async fetchTradingConfigs(
        params: { limit: number; offset: number }
    ): Promise<ConfigType[]> {
        const { limit, offset } = params;

        if (this.configCache && (Date.now() - this.configCache.timestamp < this.CONFIG_CACHE_TTL_MS)) {
            tradingCronLogger.debug(`[fetchTradingConfigs] Returning ${this.configCache.data.length} cached bot configs (TTL valid)`);
            return this.configCache.data;
        }

        const url = `${env.payloadUrl}/api/trading-bots/active-subscribed/all?limit=${limit}&offset=${offset}&serverIp=${env.serverIp}`;

        let bots: ActiveSubscribedBot[] = [];
        const maxConfigRetries = 3;

        for (let attempt = 1; attempt <= maxConfigRetries; attempt++) {
            try {
                const res = await fetch(url);
                if (!res.ok) {
                    tradingCronLogger.warn(`[fetchTradingConfigs] HTTP ${res.status} for ${url} (Attempt ${attempt}/${maxConfigRetries})`);
                    if (attempt === maxConfigRetries) break;
                } else {
                    bots = (await res.json()) as ActiveSubscribedBot[];
                    break;
                }
            } catch (err: any) {
                tradingCronLogger.error(`[fetchTradingConfigs] Fetch error for ${url} (Attempt ${attempt}/${maxConfigRetries}):`, err);
                if (attempt === maxConfigRetries) break;
            }
            await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        }

        if (!Array.isArray(bots)) {
            tradingCronLogger.error(`[fetchTradingConfigs] Expected array of bots, got:`, { bots });
            return [];
        }

        const defaultConfig = TradingConfig.defaultConfig;
        const deltaBaseUrl = defaultConfig.BASE_URL || "https://api.india.delta.exchange/v2";

        // 1. Identify unique Delta symbols using DeltaExchangeAdapter to avoid redundant API calls
        const deltaBots = bots.filter((b) => (b.EXCHANGE || "delta").toLowerCase() === "delta");
        const deltaAdapter = ExchangeAdapterFactory.getAdapterForExchange("delta");
        const uniqueDeltaMappedSymbols = [...new Set(
            deltaBots.map((bot) => deltaAdapter.mapSymbol(bot.SYMBOL || "")).filter(Boolean)
        )];

        tradingCronLogger.info(`[fetchTradingConfigs] Processing ${bots.length} active bots across exchanges. Found ${uniqueDeltaMappedSymbols.length} unique Delta symbols.`);

        // 2. Fetch Delta product metadata for uncached symbols in parallel
        const productDataMap = new Map<string, any>();
        await Promise.all(
            uniqueDeltaMappedSymbols.map(async (mappedSymbol) => {
                const product = await this.fetchDeltaProduct(mappedSymbol, deltaBaseUrl);
                if (product) {
                    productDataMap.set(mappedSymbol, product);
                }
            })
        );

        // 3. Merge bot configurations dynamically using exchange adapters
        const mergedConfigs: ConfigType[] = bots.map((bot) => {
            const exchangeName = (bot.EXCHANGE || "delta").toLowerCase();
            const adapter = ExchangeAdapterFactory.getAdapterForExchange(exchangeName);
            return adapter.prepareConfig(bot, defaultConfig, productDataMap);
        });

        tradingCronLogger.info(`[fetchTradingConfigs] Successfully processed and merged ${mergedConfigs.length} configs across exchanges`);
        mergedConfigs.forEach(cfg => {
            configDebugLogger.debug(`[fetchTradingConfigs] Final merged config for bot ${cfg.id} (${cfg.SYMBOL} on ${cfg.EXCHANGE})`, { config: cfg });
        });

        this.configCache = { data: mergedConfigs, timestamp: Date.now() };
        return mergedConfigs;
    }
}