import fs from 'fs';
import path from 'path';
import { Candle, CandlePatternSignalResult, ConfigType } from '../src/services/tradingV2/type';
import {
    CandlePatternStrategy,
    computeCandleComponents,
    detectCandlePattern,
    isHammerPattern,
    isShootingStarPattern,
    getTodayCandles,
} from '../src/services/tradingV2/strategies/candle-pattern-strategy';
import { ATR14Strategy } from '../src/services/tradingV2/strategies/atr14-strategy';
import { TradingConfig } from '../src/services/tradingV2/config';

interface CandleEvaluationReport {
    index: number;
    timestamp: number;
    timeIST: string;
    dateIST: string;
    open: number;
    high: number;
    low: number;
    close: number;
    isBullish: boolean;
    body: number;
    bodyPct: number;
    upperWickRatio: string;
    lowerWickRatio: string;
    pattern: string;
    dayHigh: number;
    dayLow: number;
    dayRange: number;
    atr14: number;
    distFromDayLow: number;
    distFromDayHigh: number;
    isNearDayLow: boolean;
    isNearDayHigh: boolean;
    breakoutConfirmed: boolean;
    signal: string;
    optionType: string | null;
    score: number;
    reasons: string[];
    skipReasons: string[];
}

async function runBacktest() {
    const cacheFile = path.join(process.cwd(), 'cache', 'nifty_15m_cached.json');
    if (!fs.existsSync(cacheFile)) {
        console.error('Cache file not found:', cacheFile);
        process.exit(1);
    }

    const rawCandles: Candle[] = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const sorted = [...rawCandles].sort((a, b) => a.timestamp - b.timestamp);

    console.log(`Loaded ${sorted.length} total candles from cache.`);

    // Group candles by IST date
    const dayMap = new Map<string, Candle[]>();
    for (const c of sorted) {
        const dateStr = new Date(c.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
        if (!dayMap.has(dateStr)) {
            dayMap.set(dateStr, []);
        }
        dayMap.get(dateStr)!.push(c);
    }

    const uniqueDates = Array.from(dayMap.keys()).sort();
    console.log(`Available trading dates in dataset: ${uniqueDates.join(', ')}`);

    if (uniqueDates.length < 2) {
        console.error('Less than 2 trading dates available!');
        process.exit(1);
    }

    // Last 2 trading days
    const last2Days = uniqueDates.slice(-2);
    console.log(`\n================================================================================`);
    console.log(`Targeting the last 2 trading days: ${last2Days.join(' and ')}`);
    console.log(`================================================================================\n`);

    const defaultCfg = TradingConfig.defaultConfig as ConfigType;

    const reports: CandleEvaluationReport[] = [];

    // Find the starting index for the last 2 days
    const firstTargetDate = last2Days[0];
    const startIndex = sorted.findIndex(c => {
        const d = new Date(c.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        return d === firstTargetDate;
    });

    console.log(`Simulating candle-by-candle cron execution from candle index ${startIndex} to ${sorted.length - 1}...\n`);

    for (let i = startIndex; i < sorted.length; i++) {
        const currentCandle = sorted[i];
        const nextCandle = i < sorted.length - 1 ? sorted[i + 1] : null;

        const timeIST = new Date(currentCandle.timestamp).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
        const dateIST = new Date(currentCandle.timestamp).toLocaleDateString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
        });

        // Candles available up to this point in time
        const historicalSlice = sorted.slice(0, i + 1);

        // Calculate ATR(14) up to this candle
        const atr = ATR14Strategy.computeATR(historicalSlice, 14);

        // Day candles for today up to this candle
        const cDateStr = new Date(currentCandle.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const todaySlice = historicalSlice.filter(c => {
            const d = new Date(c.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
            return d === cDateStr;
        });

        const dayHigh = Math.max(...todaySlice.map(c => c.high));
        const dayLow  = Math.min(...todaySlice.map(c => c.low));
        const dayRange = Math.max(dayHigh - dayLow, 1.0);

        // Compute components
        const comp = computeCandleComponents(currentCandle);
        const upperWickRatio = comp.body > 0 ? (comp.upperWick / comp.body).toFixed(2) : 'inf';
        const lowerWickRatio = comp.body > 0 ? (comp.lowerWick / comp.body).toFixed(2) : 'inf';

        // Detect raw pattern
        const prevCandle = i > 0 ? sorted[i - 1] : undefined;
        const prevPrevCandle = i > 1 ? sorted[i - 2] : undefined;
        const patternConfig = {
            hammerMaxBodyPct: 0.35,
            hammerMinLowerWickRatio: 2.0,
            hammerMaxUpperWickRatio: 0.8,
            shootingStarMaxBodyPct: 0.35,
            shootingStarMinUpperWickRatio: 2.0,
            shootingStarMaxLowerWickRatio: 0.8,
            dayRangeProximityPct: 30,
            minRangeAtrRatio: 0.35,
        };

        const patternDetection = detectCandlePattern(currentCandle, prevCandle, prevPrevCandle, patternConfig, atr);

        const proximityThreshold = 0.30 * dayRange;
        const atrThreshold = atr * 1.0;
        const maxAllowedDist = Math.max(proximityThreshold, atrThreshold);

        const distFromDayLow = currentCandle.low - dayLow;
        const distFromDayHigh = dayHigh - currentCandle.high;
        const isNearDayLow = distFromDayLow <= maxAllowedDist;
        const isNearDayHigh = distFromDayHigh <= maxAllowedDist;

        // Spot price at close of candle (or immediate breakout on next candle)
        // If next candle exists, check if its high broke Hammer high or low broke Shooting Star low
        const isBullish = patternDetection.isHammer || patternDetection.pattern === 'PIN_BAR_BULLISH';
        const isBearish = patternDetection.isShootingStar || patternDetection.pattern === 'PIN_BAR_BEARISH';

        let spotForEval = currentCandle.close;
        if (isBullish && nextCandle && nextCandle.high > currentCandle.high) {
            spotForEval = nextCandle.high; // breakout confirmed on next candle
        } else if (isBearish && nextCandle && nextCandle.low < currentCandle.low) {
            spotForEval = nextCandle.low; // breakdown confirmed on next candle
        }

        const evalResult = CandlePatternStrategy.evaluateSignal(
            historicalSlice,
            spotForEval,
            defaultCfg,
            14
        );

        let breakoutConfirmed = false;
        if (isBullish && spotForEval > currentCandle.high) breakoutConfirmed = true;
        if (isBearish && spotForEval < currentCandle.low) breakoutConfirmed = true;

        reports.push({
            index: i,
            timestamp: currentCandle.timestamp,
            timeIST,
            dateIST,
            open: currentCandle.open,
            high: currentCandle.high,
            low: currentCandle.low,
            close: currentCandle.close,
            isBullish: comp.isBullish,
            body: comp.body,
            bodyPct: comp.bodyPercent * 100,
            upperWickRatio,
            lowerWickRatio,
            pattern: patternDetection.pattern,
            dayHigh,
            dayLow,
            dayRange,
            atr14: atr,
            distFromDayLow,
            distFromDayHigh,
            isNearDayLow,
            isNearDayHigh,
            breakoutConfirmed,
            signal: evalResult.signal,
            optionType: evalResult.optionType,
            score: evalResult.score,
            reasons: evalResult.reasons,
            skipReasons: evalResult.skipReasons,
        });
    }

    // Save full report to cache
    const reportFile = path.join(process.cwd(), 'cache', 'pattern_backtest_report.json');
    fs.writeFileSync(reportFile, JSON.stringify(reports, null, 2));

    // Print summary tables
    for (const d of last2Days) {
        console.log(`\n${'='.repeat(100)}`);
        console.log(`TRADING DATE: ${d}`);
        console.log(`${'='.repeat(100)}`);

        const dayReports = reports.filter(r => {
            const dt = new Date(r.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
            return dt === d;
        });

        console.log(`Total 15m Candles: ${dayReports.length}`);
        console.log(`Day High: ₹${dayReports[dayReports.length - 1].dayHigh.toFixed(2)} | Day Low: ₹${dayReports[dayReports.length - 1].dayLow.toFixed(2)} | Range: ₹${dayReports[dayReports.length - 1].dayRange.toFixed(2)}\n`);

        console.log(`Time (IST) | Open     | High     | Low      | Close    | Type | Body%  | UWick | LWick | Pattern       | Near Extreme? | Signal`);
        console.log(`-----------|----------|----------|----------|----------|------|--------|-------|-------|---------------|---------------|---------`);

        for (const r of dayReports) {
            const typeStr = r.isBullish ? '🟢 BULL' : '🔴 BEAR';
            const patStr = r.pattern !== 'NONE' ? `🎯 ${r.pattern}` : '  -  ';
            const extStr = r.pattern === 'HAMMER'
                ? (r.isNearDayLow ? '✅ Near Low' : '❌ Not Low')
                : r.pattern === 'SHOOTING_STAR'
                ? (r.isNearDayHigh ? '✅ Near High' : '❌ Not High')
                : '  -  ';
            const sigStr = r.signal !== 'NONE' ? `🔥 ${r.signal} (${r.optionType})` : 'None';

            console.log(
                `${r.timeIST.padEnd(10)} | ${r.open.toFixed(1).padEnd(8)} | ${r.high.toFixed(1).padEnd(8)} | ${r.low.toFixed(1).padEnd(8)} | ${r.close.toFixed(1).padEnd(8)} | ` +
                `${typeStr} | ${(r.bodyPct.toFixed(1) + '%').padEnd(6)} | ${r.upperWickRatio.padEnd(5)} | ${r.lowerWickRatio.padEnd(5)} | ` +
                `${patStr.padEnd(13)} | ${extStr.padEnd(13)} | ${sigStr}`
            );
        }
    }

    // Signals Found
    const signalCandles = reports.filter(r => r.signal !== 'NONE');
    console.log(`\n${'#'.repeat(100)}`);
    console.log(`SIGNALS GENERATED ACROSS LAST 2 DAYS: ${signalCandles.length}`);
    console.log(`${'#'.repeat(100)}`);

    if (signalCandles.length === 0) {
        console.log('\nNo natural Hammer or Shooting Star confirmed trade signals were triggered in these 2 days.');
        console.log('Let us also check candles that matched the Hammer or Shooting Star pattern shape (even if proximity or breakout filtered them):');
        
        const candidatePatterns = reports.filter(r => r.pattern === 'HAMMER' || r.pattern === 'SHOOTING_STAR');
        if (candidatePatterns.length > 0) {
            console.log(`Found ${candidatePatterns.length} candle(s) with Hammer/Shooting Star shape:`);
            for (const cp of candidatePatterns) {
                console.log(`\n• Date: ${cp.dateIST} at [${cp.timeIST} IST]`);
                console.log(`  Pattern:      ${cp.pattern}`);
                console.log(`  OHLC:         O: ₹${cp.open} | H: ₹${cp.high} | L: ₹${cp.low} | C: ₹${cp.close}`);
                console.log(`  Body / Range: Body: ₹${cp.body.toFixed(1)} (${cp.bodyPct.toFixed(1)}% of range)`);
                console.log(`  Wicks:        Upper: ${cp.upperWickRatio}x body | Lower: ${cp.lowerWickRatio}x body`);
                console.log(`  Day Context:  Day High: ₹${cp.dayHigh} | Day Low: ₹${cp.dayLow} | ATR(14): ₹${cp.atr14.toFixed(1)}`);
                console.log(`  Proximity:    Dist from Low: ₹${cp.distFromDayLow.toFixed(1)} | Dist from High: ₹${cp.distFromDayHigh.toFixed(1)}`);
                console.log(`  Near Target?  ${cp.pattern === 'HAMMER' ? (cp.isNearDayLow ? 'YES (near Day Low)' : 'NO (too far from Day Low)') : (cp.isNearDayHigh ? 'YES (near Day High)' : 'NO (too far from Day High)')}`);
                console.log(`  Breakout?     ${cp.breakoutConfirmed ? 'YES' : 'NO'}`);
                if (cp.skipReasons.length) console.log(`  Skip Reason:  ${cp.skipReasons.join('; ')}`);
                if (cp.reasons.length) console.log(`  Reasons:      ${cp.reasons.join('; ')}`);
            }
        } else {
            console.log('No candle met the strict mathematical wick/body criteria (Lower Wick >= 2x body, Upper Wick <= 0.5x body, Body <= 35%).');
        }
    } else {
        for (const sc of signalCandles) {
            console.log(`\n================================================================================`);
            console.log(`🎯 SIGNAL TRIGGERED! [${sc.dateIST} - ${sc.timeIST} IST]`);
            console.log(`================================================================================`);
            console.log(`  Signal:       ${sc.signal} (${sc.optionType} Option)`);
            console.log(`  Pattern:      ${sc.pattern}`);
            console.log(`  Score:        ${sc.score}/100`);
            console.log(`  Candle OHLC:  Open: ₹${sc.open} | High: ₹${sc.high} | Low: ₹${sc.low} | Close: ₹${sc.close}`);
            console.log(`  Body:         ₹${sc.body.toFixed(1)} (${sc.bodyPct.toFixed(1)}% of range)`);
            console.log(`  Wick Ratios:  Upper Wick: ${sc.upperWickRatio}x body | Lower Wick: ${sc.lowerWickRatio}x body`);
            console.log(`  Day Context:  Day High: ₹${sc.dayHigh} | Day Low: ₹${sc.dayLow} | Day Range: ₹${sc.dayRange}`);
            console.log(`  ATR(14):      ${sc.atr14.toFixed(2)} pts`);
            console.log(`  Reason:       ${sc.reasons.join(' | ')}`);
        }
    }
}

runBacktest().catch(err => {
    console.error('Fatal error in backtest:', err);
    process.exit(1);
});
