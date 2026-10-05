// =============================================================================
// TradingConfig — Centralized config store (Kite/NIFTY version)
// =============================================================================

import { AsyncLocalStorage } from 'node:async_hooks';
import { ConfigType } from './type';
import { env } from '../../config';

export class TradingConfig {

    /* ─── Async storage (per-bot context) ───────────────────────────────── */
    static readonly configStore = new AsyncLocalStorage<ConfigType>();

    /* ─── Default config values (Kite/NIFTY options) ───────────────────── */
    static readonly defaultConfig: Partial<ConfigType> = {
        // Instrument defaults
        INDEX: 'NIFTY',
        EXCHANGE: 'NFO',
        LOT_SIZE: 65,     // 1 NIFTY lot = 65 units
        NUMBER_OF_LOTS: 1,
        EXPIRY_TYPE: 'weekly',

        // Timeframe
        TIMEFRAME: '15minute',

        // ATR-14 strategy (3:00 PM - 3:15 PM)
        ATR_STRATEGY_ENABLED: false,
        ATR_PERIOD: 14,
        TARGET_PROFIT_PCT: 10,    // legacy fallback
        STOP_LOSS_PCT: 5,     // legacy fallback
        MAX_LOSS_PER_DAY: 2500,  // ₹ max daily loss

        // Per-strategy TP / SL overrides
        ATR_STRATEGY_TP_PCT: 10,  // ATR 15m: exit when premium +10%
        ATR_STRATEGY_SL_PCT: 5,   // ATR 15m: exit when premium -5%
        UT_BOT_STRATEGY_TP_PCT: 20,  // UT Bot 1H: exit when premium +20%
        UT_BOT_STRATEGY_SL_PCT: 10,  // UT Bot 1H: exit when premium -10%
        CANDLE_PATTERN_STRATEGY_TP_PCT: 10, // Candle Pattern 15m: exit when premium +10%
        CANDLE_PATTERN_STRATEGY_SL_PCT: 10, // Candle Pattern 15m: exit when premium -10%

        // Option LTP Range Filter — select option with maximum price of 145
        OPTION_MIN_PREMIUM: env.optionMinPremium ?? 120,   // ₹ — only trade options priced ≥120
        OPTION_MAX_PREMIUM: env.optionMaxPremium ?? 145,   // ₹ — only trade options priced ≤145

        // Candle Pattern Strategy (Hammer & Shooting Star Day Reversal - 1st Priority)
        CANDLE_PATTERN_STRATEGY_ENABLED: true,
        HAMMER_MAX_BODY_PCT: 0.35,
        HAMMER_MIN_LOWER_WICK_RATIO: 2.0,
        HAMMER_MAX_UPPER_WICK_RATIO: 0.8,
        SHOOTING_STAR_MAX_BODY_PCT: 0.35,
        SHOOTING_STAR_MIN_UPPER_WICK_RATIO: 2.0,
        SHOOTING_STAR_MAX_LOWER_WICK_RATIO: 0.8,
        PATTERN_DAY_RANGE_PROXIMITY_PCT: 30, // within bottom/top 30% of day's range
        PATTERN_MIN_RANGE_ATR_RATIO: 0.35,   // candle range >= 0.35 * ATR(14)
        PATTERN_REQUIRE_EXACT_DAY_EXTREME: true, // Candle High/Low MUST be Day High/Low
        USE_CACHE_CANDLE: process.env.USE_CACHE_CANDLE === 'true' || false,
        CACHE_CANDLE_TARGET_TIME: process.env.CACHE_CANDLE_TARGET_TIME || '2026-10-01 10:00',

        // UT Bot Alerts Strategy (1H candle)
        UT_BOT_ENABLED: false,
        UT_BOT_KEY_VALUE: 1.0,
        UT_BOT_ATR_PERIOD: 10,
        UT_BOT_USE_HEIKIN_ASHI: false,
        UT_BOT_START_HOUR: 10,    // 10:15 AM IST (skips 9:15-10:15 opening noise)
        UT_BOT_START_MIN: 15,
        UT_BOT_END_HOUR: 15,    // 3:15 PM IST
        UT_BOT_END_MIN: 15,
        UT_BOT_SKIP_OPENING_CANDLE: true,        // skip opening 9:15 candle false breakouts
        UT_BOT_TRADE_ON_CANDLE_CLOSE: false,      // true = wait for 1H close (safer); false = trade on live crossover mid-candle

        // Trailing SL
        IS_TRAILING_SL_ENABLED: false,

        // Order settings
        ORDER_TYPE: 'MARKET',
        PRODUCT: 'MIS',          // MIS = intraday (auto-squared at 3:30 PM)
        MARKET_PROTECTION: -1,   // -1 = automatic market protection mandated by Zerodha for MARKET orders via API

        // Risk filters
        MAX_CONCURRENT_TRADES: 1,
        DAILY_LOSS_LIMIT: 10, // % of capital
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