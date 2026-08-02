import { Candle, ConfigType, TargetCandle } from "../type";
import { getInternalConfig } from "./config";
import {
    calculateATR,
    getRollingATRPercentAvg,
    calculateADXSeries,
    calculateVEISeries,
} from "./indicators";
import {
    detectMicroChop,
    isVolumeContracting,
    isTargetCandleNotGood,
    detectLiquiditySweep,
    getVolumeExpansionPoints,
    getTargetCandleVolumeSpike,
    isRangeCompressed,
} from "./price-action";
import { Utils } from "../utils";

export type TradeDirection = "BUY" | "SELL" | "NONE";

export interface MasterScoreResult {
    score: number;
    direction: TradeDirection;
    isTrade: boolean;
    reason?: string;
}

function clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
}

/* ================= BREAKOUT ================= */

function getBreakout(
    history: Candle[],
    target: TargetCandle,
    lookback: number,
    atr: number
) {
    const recent = history.slice(-lookback);
    if (recent.length < 2) return null;

    const prevHigh = Math.max(...recent.map(c => c.high));
    const prevLow = Math.min(...recent.map(c => c.low));

    const buffer = atr * 0.25;

    const breakoutUp = target.close > prevHigh + buffer;
    const breakoutDown = target.close < prevLow - buffer;

    if (!breakoutUp && !breakoutDown) return null;

    return { breakoutUp, breakoutDown, prevHigh, prevLow };
}

/* ================= MAIN ================= */

