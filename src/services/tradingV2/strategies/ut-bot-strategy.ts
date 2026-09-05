// =============================================================================
// UT Bot Alerts Strategy — 1-Hour Timeframe Trend Following Engine
// =============================================================================
// Pine Script v6 Reference:
//   a = input.float(1.0, "Key Value")
//   c = input.int(10, "ATR Period")
//   h = input.bool(false, "Signals from Heikin Ashi Candles")
//
//   xATR = ta.atr(c)
//   nLoss = a * xATR
//   src = h ? haClose : close
//
//   xATRTrailingStop =
//       src > prevStop and src[1] > prevStop ? math.max(prevStop, src - nLoss) :
//       src < prevStop and src[1] < prevStop ? math.min(prevStop, src + nLoss) :
//       src > prevStop ? src - nLoss : src + nLoss
//
//   pos = src[1] < prevTrailingStop and src > prevTrailingStop ? 1 :
//         src[1] > prevTrailingStop and src < prevTrailingStop ? -1 : pos[1]
//
//   emaValue = ta.ema(src, 1)  // i.e., src
//   above = ta.crossover(emaValue, xATRTrailingStop)
//   below = ta.crossover(xATRTrailingStop, emaValue)
//   buy = src > xATRTrailingStop and above
//   sell = src < xATRTrailingStop and below
// =============================================================================

import { Candle, UTBotSignalResult } from '../type';

export interface UTBotConfig {
    keyValue: number;       // default: 1.0 (sensitivity factor 'a')
    atrPeriod: number;      // default: 10 ('c')
    useHeikinAshi?: boolean;// default: false ('h')
}

export class UTBotStrategy {

    /**
     * Convert standard candles to Heikin-Ashi candles if requested
     */
    static calculateHeikinAshi(candles: Candle[]): Candle[] {
        if (!candles.length) return [];
        const haCandles: Candle[] = [];

        for (let i = 0; i < candles.length; i++) {
            const current = candles[i];
            const haClose = (current.open + current.high + current.low + current.close) / 4;
            const haOpen = i === 0
                ? (current.open + current.close) / 2
                : (haCandles[i - 1].open + haCandles[i - 1].close) / 2;
            const haHigh = Math.max(current.high, haOpen, haClose);
            const haLow = Math.min(current.low, haOpen, haClose);

            haCandles.push({
                timestamp: current.timestamp,
                open: haOpen,
                high: haHigh,
                low: haLow,
                close: haClose,
                volume: current.volume,
            });
        }
        return haCandles;
    }

    /**
     * Compute True Range of a candle relative to previous candle close
     */
    static computeTR(candle: Candle, prevCandle: Candle): number {
        const hl = candle.high - candle.low;
        const hpc = Math.abs(candle.high - prevCandle.close);
        const lpc = Math.abs(candle.low - prevCandle.close);
        return Math.max(hl, hpc, lpc);
    }

    /**
     * Compute array of ATR values using Pine Script's Wilder's Smoothing (ta.atr)
     */
    static computeATRSeries(candles: Candle[], period: number = 10): number[] {
        const n = candles.length;
        if (n < period + 1) return new Array(n).fill(0);

        const atrSeries = new Array(n).fill(0);

        // First ATR is simple SMA of initial 'period' True Ranges
        let trSum = 0;
        for (let i = 1; i <= period; i++) {
            trSum += this.computeTR(candles[i], candles[i - 1]);
        }
        let currentATR = trSum / period;
        atrSeries[period] = currentATR;

        // Subsequent ATRs use Wilder's RMA: (prevATR * (period - 1) + currentTR) / period
        for (let i = period + 1; i < n; i++) {
            const tr = this.computeTR(candles[i], candles[i - 1]);
            currentATR = (currentATR * (period - 1) + tr) / period;
            atrSeries[i] = currentATR;
        }

        return atrSeries;
    }

