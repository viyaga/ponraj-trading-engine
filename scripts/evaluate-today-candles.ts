import fs from 'fs';
import path from 'path';
import { Candle, ConfigType } from '../src/services/tradingV2/type';
import {
    CandlePatternStrategy,
    computeCandleComponents,
    detectCandlePattern,
} from '../src/services/tradingV2/strategies/candle-pattern-strategy';
import { TradingConfig } from '../src/services/tradingV2/config';

async function main() {
    const cacheFile = path.join(process.cwd(), 'cache', 'nifty_15m_cached.json');
    if (!fs.existsSync(cacheFile)) {
        console.error('Cache file not found:', cacheFile);
        process.exit(1);
    }

    const rawCandles: Candle[] = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const sorted = [...rawCandles].sort((a, b) => a.timestamp - b.timestamp);

    console.log(`Loaded ${sorted.length} candles from cache.`);

    // Determine today's date from the last candle in cache
    const latestTs = sorted[sorted.length - 1].timestamp;
    const todayDateStr = new Date(latestTs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
    console.log(`Analyzing trading session: ${todayDateStr}`);

    // Find all candles of today
    const todayIndices: number[] = [];
    sorted.forEach((c, idx) => {
        const d = new Date(c.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        if (d === todayDateStr) {
            todayIndices.push(idx);
        }
    });

    if (todayIndices.length === 0) {
        console.error(`No candles found for ${todayDateStr}`);
        process.exit(1);
    }

    console.log(`Total candles for today (${todayDateStr}): ${todayIndices.length}`);
    console.log('='.repeat(105));
    console.log(
        'Time (IST)'.padEnd(12) +
        'Open'.padStart(10) +
        'High'.padStart(10) +
        'Low'.padStart(10) +
        'Close'.padStart(10) +
        'Pattern'.padStart(16) +
        'Signal'.padStart(12) +
        'Day High/Low'.padStart(20) +
        'Outcome / Reason'.padStart(15)
    );
    console.log('='.repeat(105));

    const defaultCfg = TradingConfig.defaultConfig as ConfigType;
    let signalFoundCount = 0;

    for (let i = 0; i < todayIndices.length; i++) {
        const currentIdx = todayIndices[i];
        const candle = sorted[currentIdx];
        const timeIST = new Date(candle.timestamp).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });

        // Sliced historical candles up to this moment
        const candlesUpToNow = sorted.slice(0, currentIdx + 1);
        const spotPrice = candle.close;

        // Individual candle pattern detection
        const prevCandle = currentIdx > 0 ? sorted[currentIdx - 1] : undefined;
        const prevPrevCandle = currentIdx > 1 ? sorted[currentIdx - 2] : undefined;
        const detected = detectCandlePattern(candle, prevCandle, prevPrevCandle);

        // Evaluate Strategy
        const stratResult = CandlePatternStrategy.evaluateSignal(
            candlesUpToNow,
            spotPrice,
            defaultCfg
        );

        const isSignal = stratResult.signal !== 'NONE';
        if (isSignal) signalFoundCount++;

        const signalStr = isSignal
            ? `🔥 ${stratResult.signal} (${stratResult.optionType})`
            : 'NONE';

        const dayRangeStr = `${stratResult.dayHigh.toFixed(1)} / ${stratResult.dayLow.toFixed(1)}`;
        const details = isSignal
            ? stratResult.reasons.join(' | ')
            : (stratResult.skipReasons[0] || detected.description || 'No signal');

        console.log(
            timeIST.padEnd(12) +
            candle.open.toFixed(2).padStart(10) +
            candle.high.toFixed(2).padStart(10) +
            candle.low.toFixed(2).padStart(10) +
            candle.close.toFixed(2).padStart(10) +
            detected.pattern.padStart(16) +
            signalStr.padStart(12) +
            dayRangeStr.padStart(20) +
            '   ' + details
        );
    }

    console.log('='.repeat(105));
    console.log(`\nSummary: Evaluated ${todayIndices.length} candles for ${todayDateStr}. Total signals generated: ${signalFoundCount}`);
}

main().catch(err => {
    console.error('Error running evaluation:', err);
    process.exit(1);
});
