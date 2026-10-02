import fs from 'fs';
import path from 'path';
import { Candle, ConfigType } from '../src/services/tradingV2/type';
import {
    CandlePatternStrategy,
    computeCandleComponents,
    detectCandlePattern,
} from '../src/services/tradingV2/strategies/candle-pattern-strategy';
import { ATR14Strategy } from '../src/services/tradingV2/strategies/atr14-strategy';
import { TradingConfig } from '../src/services/tradingV2/config';

interface TradeRecord {
    date: string;
    signalTime: string;
    entryTime: string;
    pattern: string;
    optionType: 'CE' | 'PE';
    entryPrice: number;
    stopLoss: number;
    riskPoints: number;
    exitTime: string;
    exitPrice: number;
    exitReason: string;
    pnlPoints: number;
    target1_1: number;
    hitTarget1_1: boolean;
    target1_2: number;
    hitTarget1_2: boolean;
    target1_3: number;
    hitTarget1_3: boolean;
    maxFavorableExcursion: number;
    maxAdverseExcursion: number;
}

async function runTest() {
    const cacheFile = path.join(process.cwd(), 'cache', 'nifty_15m_cached.json');
    if (!fs.existsSync(cacheFile)) {
        console.error('Cache file not found:', cacheFile);
        process.exit(1);
    }

    const rawCandles: Candle[] = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const sorted = [...rawCandles].sort((a, b) => a.timestamp - b.timestamp);

    // Group candles by IST date
    const dayMap = new Map<string, Candle[]>();
    for (const c of sorted) {
        const dateStr = new Date(c.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        if (!dayMap.has(dateStr)) dayMap.set(dateStr, []);
        dayMap.get(dateStr)!.push(c);
    }

    const uniqueDates = Array.from(dayMap.keys()).sort();
    const last2Days = uniqueDates.slice(-2);

    console.log('='.repeat(90));
    console.log(`CANDLE PATTERN REVERSAL STRATEGY TEST (LAST 2 TRADING DAYS)`);
    console.log(`Evaluated Dates: ${last2Days.join(' and ')}`);
    console.log(`Strategy Rules:`);
    console.log(`  1. Hammer at Day Low -> Buy CE (Breakout above Hammer High)`);
    console.log(`  2. Shooting Star at Day High -> Buy PE (Breakdown below Shooting Star Low)`);
    console.log(`  3. Exact Day Extreme: REQUIRE_EXACT_DAY_EXTREME = true`);
    console.log('='.repeat(90));

    const defaultCfg = TradingConfig.defaultConfig as ConfigType;
    const trades: TradeRecord[] = [];

    for (const targetDate of last2Days) {
        console.log(`\n\n${'#'.repeat(90)}`);
        console.log(`TRADING DATE: ${targetDate}`);
        console.log(`${'#'.repeat(90)}`);

        const dayCandles = dayMap.get(targetDate)!;
        const fullDayHigh = Math.max(...dayCandles.map(c => c.high));
        const fullDayLow = Math.min(...dayCandles.map(c => c.low));
        const fullDayRange = fullDayHigh - fullDayLow;

        console.log(`Total 15m Candles: ${dayCandles.length}`);
        console.log(`Full Day High: ₹${fullDayHigh.toFixed(2)} | Full Day Low: ₹${fullDayLow.toFixed(2)} | Range: ₹${fullDayRange.toFixed(2)}\n`);

        console.log(`Time (IST) | Open     | High     | Low      | Close    | Pattern            | Day High So Far | Day Low So Far | Extreme Match? | Signal`);
        console.log(`-----------|----------|----------|----------|----------|--------------------|-----------------|----------------|----------------|---------`);

        let activeTrade: TradeRecord | null = null;

        for (let i = 0; i < dayCandles.length; i++) {
            const c = dayCandles[i];
            const nextCandle = i < dayCandles.length - 1 ? dayCandles[i + 1] : null;
            const prevCandle = i > 0 ? dayCandles[i - 1] : undefined;
            const prevPrevCandle = i > 1 ? dayCandles[i - 2] : undefined;

            const timeStr = new Date(c.timestamp).toLocaleTimeString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            });

            // Cumulative Day High & Day Low up to this candle
            const candlesSoFar = dayCandles.slice(0, i + 1);
            const dayHighSoFar = Math.max(...candlesSoFar.map(x => x.high));
            const dayLowSoFar = Math.min(...candlesSoFar.map(x => x.low));

            // ATR(14)
            const globalIdx = sorted.findIndex(x => x.timestamp === c.timestamp);
            const histSlice = sorted.slice(0, globalIdx + 1);
            const atr = ATR14Strategy.computeATR(histSlice, 14);

            const patternRes = detectCandlePattern(c, prevCandle, prevPrevCandle, undefined, atr);
            const isBullish = patternRes.isHammer || patternRes.pattern === 'PIN_BAR_BULLISH';
            const isBearish = patternRes.isShootingStar || patternRes.pattern === 'PIN_BAR_BEARISH';

            const isExactDayHigh = Math.abs(c.high - dayHighSoFar) <= 1.0;
            const isExactDayLow = Math.abs(c.low - dayLowSoFar) <= 1.0;

            let extremeMatch = 'No';
            if (isBearish && isExactDayHigh) extremeMatch = '🎯 Day High';
            else if (isBullish && isExactDayLow) extremeMatch = '🎯 Day Low';
            else if (isBearish) extremeMatch = `Miss High (-${(dayHighSoFar - c.high).toFixed(1)})`;
            else if (isBullish) extremeMatch = `Miss Low (+${(c.low - dayLowSoFar).toFixed(1)})`;

            let signalStr = 'None';

            // Check if active trade needs to be managed on this candle
            if (activeTrade && activeTrade.date === targetDate) {
                // If trade is running, evaluate SL or Target on current candle
                if (activeTrade.optionType === 'PE') {
                    // Short index (PE option)
                    const adverse = c.high - activeTrade.entryPrice;
                    const favorable = activeTrade.entryPrice - c.low;
                    if (adverse > activeTrade.maxAdverseExcursion) activeTrade.maxAdverseExcursion = adverse;
                    if (favorable > activeTrade.maxFavorableExcursion) activeTrade.maxFavorableExcursion = favorable;

                    if (c.low <= activeTrade.target1_1) activeTrade.hitTarget1_1 = true;
                    if (c.low <= activeTrade.target1_2) activeTrade.hitTarget1_2 = true;
                    if (c.low <= activeTrade.target1_3) activeTrade.hitTarget1_3 = true;

                    // Stop loss check
                    if (c.high >= activeTrade.stopLoss) {
                        activeTrade.exitTime = timeStr;
                        activeTrade.exitPrice = activeTrade.stopLoss;
                        activeTrade.pnlPoints = -(activeTrade.stopLoss - activeTrade.entryPrice);
                        activeTrade.exitReason = 'STOP LOSS HIT';
                        activeTrade = null;
                    } else if (i === dayCandles.length - 1) {
                        // End of day square off
                        activeTrade.exitTime = timeStr;
                        activeTrade.exitPrice = c.close;
                        activeTrade.pnlPoints = activeTrade.entryPrice - c.close;
                        activeTrade.exitReason = 'EOD EXIT (3:15 PM)';
                        activeTrade = null;
                    }
                } else if (activeTrade.optionType === 'CE') {
                    // Long index (CE option)
                    const adverse = activeTrade.entryPrice - c.low;
                    const favorable = c.high - activeTrade.entryPrice;
                    if (adverse > activeTrade.maxAdverseExcursion) activeTrade.maxAdverseExcursion = adverse;
                    if (favorable > activeTrade.maxFavorableExcursion) activeTrade.maxFavorableExcursion = favorable;

                    if (c.high >= activeTrade.target1_1) activeTrade.hitTarget1_1 = true;
                    if (c.high >= activeTrade.target1_2) activeTrade.hitTarget1_2 = true;
                    if (c.high >= activeTrade.target1_3) activeTrade.hitTarget1_3 = true;

                    // Stop loss check
                    if (c.low <= activeTrade.stopLoss) {
                        activeTrade.exitTime = timeStr;
                        activeTrade.exitPrice = activeTrade.stopLoss;
                        activeTrade.pnlPoints = -(activeTrade.entryPrice - activeTrade.stopLoss);
                        activeTrade.exitReason = 'STOP LOSS HIT';
                        activeTrade = null;
                    } else if (i === dayCandles.length - 1) {
                        activeTrade.exitTime = timeStr;
                        activeTrade.exitPrice = c.close;
                        activeTrade.pnlPoints = c.close - activeTrade.entryPrice;
                        activeTrade.exitReason = 'EOD EXIT (3:15 PM)';
                        activeTrade = null;
                    }
                }
            }

            // Check if this candle generates a new trade entry
            if ((isBearish && isExactDayHigh) || (isBullish && isExactDayLow)) {
                if (nextCandle) {
                    const nextTimeStr = new Date(nextCandle.timestamp).toLocaleTimeString('en-IN', {
                        timeZone: 'Asia/Kolkata',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                    });

                    if (isBearish && nextCandle.low < c.low) {
                        signalStr = '🔥 BEAR (PE)';
                        const entryPrice = c.low;
                        const stopLoss = c.high;
                        const risk = stopLoss - entryPrice;
                        const trade: TradeRecord = {
                            date: targetDate,
                            signalTime: timeStr,
                            entryTime: nextTimeStr,
                            pattern: patternRes.pattern,
                            optionType: 'PE',
                            entryPrice,
                            stopLoss,
                            riskPoints: risk,
                            exitTime: '',
                            exitPrice: 0,
                            exitReason: '',
                            pnlPoints: 0,
                            target1_1: entryPrice - risk * 1,
                            hitTarget1_1: false,
                            target1_2: entryPrice - risk * 2,
                            hitTarget1_2: false,
                            target1_3: entryPrice - risk * 3,
                            hitTarget1_3: false,
                            maxFavorableExcursion: 0,
                            maxAdverseExcursion: 0,
                        };
                        trades.push(trade);
                        activeTrade = trade;
                    } else if (isBullish && nextCandle.high > c.high) {
                        signalStr = '🔥 BULL (CE)';
                        const entryPrice = c.high;
                        const stopLoss = c.low;
                        const risk = entryPrice - stopLoss;
                        const trade: TradeRecord = {
                            date: targetDate,
                            signalTime: timeStr,
                            entryTime: nextTimeStr,
                            pattern: patternRes.pattern,
                            optionType: 'CE',
                            entryPrice,
                            stopLoss,
                            riskPoints: risk,
                            exitTime: '',
                            exitPrice: 0,
                            exitReason: '',
                            pnlPoints: 0,
                            target1_1: entryPrice + risk * 1,
                            hitTarget1_1: false,
                            target1_2: entryPrice + risk * 2,
                            hitTarget1_2: false,
                            target1_3: entryPrice + risk * 3,
                            hitTarget1_3: false,
                            maxFavorableExcursion: 0,
                            maxAdverseExcursion: 0,
                        };
                        trades.push(trade);
                        activeTrade = trade;
                    }
                }
            }

            const patName = patternRes.pattern !== 'NONE' ? patternRes.pattern : '-';
            console.log(
                `${timeStr.padEnd(10)} | ${c.open.toFixed(1).padEnd(8)} | ${c.high.toFixed(1).padEnd(8)} | ${c.low.toFixed(1).padEnd(8)} | ${c.close.toFixed(1).padEnd(8)} | ` +
                `${patName.padEnd(18)} | ₹${dayHighSoFar.toFixed(1).padEnd(14)} | ₹${dayLowSoFar.toFixed(1).padEnd(13)} | ` +
                `${extremeMatch.padEnd(14)} | ${signalStr}`
            );
        }
    }

    console.log(`\n\n${'='.repeat(90)}`);
    console.log(`TRADE EXECUTION & PERFORMANCE RESULTS`);
    console.log(`${'='.repeat(90)}`);

    if (trades.length === 0) {
        console.log('No trades triggered.');
        return;
    }

    for (let idx = 0; idx < trades.length; idx++) {
        const t = trades[idx];
        console.log(`\nTRADE #${idx + 1}: ${t.optionType} Trade on ${t.date} triggered by ${t.pattern}`);
        console.log(`---------------------------------------------------------------------------------`);
        console.log(`• Pattern Candle Time:   ${t.signalTime} IST`);
        console.log(`• Execution Candle Time: ${t.entryTime} IST (upon breakout/breakdown)`);
        console.log(`• Entry Price (Nifty):   ₹${t.entryPrice.toFixed(2)}`);
        console.log(`• Stop Loss (Nifty):     ₹${t.stopLoss.toFixed(2)} (Risk: ${t.riskPoints.toFixed(2)} pts)`);
        console.log(`• 1:1 Target:            ₹${t.target1_1.toFixed(2)} -> Hit? ${t.hitTarget1_1 ? '✅ YES' : '❌ NO'}`);
        console.log(`• 1:2 Target:            ₹${t.target1_2.toFixed(2)} -> Hit? ${t.hitTarget1_2 ? '✅ YES' : '❌ NO'}`);
        console.log(`• 1:3 Target:            ₹${t.target1_3.toFixed(2)} -> Hit? ${t.hitTarget1_3 ? '✅ YES' : '❌ NO'}`);
        console.log(`• Max Profit (MFE):      +${t.maxFavorableExcursion.toFixed(2)} Nifty pts`);
        console.log(`• Max Drawdown (MAE):    -${t.maxAdverseExcursion.toFixed(2)} Nifty pts`);
        console.log(`• Final Exit:            ${t.exitReason} at ${t.exitTime} IST (Price: ₹${t.exitPrice.toFixed(2)})`);
        console.log(`• Total PnL (EOD):       ${t.pnlPoints >= 0 ? '+' : ''}${t.pnlPoints.toFixed(2)} Nifty Index pts`);
        
        const estOptionPnl = t.pnlPoints * 0.5; // ~0.5 delta ATM option
        const estOptionPnlLot = estOptionPnl * 75; // 75 lot size for Nifty
        console.log(`• Estimated Option PnL:  ${estOptionPnl >= 0 ? '+' : ''}₹${estOptionPnl.toFixed(2)} per share (~₹${estOptionPnlLot.toFixed(2)} per lot of 75)`);
    }

    const totalPts = trades.reduce((acc, t) => acc + t.pnlPoints, 0);
    const winTrades = trades.filter(t => t.pnlPoints > 0).length;
    console.log(`\n${'='.repeat(90)}`);
    console.log(`OVERALL STRATEGY SUMMARY`);
    console.log(`---------------------------------------------------------------------------------`);
    console.log(`• Total Trades Taken:     ${trades.length}`);
    console.log(`• Winning Trades:         ${winTrades} / ${trades.length} (${((winTrades / trades.length) * 100).toFixed(0)}%)`);
    console.log(`• Total Nifty Points:     ${totalPts >= 0 ? '+' : ''}${totalPts.toFixed(2)} pts`);
    console.log(`• Avg Points Per Trade:   +${(totalPts / trades.length).toFixed(2)} pts`);
    console.log('='.repeat(90));
}

runTest().catch(console.error);