    /**
     * Compute UT Bot ATR Trailing Stops and Pos for the entire candle series
     */
    static calculateUTBotSeries(
        rawCandles: Candle[],
        config: UTBotConfig = { keyValue: 1.0, atrPeriod: 10, useHeikinAshi: false }
    ): {
        srcSeries: number[];
        atrSeries: number[];
        trailingStopSeries: number[];
        posSeries: number[];
        buySignals: boolean[];
        sellSignals: boolean[];
    } {
        const sorted = [...rawCandles].sort((a, b) => a.timestamp - b.timestamp);
        const candles = config.useHeikinAshi ? this.calculateHeikinAshi(sorted) : sorted;
        const n = candles.length;

        const srcSeries = candles.map(c => c.close);
        const atrSeries = this.computeATRSeries(candles, config.atrPeriod);
        const trailingStopSeries = new Array(n).fill(0);
        const posSeries = new Array(n).fill(0);
        const buySignals = new Array(n).fill(false);
        const sellSignals = new Array(n).fill(false);

        if (n <= config.atrPeriod) {
            return { srcSeries, atrSeries, trailingStopSeries, posSeries, buySignals, sellSignals };
        }

        let xATRTrailingStop = 0;
        let pos = 0;

        for (let i = config.atrPeriod; i < n; i++) {
            const src = srcSeries[i];
            const srcPrev = srcSeries[i - 1];
            const xATR = atrSeries[i];
            const nLoss = config.keyValue * xATR;

            const previousStop = xATRTrailingStop;
            const previousTrailingStop = previousStop;

            // ATR Trailing Stop calculation
            if (src > previousStop && srcPrev > previousStop) {
                xATRTrailingStop = Math.max(previousStop, src - nLoss);
            } else if (src < previousStop && srcPrev < previousStop) {
                xATRTrailingStop = Math.min(previousStop, src + nLoss);
            } else if (src > previousStop) {
                xATRTrailingStop = src - nLoss;
            } else {
                xATRTrailingStop = src + nLoss;
            }

            trailingStopSeries[i] = xATRTrailingStop;

            // Position State calculation
            if (srcPrev < previousTrailingStop && src > previousTrailingStop) {
                pos = 1;
            } else if (srcPrev > previousTrailingStop && src < previousTrailingStop) {
                pos = -1;
            }
            posSeries[i] = pos;

            // EMA(src, 1) = src
            const emaValue = src;
            const emaPrev = srcPrev;
            const stopPrev = previousStop;

            // ta.crossover(emaValue, xATRTrailingStop) -> previous was <= and current is >
            const above = emaPrev <= stopPrev && emaValue > xATRTrailingStop;
            // ta.crossover(xATRTrailingStop, emaValue) -> previous was <= and current is >
            const below = stopPrev <= emaPrev && xATRTrailingStop > emaValue;

            // Buy & Sell triggers (strictly identical to TradingView Pine Script)
            const buy = src > xATRTrailingStop && above;
            const sell = src < xATRTrailingStop && below;

            buySignals[i] = buy;
            sellSignals[i] = sell;
        }

        return {
            srcSeries,
            atrSeries,
            trailingStopSeries,
            posSeries,
            buySignals,
            sellSignals,
        };
    }

    /**
     * Evaluate 1H UT Bot Signal on completed 1-hour candles
     */
    static evaluateSignal(
        candles1h: Candle[],
        spotPrice: number,
        config: UTBotConfig = { keyValue: 1.0, atrPeriod: 10, useHeikinAshi: false }
    ): UTBotSignalResult {
        const result: UTBotSignalResult = {
            signal: 'NONE',
            optionType: null,
            atr: 0,
            trailingStop: 0,
            score: 0,
            reasons: [],
            skipReasons: [],
        };

        if (!candles1h || candles1h.length < config.atrPeriod + 2) {
            result.skipReasons.push(
                `Insufficient completed 1H candles (${candles1h?.length ?? 0}/${config.atrPeriod + 2})`
            );
            return result;
        }

        const sorted = [...candles1h].sort((a, b) => a.timestamp - b.timestamp);
        const calculated = this.calculateUTBotSeries(sorted, config);
        const lastIdx = calculated.buySignals.length - 1;

        const isBuy = calculated.buySignals[lastIdx];
        const isSell = calculated.sellSignals[lastIdx];
        const currentStop = calculated.trailingStopSeries[lastIdx];
        const currentATR = calculated.atrSeries[lastIdx];
        const currentPos = calculated.posSeries[lastIdx];
        const signalCandle = sorted[lastIdx];

        result.atr = currentATR;
        result.trailingStop = currentStop;
        result.signalCandleTimestamp = signalCandle.timestamp;

        const candleTimeStr = new Date(signalCandle.timestamp).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });

        if (isBuy) {
            result.signal = 'BULL';
            result.optionType = 'CE';
            result.score = 100;
            result.reasons.push(
                `UT Bot BUY Signal (1H): Candle [${candleTimeStr} IST] Close (${signalCandle.close.toFixed(2)}) > Trailing Stop (${currentStop.toFixed(2)}) ` +
                `with bullish crossover (Spot: ₹${spotPrice.toFixed(2)}, ATR: ${currentATR.toFixed(2)}, Key: ${config.keyValue})`
            );
        } else if (isSell) {
            result.signal = 'BEAR';
            result.optionType = 'PE';
            result.score = 100;
            result.reasons.push(
                `UT Bot SELL Signal (1H): Candle [${candleTimeStr} IST] Close (${signalCandle.close.toFixed(2)}) < Trailing Stop (${currentStop.toFixed(2)}) ` +
                `with bearish crossover (Spot: ₹${spotPrice.toFixed(2)}, ATR: ${currentATR.toFixed(2)}, Key: ${config.keyValue})`
            );
        } else {
            result.skipReasons.push(
                `UT Bot (1H): No fresh crossover on completed 1H candle [${candleTimeStr} IST Close: ${signalCandle.close.toFixed(2)}]. ` +
                `Current pos: ${currentPos === 1 ? 'LONG' : currentPos === -1 ? 'SHORT' : 'FLAT'}, TrailingStop: ₹${currentStop.toFixed(2)}`
            );
        }

        return result;
    }
}
