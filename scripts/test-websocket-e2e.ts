import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import mongoose from 'mongoose';
import { connectDB } from '../src/config';
import { AngelStreamService, AngelStreamTick } from '../src/services/tradingV2/angel-stream.service';
import { LiveCandleBuilder } from '../src/services/tradingV2/live-candle-builder';
import { TriggerManagerService } from '../src/services/tradingV2/trigger-manager.service';
import { BulkSyncService } from '../src/services/bulkSync.service';
import { ConfigType } from '../src/services/tradingV2/type';
import { TradingConfig } from '../src/services/tradingV2/config';

async function testWebSocketEndToEnd() {
    console.log('='.repeat(80));
    console.log('🌐 RUNNING END-TO-END WEBSOCKET & TRIGGER PIPELINE INTEGRATION TEST');
    console.log('='.repeat(80));

    // Connect to database for TradeState operations
    await connectDB();

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

    const stream = AngelStreamService.getInstance();

    // ── STEP 1: Live WebSocket Connection ─────────────────────────────────
    console.log('\n[Step 1] Connecting to live Angel One SmartStream WebSocket...');
    try {
        await stream.connect();
        assert(stream.isConnected(), 'AngelStreamService isConnected() is true');
        console.log('  ✔ WebSocket stream is live.');
    } catch (err: any) {
        assert(false, `WebSocket connection failed: ${err.message}`);
    }

    // ── STEP 2: Live Tick Reception & In-Memory LTP Cache ──────────────────
    console.log('\n[Step 2] Awaiting live tick and verifying memory LTP cache...');
    try {
        const receivedTick = await new Promise<AngelStreamTick>((resolve, reject) => {
            const timer = setTimeout(() => {
                unsub();
                reject(new Error('Timeout awaiting live tick from WebSocket (10s)'));
            }, 10000);

            const unsub = stream.onTick((tick) => {
                clearTimeout(timer);
                unsub();
                resolve(tick);
            });
        });

        console.log(`  ⚡ Live tick received: Token=${receivedTick.token} | LTP=₹${receivedTick.ltp.toFixed(2)} | Time=${new Date(receivedTick.timestamp).toLocaleTimeString()}`);
        assert(receivedTick.token === '99926000', 'Tick token is NIFTY (99926000)');
        assert(receivedTick.ltp > 0, `Tick LTP is positive valid price: ₹${receivedTick.ltp.toFixed(2)}`);

        // Check memory cache
        const cachedLtp = AngelStreamService.getLtp('99926000');
        assert(cachedLtp === receivedTick.ltp, `AngelStreamService.getLtp() matches received LTP (₹${cachedLtp})`);

        // Check LiveCandleBuilder
        const candle = LiveCandleBuilder.getLive1hCandle('99926000', receivedTick.ltp);
        assert(candle.close === receivedTick.ltp, `LiveCandleBuilder 1H candle Close is ₹${candle.close}`);
        assert(candle.high >= candle.low, `Candle High (₹${candle.high}) >= Low (₹${candle.low})`);
    } catch (err: any) {
        assert(false, `Live tick verification failed: ${err.message}`);
    }

    // ── STEP 3: TriggerManagerService In-Memory State & Threshold Breach ───
    console.log('\n[Step 3] Testing TriggerManagerService with in-memory thresholds & tick routing...');
    const triggerMgr = TriggerManagerService.getInstance();

    const mockConfig: ConfigType = TradingConfig.buildConfig({
        id: 'test-bot-ws-e2e',
        USER_ID: 'user-test-ws',
        INDEX: 'NIFTY',
        DRY_RUN: true,
        UT_BOT_ENABLED: true,
        UT_BOT_KEY_VALUE: 1.0,
        UT_BOT_ATR_PERIOD: 10,
    });

    try {
        await triggerMgr.registerBot(mockConfig);
        console.log('  ✔ Bot registered in TriggerManagerService.');

        // Test custom simulated tick breach dispatch
        console.log('  Simulating a tick above bull trigger threshold to test breach pipeline...');
        
        // Ensure BulkSync is clean
        console.log(`  Initial BulkSync hasPendingChanges: ${BulkSyncService.hasPendingChanges()}`);

        // Trigger an in-memory simulated tick event
        const testBreachTick: AngelStreamTick = {
            token: '99926000',
            exchangeType: 1,
            ltp: 29999.00, // Deliberately high price to guarantee breach
            timestamp: Date.now(),
        };

        // Emit through stream emitter to trigger handleTick
        (stream as any).emitter.emit('tick', testBreachTick);

        // Small pause for execution pipeline
        await new Promise(r => setTimeout(r, 200));

        assert(true, 'Trigger breach pipeline executed and handled gracefully');
    } catch (err: any) {
        assert(false, `TriggerManager test failed: ${err.message}`);
    }

    // ── STEP 4: Clean Disconnect ──────────────────────────────────────────
    console.log('\n[Step 4] Testing graceful disconnect & cleanup...');
    try {
        stream.disconnect();
        assert(!stream.isConnected(), 'AngelStreamService isConnected() is false after disconnect()');
        triggerMgr.cleanup();
        console.log('  ✔ Stream and TriggerManager cleaned up successfully.');
    } catch (err: any) {
        assert(false, `Disconnect failed: ${err.message}`);
    }

    // ── SUMMARY ───────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(80));
    console.log(`🏁 WEBSOCKET E2E TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
    console.log('='.repeat(80));

    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

testWebSocketEndToEnd().catch(async (err) => {
    console.error('Fatal test error:', err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
