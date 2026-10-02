import fs from 'fs';
import path from 'path';
import { Candle } from '../src/services/tradingV2/type';
import {
    detectCandlePattern,
    getTodayCandles,
    computeCandleComponents,
} from '../src/services/tradingV2/strategies/candle-pattern-strategy';

const cacheFile = path.join(process.cwd(), 'cache', 'nifty_15m_cached.json');
const rawCandles: Candle[] = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
const sorted = [...rawCandles].sort((a, b) => a.timestamp - b.timestamp);

// Group by date
const dayMap = new Map<string, Candle[]>();
for (const c of sorted) {
    const dateStr = new Date(c.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (!dayMap.has(dateStr)) dayMap.set(dateStr, []);
    dayMap.get(dateStr)!.push(c);
}

const uniqueDates = Array.from(dayMap.keys()).sort();
const last2Days = uniqueDates.slice(-2);

console.log('Evaluating strict Day High (Shooting Star) and Day Low (Hammer):');
console.log('Target dates:', last2Days.join(', '));

for (const targetDate of last2Days) {
    console.log(`\n============================================================`);
    console.log(`TRADING DATE: ${targetDate}`);
    console.log(`============================================================`);

    const dayCandles = dayMap.get(targetDate)!;
    
    // As the day evolves candle by candle:
    for (let i = 0; i < dayCandles.length; i++) {
        const c = dayCandles[i];
        const nextCandle = i < dayCandles.length - 1 ? dayCandles[i + 1] : null;
        const prevCandle = i > 0 ? dayCandles[i - 1] : undefined;
        const prevPrevCandle = i > 1 ? dayCandles[i - 2] : undefined;

        // Running Day High and Day Low UP TO THIS CANDLE (cumulative)
        const candlesSoFar = dayCandles.slice(0, i + 1);
        const dayHighSoFar = Math.max(...candlesSoFar.map(x => x.high));
        const dayLowSoFar = Math.min(...candlesSoFar.map(x => x.low));

        // Final full-day Day High and Day Low
        const fullDayHigh = Math.max(...dayCandles.map(x => x.high));
        const fullDayLow = Math.min(...dayCandles.map(x => x.low));

        const timeStr = new Date(c.timestamp).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });

        const patternRes = detectCandlePattern(c, prevCandle, prevPrevCandle);
        const isBullish = patternRes.isHammer || patternRes.pattern === 'PIN_BAR_BULLISH';
        const isBearish = patternRes.isShootingStar || patternRes.pattern === 'PIN_BAR_BEARISH';

        // Check if candle high is the Day High or candle low is the Day Low
        const isExactDayHigh = Math.abs(c.high - dayHighSoFar) <= 1.0;
        const isExactDayLow = Math.abs(c.low - dayLowSoFar) <= 1.0;

        if ((isBearish && isExactDayHigh) || (isBullish && isExactDayLow)) {
            console.log(`[${timeStr} IST] Pattern: ${patternRes.pattern}`);
            console.log(`  OHLC: O:${c.open}, H:${c.high}, L:${c.low}, C:${c.close}`);
            console.log(`  Day High So Far: ${dayHighSoFar} (Full Day High: ${fullDayHigh}) -> Is High: ${isExactDayHigh}`);
            console.log(`  Day Low So Far: ${dayLowSoFar} (Full Day Low: ${fullDayLow}) -> Is Low: ${isExactDayLow}`);
            
            // Check breakout on next candle
            if (isBearish && nextCandle) {
                const breakdown = nextCandle.low < c.low;
                console.log(`  PE Breakdown confirmed on next candle? ${breakdown} (Next Low: ${nextCandle.low} < Candle Low: ${c.low})`);
            }
            if (isBullish && nextCandle) {
                const breakout = nextCandle.high > c.high;
                console.log(`  CE Breakout confirmed on next candle? ${breakout} (Next High: ${nextCandle.high} > Candle High: ${c.high})`);
            }
            console.log('------------------------------------------------------------');
        }
    }
}
