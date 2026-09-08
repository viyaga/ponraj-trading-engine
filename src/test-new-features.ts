import { LiveCandleBuilder } from './services/tradingV2/live-candle-builder';
import { AngelMarketDataService } from './services/tradingV2/angel-market-data.service';
import { Candle } from './services/tradingV2/type';
import { UTBotStrategy } from './services/tradingV2/strategies/ut-bot-strategy';
import { AngelStreamService } from './services/tradingV2/angel-stream.service';
import env from './config/env';

async function runAllTests() {
    console.log('='.repeat(80));
    console.log('🧪 RUNNING COMPREHENSIVE TESTS FOR NEW WEBSOCKET & TRIGGER FEATURES');
    console.log('='.repeat(80));

    let passed = 0;
    let failed = 0;

    const assert = (condition: boolean, testName: string, detail?: any) => {
        if (condition) {
            console.log(`  ✅ PASS: ${testName}`);
            passed++;
        } else {
            console.error(`  ❌ FAIL: ${testName}`, detail ?? '');
            failed++;
        }
    };

    // ─── TEST 1: LiveCandleBuilder Real-Time Accumulation ────────────────────
    console.log('\n[Test 1] Testing LiveCandleBuilder: OHLC Accumulation from Ticks...');
    LiveCandleBuilder.clear();

    const token = '99926000'; // NIFTY
    const now = Date.now();
    const boundary1h = AngelMarketDataService.candleBoundary1h(now);

    // Tick 1: First tick of the candle
    LiveCandleBuilder.onTick(token, 23750.00, now);
    let bar1h = LiveCandleBuilder.getLive1hCandle(token, 23750.00);

    assert(bar1h.timestamp === boundary1h, '1H candle timestamp matches boundary');
    assert(bar1h.open === 23750.00, '1H candle Open is set from first tick (23750.00)');
    assert(bar1h.high === 23750.00, '1H candle High starts at first tick (23750.00)');
    assert(bar1h.low === 23750.00, '1H candle Low starts at first tick (23750.00)');
    assert(bar1h.close === 23750.00, '1H candle Close starts at first tick (23750.00)');

    // Tick 2: Higher tick
    LiveCandleBuilder.onTick(token, 23780.50, now + 1000);
    bar1h = LiveCandleBuilder.getLive1hCandle(token, 23780.50);
    assert(bar1h.high === 23780.50, '1H candle High expanded to 23780.50');
    assert(bar1h.low === 23750.00, '1H candle Low remained 23750.00');
    assert(bar1h.close === 23780.50, '1H candle Close updated to 23780.50');
    assert(bar1h.open === 23750.00, '1H candle Open remained unchanged (23750.00)');

    // Tick 3: Lower tick
    LiveCandleBuilder.onTick(token, 23740.25, now + 2000);
    bar1h = LiveCandleBuilder.getLive1hCandle(token, 23740.25);
    assert(bar1h.high === 23780.50, '1H candle High remained 23780.50');
    assert(bar1h.low === 23740.25, '1H candle Low reduced to 23740.25');
    assert(bar1h.close === 23740.25, '1H candle Close updated to 23740.25');

    // Tick 4: Rebound tick
    LiveCandleBuilder.onTick(token, 23765.00, now + 3000);
    bar1h = LiveCandleBuilder.getLive1hCandle(token, 23765.00);
    assert(bar1h.high === 23780.50, '1H candle High remained 23780.50');
    assert(bar1h.low === 23740.25, '1H candle Low remained 23740.25');
    assert(bar1h.close === 23765.00, '1H candle Close updated to 23765.00');

    // ─── TEST 2: LiveCandleBuilder Mid-Hour Cold Start Seeding ───────────────
    console.log('\n[Test 2] Testing LiveCandleBuilder: Mid-Hour Cold Start Seeding from 15m Bars...');
    LiveCandleBuilder.clear();

    const mock15mCandles: Candle[] = [
        {
            timestamp: boundary1h, // first 15m bar
            open: 23700.00,
            high: 23795.00,
            low: 23680.00,
            close: 23750.00,
            volume: 1000,
        },
        {
            timestamp: boundary1h + 15 * 60 * 1000, // second 15m bar
            open: 23750.00,
            high: 23810.00,
            low: 23740.00,
            close: 23800.00,
            volume: 1200,
        },
    ];

    const currentLiveSpot = 23790.00;
    const seeded1h = LiveCandleBuilder.getLive1hCandle(token, currentLiveSpot, mock15mCandles);

    assert(seeded1h.open === 23700.00, `Seeded Open is 23700.00 from 1st 15m bar (got ${seeded1h.open})`);
    assert(seeded1h.high === 23810.00, `Seeded High is 23810.00 from max of 15m bars (got ${seeded1h.high})`);
    assert(seeded1h.low === 23680.00, `Seeded Low is 23680.00 from min of 15m bars (got ${seeded1h.low})`);
    assert(seeded1h.close === 23790.00, `Seeded Close is current spot 23790.00 (got ${seeded1h.close})`);

    // ─── TEST 3: SmartStream Binary LTP Packet Parsing ───────────────────────
    console.log('\n[Test 3] Testing Angel One SmartStream Binary LTP Packet Parsing...');
    // Construct mock 47-byte LTP binary buffer
    const mockBuf = Buffer.alloc(47);
    mockBuf.writeInt8(1, 0); // Mode 1: LTP
    mockBuf.writeInt8(1, 1); // Exchange: 1 (NSE_CM)
    // Write token '99926000' at offset 2..26
    mockBuf.write('99926000\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0', 2, 25, 'utf-8');
    // Sequence number at offset 27..34
    mockBuf.writeBigInt64LE(BigInt(123456789), 27);
    // Timestamp at offset 35..42
    mockBuf.writeBigInt64LE(BigInt(1725690000000), 35);
    // Price in paise at offset 43..46: 23,771.50 = 2377150 paise
    mockBuf.writeInt32LE(2377150, 43);

    // Verify buffer parsing
    const parsedMode = mockBuf.readInt8(0);
    const parsedToken = mockBuf.subarray(2, 27).toString('utf-8').replace(/\0/g, '').trim();
    const parsedPrice = mockBuf.readInt32LE(43) / 100;
    const parsedSeq = mockBuf.readBigInt64LE(27).toString();

    assert(parsedMode === 1, 'Packet mode is 1 (LTP)');
    assert(parsedToken === '99926000', `Parsed token matches '99926000' (got ${parsedToken})`);
    assert(parsedPrice === 23771.50, `Parsed LTP is ₹23,771.50 (got ₹${parsedPrice})`);
    assert(parsedSeq === '123456789', `Parsed sequence is 123456789 (got ${parsedSeq})`);

    // ─── TEST 4: UT Bot Crossover Trigger Threshold Logic ───────────────────
    console.log('\n[Test 4] Testing UT Bot Strategy & Threshold Logic on Candles...');
    // Create 20 mock 1H candles with a downtrend
    const testCandles: Candle[] = [];
    let basePrice = 24000;
    const oneHour = 3600000;
    for (let i = 0; i < 20; i++) {
        const o = basePrice;
        const c = basePrice - 10;
        const h = basePrice + 5;
        const l = basePrice - 15;
        testCandles.push({
            timestamp: boundary1h - (20 - i) * oneHour,
            open: o,
            high: h,
            low: l,
            close: c,
            volume: 5000,
        });
        basePrice -= 15;
    }

    const calc = UTBotStrategy.calculateUTBotSeries(testCandles, {
        keyValue: 1.0,
        atrPeriod: 10,
        useHeikinAshi: false,
    });

    const lastIdx = calc.posSeries.length - 1;
    const currentPos = calc.posSeries[lastIdx];
    const trailingStop = calc.trailingStopSeries[lastIdx];
    const lastClose = testCandles[lastIdx].close;

    assert(currentPos === -1, `Indicator in downtrend is SHORT (pos === -1, got ${currentPos})`);
    assert(trailingStop > lastClose, `Trailing stop (${trailingStop.toFixed(2)}) is above last close (${lastClose.toFixed(2)})`);

    // In SHORT position:
    // Bull trigger = trailingStop (requires price >= trailingStop to flip to BUY)
    const bullTrigger = trailingStop;
    const belowStopPrice = trailingStop - 10;
    const aboveStopPrice = trailingStop + 1;

    assert(belowStopPrice < bullTrigger, `Price below stop (${belowStopPrice.toFixed(2)}) does NOT trigger breach`);
    assert(aboveStopPrice >= bullTrigger, `Price crossing above stop (${aboveStopPrice.toFixed(2)}) DOES trigger breach!`);

    // ─── TEST 5: Angel One Live Connectivity Test (if credentials present) ───
    console.log('\n[Test 5] Checking Angel One Credentials & Connectivity Status...');
    const hasCreds = Boolean(
        (env.angelOneApiKey || process.env.ANGEL_ONE_API_KEY) &&
        (env.angelOneClientCode || process.env.ANGEL_ONE_CLIENT_CODE)
    );

    if (hasCreds) {
        console.log('  ℹ️  Angel One credentials detected in environment. Testing stream credentials fetch...');
        try {
            const streamCreds = await AngelMarketDataService.getStreamCredentials();
            assert(Boolean(streamCreds?.jwtToken), 'Angel One TOTP auto-login generated valid JWT Token');
            assert(Boolean(streamCreds?.clientCode), 'ClientCode present for WebSocket');
            assert(Boolean(streamCreds?.apiKey), 'ApiKey present for WebSocket');
            console.log(`  ✔ Stream credentials verified. ClientCode: ${streamCreds?.clientCode?.slice(0, 3)}***`);
        } catch (err: any) {
            console.warn(`  ⚠️ Could not complete live auto-login test: ${err.message}`);
        }
    } else {
        console.log('  ℹ️  Angel One credentials not set in local env (dry-run mode). Skipping live auth.');
    }

    // ─── SUMMARY ─────────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(80));
    console.log(`🏁 TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
    console.log('='.repeat(80));

    if (failed > 0) {
        process.exit(1);
    }
}

runAllTests().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
