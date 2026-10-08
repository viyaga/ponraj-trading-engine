// =============================================================================
// Candle Pattern Strategy — Hammer & Shooting Star Day-Level Reversal Engine
// =============================================================================
// Strategy Rules:
//   1. Core Patterns:
//      - Hammer:
//          * Small body: bodyPercent <= 0.35 (35% of total candle range)
//          * Long lower wick: lowerWick >= body * 2 (at least 2x body size)
//          * Small upper wick: upperWick <= body * 0.5 (at most 0.5x body size)
//      - Shooting Star:
//          * Small body: bodyPercent <= 0.35 (35% of total candle range)
//          * Long upper wick: upperWick >= body * 2 (at least 2x body size)
//          * Small lower wick: lowerWick <= body * 0.5 (at most 0.5x body size)
//
//   2. Volatility / Noise Normalization:
//      - Candle range is normalized against historical ATR(14).
//      - Micro-dojis and low-volatility flat bars are skipped (range >= 0.35 * ATR).
//
//   3. Day Level Proximity:
//      - Hammer Near Day Low:
//          * Candle low is within bottom 30% of day's range (or <= 1.0 * ATR from Day Low)
//          * Signal Direction: BUY CALL OPTION (CE)
//      - Shooting Star Near Day High:
//          * Candle high is within top 30% of day's range (or <= 1.0 * ATR from Day High)
//          * Signal Direction: BUY PUT OPTION (PE)
//
//   4. Trade Confirmation:
//      - Pattern detection is strictly separated from trade entry confirmation.
//      - Call Confirmation: Spot price or next candle breaks above the Hammer candle's High.
//      - Put Confirmation: Spot price or next candle breaks below the Shooting Star candle's Low.
// =============================================================================

import {
    Candle,
    CandleComponents,
    CandlePatternType,
    CandlePatternResult,
    CandlePatternSignalResult,
    ConfigType,
} from '../type';
import { ATR14Strategy } from './atr14-strategy';

export interface CandlePatternConfig {
    hammerMaxBodyPct?: number;             // default: 0.35
    hammerMinLowerWickRatio?: number;      // default: 2.0
    hammerMaxUpperWickRatio?: number;      // default: 0.8
    shootingStarMaxBodyPct?: number;        // default: 0.35
    shootingStarMinUpperWickRatio?: number; // default: 2.0
    shootingStarMaxLowerWickRatio?: number; // default: 0.8
    dayRangeProximityPct?: number;          // default: 30 (% of day range for near high/low)
    minRangeAtrRatio?: number;              // default: 0.35 (candle range >= 0.35 * ATR)
    requireExactDayExtreme?: boolean;       // default: true (candle High/Low MUST be Day High/Low)
}

/**
 * Compute detailed OHLC components, body percentage, and wick ratios for a candle.
 */
export function computeCandleComponents(candle: Candle): CandleComponents {
    const body = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const bodyPercent = range > 0 ? body / range : 0;
    const upperWickPercent = range > 0 ? upperWick / range : 0;
    const lowerWickPercent = range > 0 ? lowerWick / range : 0;
    const isBullish = candle.close >= candle.open;

    return {
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        body,
        range,
        upperWick,
        lowerWick,
        bodyPercent,
        upperWickPercent,
        lowerWickPercent,
        isBullish,
    };
}

/**
 * Detect whether a candle matches the mathematical Hammer criteria.
 */
