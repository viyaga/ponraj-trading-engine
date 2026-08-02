import { Candle, ConfigType, InternalChopConfig, TargetCandle, MarketEvaluationMode } from "../type";
import { marketDetectorLogger, getContextualLogger } from "../logger";
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
    isRangeCompressed,
    getVolumeExpansionPoints,
    getTargetCandleVolumeSpike,
    detectLiquiditySweep,
} from "./price-action";
import { Utils } from "../utils";

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export class MarketDetector {
    static getMarketProbability(
        targetCandle: TargetCandle,
        candles: Candle[],
        config: ConfigType,
        mode: MarketEvaluationMode = "entry",
        logContext?: any
    ): { probability: number; isAllowed: boolean; mode: MarketEvaluationMode; details?: any } {
        const internal = getInternalConfig(config);

        return this.calculateProbability(
            targetCandle,
            candles,
            internal,
            config.SYMBOL,
            mode,
            logContext
        );
    }

    private static calculateProbability(
        target: TargetCandle,
        candles: Candle[],
        cfg: InternalChopConfig,
        symbol: string,
        mode: MarketEvaluationMode,
        logContext?: any
    ): { probability: number; isAllowed: boolean; mode: MarketEvaluationMode; details?: any } {
        const logger = getContextualLogger(marketDetectorLogger, logContext);
        const details: any = {
            mode,
            atr: {},
            adx: {},
            vei: {},
            candle: {},
            volume: {},
            misc: {}
        };
        if (candles.length < Math.max(cfg.MIN_REQUIRED_CANDLES, cfg.ATR_PERIOD + 2)) {
            const probability = 0;
            const isAllowed = false;

            logger.info(`[MarketProbability] ${symbol}`, {
                probability,
                isAllowed,
                mode,
                reason: "INSUFFICIENT_CANDLES",
            });

            return { probability, isAllowed, mode, details: { reason: "INSUFFICIENT_CANDLES" } };
        }

        let prob = 50;
        const latestClose = candles[candles.length - 1].close;

        /* ================= ATR ================= */

        const atr = calculateATR(candles, cfg.ATR_PERIOD);
        const atrPercent = latestClose === 0 ? 0 : (atr / latestClose) * 100;
        const atrAvg = getRollingATRPercentAvg(candles, cfg.ATR_PERIOD);

        details.atr = { value: atr, percent: atrPercent, avg: atrAvg, score: 0 };
        if (atrAvg > 0) {
            if (atrPercent > atrAvg * 1.1) {
                prob += 8;
                details.atr.score = 8;
            } else if (atrPercent > atrAvg * 0.95) {
                prob += 4;
                details.atr.score = 4;
            } else {
                prob -= 8;
                details.atr.score = -8;
            }
        } else {
            prob -= 4;
            details.atr.score = -4;
        }

        /* ================= ADX ================= */

        const adxSeries = calculateADXSeries(candles, cfg.ADX_PERIOD);
        if (adxSeries.length > 0) {
            const adx = adxSeries[adxSeries.length - 1];
            details.adx = { value: adx, score: 0 };

            if (adx > cfg.ADX_WEAK_THRESHOLD + 8) {
                prob += 12;
                details.adx.score = 12;
            } else if (adx > cfg.ADX_WEAK_THRESHOLD) {
                prob += 8;
                details.adx.score = 8;
            } else {
                prob -= 8;
                details.adx.score = -8;
            }
        }

        /* ================= VEI ================= */

        const veiSeries = calculateVEISeries(candles, 20);
        const vei = veiSeries.length > 0 ? veiSeries[veiSeries.length - 1] : 1;
        details.vei = { value: vei, score: 0 };

        if (vei > 1.4) {
            prob += 5;
            details.vei.score = 5;
        } else if (vei > 1.2) {
            prob += 3;
            details.vei.score = 3;
        } else {
            prob -= 4;
            details.vei.score = -4;
        }

        /* ================= CANDLE STRENGTH ================= */

        const bodyPercent = Utils.getBodyPercent(target);
        details.candle = { bodyPercent, score: 0 };

        if (bodyPercent > 75) {
            prob += 15;
            details.candle.score = 15;
        } else if (bodyPercent > 65) {
            prob += 10;
            details.candle.score = 10;
        } else if (bodyPercent > 55) {
            prob += 5;
            details.candle.score = 5;
        } else if (bodyPercent < 45) {
            prob -= 10;
            details.candle.score = -10;
        } else if (bodyPercent < 35) {
            prob -= 15;
            details.candle.score = -15;
        }

        /* ================= VOLUME ================= */

        const volumeWindow = Math.min(20, candles.length);
        const avgVol =
            candles.slice(-volumeWindow).reduce((a, b) => a + b.volume, 0) / volumeWindow;

        const volumeSpike = avgVol > 0 && target.volume > avgVol * 1.5;
        details.volume = { avg: avgVol, target: target.volume, score: 0 };

        if (volumeSpike) {
            prob += 10;
            details.volume.score += 10;
        } else if (avgVol > 0 && target.volume > avgVol * 1.2) {
            prob += 5;
            details.volume.score += 5;
        }

        if (isVolumeContracting(candles)) {
            prob -= 8;
            details.volume.score -= 8;
        }

        const volExp = getVolumeExpansionPoints(candles);
        prob += volExp;
        details.volume.score += volExp;

        const targetVolSpike = getTargetCandleVolumeSpike(target, candles);
        prob += targetVolSpike;
        details.volume.score += targetVolSpike;

        /* ================= LIQUIDITY SWEEP ================= */

        if (detectLiquiditySweep(candles, cfg.LOOKBACK)) {
            prob += 8;
            details.misc.liquiditySweep = 8;
        }

        /* ================= CHOP / QUALITY ================= */

        const microChop = detectMicroChop(
            candles,
            atrAvg,
            cfg.SMALL_BODY_PERCENT_THRESHOLD,
            cfg.SMALL_BODY_MIN_COUNT
        );

        if (microChop) {
            prob -= 12;
            details.misc.microChop = -12;
        }

        const targetBad = isTargetCandleNotGood(target, atrPercent, 0.3);
        if (targetBad) {
            prob -= 8;
            details.misc.targetQuality = -8;
        }

        /* ================= MODE ================= */

        if (mode === "structure") {
            const compression = isRangeCompressed(candles, 5, cfg.LOOKBACK, 2);
            if (compression) {
                prob += 5;
                details.misc.compression = 5;
            } else {
                prob -= 3;
                details.misc.compression = -3;
            }
        }

        if (mode === "confirmation") {
            if (atrPercent > atrAvg * 1.05 || vei > 1.2) {
                prob += 4;
                details.misc.modeBonus = 4;
            } else {
                prob -= 4;
                details.misc.modeBonus = -4;
            }
        }

        prob = clamp(prob, 0, 100);

        const isAllowed = prob >= cfg.PROBABILITY_THRESHOLD;

        return {
            probability: prob,
            isAllowed,
            mode,
            details,
        };
    }
}