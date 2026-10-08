// =============================================================================
// Unit Tests for 3rd Strategy: Hammer & Shooting Star Candle Pattern Reversal
// =============================================================================

import {
    computeCandleComponents,
    isHammerPattern,
    isShootingStarPattern,
    detectCandlePattern,
    CandlePatternStrategy,
} from './services/tradingV2/strategies/candle-pattern-strategy';
import { Candle, ConfigType } from './services/tradingV2/type';
import { TradingConfig } from './services/tradingV2/config';

function runTests() {
    console.log('='.repeat(80));
    console.log('🧪 RUNNING TESTS: CANDLE PATTERN STRATEGY (HAMMER & SHOOTING STAR)');
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

    // ─── 1. Candle Components Calculation ─────────────────────────────────────
    console.log('\n[Suite 1] Candle Components & Math Calculation...');
    const testCandle: Candle = {
        timestamp: Date.now(),
        open: 100,
        high: 110,
        low: 80,
        close: 105,
        volume: 1000,
    };
    const comp = computeCandleComponents(testCandle);
    assert(comp.body === 5, 'Body is |105 - 100| = 5');
    assert(comp.range === 30, 'Range is 110 - 80 = 30');
    assert(comp.upperWick === 5, 'Upper wick is 110 - 105 = 5');
    assert(comp.lowerWick === 20, 'Lower wick is 100 - 80 = 20');
    assert(Math.abs(comp.bodyPercent - 5 / 30) < 0.001, 'Body % is 5/30 ~ 16.67%');
    assert(comp.isBullish === true, 'Candle is bullish (close > open)');

    // ─── 2. Hammer Detection ──────────────────────────────────────────────────
    console.log('\n[Suite 2] Mathematical Hammer Detection...');
    // Valid Hammer: Range 40, Open 24450, Close 24455 (Body 5), High 24456 (Upper wick 1), Low 24416 (Lower wick 34)
    // body = 5, lowerWick = 34 (6.8x body >= 2.0x), upperWick = 1 (0.2x body <= 0.5x), bodyPercent = 5/40 = 12.5% <= 35%
    const validHammerCandle: Candle = {
        timestamp: Date.now(),
        open: 24450,
        high: 24456,
        low: 24416,
        close: 24455,
        volume: 5000,
    };
    const hammerRes = isHammerPattern(validHammerCandle);
    assert(hammerRes.isMatch === true, 'Valid Hammer detected correctly', hammerRes.reason);

    // Invalid Hammer: Large body (bodyPercent > 35%)
    const bigBodyCandle: Candle = {
        timestamp: Date.now(),
        open: 24420,
        high: 24456,
        low: 24416,
        close: 24455, // Body = 35 / Range = 40 = 87.5%
        volume: 5000,
    };
    const invalidHammerRes1 = isHammerPattern(bigBodyCandle);
    assert(invalidHammerRes1.isMatch === false, 'Rejected candle with large body (> 35%)');

    // Invalid Hammer: Upper wick too long
    const longUpperWickCandle: Candle = {
        timestamp: Date.now(),
        open: 24430,
        high: 24460, // Upper wick = 24460 - 24435 = 25 > 5 * 0.5
        low: 24416,
        close: 24435, // Body = 5
        volume: 5000,
    };
    const invalidHammerRes2 = isHammerPattern(longUpperWickCandle);
    assert(invalidHammerRes2.isMatch === false, 'Rejected candle with long upper wick');

    // ─── 3. Shooting Star Detection ───────────────────────────────────────────
    console.log('\n[Suite 3] Mathematical Shooting Star Detection...');
    // Valid Shooting Star: Range 40, Open 24650, Close 24645 (Body 5), High 24685 (Upper wick 35), Low 24644 (Lower wick 1)
    // body = 5, upperWick = 35 (7x body >= 2.0x), lowerWick = 1 (0.2x body <= 0.5x), bodyPercent = 5/40 = 12.5% <= 35%
    const validStarCandle: Candle = {
        timestamp: Date.now(),
        open: 24650,
        high: 24685,
        low: 24644,
        close: 24645,
        volume: 5000,
    };
    const starRes = isShootingStarPattern(validStarCandle);
    assert(starRes.isMatch === true, 'Valid Shooting Star detected correctly', starRes.reason);

    // Invalid Shooting Star: Lower wick too long
    const longLowerWickStar: Candle = {
        timestamp: Date.now(),
        open: 24660,
        high: 24685,
        low: 24630, // Lower wick = 24655 - 24630 = 25 > 5 * 0.5
        close: 24655, // Body = 5
        volume: 5000,
    };
    const invalidStarRes = isShootingStarPattern(longLowerWickStar);
    assert(invalidStarRes.isMatch === false, 'Rejected Shooting Star with long lower wick');

    // ─── 4. detectCandlePattern Multi-Pattern Recognition ─────────────────────
    console.log('\n[Suite 4] Multi-Pattern Recognition (detectCandlePattern)...');
    const detectedHammer = detectCandlePattern(validHammerCandle);
    assert(detectedHammer.pattern === 'HAMMER' && detectedHammer.isHammer, 'Recognized HAMMER');

    const detectedStar = detectCandlePattern(validStarCandle);
    assert(detectedStar.pattern === 'SHOOTING_STAR' && detectedStar.isShootingStar, 'Recognized SHOOTING_STAR');

    // Bullish Engulfing
    const prevRed: Candle = { timestamp: Date.now() - 60000, open: 100, high: 101, low: 90, close: 92, volume: 100 };
    const currGreen: Candle = { timestamp: Date.now(), open: 91, high: 105, low: 90, close: 103, volume: 200 };
    const detectedEngulfing = detectCandlePattern(currGreen, prevRed);
    assert(detectedEngulfing.pattern === 'BULLISH_ENGULFING', 'Recognized BULLISH_ENGULFING');

    // Doji
    const dojiCandle: Candle = { timestamp: Date.now(), open: 100, high: 110, low: 90, close: 100.5, volume: 100 };
    const detectedDoji = detectCandlePattern(dojiCandle);
    assert(detectedDoji.pattern === 'DOJI', 'Recognized DOJI');

    // ─── 5. Strategy Evaluation: Hammer Near Day Low → CALL OPTION (CE) ────────
    console.log('\n[Suite 5] Full Strategy Execution: Hammer Near Day Low...');
    const baseConfig = TradingConfig.buildConfig({});

    // Create series of 15m candles:
    // Session opens at 24600, trends down to 24420 (Day Low).
    // Last candle is a Hammer with Low = 24420 (exactly at Day Low), High = 24460.
    const nowTs = Date.now();
    const candlesDown: Candle[] = [
        { timestamp: nowTs - 6 * 15 * 60000, open: 24600, high: 24620, low: 24550, close: 24560, volume: 1000 },
        { timestamp: nowTs - 5 * 15 * 60000, open: 24560, high: 24570, low: 24500, close: 24510, volume: 1000 },
        { timestamp: nowTs - 4 * 15 * 60000, open: 24510, high: 24530, low: 24470, close: 24480, volume: 1000 },
        { timestamp: nowTs - 3 * 15 * 60000, open: 24480, high: 24490, low: 24440, close: 24450, volume: 1000 },
        { timestamp: nowTs - 2 * 15 * 60000, open: 24450, high: 24460, low: 24430, close: 24435, volume: 1000 },
        // Setup Hammer at Day Low:
        { timestamp: nowTs - 1 * 15 * 60000, open: 24450, high: 24456, low: 24416, close: 24454, volume: 3000 },
    ];

    // Case 5A: Spot above hammer high — should fire BULL immediately on pattern close
    const spotPriceBreakout = 24465;
    const resHammerBull = CandlePatternStrategy.evaluateSignal(candlesDown, spotPriceBreakout, baseConfig);
    assert(resHammerBull.signal === 'BULL', 'Signal is BULL (spot above hammer high)');
    assert(resHammerBull.optionType === 'CE', 'Option type is CE (Call Option)');
    assert(resHammerBull.pattern === 'HAMMER', 'Identified pattern is HAMMER');
    assert(resHammerBull.score === 100, 'Score is 100');

    // Case 5B: Spot still below hammer high — BULL fires immediately (no confirmation required)
    const spotPriceNoBreakout = 24450;
    const resHammerNoBreak = CandlePatternStrategy.evaluateSignal(candlesDown, spotPriceNoBreakout, baseConfig);
    assert(resHammerNoBreak.signal === 'BULL', 'Signal is BULL even when spot has not crossed hammer high (no wait)');
    assert(resHammerNoBreak.optionType === 'CE', 'Option type is CE');
    assert(resHammerNoBreak.reasons.some(r => r.includes('no breakout wait')), 'Reason mentions no breakout wait');

    // Case 5C: Hammer formed near Day HIGH instead of Day Low -> Skipped
    const candlesUpForHammer: Candle[] = [
        { timestamp: nowTs - 6 * 15 * 60000, open: 24300, high: 24350, low: 24290, close: 24340, volume: 1000 },
        { timestamp: nowTs - 5 * 15 * 60000, open: 24340, high: 24400, low: 24330, close: 24390, volume: 1000 },
        { timestamp: nowTs - 4 * 15 * 60000, open: 24390, high: 24450, low: 24380, close: 24440, volume: 1000 },
        { timestamp: nowTs - 3 * 15 * 60000, open: 24440, high: 24500, low: 24430, close: 24490, volume: 1000 },
        { timestamp: nowTs - 2 * 15 * 60000, open: 24490, high: 24550, low: 24480, close: 24540, volume: 1000 },
        // Hammer at the very top (Day High = ~24600, Day Low = 24290):
        { timestamp: nowTs - 1 * 15 * 60000, open: 24580, high: 24586, low: 24546, close: 24584, volume: 3000 },
    ];
    const resHammerNearHigh = CandlePatternStrategy.evaluateSignal(candlesUpForHammer, 24595, baseConfig);
    assert(resHammerNearHigh.signal === 'NONE', 'Hammer near Day HIGH is rejected (must be near Day Low)');
    assert(resHammerNearHigh.skipReasons.some(r => r.includes('NOT near Day Low')), 'Skip reason explains NOT near Day Low');

    // ─── 6. Strategy Evaluation: Shooting Star Near Day High → PUT OPTION (PE) ─
    console.log('\n[Suite 6] Full Strategy Execution: Shooting Star Near Day High...');
    const candlesUp: Candle[] = [
        { timestamp: nowTs - 6 * 15 * 60000, open: 24300, high: 24350, low: 24290, close: 24340, volume: 1000 },
        { timestamp: nowTs - 5 * 15 * 60000, open: 24340, high: 24400, low: 24330, close: 24390, volume: 1000 },
        { timestamp: nowTs - 4 * 15 * 60000, open: 24390, high: 24450, low: 24380, close: 24440, volume: 1000 },
        { timestamp: nowTs - 3 * 15 * 60000, open: 24440, high: 24500, low: 24430, close: 24490, volume: 1000 },
        { timestamp: nowTs - 2 * 15 * 60000, open: 24490, high: 24550, low: 24480, close: 24540, volume: 1000 },
        // Shooting Star at Day High: High 24685, Low 24644, Close 24645
        { timestamp: nowTs - 1 * 15 * 60000, open: 24650, high: 24685, low: 24644, close: 24645, volume: 3000 },
    ];

    // Case 6A: Spot below shooting star low — BEAR fires immediately on pattern close
    const spotPriceBreakdown = 24635;
    const resStarBear = CandlePatternStrategy.evaluateSignal(candlesUp, spotPriceBreakdown, baseConfig);
    assert(resStarBear.signal === 'BEAR', 'Signal is BEAR (spot below shooting star low)');
    assert(resStarBear.optionType === 'PE', 'Option type is PE (Put Option)');
    assert(resStarBear.pattern === 'SHOOTING_STAR', 'Identified pattern is SHOOTING_STAR');
    assert(resStarBear.score === 100, 'Score is 100');

    // Case 6B: Spot still above shooting star low — BEAR fires immediately (no confirmation required)
    const spotPriceNoBreakdown = 24655;
    const resStarNoBreak = CandlePatternStrategy.evaluateSignal(candlesUp, spotPriceNoBreakdown, baseConfig);
    assert(resStarNoBreak.signal === 'BEAR', 'Signal is BEAR even when spot has not crossed shooting star low (no wait)');
    assert(resStarNoBreak.optionType === 'PE', 'Option type is PE');
    assert(resStarNoBreak.reasons.some(r => r.includes('no breakdown wait')), 'Reason mentions no breakdown wait');

    console.log('='.repeat(80));
    console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('='.repeat(80));

    if (failed > 0) {
        process.exit(1);
    }
}

runTests();
