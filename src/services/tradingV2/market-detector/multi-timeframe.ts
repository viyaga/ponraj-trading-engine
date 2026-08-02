import { marketDetectorLogger } from "../logger";
import { Candle, ConfigType, TargetCandle, OrderSide } from "../type";
import { MarketDetector } from "./market-detector";
import { evaluateBreakoutTrade } from "./master-breakout-system";
import { getRollingATRPercentAvg } from "./indicators";
import { Utils } from "../utils";

export type TradeDecision = "STRONG_TRADE" | "GOOD_TRADE" | "WEAK_TRADE" | "SKIP" | "TEST_TRADE";

export interface TripleTFResult {
    entryScore: number;
    confirmationProbability: number;
    structureProbability: number;
    finalScore: number;
    decision: TradeDecision;
    isAllowed: boolean;
    direction: "BUY" | "SELL" | "NONE";
    breakoutTimeframe?: string;

    // 🔥 NEW
    tp: number;
    sl: number;
    rr: number;
    tpPerc: number;
    slPerc: number;
    slLimit: number;
    tpLimit: number;
}

export class MultiTimeframeAlignment {
    static evaluate(
        entryTarget: TargetCandle,
        confirmationTarget: TargetCandle,
        structureTarget: TargetCandle,
        entryCandles: Candle[],
        confirmationCandles: Candle[],
        structureCandles: Candle[],
        entryConfig: ConfigType,
        confirmationConfig: ConfigType,
        structureConfig: ConfigType,
        currentPriceParam?: number,
        logContext?: any,
        positionSideOverride?: OrderSide
    ): TripleTFResult {

        // 🔥 Use current price if provided, otherwise fallback to candle close (Hybrid/Real-time MTF Evaluation)
        const entryPrice = currentPriceParam && currentPriceParam > 0 ? currentPriceParam : entryTarget.close;

        const confirmationResult = MarketDetector.getMarketProbability(
            confirmationTarget,
            confirmationCandles,
            confirmationConfig,
            "confirmation",
            logContext
        );

        const structureResult = MarketDetector.getMarketProbability(
            structureTarget,
            structureCandles,
            structureConfig,
            "structure",
            logContext
        );

        const rawConfirmationProbability = confirmationResult.probability;
        const structureProbability = structureResult.probability;

        const breakout = evaluateBreakoutTrade(entryCandles, entryTarget, entryConfig);
        let direction = positionSideOverride
            ? (positionSideOverride.toUpperCase() as "BUY" | "SELL")
            : breakout.direction;
        const entryScore = breakout.score;

        // Evaluate breakout trade on confirmation and structure timeframes
        const confirmationBreakout = evaluateBreakoutTrade(confirmationCandles, confirmationTarget, confirmationConfig);
        const structureBreakout = evaluateBreakoutTrade(structureCandles, structureTarget, structureConfig);

        // 🔥 HIGHEST TIMEFRAME BREAKOUT PRIORITY: 1h > 15m > 5m
        let breakoutTimeframe: string = entryConfig.IS_TESTING ? (entryConfig.TIMEFRAME || "5m") : "NONE";
        if (structureBreakout.direction !== "NONE") {
            breakoutTimeframe = entryConfig.STRUCTURE_TIMEFRAME || "1h";
        } else if (confirmationBreakout.direction !== "NONE") {
            breakoutTimeframe = entryConfig.CONFIRMATION_TIMEFRAME || "15m";
        } else if (breakout.direction !== "NONE") {
            breakoutTimeframe = entryConfig.TIMEFRAME || "5m";
        }

        // Blend confirmation breakout score with general confirmation probability (50/50 balance)
        const confirmationProbability = Math.round(
            (confirmationBreakout.score * 0.50) +
            (rawConfirmationProbability * 0.50)
        );

        const evalTag = positionSideOverride ? `[MTF-PosMgmt:${positionSideOverride}]` : `[MTF-NewEntry]`;

        marketDetectorLogger.info(`${evalTag} Sub-scores for ${entryConfig.SYMBOL}: Entry=${entryScore}, Confirmation=${confirmationProbability} (BO:${confirmationBreakout.score}, Prob:${rawConfirmationProbability}), Structure=${structureProbability}`);
        marketDetectorLogger.debug(`${evalTag} Breakout details for ${entryConfig.SYMBOL}: 5m Entry Dir=${breakout.direction}, Score=${breakout.score}, Reason=${breakout.reason}`);
        marketDetectorLogger.debug(`${evalTag} 15m Confirmation Breakout details: Dir=${confirmationBreakout.direction}, Score=${confirmationBreakout.score}, Reason=${confirmationBreakout.reason}`);
        marketDetectorLogger.debug(`${evalTag} 1h Structure Breakout details: Dir=${structureBreakout.direction}, Score=${structureBreakout.score}, Reason=${structureBreakout.reason}`);
        marketDetectorLogger.info(`${evalTag} ${entryConfig.SYMBOL}: Active Breakout Timeframe identified: ${breakoutTimeframe} (Priority: 1h > 15m > 5m)`);

        const symbol = entryConfig.SYMBOL;

        // 🔥 FALLBACK TO 15M BREAKOUT: If 5m entry has no breakout, but 15m confirmation does, inherit direction from 15m
        let isDirectionFromConfirmation = false;
        if (direction === "NONE" && confirmationBreakout.direction !== "NONE") {
            direction = confirmationBreakout.direction;
            isDirectionFromConfirmation = true;
            marketDetectorLogger.info(`${evalTag} ${symbol}: No 5m breakout. Inheriting 15m confirmation breakout direction instead: ${direction}`);
        }

        // 🔥 TESTING OVERRIDE: If testing and no breakout, force BUY
        if (direction === "NONE" && entryConfig.IS_TESTING) {
            marketDetectorLogger.info(`[TESTING] ${symbol}: Forcing BUY direction since entry search was NONE`);
            direction = "BUY";
        }

        // Direct conflict check: If confirmation timeframe has a breakout in opposite direction
        const hasConfBreakoutMismatch =
            !positionSideOverride &&
            !entryConfig.IS_TESTING &&
            direction !== "NONE" &&
            confirmationBreakout.direction !== "NONE" &&
            confirmationBreakout.direction !== direction;

        if (direction === "NONE" || hasConfBreakoutMismatch) {
            if (hasConfBreakoutMismatch) {
                marketDetectorLogger.info(`${evalTag}[Skip] ${symbol}: Direction mismatch between Entry (${direction}) and Confirmation (${confirmationBreakout.direction}) breakouts.`);
            }
            return {
                entryScore,
                confirmationProbability,
                structureProbability,
                finalScore: 0,
                decision: "SKIP",
                isAllowed: false,
                direction: "NONE",
                breakoutTimeframe,
                tp: 0,
                sl: 0,
                rr: 0,
                tpPerc: 0,
                slPerc: 0,
                slLimit: 0,
                tpLimit: 0,
            };
        }

        /* ================= STRUCTURE TREND DIRECTION ALIGNMENT ================= */
        const structEma20 = Utils.calculateEMA(structureCandles, 20);
        let isStructTrendAligned = true;
        if (structEma20 > 0) {
            // 🔥 Hybrid approach: Compare the real-time entryPrice against the structure EMA
            if (direction === "BUY" && entryPrice < structEma20) {
                isStructTrendAligned = false;
            } else if (direction === "SELL" && entryPrice > structEma20) {
                isStructTrendAligned = false;
            }
        }

        /* ================= FINAL SCORE ================= */

        // 🔥 Highly Balanced Win-Rate Strategy: 25% Entry, 45% Confirmation, 30% Structure
        let finalScore = Math.round(
            (entryScore * 0.25) +
            (confirmationProbability * 0.45) +
            (structureProbability * 0.30)
        );

        // 🔥 Breakout Alignment Bonus: If both 5m entry and 15m confirmation breakouts are active and aligned in the same direction
        const is5mBreakoutActive = breakout.direction !== "NONE";
        const is15mBreakoutActive = confirmationBreakout.direction !== "NONE";
        if (is5mBreakoutActive && is15mBreakoutActive && breakout.direction === confirmationBreakout.direction) {
            finalScore = Math.min(100, finalScore + 10);
            marketDetectorLogger.info(`${evalTag} ${symbol}: Breakout Alignment Bonus! Both 5m (${breakout.direction}) and 15m (${confirmationBreakout.direction}) breakouts aligned. +10 added to score (Final: ${finalScore})`);
        }

        // 🔥 Trend Alignment Score Adjustment (Instead of blocking the trade)
        const isAligned = confirmationProbability >= 50 && structureProbability >= 50 && isStructTrendAligned;
        if (isAligned) {
            finalScore = Math.min(100, finalScore + 5);
            marketDetectorLogger.info(`${evalTag} ${symbol}: Trend Aligned Bonus! 1h EMA trend aligned. +5 added to score (Final: ${finalScore})`);
        } else {
            const penalty = 15;
            const reasons = [];
            if (confirmationProbability < 50) reasons.push(`Confirmation Prob < 50 (${confirmationProbability})`);
            if (structureProbability < 50) reasons.push(`Structure Prob < 50 (${structureProbability})`);
            if (!isStructTrendAligned) reasons.push("Structure EMA trend mismatch");

            finalScore = Math.max(0, finalScore - penalty);
            marketDetectorLogger.info(`${evalTag} ${symbol}: Trend Alignment Mismatch (${reasons.join(", ")}). -${penalty} penalty applied to score (Final: ${finalScore})`);
        }

        /* ================= ATR LOW VOLATILITY PENALTY & GATE ================= */
        let atrPercent = getRollingATRPercentAvg(confirmationCandles, 14);
        if (!atrPercent || isNaN(atrPercent) || atrPercent <= 0) {
            atrPercent = 1.0;
        }

        if (atrPercent < 0.15) {
            const atrPenalty = 15;
            finalScore = Math.max(0, finalScore - atrPenalty);
            marketDetectorLogger.info(`${evalTag} ${symbol}: Low ATR Volatility (${atrPercent.toFixed(4)}% < 0.15%). -${atrPenalty} penalty applied to final score (Final: ${finalScore})`);
        }

        marketDetectorLogger.info(`${evalTag} Final Score Calculation: (5m:${entryScore} * 0.25) + (15m:${confirmationProbability} * 0.45) + (1h:${structureProbability} * 0.30) [with adjustments] = Final: ${finalScore}`);

        let decision: TradeDecision = "SKIP";

        if (finalScore >= 75) decision = "STRONG_TRADE";
        else if (finalScore >= 70) decision = "GOOD_TRADE";
        else if (finalScore >= 50) decision = "WEAK_TRADE";

        const minEntry = entryConfig.MIN_ENTRY_SCORE ?? 60;
        const minConf = entryConfig.MIN_CONFIRMATION_SCORE ?? 60;
        const minStruct = entryConfig.MIN_STRUCTURE_SCORE ?? 60;

        const isPassingMinScores =
            entryScore >= minEntry &&
            confirmationProbability >= minConf &&
            rawConfirmationProbability >= Math.min(minConf, 55) &&
            structureProbability >= minStruct;

        const minFinal = entryConfig.MIN_FINAL_SCORE ?? 70;

        // Preliminary permission based on score (Block trade if ATR% is under 0.08% dead market threshold)
        const isDeadMarket = atrPercent < 0.08;
        let isAllowedScore = entryConfig.IS_TESTING || (!isDeadMarket && finalScore >= minFinal && isPassingMinScores);

        /* ================= EXTRA FILTER (OPTIONAL BUT STRONG) ================= */

        const isStrongTrend =
            confirmationProbability > 60 &&
            structureProbability > 60;

        if (!entryConfig.IS_TESTING && !isStrongTrend) {
            const primaryScore = isDirectionFromConfirmation ? confirmationBreakout.score : entryScore;
            if (primaryScore < 65) {
                isAllowedScore = false;
                marketDetectorLogger.info(`${evalTag}[Skip] ${symbol}: Breakout source score ${primaryScore} too low under non-strong trend conditions`);
            }
        }

        /* ================= 🔥 DYNAMIC TP/SL ================= */
        const levels = this.calculateSlTpLevels(
            direction,
            entryPrice,
            entryTarget,
            confirmationTarget,
            structureTarget,
            entryCandles,
            confirmationCandles,
            structureCandles,
            entryConfig,
            breakoutTimeframe,
            finalScore,
            isAllowedScore
        );

        const {
            tp,
            sl,
            rr,
            tpPerc,
            slPerc,
            slLimit,
            tpLimit,
            isSlAlreadyCrossed,
            crossedReason,
            isExceededMovementLimit,
            structSlPerc,
            confSlPerc,
            isPoorNaturalRr
        } = levels;

        /* ================= FINAL PERMISSION ================= */
        // If we are overriding the side for an already open trade, bypass entry-based safety checks.
        const minRr = Math.max(1.0, entryConfig.MIN_RR ?? 1.0);
        let isAllowed = positionSideOverride
            ? tp > 0 && sl > 0
            : entryConfig.IS_TESTING
                ? tp > 0 && sl > 0
                : isAllowedScore && tp > 0 && sl > 0 && !isExceededMovementLimit && !isSlAlreadyCrossed && !isPoorNaturalRr && (rr + 1e-5) >= minRr;

        if (entryConfig.IS_TESTING && isAllowed && decision === "SKIP") {
            decision = "TEST_TRADE";
        }

        /* ================= LOG ================= */

        const mtfLogPrefix = isAllowed ? `${evalTag}[Allowed]` : `${evalTag}[Skip]`;
        marketDetectorLogger.info(`${mtfLogPrefix} ${symbol} | FS: ${finalScore} | Dir: ${direction} | Dec: ${decision}${entryConfig.IS_TESTING ? " [IS_TESTING=true]" : ""} | CurrentPrice: ${entryPrice} | TP Trigger: ${tp} | TP Limit: ${tpLimit} | SL Trigger: ${sl} | RR: ${rr.toFixed(2)}`);

        if (isAllowed) {
            marketDetectorLogger.debug(`[MarketProbability] ${symbol} Confirmation`, {
                probability: confirmationResult.probability,
                isAllowed: confirmationResult.isAllowed,
                mode: confirmationResult.mode,
                details: confirmationResult.details,
            });

            marketDetectorLogger.debug(`[MarketProbability] ${symbol} Structure`, {
                probability: structureResult.probability,
                isAllowed: structureResult.isAllowed,
                mode: structureResult.mode,
                details: structureResult.details,
            });

            if (entryConfig.IS_TESTING) {
                const warnings: string[] = [];
                if (rr < minRr) {
                    warnings.push(`Risk-Reward ratio below minimum: RR=${rr.toFixed(2)} (Min:${minRr})`);
                }
                if (isSlAlreadyCrossed) {
                    warnings.push(`Stop loss boundary already crossed before entry: ${crossedReason}`);
                }
                if (isExceededMovementLimit) {
                    warnings.push(`Stop loss percentage limit exceeded: Structure SL Distance=${structSlPerc.toFixed(2)}%, Confirmation SL Distance=${confSlPerc.toFixed(2)}% (Max Limit=${entryConfig.MAX_ALLOWED_PRICE_MOVEMENT_PERCENT}%)`);
                }
                if (!isPassingMinScores) {
                    warnings.push(`Individual timeframe score below minimum: Entry=${entryScore} (Min:${minEntry}), Confirmation=${confirmationProbability} (Min:${minConf}), Structure=${structureProbability} (Min:${minStruct})`);
                }
                if (finalScore < minFinal) {
                    warnings.push(`Final score below minimum: Score=${finalScore} (Min:${minFinal})`);
                }

                if (warnings.length > 0) {
                    marketDetectorLogger.warn(`⚠️ [TESTING-WARNING] ${symbol} (Would be skipped in Production): \n${warnings.map(w => `      * ${w}`).join('\n')}`);
                }
            }
        } else if (!entryConfig.IS_TESTING && !isPassingMinScores) {
            marketDetectorLogger.info(`[MTF-Skip] ${symbol} | Individual timeframe score below minimum: Entry=${entryScore} (Min:${minEntry}), Confirmation=${confirmationProbability} (Min:${minConf}), Structure=${structureProbability} (Min:${minStruct})`);
        } else if (isSlAlreadyCrossed) {
            marketDetectorLogger.info(`[MTF-Skip] ${symbol} | Stop loss boundary already crossed before entry: ${crossedReason}`);
        } else if (isExceededMovementLimit) {
            marketDetectorLogger.info(`[MTF-Skip] ${symbol} | Stop loss percentage limit exceeded: Structure SL Distance=${structSlPerc.toFixed(2)}%, Confirmation SL Distance=${confSlPerc.toFixed(2)}% (Max Limit=${entryConfig.MAX_ALLOWED_PRICE_MOVEMENT_PERCENT}%)`);
        } else if ((rr + 1e-5) < minRr) {
            marketDetectorLogger.info(`[MTF-Skip] ${symbol} | Risk-Reward ratio below minimum: RR=${rr.toFixed(4)} (Min:${minRr})`);
        }

        return {
            entryScore,
            confirmationProbability,
            structureProbability,
            finalScore,
            decision,
            isAllowed,
            direction,
            breakoutTimeframe,
            tp,
            sl,
            rr,
            tpPerc,
            slPerc,
            slLimit,
            tpLimit,
        };
    }