export function evaluateBreakoutTrade(
    candles: Candle[],
    target: TargetCandle,
    config: ConfigType
): MasterScoreResult {

    const cfg = getInternalConfig(config);

    if (candles.length < cfg.MIN_REQUIRED_CANDLES) {
        return { score: 0, direction: "NONE", isTrade: false, reason: "INSUFFICIENT_CANDLES" };
    }

    const history = candles.slice(0, -1);

    let score = 45; // ✅ reduced bias
    let direction: TradeDirection = "NONE";
    let breakoutLevel = 0;

    const latestClose = target.close;

    /* ================= ATR ================= */

    const atr = calculateATR(candles, cfg.ATR_PERIOD);
    const atrPercent = (atr / latestClose) * 100;
    const atrAvg = getRollingATRPercentAvg(candles, cfg.ATR_PERIOD);

    /* ================= BREAKOUT ================= */

    const breakout = getBreakout(history, target, cfg.LOOKBACK, atr);

    if (breakout) {
        if (breakout.breakoutUp) {
            direction = "BUY";
            breakoutLevel = breakout.prevHigh;
        } else {
            direction = "SELL";
            breakoutLevel = breakout.prevLow;
        }

        score += 20;

        // ✅ breakout strength
        const strength = Math.abs(target.close - breakoutLevel) / atr;

        if (strength > 0.8) score += 10;
        else if (strength > 0.5) score += 6;
        else score -= 6;
    } else {
        score -= 12;
    }

    /* ================= EMA TREND ================= */

    const ema20 = Utils.calculateEMA(candles, 20);
    const ema50 = Utils.calculateEMA(candles, 50);

    if (direction === "BUY" && ema20 > ema50) score += 6;
    else if (direction === "SELL" && ema20 < ema50) score += 6;
    else score -= 6;

    /* ================= CANDLE ================= */

    const bodyPercent = Utils.getBodyPercent(target);

    if (bodyPercent > 75) score += 15;
    else if (bodyPercent > 65) score += 10;
    else if (bodyPercent > 55) score += 5;
    else if (bodyPercent < 45) score -= 10;
    else if (bodyPercent < 35) score -= 15;

    // 🔥 ATR-Relative Candle Body Size Check
    const bodyHeight = Math.abs(target.close - target.open);
    if (atr > 0) {
        const bodyToAtrRatio = bodyHeight / atr;
        if (bodyToAtrRatio > 2.2) score -= 20; // ❗ Climax/exhaustion candle penalty
        else if (bodyToAtrRatio > 1.2) score += 10;
        else if (bodyToAtrRatio < 0.6) score -= 15;
    }

    // 🔥 Color Alignment Check vs Breakout Direction
    const candleColor = Utils.getCandleColor(target);
    if (direction === "BUY" && candleColor === "red") score -= 20;
    if (direction === "SELL" && candleColor === "green") score -= 20;

    /* ================= FAKE BREAKOUT FILTER ================= */

    const range = target.high - target.low;

    if (range > 0) {
        const upperWick = target.high - Math.max(target.open, target.close);
        const lowerWick = Math.min(target.open, target.close) - target.low;

        if (direction === "BUY" && upperWick / range > 0.25) score -= 15;
        if (direction === "SELL" && lowerWick / range > 0.25) score -= 15;
    }

    /* ================= VOLATILITY ================= */

    if (atrAvg > 0) {
        if (atrPercent > atrAvg * 1.2) score += 8;
        else if (atrPercent > atrAvg) score += 5;
        else score -= 4;
    }

    /* ================= COMPRESSION + EXPANSION ================= */

    const compressed = isRangeCompressed(candles, 5, cfg.LOOKBACK, 2);

    if (compressed) score += 10;

    if (compressed && atrPercent > atrAvg * 1.15) {
        score += 15; // 🔥 expansion phase
    }

    /* ================= VOLUME ================= */

    const volumeWindow = Math.min(20, candles.length);
    const avgVol = candles.slice(-volumeWindow).reduce((a, b) => a + b.volume, 0) / volumeWindow;

    const ratio = avgVol > 0 ? target.volume / avgVol : 0;

    if (ratio > 2.2) score += 12;
    else if (ratio > 1.8) score += 8;
    else if (ratio > 1.5) score += 5;
    else score -= 20; // 🔥 heavy penalty for low volume ratio

    // 🔥 Volume-Body Synergy Bonus
    if (ratio > 2.0 && bodyPercent > 70) {
        score += 8;
    }

    // ✅ pre-breakout contraction
    const preVol =
        candles.slice(-5, -1).reduce((a, b) => a + b.volume, 0) / 4;

    if (preVol < avgVol * 0.8) score += 5;

    if (isVolumeContracting(candles)) score -= 4;

    score += getVolumeExpansionPoints(candles);

    const spikePoints = getTargetCandleVolumeSpike(target, candles);
    score += spikePoints;

    // 🔥 CRITICAL: breakout confirmation via volume
    if (direction !== "NONE" && ratio < 1.5) {
        score -= 20; // ❗ extra penalty for breakout without clear volume spike
    }

    /* ================= ADX ================= */

    const adxSeries = calculateADXSeries(candles, cfg.ADX_PERIOD);
    if (adxSeries.length > 0) {
        const adx = adxSeries[adxSeries.length - 1];

        if (adx > cfg.ADX_WEAK_THRESHOLD + 10) score += 6;
        else if (adx > cfg.ADX_WEAK_THRESHOLD) score += 4;
        else score -= 4;
    }

    /* ================= MOMENTUM ================= */

    const prev = history[history.length - 1];

    if (
        (direction === "BUY" && target.close > prev.close) ||
        (direction === "SELL" && target.close < prev.close)
    ) {
        score += 6;
    } else {
        score -= 4;
    }

    /* ================= LIQUIDITY ================= */

    if (detectLiquiditySweep(candles, cfg.LOOKBACK)) {
        score += 5;
    }

    /* ================= CHOP ================= */

    if (
        detectMicroChop(
            candles,
            atrAvg,
            cfg.SMALL_BODY_PERCENT_THRESHOLD,
            cfg.SMALL_BODY_MIN_COUNT
        )
    ) {
        score -= 6;
    }

    /* ================= TARGET QUALITY ================= */

    if (isTargetCandleNotGood(target, atrPercent, 0.3)) {
        score -= 5;
    }

    /* ================= RETEST ================= */

    if (breakoutLevel > 0) {
        const distance = Math.abs(target.close - breakoutLevel) / breakoutLevel;

        if (distance < 0.002) score += 10;
        else if (distance < 0.005) score += 6;
        else if (distance < 0.01) score += 3;
        else score -= 6; // ❗ avoid chasing
    }

    score = clamp(score, 0, 100);

    return {
        score,
        direction,
        isTrade: score >= 55,
        reason: breakout ? (breakout.breakoutUp ? "BREAKOUT_UP" : "BREAKOUT_DOWN") : "NO_BREAKOUT"
    };
}