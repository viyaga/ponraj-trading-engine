// =============================================================================
// Data — Bot config fetching & state management (Kite/NIFTY version)
// =============================================================================

import { env } from '../../config';
import { ITradeState, TradeState } from '../../models/tradeState.model';
import { TradingConfig } from './config';
import { configDebugLogger, tradingCronLogger } from './logger';
import { ConfigType, ActiveSubscribedBot } from './type';

export class Data {

    // Config cache (30s TTL — refreshed per cron cycle)
    private static configCache: { data: ConfigType[]; timestamp: number } | null = null;
    private static CONFIG_CACHE_TTL_MS = 30 * 1000;

    // ─── Trade State ─────────────────────────────────────────────────────────

    static async getOrCreateState(
        tradingBotId: string,
        userId:       string,
        symbol:       string,  // e.g. 'NIFTY24JAN25000CE'
    ): Promise<ITradeState> {

        // 1. Try to find existing open state
        let st = await TradeState.findOne({ tradingBotId, status: 'open' });

        if (st) {
            // Sync symbol if changed (e.g. expiry rollover)
            if (st.symbol !== symbol) {
                st.symbol = symbol;
                await st.save();
            }
            tradingCronLogger.debug(`[Data] Loaded open state for bot ${tradingBotId}`);
            return st;
        }

        // 2. Inherit all-time PnL from last closed state
        const lastClosed = await TradeState.findOne({ tradingBotId, status: 'closed' })
            .sort({ updatedAt: -1 });

        const allTimePnl  = lastClosed?.allTimePnl  ?? 0;
        const allTimeFees = lastClosed?.allTimeFees ?? 0;

        // 3. Daily PnL reset (IST day boundary)
        const now     = new Date();
        const istDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const lastUpdated = lastClosed?.updatedAt
            ? new Date(new Date(lastClosed.updatedAt).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
            : null;
        const isSameDay = lastUpdated &&
            lastUpdated.getDate() === istDate.getDate() &&
            lastUpdated.getMonth() === istDate.getMonth() &&
            lastUpdated.getFullYear() === istDate.getFullYear();

        const dailyPnl = isSameDay ? (lastClosed?.dailyPnl ?? 0) : 0;

        const cfg = TradingConfig.getConfig();
        const dailyLossLimitINR = cfg.MAX_LOSS_PER_DAY ?? 2500; // ₹ per day

        // 4. Create new open state
        st = await TradeState.create({
            tradingBotId,
            userId,
            symbol,
            status:       'open',
            currentLevel: 1,
            tradeOutcome: 'none',
            pnl:          0,
            cumulativeFees: 0,
            dailyPnl,
            dailyLossLimitUSD: dailyLossLimitINR, // field name kept for DB compat; stores ₹
            allTimePnl,
            allTimeFees,
            quantity: cfg.LOT_SIZE * (cfg.NUMBER_OF_LOTS ?? 1),
        });

        tradingCronLogger.info(`[Data] Created new open state for bot ${tradingBotId} (allTimePnl: ₹${allTimePnl})`);
        return st;
    }

    // ─── Bot Config Fetching ─────────────────────────────────────────────────

    /**
     * Fetch active subscribed bots from Payload backend and map to ConfigType.
     * The backend returns bots filtered by server IP and active subscription status.
     */
    static async fetchTradingConfigs(
        params: { limit: number; offset: number }
    ): Promise<ConfigType[]> {

        const { limit, offset } = params;

        if (
            this.configCache &&
            Date.now() - this.configCache.timestamp < this.CONFIG_CACHE_TTL_MS
        ) {
            tradingCronLogger.debug(`[fetchTradingConfigs] Using cached configs (${this.configCache.data.length} bots)`);
            return this.configCache.data;
        }

        // Fetch from backend — exchange is always 'zerodha' now
        const url = `${env.payloadUrl}/api/trading-bots/active-subscribed/zerodha?limit=${limit}&offset=${offset}&serverIp=${env.serverIp}`;

        let bots: ActiveSubscribedBot[] = [];
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const res = await fetch(url);
                if (!res.ok) {
                    tradingCronLogger.warn(`[fetchTradingConfigs] HTTP ${res.status} (attempt ${attempt}/${maxRetries})`);
                } else {
                    bots = await res.json() as ActiveSubscribedBot[];
                    break;
                }
            } catch (err: any) {
                tradingCronLogger.error(`[fetchTradingConfigs] Fetch error (attempt ${attempt}/${maxRetries}): ${err.message}`);
            }
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, attempt * 2000));
            }
        }

        if (!Array.isArray(bots)) {
            tradingCronLogger.error('[fetchTradingConfigs] Expected array, got:', { bots });
            return [];
        }

        tradingCronLogger.info(`[fetchTradingConfigs] Fetched ${bots.length} active Zerodha bots`);

        const mergedConfigs: ConfigType[] = bots.map(bot => this.mapBotToConfig(bot));

        mergedConfigs.forEach(cfg => {
            configDebugLogger.debug(`[fetchTradingConfigs] Config for bot ${cfg.id} (${cfg.INDEX} | DRY_RUN: ${cfg.DRY_RUN})`);
        });

        this.configCache = { data: mergedConfigs, timestamp: Date.now() };
        return mergedConfigs;
    }

    // ─── Bot → ConfigType mapper ──────────────────────────────────────────────

    private static mapBotToConfig(bot: ActiveSubscribedBot): ConfigType {
        const defaults = TradingConfig.defaultConfig;
        return TradingConfig.buildConfig({
            id:           bot.id,
            USER_ID:      bot.USER_ID,

            // Kite credentials
            API_KEY:      bot.API_KEY,
            ACCESS_TOKEN: bot.ACCESS_TOKEN,

            // Instrument
            INDEX:           (bot.INDEX ?? defaults.INDEX) as 'NIFTY' | 'BANKNIFTY',
            EXCHANGE:        'NFO',
            LOT_SIZE:        bot.LOT_SIZE        ?? defaults.LOT_SIZE        ?? 75,
            NUMBER_OF_LOTS:  bot.NUMBER_OF_LOTS  ?? defaults.NUMBER_OF_LOTS  ?? 1,
            EXPIRY_TYPE:     (bot.EXPIRY_TYPE    ?? defaults.EXPIRY_TYPE)    as 'weekly' | 'monthly',

            // Timeframe (fixed to 15m)
            TIMEFRAME: '15minute',

            // Strategy (3:00 PM - 3:15 PM)
            ATR_PERIOD:          bot.ATR_PERIOD         ?? defaults.ATR_PERIOD         ?? 14,
            TARGET_PROFIT_PCT:   bot.TARGET_PROFIT_PCT  ?? defaults.TARGET_PROFIT_PCT  ?? 7,
            STOP_LOSS_PCT:       bot.STOP_LOSS_PCT      ?? defaults.STOP_LOSS_PCT      ?? 5,
            MAX_LOSS_PER_DAY:    bot.MAX_LOSS_PER_DAY   ?? defaults.MAX_LOSS_PER_DAY   ?? 2500,

            // UT Bot Alerts Strategy (1H Candle - 1st Priority)
            UT_BOT_ENABLED:         bot.UT_BOT_ENABLED         ?? defaults.UT_BOT_ENABLED         ?? true,
            UT_BOT_KEY_VALUE:       bot.UT_BOT_KEY_VALUE       ?? defaults.UT_BOT_KEY_VALUE       ?? 1.0,
            UT_BOT_ATR_PERIOD:      bot.UT_BOT_ATR_PERIOD      ?? defaults.UT_BOT_ATR_PERIOD      ?? 10,
            UT_BOT_USE_HEIKIN_ASHI: bot.UT_BOT_USE_HEIKIN_ASHI ?? defaults.UT_BOT_USE_HEIKIN_ASHI ?? false,

            // Trailing SL
            IS_TRAILING_SL_ENABLED: bot.IS_TRAILING_SL_ENABLED ?? defaults.IS_TRAILING_SL_ENABLED ?? true,

            // Orders
            ORDER_TYPE: (bot.ORDER_TYPE ?? defaults.ORDER_TYPE ?? 'MARKET') as 'MARKET' | 'LIMIT',
            PRODUCT:    (bot.PRODUCT    ?? defaults.PRODUCT    ?? 'MIS')    as 'MIS' | 'NRML',

            // Risk
            MAX_CONCURRENT_TRADES:    bot.MAX_CONCURRENT_TRADES    ?? defaults.MAX_CONCURRENT_TRADES    ?? 1,
            DAILY_LOSS_LIMIT:         bot.DAILY_LOSS_LIMIT         ?? defaults.DAILY_LOSS_LIMIT         ?? 10,
            IS_WEEKEND_SAFETY_ENABLED: bot.IS_WEEKEND_SAFETY_ENABLED ?? defaults.IS_WEEKEND_SAFETY_ENABLED ?? true,

            DRY_RUN: bot.DRY_RUN ?? defaults.DRY_RUN ?? true, // default: safe
        });
    }

    // ─── Daily loss check ─────────────────────────────────────────────────────

    static async isDailyLossLimitReached(
        tradingBotId: string,
        maxLossPerDay: number
    ): Promise<boolean> {
        const st = await TradeState.findOne({ tradingBotId, status: 'open' });
        if (!st) return false;
        return (st.dailyPnl ?? 0) <= -Math.abs(maxLossPerDay);
    }

    // ─── Open position check ──────────────────────────────────────────────────

    static async hasOpenPosition(tradingBotId: string): Promise<boolean> {
        const st = await TradeState.findOne({ tradingBotId, status: 'open' });
        return !!(st?.entryOrderId);
    }
}