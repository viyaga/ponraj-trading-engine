import { ConfigType, InternalChopConfig } from "../type";

export function getInternalConfig(config: ConfigType): InternalChopConfig {
    const timeframe = (config.TIMEFRAME || "15m").toLowerCase();

    let lookback = 36;

    if (timeframe.includes("5m")) lookback = 36;
    else if (timeframe.includes("15m")) lookback = 48;
    else if (timeframe.includes("1h")) lookback = 48;
    else if (timeframe.includes("4h")) lookback = 60;

    const resolvedLookback = config.LOOKBACK ?? lookback;
    const resolvedConfLookback = config.CONFIRMATION_LOOKBACK ?? 48;

    const base: Record<string, InternalChopConfig> = {
        conservative: {
            ATR_PERIOD: 14,
            ADX_PERIOD: 14,
            ADX_WEAK_THRESHOLD: 22,
            LOOKBACK: resolvedLookback,
            CONFIRMATION_LOOKBACK: resolvedConfLookback,
            SMALL_BODY_PERCENT_THRESHOLD: 50,
            SMALL_BODY_MIN_COUNT: 7,
            MIN_REQUIRED_CANDLES: 70,
            PROBABILITY_THRESHOLD: 68,
        },

        balanced: {
            ATR_PERIOD: 14,
            ADX_PERIOD: 14,
            ADX_WEAK_THRESHOLD: 20,
            LOOKBACK: resolvedLookback,
            CONFIRMATION_LOOKBACK: resolvedConfLookback,
            SMALL_BODY_PERCENT_THRESHOLD: 48,
            SMALL_BODY_MIN_COUNT: 6,
            MIN_REQUIRED_CANDLES: 60,
            PROBABILITY_THRESHOLD: 60,
        },

        aggressive: {
            ATR_PERIOD: 10,
            ADX_PERIOD: 10,
            ADX_WEAK_THRESHOLD: 18,
            LOOKBACK: resolvedLookback,
            CONFIRMATION_LOOKBACK: resolvedConfLookback,
            SMALL_BODY_PERCENT_THRESHOLD: 45,
            SMALL_BODY_MIN_COUNT: 5,
            MIN_REQUIRED_CANDLES: 40,
            PROBABILITY_THRESHOLD: 52,
        },
    };

    return base[config.TRADING_MODE] ?? base.balanced;
}