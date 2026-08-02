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

        // Timeframes (Kite interval strings)
        ENTRY_TIMEFRAME:          '5minute',
        CONFIRMATION_TIMEFRAME:   '15minute',
        STRUCTURE_TIMEFRAME:      '60minute',

        // ATR-14 strategy
        ATR_PERIOD:           14,
        ATR_MULTIPLIER:       1.25,  // TR must be > 1.25 × ATR14 to signal
        TARGET_PROFIT_PCT:    15,    // exit when option premium +15%
        STOP_LOSS_PCT:        8,     // exit when option premium -8%
        MAX_LOSS_PER_DAY:     2500,  // ₹ max daily loss

        // Trailing SL
        IS_TRAILING_SL_ENABLED: true,
        TRAILING_SL_MULTIPLIER: 1.5,

        // Order settings
        ORDER_TYPE:  'MARKET',
        PRODUCT:     'MIS',          // MIS = intraday (auto-squared at 3:30 PM)

        // Risk filters
        MAX_CONCURRENT_TRADES:    1,
        DAILY_LOSS_LIMIT:         10, // % of capital
        IS_WEEKEND_SAFETY_ENABLED: true,
        MIN_FINAL_SCORE:           70, // minimum composite score to enter

        // Safety
        DRY_RUN: true, // ← default: true (paper trading mode)
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