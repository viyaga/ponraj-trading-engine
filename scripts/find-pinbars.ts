import fs from 'fs';
import path from 'path';
import { Candle } from '../src/services/tradingV2/type';
import {
    detectCandlePattern,
    computeCandleComponents
} from '../src/services/tradingV2/strategies/candle-pattern-strategy';

const cacheFile = path.join(process.cwd(), 'cache', 'nifty_15m_cached.json');
const candles: Candle[] = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

console.log(`Scanning all ${candles.length} candles in dataset for PIN_BAR_BULLISH and HAMMER...`);

let count = 0;
for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prev = i > 0 ? candles[i - 1] : undefined;
    const prevPrev = i > 1 ? candles[i - 2] : undefined;
    const res = detectCandlePattern(c, prev, prevPrev);
    
    if (res.pattern === 'PIN_BAR_BULLISH' || res.pattern === 'HAMMER') {
        count++;
        const comp = computeCandleComponents(c);
        const timeStr = new Date(c.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        console.log(`${count}. [${timeStr}] Pattern: ${res.pattern} (isHammer=${res.isHammer})`);
        console.log(`   OHLC: O:${c.open}, H:${c.high}, L:${c.low}, C:${c.close} | Range: ${comp.range.toFixed(1)}`);
        console.log(`   Lower Wick: ${(comp.lowerWickPercent * 100).toFixed(1)}% (${(comp.lowerWick / (comp.body || 1)).toFixed(2)}x body), Upper Wick: ${(comp.upperWickPercent * 100).toFixed(1)}% (${(comp.upperWick / (comp.body || 1)).toFixed(2)}x body), Body: ${(comp.bodyPercent * 100).toFixed(1)}%`);
        console.log(`   Description: ${res.description}`);
    }
}
