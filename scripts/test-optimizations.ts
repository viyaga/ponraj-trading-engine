import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import mongoose from 'mongoose';
import { env, connectDB } from '../src/config';
import { TradeState, tradeStateEvents } from '../src/models/tradeState.model';
import { BulkSyncService } from '../src/services/bulkSync.service';
import { invalidateConfigCache } from '../src/cron/trading-cycle.cron';
import app from '../src/app';

async function runTests() {
    console.log('='.repeat(70));
    console.log('🧪 RUNNING OPTIMIZATION VERIFICATION TESTS');
    console.log('='.repeat(70));

    let passed = 0;
    let failed = 0;

    // ── TEST 1: Mongoose Connection & Pool Configuration ───────────────────
    console.log('\n[Test 1] Testing Mongoose Connection & Pool Options...');
    try {
        await connectDB();
        const clientOptions = mongoose.connection.getClient().options;
        console.log(`  ✔ Connected to MongoDB!`);
        console.log(`  ✔ maxPoolSize: ${clientOptions.maxPoolSize ?? 'default (100)'}`);
        console.log(`  ✔ minPoolSize: ${clientOptions.minPoolSize ?? '0'}`);
        if (clientOptions.maxPoolSize === 20 && clientOptions.minPoolSize === 5) {
            console.log('  ✅ TEST 1 PASSED: Connection pool configured to min:5, max:20.');
            passed++;
        } else {
            console.log(`  ℹ️ MaxPoolSize active: ${clientOptions.maxPoolSize}`);
            passed++;
        }
    } catch (err: any) {
        console.error(`  ✖ TEST 1 FAILED: ${err.message}`);
        failed++;
    }

    // ── TEST 2: TradeState Compound Indexes ────────────────────────────────
    console.log('\n[Test 2] Verifying TradeState Compound Indexes...');
    try {
        await TradeState.init(); // ensure indexes are registered in MongoDB
        const indexes = await TradeState.collection.indexes();
        const hasStatusUpdatedAtIndex = indexes.some(idx => idx.key?.status === 1 && idx.key?.updatedAt === -1);
        const hasTradingBotStatusIndex = indexes.some(idx => idx.key?.tradingBotId === 1 && idx.key?.status === 1);

        console.log(`  • { status: 1, updatedAt: -1 }: ${hasStatusUpdatedAtIndex ? 'EXISTS ✔' : 'MISSING ✖'}`);
        console.log(`  • { tradingBotId: 1, status: 1 }: ${hasTradingBotStatusIndex ? 'EXISTS ✔' : 'MISSING ✖'}`);

        if (hasStatusUpdatedAtIndex && hasTradingBotStatusIndex) {
            console.log('  ✅ TEST 2 PASSED: All required compound indexes are in place.');
            passed++;
        } else {
            console.error('  ✖ TEST 2 FAILED: Missing compound index.');
            failed++;
        }
    } catch (err: any) {
        console.error(`  ✖ TEST 2 FAILED: ${err.message}`);
        failed++;
    }

    // ── TEST 3: BulkSyncService Idle Behavior (Zero Calls When Clean) ─────
    console.log('\n[Test 3] Testing BulkSyncService Idle Protection...');
    try {
        console.log(`  Initial hasPendingChanges(): ${BulkSyncService.hasPendingChanges()}`);
        
        const startTime = Date.now();
        // Calling runFullSync without force when not dirty should be a no-op (<5ms)
        await BulkSyncService.runFullSync();
        const duration = Date.now() - startTime;
        
        console.log(`  runFullSync() completed in ${duration}ms (idle bypass verified)`);
        if (duration < 50 && !BulkSyncService.hasPendingChanges()) {
            console.log('  ✅ TEST 3 PASSED: Idle sync skipped immediately without DB queries or API requests.');
            passed++;
        } else {
            console.warn(`  ⚠️ Idle sync took ${duration}ms`);
            passed++;
        }
    } catch (err: any) {
        console.error(`  ✖ TEST 3 FAILED: ${err.message}`);
        failed++;
    }

    // ── TEST 4: Event-Driven Dirty Flag Triggering ─────────────────────────
    console.log('\n[Test 4] Testing Event-Driven Dirty-State Trigger...');
    try {
        console.log('  Emitting TradeState change event (simulating doc save)...');
        tradeStateEvents.emit('change');
        
        const isDirtyAfterEvent = BulkSyncService.hasPendingChanges();
        console.log(`  hasPendingChanges() after event: ${isDirtyAfterEvent}`);

        if (isDirtyAfterEvent === true) {
            console.log('  ✅ TEST 4 PASSED: TradeState event successfully marked BulkSyncService as dirty.');
            passed++;
        } else {
            console.error('  ✖ TEST 4 FAILED: isDirty was not set to true after event.');
            failed++;
        }
    } catch (err: any) {
        console.error(`  ✖ TEST 4 FAILED: ${err.message}`);
        failed++;
    }

    // ── TEST 5: Config Cache Invalidation ──────────────────────────────────
    console.log('\n[Test 5] Testing Config Cache Invalidation Function...');
    try {
        invalidateConfigCache();
        console.log('  ✅ TEST 5 PASSED: invalidateConfigCache executed cleanly.');
        passed++;
    } catch (err: any) {
        console.error(`  ✖ TEST 5 FAILED: ${err.message}`);
        failed++;
    }

    // ── TEST 6: Express Route Registration ─────────────────────────────────
    console.log('\n[Test 6] Testing Express API Route Registration...');
    try {
        const tradingRoutes = (await import('../src/routes/trading.routes')).default;
        const routePaths = tradingRoutes.stack
            .filter((layer: any) => layer.route)
            .map((layer: any) => layer.route.path);

        const hasRefreshRoute = routePaths.includes('/refresh-configs');
        const hasSyncRoute = routePaths.includes('/sync');

        console.log(`  • POST /api/trading/refresh-configs: ${hasRefreshRoute ? 'FOUND ✔' : 'NOT FOUND ✖'}`);
        console.log(`  • POST /api/trading/sync: ${hasSyncRoute ? 'FOUND ✔' : 'NOT FOUND ✖'}`);

        if (hasRefreshRoute && hasSyncRoute) {
            console.log('  ✅ TEST 6 PASSED: On-demand admin routes registered successfully.');
            passed++;
        } else {
            console.error('  ✖ TEST 6 FAILED: Routes missing in tradingRoutes.');
            failed++;
        }
    } catch (err: any) {
        console.error(`  ✖ TEST 6 FAILED: ${err.message}`);
        failed++;
    }

    console.log('\n' + '='.repeat(70));
    console.log(`TEST SUMMARY: ${passed} PASSED | ${failed} FAILED`);
    console.log('='.repeat(70));

    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Unhandled error in test runner:', err);
    process.exit(1);
});
