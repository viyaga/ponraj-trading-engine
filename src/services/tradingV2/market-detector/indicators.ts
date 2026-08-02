import { Candle } from "../type";

export function calculateATR(candles: Candle[], period: number): number {
    if (candles.length < period + 1) return 0;

    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close;

        trs.push(Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        ));
    }

    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < trs.length; i++) {
        atr = ((atr * (period - 1)) + trs[i]) / period;
    }

    return atr;
}

export function getRollingATRPercentAvg(candles: Candle[], period: number): number {
    if (candles.length < period * 2) return 0;

    const atrValues: number[] = [];

    for (let i = period; i < candles.length; i++) {
        const slice = candles.slice(0, i + 1);
        const atr = calculateATR(slice, period);
        const close = slice[slice.length - 1].close;
        atrValues.push(close === 0 ? 0 : (atr / close) * 100);
    }

    const last = atrValues.slice(-period);
    return last.reduce((a, b) => a + b, 0) / last.length;
}

export function calculateADXSeries(candles: Candle[], period: number): number[] {
    if (candles.length < period * 2) return [];

    const plusDM: number[] = [];
    const minusDM: number[] = [];
    const trs: number[] = [];

    for (let i = 1; i < candles.length; i++) {
        const upMove = candles[i].high - candles[i - 1].high;
        const downMove = candles[i - 1].low - candles[i].low;

        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

        trs.push(Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close)
        ));
    }

    let smoothedTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
    let smoothedPlus = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
    let smoothedMinus = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

    const dxValues: number[] = [];

    for (let i = period; i < trs.length; i++) {
        smoothedTR = smoothedTR - (smoothedTR / period) + trs[i];
        smoothedPlus = smoothedPlus - (smoothedPlus / period) + plusDM[i];
        smoothedMinus = smoothedMinus - (smoothedMinus / period) + minusDM[i];

        if (smoothedTR === 0) {
            dxValues.push(0);
            continue;
        }

        const plusDI = (smoothedPlus / smoothedTR) * 100;
        const minusDI = (smoothedMinus / smoothedTR) * 100;
        const sum = plusDI + minusDI;

        dxValues.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100);
    }

    let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const series: number[] = [adx];

    for (let i = period; i < dxValues.length; i++) {
        adx = ((adx * (period - 1)) + dxValues[i]) / period;
        series.push(adx);
    }

    return series;
}

export function calculateVEISeries(candles: Candle[], period: number = 20): number[] {
    if (candles.length < period) return [];

    const veiSeries: number[] = [];

    for (let i = period; i < candles.length; i++) {
        const slice = candles.slice(i - period, i + 1);
        const currentRange = slice[slice.length - 1].high - slice[slice.length - 1].low;

        const avgRange = slice.reduce((acc, c) => acc + (c.high - c.low), 0) / slice.length;

        veiSeries.push(avgRange === 0 ? 1 : currentRange / avgRange);
    }

    return veiSeries;
}