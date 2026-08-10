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

        // Fixed 15m Timeframe
        TIMEFRAME:           '15minute',

        // ATR-14 strategy (3:00 PM - 3:15 PM)
        ATR_PERIOD:           14,
        TARGET_PROFIT_PCT:    7,     // exit when option premium +7%
        STOP_LOSS_PCT:        5,     // exit when option premium -5%
        MAX_LOSS_PER_DAY:     2500,  // ₹ max daily loss

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