// ===========================================================================
// TradingConfigType
// Centralized configuration management with AsyncLocalStorage
// SINGLE CONFIG ONLY
// ZERO LOGIC CHANGES — mechanical refactor only
// ============================================================================

import { AsyncLocalStorage } from "node:async_hooks";
import { ConfigType } from "./type";

export class TradingConfig {

    /* -------------------------------------------------------------------------
       ASYNC STORAGE FOR PER-REQUEST CONFIG
    ---------------------------------------------------------------------------- */
    static readonly configStore = new AsyncLocalStorage<ConfigType>();

    /* ------------------------------------------------------------------------
       BASE DEFAULT CONFIG
    ------------------------------------------------------------------------- */
    static readonly defaultConfig: Partial<ConfigType> = {
        BASE_URL: "https://api.india.delta.exchange/v2",
        RUN_MINUTES: [0, 15, 30, 45],
        TIMEFRAME: "5m",
        CONFIRMATION_TIMEFRAME: "15m",
        STRUCTURE_TIMEFRAME: "1h",
        SL_TRIGGER_BUFFER_PERCENT: 0.2,
        SL_LIMIT_BUFFER_PERCENT: 0.3,
        TP_TRIGGER_BUFFER_PERCENT: 0.2,
        TP_LIMIT_BUFFER_PERCENT: 0.3,
        MAX_ALLOWED_PRICE_MOVEMENT_PERCENT: 1.5,
        MIN_RR: 1.0,
        MIN_RR_ENFORCEMENT_MODE: "tp",
        MIN_SL_SAFETY_BUFFER_PERCENT: 0.2,
        MIN_TP_PRICE_MOVEMENT_PERCENT: 0.4,
        MAX_TP_PRICE_MOVEMENT_PERCENT: 3.0,
        MAX_SL_PRICE_MOVEMENT_PERCENT: 1.5,
        DRY_RUN: false,
        IS_TESTING: process.env.IS_TESTING === "true",
        IS_TRAILING_SL_ENABLED: false,
        SL_SELECTION_MODE: "fixed_atr",
        TP_SELECTION_MODE: "fixed_atr",
        SL_ATR_MULTIPLIER: 1.0,
        TP_ATR_MULTIPLIER: 2.0,
        CONFIRMATION_LOOKBACK: 48,
        ESTIMATED_FEE_PERCENT: 0.1,
        IS_WEEKEND_SAFETY_ENABLED: true,
        IS_CANDLE_LIMIT_EXIT_ENABLED: true,
        MAX_HOLDING_CANDLES_MAP: {
            "5m": 12,
            "15m": 8,
            "1h": 6,
            "4h": 4
        },
        EXCHANGE: "delta",
        MIN_ENTRY_SCORE: 0,
        MIN_CONFIRMATION_SCORE: 60,
        MIN_STRUCTURE_SCORE: 20,
        MIN_FINAL_SCORE: 70,
        IS_MOMENTUM_INVALIDATION_EXIT_ENABLED: true,
        MOMENTUM_INVALIDATION_SCORE_THRESHOLD: 20,
        MOMENTUM_INVALIDATION_CONFIRMATION_THRESHOLD: 40,
        MOMENTUM_INVALIDATION_STRUCTURE_THRESHOLD: 15,
        MOMENTUM_INVALIDATION_CONSECUTIVE_CYCLES: 2,
        IS_TP_REDUCTION_ENABLED: true,
    }

    /* -------------------------------------------------------------------------
       CONFIG RESOLVER
    ---------------------------------------------------------------------------- */
    static getConfig(user_id?: string, product_symbol?: string): ConfigType {

        const stored = this.configStore.getStore();

        if (stored) {
            return stored;
        }

        throw new Error("No config found");
    }
}