// =============================================================================
// TradingConfig — Centralized config store (Kite/NIFTY version)
// =============================================================================

import { AsyncLocalStorage } from 'node:async_hooks';
import { ConfigType } from './type';

export class TradingConfig {

    /* ─── Async storage (per-bot context) ───────────────────────────────── */
    static readonly configStore = new AsyncLocalStorage<ConfigType>();

    /* ─── Default config values (Kite/NIFTY options) ───────────────────── */
    static readonly defaultConfig: Partial<ConfigType> = {
        // Instrument defaults
        INDEX:               'NIFTY',
        EXCHANGE:            'NFO',
        LOT_SIZE:            75,     // 1 NIFTY lot = 75 units
        NUMBER_OF_LOTS:      1,
        EXPIRY_TYPE:         'weekly',

        // Timeframe
        TIMEFRAME:           '15minute',

        // ATR-14 strategy (3:00 PM - 3:15 PM)
        ATR_PERIOD:           14,
        TARGET_PROFIT_PCT:    10,    // legacy fallback
        STOP_LOSS_PCT:        5,     // legacy fallback
        MAX_LOSS_PER_DAY:     2500,  // ₹ max daily loss

        // Per-strategy TP / SL overrides
        ATR_STRATEGY_TP_PCT:    10,  // ATR 15m: exit when premium +10%
        ATR_STRATEGY_SL_PCT:    5,   // ATR 15m: exit when premium -5%
        UT_BOT_STRATEGY_TP_PCT: 20,  // UT Bot 1H: exit when premium +20%
        UT_BOT_STRATEGY_SL_PCT: 10,  // UT Bot 1H: exit when premium -10%

        // Option LTP Range Filter
        OPTION_MIN_PREMIUM:   120,   // ₹ — only trade options priced ≥120
        OPTION_MAX_PREMIUM:   150,   // ₹ — only trade options priced ≤150

        // UT Bot Alerts Strategy (1H candle - 1st Priority)
        UT_BOT_ENABLED:       true,
        UT_BOT_KEY_VALUE:     1.0,
        UT_BOT_ATR_PERIOD:    10,
        UT_BOT_USE_HEIKIN_ASHI: false,

        // Trailing SL
        IS_TRAILING_SL_ENABLED: true,

        // Order settings
        ORDER_TYPE:  'MARKET',
        PRODUCT:     'MIS',          // MIS = intraday (auto-squared at 3:30 PM)

        // Risk filters
        MAX_CONCURRENT_TRADES:    1,
        DAILY_LOSS_LIMIT:         10, // % of capital
        IS_WEEKEND_SAFETY_ENABLED: true,

        // Safety
        DRY_RUN: true, // default: true (paper trading mode)
    };

    /* ─── Config resolver ───────────────────────────────────────────────── */
    static getConfig(): ConfigType {
        const stored = this.configStore.getStore();
        if (stored) return stored;
        throw new Error('[TradingConfig] No config found in AsyncLocalStorage context');
    }

    /* ─── Merge bot config with defaults ────────────────────────────────── */
    static buildConfig(overrides: Partial<ConfigType>): ConfigType {
        return { ...this.defaultConfig, ...overrides } as ConfigType;
    }
}