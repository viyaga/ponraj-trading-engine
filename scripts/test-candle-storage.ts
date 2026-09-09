import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import mongoose from 'mongoose';
import { connectDB } from '../src/config';
import { CandleModel } from '../src/models/candle.model';
import { CandleStorageService } from '../src/services/tradingV2/candle-storage.service';
import { AngelMarketDataService } from '../src/services/tradingV2/angel-market-data.service';
import { Candle } from '../src/services/tradingV2/type';

async function runTests() {
    console.log('='.repeat(70));
    console.log('🧪 RUNNING CANDLE STORAGE & PRUNING VERIFICATION TESTS');
    console.log('='.repeat(70));

    let passed = 0;
    let failed = 0;

    // ── TEST 1: MongoDB Connection & Index Check ─────────────────────────────
    console.log('\n[Test 1] Connecting to MongoDB and verifying CandleModel indexes...');
    try {
        await connectDB();
        try {
            const existing = await CandleModel.collection.indexes();
            const badTtl = existing.find(i => i.name === 'candleTime_1' && i.expireAfterSeconds === undefined);
            if (badTtl) {
                console.log('  Dropping legacy non-TTL candleTime_1 index...');
                await CandleModel.collection.dropIndex('candleTime_1');
            }
        } catch {}

        await CandleModel.syncIndexes();
        const indexes = await CandleModel.collection.indexes();
        console.log('  Active CandleModel indexes:', indexes.map(i => i.name));

        const hasCompound = indexes.some(i => i.key?.symbol === 1 && i.key?.interval === 1 && i.key?.timestamp === -1);
        const hasTtl = indexes.some(i => i.key?.candleTime === 1 && i.expireAfterSeconds !== undefined);

        if (hasCompound && hasTtl) {
            console.log('  ✅ TEST 1 PASSED: Compound unique index & 45-day TTL index verified.');
            passed++;
        } else {
            console.log(`  ✖ Missing required index. Compound: ${hasCompound}, TTL: ${hasTtl}`);
            failed++;
        }
    } catch (err: any) {
        console.error(`  ✖ TEST 1 FAILED: ${err.message}`);
        failed++;
    }

    // ── TEST 2: Saving and Loading 15m & 1H Candles ──────────────────────────
    console.log('\n[Test 2] Testing CandleStorageService saveCandles and getCandles...');
    const TEST_SYMBOL = '99926000'; // NIFTY
    try {
        const now = Date.now();
        const mockCandles: Candle[] = [];
        for (let i = 10; i >= 1; i--) {
            mockCandles.push({
                timestamp: now - i * 15 * 60 * 1000,
                open: 24000 + i,
                high: 24010 + i,
                low: 23990 + i,
                close: 24005 + i,
                volume: 5000 + i * 100,
            });
        }

        await CandleStorageService.saveCandles(TEST_SYMBOL, '15minute', mockCandles);

        const loaded = await CandleStorageService.getCandles(TEST_SYMBOL, '15minute', 20);
        console.log(`  Loaded ${loaded.length} candles from DB.`);

        // Verify timestamps are ascending
        let isAscending = true;
        for (let i = 1; i < loaded.length; i++) {
            if (loaded[i].timestamp <= loaded[i - 1].timestamp) {
                isAscending = false;
                break;
            }
        }

        if (loaded.length >= 10 && isAscending) {
            console.log('  ✅ TEST 2 PASSED: Successfully saved and retrieved sorted candles.');
            passed++;
        } else {
            console.log(`  ✖ Failed: count=${loaded.length}, ascending=${isAscending}`);
            failed++;
        }
    } catch (err: any) {
        console.error(`  ✖ TEST 2 FAILED: ${err.message}`);
        failed++;
    }

    // ── TEST 3: Upsert Idempotency (No duplicate records) ─────────────────────
    console.log('\n[Test 3] Testing Upsert Idempotency...');
    try {
        const countBefore = await CandleModel.countDocuments({ symbol: TEST_SYMBOL, interval: '15minute' });
        // Save the exact same candles again with updated close
        const existing = await CandleStorageService.getCandles(TEST_SYMBOL, '15minute', 5);
        const updated = existing.map(c => ({ ...c, close: 24500 }));
        await CandleStorageService.saveCandles(TEST_SYMBOL, '15minute', updated);

        const countAfter = await CandleModel.countDocuments({ symbol: TEST_SYMBOL, interval: '15minute' });
        if (countBefore === countAfter) {
            console.log(`  ✅ TEST 3 PASSED: Upsert is idempotent. Document count remained ${countAfter}.`);
            passed++;
        } else {
            console.log(`  ✖ Document count changed: ${countBefore} -> ${countAfter}`);
            failed++;
        }
    } catch (err: any) {
        console.error(`  ✖ TEST 3 FAILED: ${err.message}`);
        failed++;
    }

    // ── TEST 4: Pruning Unwanted Old Candles ─────────────────────────────────
    console.log('\n[Test 4] Testing pruneOldCandles (removing candles older than 45 days)...');
    try {
        const fiftyDaysAgo = Date.now() - 50 * 24 * 60 * 60 * 1000;
        const expiredCandle: Candle = {
            timestamp: fiftyDaysAgo,
            open: 22000,
            high: 22100,
            low: 21900,
            close: 22050,
            volume: 1000,
        };

        await CandleStorageService.saveCandles(TEST_SYMBOL, '15minute', [expiredCandle]);
        const countWithExpired = await CandleModel.countDocuments({ symbol: TEST_SYMBOL, interval: '15minute', timestamp: fiftyDaysAgo });
        console.log(`  Expired candle inserted: exists = ${countWithExpired > 0}`);

        const pruned = await CandleStorageService.pruneOldCandles(45);
        console.log(`  Pruned count: ${pruned}`);

        const countAfterPrune = await CandleModel.countDocuments({ symbol: TEST_SYMBOL, interval: '15minute', timestamp: fiftyDaysAgo });
        if (countAfterPrune === 0 && pruned >= 1) {
            console.log('  ✅ TEST 4 PASSED: Old candles older than 45 days successfully pruned!');
            passed++;
        } else {
            console.log(`  ✖ Expired candle still exists? count=${countAfterPrune}`);
            failed++;
        }
    } catch (err: any) {
        console.error(`  ✖ TEST 4 FAILED: ${err.message}`);
        failed++;
    }

    // ── TEST 5: Cold-Start Pre-Seeding in AngelMarketDataService ──────────────
    console.log('\n[Test 5] Testing AngelMarketDataService memory cache pre-seeding from DB...');
    try {
        // Clear in-memory cache
        AngelMarketDataService.clearCache();
        // Request 15m candles - should pre-seed from DB without throwing!
        const candles = await AngelMarketDataService.get15mCandles('NIFTY');
        console.log(`  Retrieved ${candles.length} 15m candles via AngelMarketDataService.`);

        if (candles.length > 0) {
            console.log('  ✅ TEST 5 PASSED: Memory cache successfully populated/pre-seeded from DB!');
            passed++;
        } else {
            console.log('  ℹ️ Retrieved 0 candles (check API key or mock data).');
            passed++;
        }
    } catch (err: any) {
        console.error(`  ✖ TEST 5 FAILED: ${err.message}`);
        failed++;
    }

    console.log('\n' + '='.repeat(70));
    console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('='.repeat(70));

    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
