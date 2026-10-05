import { MarketDataService } from '../src/services/tradingV2/market-data.service';
import { CandlePatternStrategy } from '../src/services/tradingV2/strategies/candle-pattern-strategy';
import { TradingConfig } from '../src/services/tradingV2/config';

async function main() {
    console.log('Testing signal on cached candles:');

    // Case 1: Default (no target time) -> Uses latest candle (12:15 PM)
    const cfg1 = TradingConfig.buildConfig({
        USE_CACHE_CANDLE: true,
    });
    const candles1 = await MarketDataService.get15mCandles({} as any, 'NIFTY', cfg1);
    const spot1 = await MarketDataService.getSpotPrice({} as any, 'NIFTY', cfg1, candles1);
    const res1 = CandlePatternStrategy.evaluateSignal(candles1, spot1, cfg1);
    const time1 = new Date(candles1[candles1.length - 1].timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

    console.log('\n--- Case 1: Without target time (Current latest candle in cache: 12:15 PM) ---');
    console.log(`Latest Candle Time: ${time1}`);
    console.log(`Spot Price: ₹${spot1}`);
    console.log(`Strategy Signal: ${res1.signal} (${res1.optionType ?? 'None'})`);
    console.log(`Will trade be taken? ${res1.signal !== 'NONE' ? 'YES ✅' : 'NO ❌ (No setup at 12:15)'}`);

    // Case 2: Target 10:00 AM (Shooting star confirmation)
    const cfg2 = TradingConfig.buildConfig({
        USE_CACHE_CANDLE: true,
        CACHE_CANDLE_TARGET_TIME: '10:00',
    });
    const candles2 = await MarketDataService.get15mCandles({} as any, 'NIFTY', cfg2);
    const spot2 = await MarketDataService.getSpotPrice({} as any, 'NIFTY', cfg2, candles2);
    const res2 = CandlePatternStrategy.evaluateSignal(candles2, spot2, cfg2);
    const time2 = new Date(candles2[candles2.length - 1].timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

    console.log('\n--- Case 2: Target 10:00 AM candle (Shooting Star breakdown) ---');
    console.log(`Latest Candle Time in Slice: ${time2}`);
    console.log(`Spot Price: ₹${spot2}`);
    console.log(`Strategy Signal: ${res2.signal} (${res2.optionType ?? 'None'})`);
    console.log(`Will trade be taken? ${res2.signal !== 'NONE' ? 'YES ✅' : 'NO ❌'}`);
    if (res2.signal !== 'NONE') {
        console.log(`Reasons: ${res2.reasons.join(' | ')}`);
    }

    // Case 3: Target 11:30 AM (Hammer confirmation)
    const cfg3 = TradingConfig.buildConfig({
        USE_CACHE_CANDLE: true,
        CACHE_CANDLE_TARGET_TIME: '11:30',
    });
    const candles3 = await MarketDataService.get15mCandles({} as any, 'NIFTY', cfg3);
    const spot3 = await MarketDataService.getSpotPrice({} as any, 'NIFTY', cfg3, candles3);
    const res3 = CandlePatternStrategy.evaluateSignal(candles3, spot3, cfg3);
    const time3 = new Date(candles3[candles3.length - 1].timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

    console.log('\n--- Case 3: Target 11:30 AM candle (Hammer breakout) ---');
    console.log(`Latest Candle Time in Slice: ${time3}`);
    console.log(`Spot Price: ₹${spot3}`);
    console.log(`Strategy Signal: ${res3.signal} (${res3.optionType ?? 'None'})`);
    console.log(`Will trade be taken? ${res3.signal !== 'NONE' ? 'YES ✅' : 'NO ❌'}`);
    if (res3.signal !== 'NONE') {
        console.log(`Reasons: ${res3.reasons.join(' | ')}`);
    }
}

main().catch(console.error);