    /**
     * Calculates dynamic Stop Loss and Take Profit levels, along with risk metrics and bounds.
     * Structured as a separate helper for readability, maintainability, and testing.
     */
    private static calculateSlTpLevels(
        direction: "BUY" | "SELL",
        entryPrice: number,
        entryTarget: TargetCandle,
        confirmationTarget: TargetCandle,
        structureTarget: TargetCandle,
        entryCandles: Candle[],
        confirmationCandles: Candle[],
        structureCandles: Candle[],
        entryConfig: ConfigType,
        breakoutTimeframe: string,
        finalScore: number,
        isAllowedScore: boolean = false
    ): {
        sl: number;
        tp: number;
        rr: number;
        tpPerc: number;
        slPerc: number;
        slLimit: number;
        tpLimit: number;
        isSlAlreadyCrossed: boolean;
        crossedReason: string;
        isExceededMovementLimit: boolean;
        structSlPerc: number;
        confSlPerc: number;
        isPoorNaturalRr: boolean;
    } {
        let tp = 0;
        let sl = 0;
        let rr = 0;
        let tpPerc = 0;
        let slPerc = 0;
        let structSlPerc = 0;
        let confSlPerc = 0;
        let slLimit = 0;
        let tpLimit = 0;
        let isSlAlreadyCrossed = false;
        let crossedReason = "";
        let isExceededMovementLimit = false;
        let isPoorNaturalRr = false;
        const leverage = entryConfig.LEVERAGE;

        if (entryPrice > 0) {
            /* ================= DYNAMIC ATR & SOURCE CANDLE SELECTION ================= */
            const entrySlPrice = direction === "BUY" ? entryTarget.low : entryTarget.high;
            const structSlPrice = direction === "BUY" ? structureTarget.low : structureTarget.high;
            const confSlPrice = direction === "BUY" ? confirmationTarget.low : confirmationTarget.high;

            const entrySlPerc = (Math.abs(entryPrice - entrySlPrice) / entryPrice) * 100;
            structSlPerc = (Math.abs(entryPrice - structSlPrice) / entryPrice) * 100;
            confSlPerc = (Math.abs(entryPrice - confSlPrice) / entryPrice) * 100;

            const maxLimit = entryConfig.MAX_ALLOWED_PRICE_MOVEMENT_PERCENT;
            const slMode = entryConfig.SL_SELECTION_MODE || "active_tf"; // "active_tf" | "structure" | "tightest"

            let sourceCandle = confirmationTarget;
            let sourceCandles = confirmationCandles;
            let selectedTfName = entryConfig.CONFIRMATION_TIMEFRAME || "15m";

            if (slMode === "active_tf" || slMode === "lookback_3" || slMode === "doji_filter" || slMode === "fixed_atr") {
                if (breakoutTimeframe === (entryConfig.TIMEFRAME || "5m") && entrySlPerc <= maxLimit) {
                    sourceCandle = entryTarget;
                    sourceCandles = entryCandles;
                    selectedTfName = entryConfig.TIMEFRAME || "5m";
                } else if (breakoutTimeframe === (entryConfig.CONFIRMATION_TIMEFRAME || "15m") && confSlPerc <= maxLimit) {
                    sourceCandle = confirmationTarget;
                    sourceCandles = confirmationCandles;
                    selectedTfName = entryConfig.CONFIRMATION_TIMEFRAME || "15m";
                } else if (structSlPerc <= maxLimit) {
                    sourceCandle = structureTarget;
                    sourceCandles = structureCandles;
                    selectedTfName = entryConfig.STRUCTURE_TIMEFRAME || "1h";
                } else if (confSlPerc <= maxLimit) {
                    sourceCandle = confirmationTarget;
                    sourceCandles = confirmationCandles;
                    selectedTfName = entryConfig.CONFIRMATION_TIMEFRAME || "15m";
                } else {
                    // Fallback to active timeframe candle and clamp SL to maxLimit below
                    sourceCandle = entryTarget;
                    sourceCandles = entryCandles;
                    selectedTfName = entryConfig.TIMEFRAME || "5m";
                }
            } else if (slMode === "tightest") {
                const candidates = [
                    { tf: entryConfig.TIMEFRAME || "5m", candle: entryTarget, candles: entryCandles, perc: entrySlPerc },
                    { tf: entryConfig.CONFIRMATION_TIMEFRAME || "15m", candle: confirmationTarget, candles: confirmationCandles, perc: confSlPerc },
                    { tf: entryConfig.STRUCTURE_TIMEFRAME || "1h", candle: structureTarget, candles: structureCandles, perc: structSlPerc },
                ].filter(c => c.perc <= maxLimit);

                if (candidates.length > 0) {
                    candidates.sort((a, b) => a.perc - b.perc);
                    sourceCandle = candidates[0].candle;
                    sourceCandles = candidates[0].candles;
                    selectedTfName = candidates[0].tf;
                } else {
                    sourceCandle = entryTarget;
                    sourceCandles = entryCandles;
                    selectedTfName = entryConfig.TIMEFRAME || "5m";
                }
            } else {
                if (structSlPerc <= maxLimit) {
                    sourceCandle = structureTarget;
                    sourceCandles = structureCandles;
                    selectedTfName = entryConfig.STRUCTURE_TIMEFRAME || "1h";
                } else if (confSlPerc <= maxLimit) {
                    sourceCandle = confirmationTarget;
                    sourceCandles = confirmationCandles;
                    selectedTfName = entryConfig.CONFIRMATION_TIMEFRAME || "15m";
                } else {
                    sourceCandle = structureTarget;
                    sourceCandles = structureCandles;
                    selectedTfName = entryConfig.STRUCTURE_TIMEFRAME || "1h";
                }
            }

            let atrPercent = getRollingATRPercentAvg(sourceCandles, 14);
            if (!atrPercent || isNaN(atrPercent) || atrPercent <= 0) {
                atrPercent = 1.0; // fallback default volatility
            }
            const atrDistance = entryPrice * (atrPercent / 100);

            /* ================= ATR EXTREME REGIME FILTER ================= */
            if (atrPercent < 0.15) {
                marketDetectorLogger.warn(`[ATR-Filter] ${entryConfig.SYMBOL} ATR% is extremely low (${atrPercent.toFixed(4)}%), market may be range-bound/dead`);
            } else if (atrPercent > 4.5) {
                marketDetectorLogger.warn(`[ATR-Filter] ${entryConfig.SYMBOL} ATR% is abnormally high (${atrPercent.toFixed(4)}%), market shows extreme volatility`);
            }

            /* ================= CANDLE LOW / HIGH SL ================= */
            let structSl: number;

            if (slMode === "lookback_3" && sourceCandles && sourceCandles.length > 0) {
                const lookbackCandles = sourceCandles.slice(-3);
                if (direction === "BUY") {
                    structSl = Math.min(...lookbackCandles.map(c => c.low));
                } else {
                    structSl = Math.max(...lookbackCandles.map(c => c.high));
                }
            } else if (slMode === "doji_filter" && sourceCandles && sourceCandles.length > 0) {
                const recentCandles = sourceCandles.slice(-5);
                let validCandle: Candle | undefined;

                for (let i = recentCandles.length - 1; i >= 0; i--) {
                    const c = recentCandles[i];
                    const bodyPct = Utils.getBodyPercent(c);
                    const range = Math.abs(c.high - c.low);
                    if (bodyPct >= 40 && range >= 0.5 * atrDistance) {
                        validCandle = c;
                        break;
                    }
                }

                if (validCandle) {
                    structSl = direction === "BUY" ? validCandle.low : validCandle.high;
                } else {
                    structSl = direction === "BUY"
                        ? Math.min(...recentCandles.map(c => c.low))
                        : Math.max(...recentCandles.map(c => c.high));
                }
            } else if (slMode === "fixed_atr") {
                const estimatedFeePerc = entryConfig.ESTIMATED_FEE_PERCENT || 0.1;
                const feeToAtrRatio = atrPercent > 0 ? estimatedFeePerc / atrPercent : 0.5;
                const smartBufferBonus = parseFloat(Math.max(0.05, Math.min(0.25, 0.05 + (feeToAtrRatio * 0.36))).toFixed(3));
                const slAtrMult = (entryConfig.SL_ATR_MULTIPLIER ?? 1.0) + smartBufferBonus;
                const slAtrDist = atrDistance * slAtrMult;
                const targetSlPrice = direction === "BUY" ? (entryPrice - slAtrDist) : (entryPrice + slAtrDist);
                const slBufferFactor = 1 - (direction === "BUY" ? entryConfig.SL_TRIGGER_BUFFER_PERCENT : -entryConfig.SL_TRIGGER_BUFFER_PERCENT) / 100;
                structSl = targetSlPrice / slBufferFactor;
                marketDetectorLogger.info(`[SmartBuffer-SL] ${entryConfig.SYMBOL}: ATR%=${atrPercent.toFixed(4)}% | Fee/ATR Ratio=${feeToAtrRatio.toFixed(3)} | Smart Buffer=+${smartBufferBonus}x ATR | Final SL Mult=${slAtrMult.toFixed(3)}x ATR`);
            } else {
                structSl = direction === "BUY" ? sourceCandle.low : sourceCandle.high;
            }

            if (direction === "BUY") {
                sl = structSl * (1 - entryConfig.SL_TRIGGER_BUFFER_PERCENT / 100);
            } else {
                sl = structSl * (1 + entryConfig.SL_TRIGGER_BUFFER_PERCENT / 100);
            }
            sl = parseFloat(sl.toFixed(entryConfig.PRICE_DECIMAL_PLACES));

            // Smart SL Clamping: If natural SL distance exceeds maxLimit (1.5%), clamp SL to maxLimit to allow trade execution safely!
            const naturalSlDistancePerc = (Math.abs(entryPrice - sl) / entryPrice) * 100;
            if (naturalSlDistancePerc > maxLimit) {
                const cappedDist = entryPrice * (maxLimit / 100);
                if (direction === "BUY") {
                    sl = entryPrice - cappedDist;
                    structSl = sl;
                } else {
                    sl = entryPrice + cappedDist;
                    structSl = sl;
                }
                sl = parseFloat(sl.toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                isExceededMovementLimit = false;
                marketDetectorLogger.info(
                    `[DynamicSL-Clamp] ${entryConfig.SYMBOL}: Natural SL distance (${naturalSlDistancePerc.toFixed(2)}%) exceeded max limit (${maxLimit}%). Clamped SL to ${maxLimit}% (${sl}) to allow trade execution.`
                );
            }

            const slBaseLabel = slMode === "fixed_atr" ? "ATR SL Base" : (direction === "BUY" ? "Candle Low" : "Candle High");
            marketDetectorLogger.info(
                `[CandleSL] ${entryConfig.SYMBOL} (${selectedTfName}, Mode:${slMode}) | ${slBaseLabel}=${structSl.toFixed(entryConfig.PRICE_DECIMAL_PLACES)} | Trigger Buffer=${entryConfig.SL_TRIGGER_BUFFER_PERCENT}% | Final SL=${sl}`
            );

            /* ================= SL CROSSING SAFETIES ================= */
            if (direction === "BUY") {
                if (entryPrice <= sl) {
                    isSlAlreadyCrossed = true;
                    crossedReason = `Current price (${entryPrice}) is already below or equal to SL trigger (${sl})`;
                } else if (entryPrice <= sourceCandle.low) {
                    isSlAlreadyCrossed = true;
                    crossedReason = `Current price (${entryPrice}) is already below or equal to source candle low (${sourceCandle.low})`;
                }
            } else if (direction === "SELL") {
                if (entryPrice >= sl) {
                    isSlAlreadyCrossed = true;
                    crossedReason = `Current price (${entryPrice}) is already above or equal to SL trigger (${sl})`;
                } else if (entryPrice >= sourceCandle.high) {
                    isSlAlreadyCrossed = true;
                    crossedReason = `Current price (${entryPrice}) is already above or equal to source candle high (${sourceCandle.high})`;
                }
            }

            /* ================= METRICS & RR (PRELIMINARY) ================= */
            slLimit = sl;

            const riskPriceDist = Math.abs(entryPrice - sl);

            // Include Estimated Fees in RR
            const feePercent = entryConfig.ESTIMATED_FEE_PERCENT / 100;
            const entryFee = entryPrice * (feePercent / 2);
            const exitFeeSl = sl * (feePercent / 2);
            const netRisk = riskPriceDist + (entryFee + exitFeeSl);

            /* ================= DYNAMIC TP SELECTION MODES ================= */
            const tpMode = entryConfig.TP_SELECTION_MODE || "dynamic_atr";
            const minTpPerc = entryConfig.MIN_TP_PRICE_MOVEMENT_PERCENT ?? 0.5;
            const maxTpPerc = entryConfig.MAX_TP_PRICE_MOVEMENT_PERCENT ?? 3.0;

            let baseTp: number;

            if (tpMode === "fixed_atr") {
                const estimatedFeePerc = entryConfig.ESTIMATED_FEE_PERCENT || 0.1;
                const feeToAtrRatio = atrPercent > 0 ? estimatedFeePerc / atrPercent : 0.5;
                const smartBufferBonus = parseFloat(Math.max(0.05, Math.min(0.25, 0.05 + (feeToAtrRatio * 0.36))).toFixed(3));
                const tpAtrMult = (entryConfig.TP_ATR_MULTIPLIER ?? 2.0) + smartBufferBonus;
                const rawTpPercent = atrPercent * tpAtrMult;
                const tpPercent = Math.max(minTpPerc, Math.min(maxTpPerc, rawTpPercent));
                const targetTpPrice = direction === "BUY" ? entryPrice * (1 + tpPercent / 100) : entryPrice * (1 - tpPercent / 100);
                const tpTriggerFactor = 1 - (direction === "BUY" ? entryConfig.TP_TRIGGER_BUFFER_PERCENT : -entryConfig.TP_TRIGGER_BUFFER_PERCENT) / 100;
                baseTp = targetTpPrice / tpTriggerFactor;
                marketDetectorLogger.info(`[SmartBuffer-TP] ${entryConfig.SYMBOL} Mode: fixed_atr | Smart Buffer=+${smartBufferBonus}x ATR | Final TP Mult=${tpAtrMult.toFixed(3)}x ATR | Final TP%=${tpPercent.toFixed(4)}%`);
            } else if (tpMode === "fixed_rr") {
                const targetRr = Math.max(1.0, entryConfig.MIN_RR ?? 1.5);
                const requiredNetReward = targetRr * netRisk;
                if (direction === "BUY") {
                    baseTp = (requiredNetReward + entryPrice * (1 + feePercent / 2)) / (1 - feePercent / 2);
                } else {
                    baseTp = (entryPrice * (1 - feePercent / 2) - requiredNetReward) / (1 + feePercent / 2);
                }
                marketDetectorLogger.info(`[TP-Selection] ${entryConfig.SYMBOL} Mode: fixed_rr | Target RR=${targetRr} | Base TP=${baseTp}`);
            } else {
                // Enhanced Dynamic ATR: Score Scaled + HTF Trend Bonus + Volume Surge Bonus
                const scoreFactor = Math.max(70, Math.min(90, finalScore));
                const baseMultiplier = 1.0 + ((scoreFactor - 70) / 20) * 1.0; // 1.0x to 2.0x base

                // 1. HTF Trend Alignment Bonus (+0.3x for 1h/structure, +0.15x for 15m/confirmation)
                let htfBonus = 0;
                const structTfName = entryConfig.STRUCTURE_TIMEFRAME || "1h";
                const confTfName = entryConfig.CONFIRMATION_TIMEFRAME || "15m";
                if (breakoutTimeframe === structTfName) {
                    htfBonus = 0.3;
                } else if (breakoutTimeframe === confTfName) {
                    htfBonus = 0.15;
                }

                // 2. Volume Surge Bonus (+0.2x for volume >= 1.5x 20-period avg)
                let volumeBonus = 0;
                if (entryTarget && entryCandles && entryCandles.length > 0) {
                    const recentCandles = entryCandles.slice(-20);
                    const avgVol = recentCandles.reduce((acc, c) => acc + (c.volume || 0), 0) / recentCandles.length;
                    if (avgVol > 0 && entryTarget.volume && (entryTarget.volume / avgVol) >= 1.5) {
                        volumeBonus = 0.2;
                    }
                }

                // Combine & cap maximum dynamic multiplier to 2.5x ATR
                const multiplier = Math.min(2.5, baseMultiplier + htfBonus + volumeBonus);

                // Use robust 15m ATR if available, fallback to active ATR
                const effectiveAtrPercent = getRollingATRPercentAvg(confirmationCandles, 14) || atrPercent;

                const rawTpPercent = effectiveAtrPercent * multiplier;
                const tpPercent = Math.max(minTpPerc, Math.min(maxTpPerc, rawTpPercent));

                marketDetectorLogger.info(
                    `[DynamicTP-Enhanced] ${entryConfig.SYMBOL}: ATR%=${effectiveAtrPercent.toFixed(4)}% | Score=${finalScore} | Multipliers [Base:${baseMultiplier.toFixed(2)}x, HTF:${htfBonus > 0 ? `+${htfBonus}` : '0'}, Vol:${volumeBonus > 0 ? `+${volumeBonus}` : '0'}] = Total:${multiplier.toFixed(2)}x | Raw TP%=${rawTpPercent.toFixed(4)}% | Final TP%=${tpPercent.toFixed(4)}%`
                );
                baseTp = direction === "BUY" ? entryPrice * (1 + tpPercent / 100) : entryPrice * (1 - tpPercent / 100);
            }

            const tpTriggerFactor = 1 - (direction === "BUY" ? entryConfig.TP_TRIGGER_BUFFER_PERCENT : -entryConfig.TP_TRIGGER_BUFFER_PERCENT) / 100;
            tp = baseTp * tpTriggerFactor;

            if (tp <= 0) {
                tp = parseFloat((1 / Math.pow(10, entryConfig.PRICE_DECIMAL_PLACES)).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
            } else {
                tp = parseFloat(tp.toFixed(entryConfig.PRICE_DECIMAL_PLACES));
            }

            /* ================= METRICS & RR (PRELIMINARY CALCULATIONS) ================= */
            const tpLimitFactor = 1 - (direction === "BUY" ? entryConfig.TP_LIMIT_BUFFER_PERCENT : -entryConfig.TP_LIMIT_BUFFER_PERCENT) / 100;
            const rawTpLimit = baseTp * tpLimitFactor;
            if (rawTpLimit <= 0) {
                tpLimit = parseFloat((1 / Math.pow(10, entryConfig.PRICE_DECIMAL_PLACES)).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
            } else {
                tpLimit = parseFloat(rawTpLimit.toFixed(entryConfig.PRICE_DECIMAL_PLACES));
            }

            let rewardPriceDist = Math.abs(tp - entryPrice);
            let exitFeeTp = tp * (feePercent / 2);
            let netReward = rewardPriceDist - (entryFee + exitFeeTp);

            rr = netRisk > 0 ? netReward / netRisk : 0;

            tpPerc = entryPrice > 0 ? (rewardPriceDist / entryPrice) * 100 : 0;
            slPerc = entryPrice > 0 ? (riskPriceDist / entryPrice) * 100 : 0;

            const rawPriceRr = riskPriceDist > 0 ? rewardPriceDist / riskPriceDist : 0;
            marketDetectorLogger.info(
                `[NaturalRR] ${entryConfig.SYMBOL} | Raw Price RR: ${rawPriceRr.toFixed(2)} | Net Fee-Adjusted RR: ${rr.toFixed(2)} (Price Risk: ${riskPriceDist.toFixed(entryConfig.PRICE_DECIMAL_PLACES)}, Net Risk: ${netRisk.toFixed(entryConfig.PRICE_DECIMAL_PLACES)}, Price Reward: ${rewardPriceDist.toFixed(entryConfig.PRICE_DECIMAL_PLACES)}, Net Reward: ${netReward.toFixed(entryConfig.PRICE_DECIMAL_PLACES)}, Fee: ${entryConfig.ESTIMATED_FEE_PERCENT}%)`
            );

            /* ================= FORCED RR ADJUSTMENT IF RR < MIN_RR (MIN 1.0) ================= */
            const targetMinRr = Math.max(1.0, entryConfig.MIN_RR ?? 1.0);
            const rrEnforcementMode = entryConfig.MIN_RR_ENFORCEMENT_MODE || "tp";

            if (rr < targetMinRr && !isSlAlreadyCrossed && !isExceededMovementLimit && netRisk > 0) {
                const initialRr = rr;
                const initialTp = tp;
                const initialSl = sl;

                if (initialRr < 0.35) {
                    isPoorNaturalRr = true;
                    marketDetectorLogger.warn(`[DynamicRR-Safety] ${entryConfig.SYMBOL}: Natural Risk/Reward (${initialRr.toFixed(2)}) is below minimum structure threshold (0.35). Trade rejected due to poor risk structure.`);
                }

                if (rrEnforcementMode === "sl") {
                    // Mode = "sl": Shorten Stop Loss to achieve targetMinRr while preserving safety buffers
                    const requiredMaxNetRisk = netReward / targetMinRr;

                    let targetSl: number;
                    if (direction === "BUY") {
                        targetSl = (entryPrice * (1 + feePercent / 2) - requiredMaxNetRisk) / (1 - feePercent / 2);
                    } else {
                        targetSl = (requiredMaxNetRisk + entryPrice * (1 - feePercent / 2)) / (1 + feePercent / 2);
                    }

                    // Safety Solution for Shortening SL: Check minimum safe distance
                    const minSafeBufferPerc = Math.max(0.15, entryConfig.MIN_SL_SAFETY_BUFFER_PERCENT ?? 0.2, entryConfig.SL_TRIGGER_BUFFER_PERCENT ?? 0.2);
                    const minSafeDist = entryPrice * (minSafeBufferPerc / 100);

                    const maxSafeSlBuy = entryPrice - minSafeDist;
                    const minSafeSlSell = entryPrice + minSafeDist;

                    let wasSlClamped = false;
                    if (direction === "BUY" && targetSl > maxSafeSlBuy) {
                        targetSl = maxSafeSlBuy;
                        wasSlClamped = true;
                    } else if (direction === "SELL" && targetSl < minSafeSlSell) {
                        targetSl = minSafeSlSell;
                        wasSlClamped = true;
                    }

                    sl = parseFloat(targetSl.toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                    slLimit = sl;

                    // Recalculate Net Risk with new SL
                    let newRiskPriceDist = Math.abs(entryPrice - sl);
                    let newExitFeeSl = sl * (feePercent / 2);
                    let newNetRisk = newRiskPriceDist + (entryFee + newExitFeeSl);

                    // If SL was clamped to protect entry safety distance, use hybrid fallthrough to adjust TP for the remaining gap
                    if (wasSlClamped) {
                        const requiredNetRewardClamped = targetMinRr * newNetRisk;
                        let forcedTpClamped: number;
                        if (direction === "BUY") {
                            forcedTpClamped = (requiredNetRewardClamped + entryPrice * (1 + feePercent / 2)) / (1 - feePercent / 2);
                        } else {
                            forcedTpClamped = (entryPrice * (1 - feePercent / 2) - requiredNetRewardClamped) / (1 + feePercent / 2);
                        }
                        tp = parseFloat(forcedTpClamped.toFixed(entryConfig.PRICE_DECIMAL_PLACES));

                        rewardPriceDist = Math.abs(tp - entryPrice);
                        exitFeeTp = tp * (feePercent / 2);
                        const forcedNetRewardClamped = rewardPriceDist - (entryFee + exitFeeTp);
                        rr = newNetRisk > 0 ? forcedNetRewardClamped / newNetRisk : 0;

                        // Tick-nudge loop to ensure decimal rounding doesn't drop RR below targetMinRr
                        const tick = 1 / Math.pow(10, entryConfig.PRICE_DECIMAL_PLACES);
                        let loopCount = 0;
                        while ((rr + 1e-5) < targetMinRr && loopCount < 10) {
                            tp = parseFloat((tp + (direction === "BUY" ? tick : -tick)).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                            rewardPriceDist = Math.abs(tp - entryPrice);
                            exitFeeTp = tp * (feePercent / 2);
                            const currentNetReward = rewardPriceDist - (entryFee + exitFeeTp);
                            rr = newNetRisk > 0 ? currentNetReward / newNetRisk : 0;
                            loopCount++;
                        }

                        baseTp = tp / tpTriggerFactor;
                        const rawTpLimitForced = baseTp * tpLimitFactor;
                        tpLimit = rawTpLimitForced <= 0
                            ? parseFloat((1 / Math.pow(10, entryConfig.PRICE_DECIMAL_PLACES)).toFixed(entryConfig.PRICE_DECIMAL_PLACES))
                            : parseFloat(rawTpLimitForced.toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                    } else {
                        rewardPriceDist = Math.abs(tp - entryPrice);
                        exitFeeTp = tp * (feePercent / 2);
                        const currentNetReward = rewardPriceDist - (entryFee + exitFeeTp);
                        rr = newNetRisk > 0 ? currentNetReward / newNetRisk : 0;
                    }

                    slPerc = entryPrice > 0 ? (newRiskPriceDist / entryPrice) * 100 : 0;
                    tpPerc = entryPrice > 0 ? (rewardPriceDist / entryPrice) * 100 : 0;

                    marketDetectorLogger.info(
                        `[DynamicSL] ${entryConfig.SYMBOL}: Initial RR (${initialRr.toFixed(2)}) < min RR (${targetMinRr.toFixed(2)}). Shortened SL to meet RR: initial SL=${initialSl} -> adjusted SL=${sl}${wasSlClamped ? ` (Clamped at ${minSafeBufferPerc}% min safe buffer)` : ""}, updated RR=${rr.toFixed(2)}`
                    );
                } else {
                    // Mode = "tp": Extend Take Profit to achieve targetMinRr (Existing logic)
                    const requiredNetReward = targetMinRr * netRisk;

                    let forcedTp: number;
                    if (direction === "BUY") {
                        forcedTp = (requiredNetReward + entryPrice * (1 + feePercent / 2)) / (1 - feePercent / 2);
                    } else {
                        forcedTp = (entryPrice * (1 - feePercent / 2) - requiredNetReward) / (1 + feePercent / 2);
                    }

                    tp = parseFloat(forcedTp.toFixed(entryConfig.PRICE_DECIMAL_PLACES));

                    baseTp = tp / tpTriggerFactor;
                    const rawTpLimitForced = baseTp * tpLimitFactor;
                    if (rawTpLimitForced <= 0) {
                        tpLimit = parseFloat((1 / Math.pow(10, entryConfig.PRICE_DECIMAL_PLACES)).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                    } else {
                        tpLimit = parseFloat(rawTpLimitForced.toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                    }

                    rewardPriceDist = Math.abs(tp - entryPrice);
                    exitFeeTp = tp * (feePercent / 2);
                    const forcedNetReward = rewardPriceDist - (entryFee + exitFeeTp);
                    rr = netRisk > 0 ? forcedNetReward / netRisk : 0;

                    const tick = 1 / Math.pow(10, entryConfig.PRICE_DECIMAL_PLACES);
                    let loopCount = 0;
                    while (rr < targetMinRr && loopCount < 10) {
                        tp = parseFloat((tp + (direction === "BUY" ? tick : -tick)).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                        rewardPriceDist = Math.abs(tp - entryPrice);
                        exitFeeTp = tp * (feePercent / 2);
                        const currentNetReward = rewardPriceDist - (entryFee + exitFeeTp);
                        rr = netRisk > 0 ? currentNetReward / netRisk : 0;
                        loopCount++;
                    }

                    tpPerc = entryPrice > 0 ? (rewardPriceDist / entryPrice) * 100 : 0;

                    marketDetectorLogger.info(
                        `[DynamicTP] ${entryConfig.SYMBOL}: Initial RR (${initialRr.toFixed(2)}) < target min RR (${targetMinRr.toFixed(2)}). Forced TP by adjusting TP: initial TP=${initialTp} -> adjusted TP=${tp}, updated RR=${rr.toFixed(2)}`
                    );
                }
            }

            /* ================= TESTING MODE TP/SL GUARANTEE ================= */
            if (entryConfig.IS_TESTING) {
                // Ensure SL is strictly valid for exchange order placement
                if (direction === "BUY" && (sl <= 0 || sl >= entryPrice)) {
                    sl = parseFloat((entryPrice * 0.99).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                    slLimit = sl;
                    isSlAlreadyCrossed = false;
                    marketDetectorLogger.info(`[TESTING] ${entryConfig.SYMBOL}: Adjusted BUY SL to valid price below entry: SL=${sl}`);
                } else if (direction === "SELL" && (sl <= 0 || sl <= entryPrice)) {
                    sl = parseFloat((entryPrice * 1.01).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                    slLimit = sl;
                    isSlAlreadyCrossed = false;
                    marketDetectorLogger.info(`[TESTING] ${entryConfig.SYMBOL}: Adjusted SELL SL to valid price above entry: SL=${sl}`);
                }

                // Ensure TP is strictly valid for exchange order placement
                if (direction === "BUY" && (tp <= 0 || tp <= entryPrice || tp <= sl)) {
                    tp = parseFloat((entryPrice * 1.02).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                    marketDetectorLogger.info(`[TESTING] ${entryConfig.SYMBOL}: Adjusted BUY TP to valid price above entry: TP=${tp}`);
                } else if (direction === "SELL" && (tp <= 0 || tp >= entryPrice || tp >= sl)) {
                    tp = parseFloat((entryPrice * 0.98).toFixed(entryConfig.PRICE_DECIMAL_PLACES));
                    marketDetectorLogger.info(`[TESTING] ${entryConfig.SYMBOL}: Adjusted SELL TP to valid price below entry: TP=${tp}`);
                }

                // Recalculate metrics for testing logs
                const finalRiskDist = Math.abs(entryPrice - sl);
                const finalRewardDist = Math.abs(tp - entryPrice);
                slPerc = entryPrice > 0 ? (finalRiskDist / entryPrice) * 100 : 0;
                tpPerc = entryPrice > 0 ? (finalRewardDist / entryPrice) * 100 : 0;
                rr = finalRiskDist > 0 ? finalRewardDist / finalRiskDist : 1.0;
            }

            const slRoe = (slPerc * leverage).toFixed(2);
            const tpRoe = (tpPerc * leverage).toFixed(2);

            marketDetectorLogger.info(
                `[SlTpLevels] ${entryConfig.SYMBOL} (${direction}) | Entry: ${entryPrice} | SL: ${sl} (-${slPerc.toFixed(2)}% price, -${slRoe}% ROE @ ${leverage}x) | TP: ${tp} (+${tpPerc.toFixed(2)}% price, +${tpRoe}% ROE @ ${leverage}x) | RR: ${rr.toFixed(2)} | Testing: ${entryConfig.IS_TESTING}`
            );
        }

        return {
            sl,
            tp,
            rr,
            tpPerc,
            slPerc,
            slLimit,
            tpLimit,
            isSlAlreadyCrossed,
            crossedReason,
            isExceededMovementLimit,
            structSlPerc,
            confSlPerc,
            isPoorNaturalRr
        };
    }
}