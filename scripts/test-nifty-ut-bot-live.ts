// =============================================================================
// Live NIFTY 50 1-Hour UT Bot Signal Verification Script
// =============================================================================

import { AngelMarketDataService } from '../src/services/tradingV2/angel-market-data.service';
import { UTBotStrategy } from '../src/services/tradingV2/strategies/ut-bot-strategy';
import { Candle } from '../src/services/tradingV2/type';

async function main() {
    console.log('='.repeat(80));
    console.log('🚀 FETCHING NIFTY 50 1-HOUR CANDLES VIA ANGEL ONE SMARTAPI...');
    console.log('='.repeat(80));

    const candles = await AngelMarketDataService.get1hCandles('NIFTY');

    if (!candles || candles.length === 0) {
        console.error('❌ Failed to fetch 1H candles from Angel One. Please check credentials/network.');
        process.exit(1);
    }

    console.log(`\n✔ Successfully fetched ${candles.length} completed 1-Hour candles for NIFTY 50.\n`);

    // Sort ascending by timestamp
    const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);

    const firstTime = new Date(sorted[0].timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const lastTime  = new Date(sorted[sorted.length - 1].timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    console.log(`Date Range: ${firstTime} to ${lastTime} IST\n`);

    // Compute UT Bot Series: Key Value = 1.0, ATR Period = 10
    const config = { keyValue: 1.0, atrPeriod: 10, useHeikinAshi: false };
    const ut = UTBotStrategy.calculateUTBotSeries(sorted, config);

    interface AlertEvent {
        candleIndex: number;
        dateTimeIST: string;
        timestamp: number;
        type: 'BUY (CE)' | 'SELL (PE)';
        open: number;
        high: number;
        low: number;
        close: number;
        atr: number;
        trailingStop: number;
    }

    const alerts: AlertEvent[] = [];

    for (let i = 0; i < sorted.length; i++) {
        const c = sorted[i];
        const isBuy = ut.buySignals[i];
        const isSell = ut.sellSignals[i];

        if (isBuy || isSell) {
            const istDateStr = new Date(c.timestamp).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            });

            alerts.push({
                candleIndex: i,
                dateTimeIST: istDateStr,
                timestamp: c.timestamp,
                type: isBuy ? 'BUY (CE)' : 'SELL (PE)',
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                atr: ut.atrSeries[i],
                trailingStop: ut.trailingStopSeries[i],
            });
        }
    }

    console.log('='.repeat(80));
    console.log(`🎯 UT BOT ALERTS (1-HOUR NIFTY 50) — KEY: ${config.keyValue}, ATR: ${config.atrPeriod}`);
    console.log('='.repeat(80));
    console.log(`Total Crossover Alerts Found: ${alerts.length}\n`);

    console.log(
        '| #  | Candle Time (IST) | Signal    | Candle Close | ATR (10)  | Trailing Stop | High      | Low       |'
    );
    console.log(
        '|:---|:------------------|:----------|:-------------|:----------|:--------------|:----------|:----------|'
    );

    alerts.forEach((a, idx) => {
        const num = String(idx + 1).padStart(2, ' ');
        const time = a.dateTimeIST.padEnd(17, ' ');
        const sig = a.type.padEnd(9, ' ');
        const close = a.close.toFixed(2).padStart(12, ' ');
        const atr = a.atr.toFixed(2).padStart(9, ' ');
        const stop = a.trailingStop.toFixed(2).padStart(13, ' ');
        const high = a.high.toFixed(2).padStart(9, ' ');
        const low = a.low.toFixed(2).padStart(9, ' ');
        console.log(`| ${num} | ${time} | ${sig} | ${close} | ${atr} | ${stop} | ${high} | ${low} |`);
    });

    console.log('\n' + '='.repeat(80));
    console.log('📊 LAST 10 COMPLETED 1-HOUR CANDLES DETAILED LOG');
    console.log('='.repeat(80));

    const startIdx = Math.max(0, sorted.length - 10);
    console.log(
        '| Candle Time (IST) | Close     | ATR (10)  | Trailing Stop | Pos State | Signal Alert |'
    );
    console.log(
        '|:------------------|:----------|:----------|:--------------|:----------|:-------------|'
    );

    for (let i = startIdx; i < sorted.length; i++) {
        const c = sorted[i];
        const time = new Date(c.timestamp).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).padEnd(17, ' ');

        const close = c.close.toFixed(2).padStart(9, ' ');
        const atr = ut.atrSeries[i].toFixed(2).padStart(9, ' ');
        const stop = ut.trailingStopSeries[i].toFixed(2).padStart(13, ' ');
        const pos = (ut.posSeries[i] === 1 ? 'LONG ' : ut.posSeries[i] === -1 ? 'SHORT' : 'FLAT ').padEnd(9, ' ');
        const sig = ut.buySignals[i] ? '🟢 BUY ' : ut.sellSignals[i] ? '🔴 SELL' : '—     ';

        console.log(`| ${time} | ${close} | ${atr} | ${stop} | ${pos} | ${sig}      |`);
    }

    // Evaluate current signal using evaluateSignal
    const latestClose = sorted[sorted.length - 1].close;
    const currentSignal = UTBotStrategy.evaluateSignal(sorted, latestClose, config);
    console.log('\n' + '='.repeat(80));
    console.log('⚡ CURRENT ENGINE SIGNAL STATE:');
    console.log('='.repeat(80));
    console.log('Signal:      ', currentSignal.signal);
    console.log('Option Type: ', currentSignal.optionType ?? 'NONE');
    console.log('ATR:         ', currentSignal.atr.toFixed(2));
    console.log('Trailing Stop: ₹' + currentSignal.trailingStop.toFixed(2));
    if (currentSignal.reasons.length) {
        console.log('Reasons:     ', currentSignal.reasons.join('\n'));
    }
    if (currentSignal.skipReasons.length) {
        console.log('Status:      ', currentSignal.skipReasons.join('\n'));
    }
    console.log('='.repeat(80));
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