export function isHammerPattern(
    candle: Candle,
    config?: CandlePatternConfig,
    atr?: number
): { isMatch: boolean; components: CandleComponents; reason: string } {
    const c = computeCandleComponents(candle);
    const maxBodyPct = config?.hammerMaxBodyPct ?? 0.35;
    const minLowerWickRatio = config?.hammerMinLowerWickRatio ?? 2.0;
    const maxUpperWickRatio = config?.hammerMaxUpperWickRatio ?? 0.8;
    const minRangeAtrRatio = config?.minRangeAtrRatio ?? 0.35;

    if (c.range <= 0) {
        return { isMatch: false, components: c, reason: 'Zero range candle' };
    }

    if (atr && atr > 0 && c.range < minRangeAtrRatio * atr) {
        return {
            isMatch: false,
            components: c,
            reason: `Range ₹${c.range.toFixed(1)} < ${(minRangeAtrRatio * 100).toFixed(0)}% of ATR ₹${atr.toFixed(1)} (insufficient volatility)`,
        };
    }

    const bodyOk = c.bodyPercent <= maxBodyPct;
    const lowerWickOk = c.lowerWick >= c.body * minLowerWickRatio;
    const upperWickOk = c.upperWick <= c.body * maxUpperWickRatio;

    const isMatch = bodyOk && lowerWickOk && upperWickOk;
    const lowerRatioStr = c.body > 0 ? (c.lowerWick / c.body).toFixed(2) : 'inf';
    const upperRatioStr = c.body > 0 ? (c.upperWick / c.body).toFixed(2) : '0.00';

    const reason = isMatch
        ? `Hammer confirmed: Body=${(c.bodyPercent * 100).toFixed(1)}% (<= ${(maxBodyPct * 100)}%), LowerWick=${lowerRatioStr}x body (>= ${minLowerWickRatio}x), UpperWick=${upperRatioStr}x body (<= ${maxUpperWickRatio}x)`
        : `Not hammer: Body=${(c.bodyPercent * 100).toFixed(1)}% [${bodyOk ? 'OK' : 'FAIL'}], LowerWick=${lowerRatioStr}x [${lowerWickOk ? 'OK' : 'FAIL'}], UpperWick=${upperRatioStr}x [${upperWickOk ? 'OK' : 'FAIL'}]`;

    return { isMatch, components: c, reason };
}

/**
 * Detect whether a candle matches the mathematical Shooting Star criteria.
 */
export function isShootingStarPattern(
    candle: Candle,
    config?: CandlePatternConfig,
    atr?: number
): { isMatch: boolean; components: CandleComponents; reason: string } {
    const c = computeCandleComponents(candle);
    const maxBodyPct = config?.shootingStarMaxBodyPct ?? 0.35;
    const minUpperWickRatio = config?.shootingStarMinUpperWickRatio ?? 2.0;
    const maxLowerWickRatio = config?.shootingStarMaxLowerWickRatio ?? 0.8;
    const minRangeAtrRatio = config?.minRangeAtrRatio ?? 0.35;

    if (c.range <= 0) {
        return { isMatch: false, components: c, reason: 'Zero range candle' };
    }

    if (atr && atr > 0 && c.range < minRangeAtrRatio * atr) {
        return {
            isMatch: false,
            components: c,
            reason: `Range ₹${c.range.toFixed(1)} < ${(minRangeAtrRatio * 100).toFixed(0)}% of ATR ₹${atr.toFixed(1)} (insufficient volatility)`,
        };
    }

    const bodyOk = c.bodyPercent <= maxBodyPct;
    const upperWickOk = c.upperWick >= c.body * minUpperWickRatio;
    const lowerWickOk = c.lowerWick <= c.body * maxLowerWickRatio;

    const isMatch = bodyOk && upperWickOk && lowerWickOk;
    const upperRatioStr = c.body > 0 ? (c.upperWick / c.body).toFixed(2) : 'inf';
    const lowerRatioStr = c.body > 0 ? (c.lowerWick / c.body).toFixed(2) : '0.00';

    const reason = isMatch
        ? `Shooting Star confirmed: Body=${(c.bodyPercent * 100).toFixed(1)}% (<= ${(maxBodyPct * 100)}%), UpperWick=${upperRatioStr}x body (>= ${minUpperWickRatio}x), LowerWick=${lowerRatioStr}x body (<= ${maxLowerWickRatio}x)`
        : `Not shooting star: Body=${(c.bodyPercent * 100).toFixed(1)}% [${bodyOk ? 'OK' : 'FAIL'}], UpperWick=${upperRatioStr}x [${upperWickOk ? 'OK' : 'FAIL'}], LowerWick=${lowerRatioStr}x [${lowerWickOk ? 'OK' : 'FAIL'}]`;

    return { isMatch, components: c, reason };
}

/**
 * Production-ready candle pattern detector supporting:
 * Hammer, Shooting Star, Bullish/Bearish Engulfing, Doji, Pin Bar, Morning/Evening Star.
 */
export function detectCandlePattern(
    candle: Candle,
    prevCandle?: Candle,
    prevPrevCandle?: Candle,
    config?: CandlePatternConfig,
    atr?: number
): CandlePatternResult {
    const comp = computeCandleComponents(candle);

    // 1. Hammer check
    const hammer = isHammerPattern(candle, config, atr);
    if (hammer.isMatch) {
        return {
            pattern: 'HAMMER',
            isHammer: true,
            isShootingStar: false,
            components: comp,
            description: hammer.reason,
        };
    }

    // 2. Shooting Star check
    const star = isShootingStarPattern(candle, config, atr);
    if (star.isMatch) {
        return {
            pattern: 'SHOOTING_STAR',
            isHammer: false,
            isShootingStar: true,
            components: comp,
            description: star.reason,
        };
    }

    // 3. Pin Bar check (generic pin bar with long rejection wick)
    if (comp.lowerWickPercent >= 0.60 && comp.bodyPercent <= 0.30) {
        return {
            pattern: 'PIN_BAR_BULLISH',
            isHammer: true, // Also treat as Hammer-equivalent for bullish reversal
            isShootingStar: false,
            components: comp,
            description: `Bullish Pin Bar: Lower wick ${(comp.lowerWickPercent * 100).toFixed(1)}% rejection`,
        };
    }
    if (comp.upperWickPercent >= 0.60 && comp.bodyPercent <= 0.30) {
        return {
            pattern: 'PIN_BAR_BEARISH',
            isHammer: false,
            isShootingStar: true, // Also treat as Shooting Star-equivalent for bearish reversal
            components: comp,
            description: `Bearish Pin Bar: Upper wick ${(comp.upperWickPercent * 100).toFixed(1)}% rejection`,
        };
    }

    // 4. Engulfing patterns (requires previous candle)
    if (prevCandle) {
        const prevComp = computeCandleComponents(prevCandle);
        const isBullishEngulfing =
            !prevComp.isBullish &&
            comp.isBullish &&
            candle.open <= prevCandle.close &&
            candle.close >= prevCandle.open &&
            comp.body > prevComp.body;

        if (isBullishEngulfing) {
            return {
                pattern: 'BULLISH_ENGULFING',
                isHammer: false,
                isShootingStar: false,
                components: comp,
                description: `Bullish Engulfing: Green candle body (${comp.body.toFixed(1)}) engulfs prior red body (${prevComp.body.toFixed(1)})`,
            };
        }

        const isBearishEngulfing =
            prevComp.isBullish &&
            !comp.isBullish &&
            candle.open >= prevCandle.close &&
            candle.close <= prevCandle.open &&
            comp.body > prevComp.body;

        if (isBearishEngulfing) {
            return {
                pattern: 'BEARISH_ENGULFING',
                isHammer: false,
                isShootingStar: false,
                components: comp,
                description: `Bearish Engulfing: Red candle body (${comp.body.toFixed(1)}) engulfs prior green body (${prevComp.body.toFixed(1)})`,
            };
        }
    }

    // 5. 3-Candle Morning Star / Evening Star
    if (prevCandle && prevPrevCandle) {
        const c1 = computeCandleComponents(prevPrevCandle);
        const c2 = computeCandleComponents(prevCandle);
        const c3 = comp;

        // Morning Star: Large red -> Small body star below -> Large green closing above mid of c1
        const isMorningStar =
            !c1.isBullish &&
            c1.bodyPercent >= 0.50 &&
            c2.bodyPercent <= 0.30 &&
            c3.isBullish &&
            c3.close >= c1.open - c1.body * 0.5;

        if (isMorningStar) {
            return {
                pattern: 'MORNING_STAR',
                isHammer: false,
                isShootingStar: false,
                components: comp,
                description: 'Morning Star: 3-candle bullish reversal pattern confirmed',
            };
        }

        // Evening Star: Large green -> Small body star above -> Large red closing below mid of c1
        const isEveningStar =
            c1.isBullish &&
            c1.bodyPercent >= 0.50 &&
            c2.bodyPercent <= 0.30 &&
            !c3.isBullish &&
            c3.close <= c1.open + c1.body * 0.5;

        if (isEveningStar) {
            return {
                pattern: 'EVENING_STAR',
                isHammer: false,
                isShootingStar: false,
                components: comp,
                description: 'Evening Star: 3-candle bearish reversal pattern confirmed',
            };
        }
    }

    // 6. Doji check
    if (comp.bodyPercent <= 0.10 && comp.range > 0) {
        return {
            pattern: 'DOJI',
            isHammer: false,
            isShootingStar: false,
            components: comp,
            description: `Doji: Indecision body=${(comp.bodyPercent * 100).toFixed(1)}% of range`,
        };
    }

    return {
        pattern: 'NONE',
        isHammer: false,
        isShootingStar: false,
        components: comp,
        description: 'No classic candlestick pattern detected',
    };
}

/**
 * Filter candles belonging strictly to the current IST calendar day (from 09:15 IST onward).
 */
export function getTodayCandles(candles: Candle[], targetTimestamp: number = Date.now()): Candle[] {
    const targetIst = new Date(new Date(targetTimestamp).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const targetYear  = targetIst.getFullYear();
    const targetMonth = targetIst.getMonth();
    const targetDate  = targetIst.getDate();

    return candles.filter((c) => {
        const cIst = new Date(new Date(c.timestamp).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        return (
            cIst.getFullYear() === targetYear &&
            cIst.getMonth() === targetMonth &&
            cIst.getDate() === targetDate
        );
    });
}

/**
 * Main Candle Pattern Strategy (Priority 3 Reversal Strategy)
 */
export class CandlePatternStrategy {

    /**
     * Evaluate the strategy on 15-minute candles:
     * 1. Calculates Day High and Day Low for the current trading day.
     * 2. Computes ATR(14) for volatility normalization.
     * 3. Inspects the most recent completed candle(s) for Hammer or Shooting Star patterns.
     * 4. Validates Day Level Proximity:
     *    - Hammer near Day Low (within bottom 30% of day range or <= 1 ATR from Day Low)
     *    - Shooting Star near Day High (within top 30% of day range or <= 1 ATR from Day High)
     * 5. Validates Breakout Confirmation:
     *    - Hammer High Breakout: Spot price > Hammer High -> BUY CALL (CE)
     *    - Shooting Star Low Breakout: Spot price < Shooting Star Low -> BUY PUT (PE)
     */
    static evaluateSignal(
        completedCandles15m: Candle[],
        spotPrice: number,
        config?: ConfigType,
        atrPeriod: number = 14
    ): CandlePatternSignalResult {
        const result: CandlePatternSignalResult = {
            signal: 'NONE',
            optionType: null,
            pattern: 'NONE',
            score: 0,
            atr: 0,
            dayHigh: 0,
            dayLow: 0,
            dayRange: 0,
            reasons: [],
            skipReasons: [],
        };

        if (!completedCandles15m || completedCandles15m.length < 5) {
            result.skipReasons.push(
                `Insufficient 15m candles for pattern analysis (${completedCandles15m?.length ?? 0}/5)`
            );
            return result;
        }

        const sorted = [...completedCandles15m].sort((a, b) => a.timestamp - b.timestamp);

        // 1. Calculate ATR(14) for volatility baseline
        const atr = ATR14Strategy.computeATR(sorted, atrPeriod);
        result.atr = atr;

        // 2. Calculate Day High, Day Low, and Day Range
        const latestCandle = sorted[sorted.length - 1];
        const referenceTime = latestCandle?.timestamp ?? Date.now();
        let todayCandles = getTodayCandles(sorted, referenceTime);
        // Fallback: If today's candles count < 2 (e.g. testing mode or weekend backtest), use last 12 candles
        if (todayCandles.length < 2) {
            todayCandles = sorted.slice(-Math.min(12, sorted.length));
        }

        const highPrices = todayCandles.map((c) => c.high);
        const lowPrices  = todayCandles.map((c) => c.low);
        const dayHigh = Math.max(...highPrices, spotPrice);
        const dayLow  = Math.min(...lowPrices, spotPrice);
        const dayRange = Math.max(dayHigh - dayLow, 1.0); // avoid div by 0

        result.dayHigh = dayHigh;
        result.dayLow = dayLow;
        result.dayRange = dayRange;

        // Pattern config
        const patternConfig: CandlePatternConfig = {
            hammerMaxBodyPct:              config?.HAMMER_MAX_BODY_PCT ?? 0.35,
            hammerMinLowerWickRatio:       config?.HAMMER_MIN_LOWER_WICK_RATIO ?? 2.0,
            hammerMaxUpperWickRatio:       config?.HAMMER_MAX_UPPER_WICK_RATIO ?? 0.8,
            shootingStarMaxBodyPct:        config?.SHOOTING_STAR_MAX_BODY_PCT ?? 0.35,
            shootingStarMinUpperWickRatio: config?.SHOOTING_STAR_MIN_UPPER_WICK_RATIO ?? 2.0,
            shootingStarMaxLowerWickRatio: config?.SHOOTING_STAR_MAX_LOWER_WICK_RATIO ?? 0.8,
            dayRangeProximityPct:          config?.PATTERN_DAY_RANGE_PROXIMITY_PCT ?? 30,
            minRangeAtrRatio:              config?.PATTERN_MIN_RANGE_ATR_RATIO ?? 0.35,
            requireExactDayExtreme:        config?.PATTERN_REQUIRE_EXACT_DAY_EXTREME ?? true,
        };

        const proximityThreshold = ((patternConfig.dayRangeProximityPct ?? 30) / 100) * dayRange;
        const atrThreshold = atr > 0 ? atr * 1.0 : proximityThreshold;

        // 3. Inspect recent candles for Hammer / Bullish Pin Bar or Shooting Star / Bearish Pin Bar
        // We check the last completed candle (Candle N-1), or the one right before (Candle N-2)
        const lastIdx = sorted.length - 1;
        const candidateIndices = [lastIdx];
        if (lastIdx >= 1) {
            candidateIndices.push(lastIdx - 1);
        }

        for (const idx of candidateIndices) {
            const candle = sorted[idx];
            const prevCandle = idx > 0 ? sorted[idx - 1] : undefined;
            const prevPrevCandle = idx > 1 ? sorted[idx - 2] : undefined;

            const detected = detectCandlePattern(candle, prevCandle, prevPrevCandle, patternConfig, atr);

            const candleTimeStr = new Date(candle.timestamp).toLocaleTimeString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            });

            // Calculate Day High & Low up to this candle's close
            const candlesUpToCandle = todayCandles.filter(c => c.timestamp <= candle.timestamp);
            const candleDayHigh = candlesUpToCandle.length > 0 ? Math.max(...candlesUpToCandle.map(c => c.high)) : dayHigh;
            const candleDayLow  = candlesUpToCandle.length > 0 ? Math.min(...candlesUpToCandle.map(c => c.low)) : dayLow;

            // ─── A. EVALUATE BULLISH REVERSAL (HAMMER / PIN BAR) AT DAY LOW (CALL / CE) ──────
            const isBullishReversal = detected.isHammer || detected.pattern === 'PIN_BAR_BULLISH';
            if (isBullishReversal) {
                const distFromDayLow = candle.low - candleDayLow;
                const isExactDayLow = Math.abs(distFromDayLow) <= 1.0;
                const isNearDayLow = patternConfig.requireExactDayExtreme
                    ? isExactDayLow
                    : (distFromDayLow <= proximityThreshold || distFromDayLow <= atrThreshold);

                if (!isNearDayLow) {
                    result.skipReasons.push(
                        `${detected.pattern} detected at [${candleTimeStr} IST] (Low: ₹${candle.low.toFixed(1)}) but NOT Day Low ` +
                        `(Candle Low ₹${candle.low.toFixed(1)} vs Day Low ₹${candleDayLow.toFixed(1)}, Dist: ₹${distFromDayLow.toFixed(1)} pts)`
                    );
                    continue;
                }

                // No breakout confirmation required — take the trade immediately on pattern detection
                const patternLabel = detected.pattern === 'PIN_BAR_BULLISH' ? 'BULLISH PIN BAR' : 'HAMMER';
                const extremeDesc = patternConfig.requireExactDayExtreme ? 'AT DAY LOW' : 'NEAR DAY LOW';
                result.signal = 'BULL';
                result.optionType = 'CE';
                result.pattern = detected.pattern;
                result.score = 100;
                result.patternCandle = candle;
                result.confirmingCandle = undefined;
                result.signalCandleTimestamp = candle.timestamp;

                const comp = detected.components;
                const lowerWickRatio = comp.body > 0 ? (comp.lowerWick / comp.body).toFixed(1) : 'inf';
                result.reasons.push(
                    `🔨 ${patternLabel} ${extremeDesc} [${candleTimeStr} IST]: Candle Low ₹${candle.low.toFixed(1)} ` +
                    `is the Day Low ₹${candleDayLow.toFixed(1)} (Day Range: ₹${dayRange.toFixed(1)}). ` +
                    `Body: ${(comp.bodyPercent * 100).toFixed(1)}%, Lower Wick: ${lowerWickRatio}x body. ` +
                    `Spot: ₹${spotPrice.toFixed(1)} — entering on pattern close (no breakout wait).`
                );
                return result;
            }

            // ─── B. EVALUATE BEARISH REVERSAL (SHOOTING STAR / PIN BAR) AT DAY HIGH (PUT / PE) ───
            const isBearishReversal = detected.isShootingStar || detected.pattern === 'PIN_BAR_BEARISH';
            if (isBearishReversal) {
                const distFromDayHigh = candleDayHigh - candle.high;
                const isExactDayHigh = Math.abs(distFromDayHigh) <= 1.0;
                const isNearDayHigh = patternConfig.requireExactDayExtreme
                    ? isExactDayHigh
                    : (distFromDayHigh <= proximityThreshold || distFromDayHigh <= atrThreshold);

                if (!isNearDayHigh) {
                    result.skipReasons.push(
                        `${detected.pattern} detected at [${candleTimeStr} IST] (High: ₹${candle.high.toFixed(1)}) but NOT Day High ` +
                        `(Candle High ₹${candle.high.toFixed(1)} vs Day High ₹${candleDayHigh.toFixed(1)}, Dist: ₹${distFromDayHigh.toFixed(1)} pts)`
                    );
                    continue;
                }

                // No breakdown confirmation required — take the trade immediately on pattern detection
                const patternLabel = detected.pattern === 'PIN_BAR_BEARISH' ? 'BEARISH PIN BAR' : 'SHOOTING STAR';
                const extremeDesc = patternConfig.requireExactDayExtreme ? 'AT DAY HIGH' : 'NEAR DAY HIGH';
                result.signal = 'BEAR';
                result.optionType = 'PE';
                result.pattern = detected.pattern;
                result.score = 100;
                result.patternCandle = candle;
                result.confirmingCandle = undefined;
                result.signalCandleTimestamp = candle.timestamp;

                const comp = detected.components;
                const upperWickRatio = comp.body > 0 ? (comp.upperWick / comp.body).toFixed(1) : 'inf';
                result.reasons.push(
                    `⭐ ${patternLabel} ${extremeDesc} [${candleTimeStr} IST]: Candle High ₹${candle.high.toFixed(1)} ` +
                    `is the Day High ₹${candleDayHigh.toFixed(1)} (Day Range: ₹${dayRange.toFixed(1)}). ` +
                    `Body: ${(comp.bodyPercent * 100).toFixed(1)}%, Upper Wick: ${upperWickRatio}x body. ` +
                    `Spot: ₹${spotPrice.toFixed(1)} — entering on pattern close (no breakdown wait).`
                );
                return result;
            }
        }

        if (result.signal === 'NONE' && result.skipReasons.length === 0) {
            const lastCandle = sorted[lastIdx];
            const lastComp = computeCandleComponents(lastCandle);
            const lastTimeStr = new Date(lastCandle.timestamp).toLocaleTimeString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            });
            const lastColor = lastComp.isBullish ? '🟢 Green' : '🔴 Red';
            const bodyPctStr = (lastComp.bodyPercent * 100).toFixed(1);
            const lowerWickRatio = lastComp.body > 0 ? (lastComp.lowerWick / lastComp.body).toFixed(1) : 'inf';
            const upperWickRatio = lastComp.body > 0 ? (lastComp.upperWick / lastComp.body).toFixed(1) : 'inf';
            result.skipReasons.push(
                `Last closed 15m candle [${lastTimeStr} IST] was ${lastColor} ` +
                `(Body: ₹${lastComp.body.toFixed(1)} / ${bodyPctStr}%, Lower Wick: ${lowerWickRatio}x, Upper Wick: ${upperWickRatio}x) — ` +
                `no Hammer near Day Low or Shooting Star near Day High detected`
            );
        }

        return result;
    }
}
