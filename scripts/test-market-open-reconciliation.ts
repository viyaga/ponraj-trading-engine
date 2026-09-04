/**
 * Test Market-Open Reconciliation for Pending/AMO Orders
 * 
 * Verifies:
 * 1. AMO Pending: Remains pending, NO GTT placed.
 * 2. AMO Rejected/Cancelled: Transitions to status='closed', tradeOutcome='cancelled', NO GTT placed.
 * 3. AMO Complete: Reconciles actual fill price & qty, recalculates SL & TP, places GTT OCO, confirms status='open'.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { TradeState } from '../src/models/tradeState.model';
import { TradingV2 } from '../src/services/tradingV2';
import { ConfigType } from '../src/services/tradingV2/type';
import { KiteExchange } from '../src/services/tradingV2/kite-exchange';

const MOCK_BOT_ID = 'test-bot-reconcile-999';
const MOCK_USER_ID = 'test-user-999';

async function runTests() {
    console.log('===============================================================');
    console.log('🚀 STARTING MARKET-OPEN RECONCILIATION TEST SUITE');
    console.log('===============================================================\n');

    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/kite-ai-engine';
    console.log(`Connecting to MongoDB at ${mongoUri}...`);
    try {
        await mongoose.connect(mongoUri);
        console.log('✔ MongoDB connected\n');
    } catch (err: any) {
        console.error('✖ Could not connect to MongoDB:', err.message);
        process.exit(1);
    }

    const mockConfig: ConfigType = {
        id: MOCK_BOT_ID,
        USER_ID: MOCK_USER_ID,
        INDEX: 'NIFTY',
        DRY_RUN: false,
        LOT_SIZE: 65,
        NUMBER_OF_LOTS: 1,
        TARGET_PROFIT_PCT: 20,
        STOP_LOSS_PCT: 10,
        MAX_LOSS_PER_DAY: 2500,
        PRODUCT: 'MIS',
        API_KEY: 'test-api-key',
        ACCESS_TOKEN: 'test-access-token',
        TARGET_PREMIUM_MIN: 120,
        TARGET_PREMIUM_MAX: 150,
        EXPIRY_TYPE: 'weekly',
        OPTION_STEP_SIZE: 50,
        OPTION_MAX_STEPS: 8,
        UT_BOT_ENABLED: true,
    } as any;

    try {
        // Clean up previous test entries
        await TradeState.deleteMany({ tradingBotId: MOCK_BOT_ID });

        // ─────────────────────────────────────────────────────────────
        // TEST 1: AMO Order Still Pending (e.g. AMO REQ RECEIVED)
        // ─────────────────────────────────────────────────────────────
        console.log('--- TEST 1: AMO Order Still Pending (AMO REQ RECEIVED) ---');
        const testTrade1 = await TradeState.create({
            tradingBotId: MOCK_BOT_ID,
            userId: MOCK_USER_ID,
            symbol: 'NIFTY2690824050PE',
            status: 'entry_pending',
            tradeOutcome: 'pending',
            entryOrderId: 'order-amo-pending-111',
            entryPrice: null,
            quantity: 65,
            stopLossOrderId: null,
            effectiveTP: 20,
            effectiveSL: 10,
        });

        let gttPlacedCount = 0;
        const mockKitePending = {
            getOrderHistory: async (orderId: string) => {
                return [{ status: 'AMO REQ RECEIVED', average_price: 0, filled_quantity: 0 }];
            },
            placeGTT: async () => {
                gttPlacedCount++;
                return { trigger_id: 12345 };
            },
            getLTP: async () => ({ 'NFO:NIFTY2690824050PE': { last_price: 134.70 } }),
        } as unknown as KiteExchange;

        await TradingV2.monitorAndExit(mockConfig, mockKitePending);

        const check1 = await TradeState.findById(testTrade1._id);
        if (check1?.status === 'entry_pending' && check1.tradeOutcome === 'pending' && check1.stopLossOrderId === null && gttPlacedCount === 0) {
            console.log('✔ TEST 1 PASSED: Trade remained ENTRY_PENDING, no GTT created, waiting for market open.\n');
        } else {
            console.error('✖ TEST 1 FAILED:', check1);
            process.exit(1);
        }

        // Clean up for test 2
        await TradeState.deleteMany({ tradingBotId: MOCK_BOT_ID });

        // ─────────────────────────────────────────────────────────────
        // TEST 2: AMO Order Rejected / Cancelled by Broker
        // ─────────────────────────────────────────────────────────────
        console.log('--- TEST 2: AMO Order Rejected / Cancelled by Broker ---');
        const testTrade2 = await TradeState.create({
            tradingBotId: MOCK_BOT_ID,
            userId: MOCK_USER_ID,
            symbol: 'NIFTY2690824050PE',
            status: 'entry_pending',
            tradeOutcome: 'pending',
            entryOrderId: 'order-amo-rejected-222',
            entryPrice: null,
            quantity: 65,
            stopLossOrderId: null,
        });

        gttPlacedCount = 0;
        const mockKiteRejected = {
            getOrderHistory: async (orderId: string) => {
                return [{ status: 'REJECTED', status_message: 'RMS: Insufficient Funds' }];
            },
            placeGTT: async () => {
                gttPlacedCount++;
                return { trigger_id: 12345 };
            },
            getLTP: async () => ({ 'NFO:NIFTY2690824050PE': { last_price: 134.70 } }),
        } as unknown as KiteExchange;

        await TradingV2.monitorAndExit(mockConfig, mockKiteRejected);

        const check2 = await TradeState.findById(testTrade2._id);
        if (check2?.status === 'closed' && check2.tradeOutcome === 'cancelled' && check2.stopLossOrderId === null && gttPlacedCount === 0) {
            console.log('✔ TEST 2 PASSED: Trade transitioned from ENTRY_PENDING → CLOSED (cancelled) and NO GTT placed.\n');
        } else {
            console.error('✖ TEST 2 FAILED:', check2);
            process.exit(1);
        }

        // Clean up for test 3
        await TradeState.deleteMany({ tradingBotId: MOCK_BOT_ID });

        // ─────────────────────────────────────────────────────────────
        // TEST 3: Market Opens & Order is COMPLETE
        // ─────────────────────────────────────────────────────────────
        console.log('--- TEST 3: Market Opens & Order is COMPLETE (Fill Reconciliation & GTT Placement) ---');
        const testTrade3 = await TradeState.create({
            tradingBotId: MOCK_BOT_ID,
            userId: MOCK_USER_ID,
            symbol: 'NIFTY2690824050PE',
            status: 'entry_pending',
            tradeOutcome: 'pending',
            entryOrderId: '2095879066292248576',
            entryPrice: null,
            quantity: 65,
            stopLossOrderId: null,
            effectiveTP: 20,
            effectiveSL: 10,
        });

        let capturedGttPayload: any = null;
        const mockActualFillPrice = 136.50; // filled at 136.50
        const mockActualFillQty = 65;

        const mockKiteComplete = {
            getOrderHistory: async (orderId: string) => {
                return [{
                    status: 'COMPLETE',
                    average_price: mockActualFillPrice,
                    filled_quantity: mockActualFillQty,
                }];
            },
            placeGTT: async (params: any) => {
                capturedGttPayload = params;
                return { trigger_id: 77889911 };
            },
            getLTP: async () => ({ 'NFO:NIFTY2690824050PE': { last_price: 136.50 } }),
        } as unknown as KiteExchange;

        await TradingV2.monitorAndExit(mockConfig, mockKiteComplete);

        const check3 = await TradeState.findById(testTrade3._id);

        const expectedTP = Math.round(mockActualFillPrice * 1.20 * 20) / 20; // 136.50 * 1.2 = 163.80
        const expectedSL = Math.round(mockActualFillPrice * 0.90 * 20) / 20; // 136.50 * 0.9 = 122.85

        console.log(`Reconciled Entry Price: ₹${check3?.entryPrice} (Expected: ₹${mockActualFillPrice})`);
        console.log(`Reconciled Quantity:    ${check3?.quantity} (Expected: ${mockActualFillQty})`);
        console.log(`Recalculated TP Price:  ₹${check3?.tpPrice} (Expected: ₹${expectedTP})`);
        console.log(`Recalculated SL Price:  ₹${check3?.slPrice} (Expected: ₹${expectedSL})`);
        console.log(`GTT Trigger ID:         ${check3?.stopLossOrderId} (Expected: '77889911')`);
        console.log(`Trade Status:           ${check3?.status} (Expected: 'open')`);

        const isGttValid = capturedGttPayload &&
            capturedGttPayload.tradingsymbol === 'NIFTY2690824050PE' &&
            capturedGttPayload.trigger_values[0] === expectedSL &&
            capturedGttPayload.trigger_values[1] === expectedTP;

        if (
            check3?.entryPrice === mockActualFillPrice &&
            check3.quantity === mockActualFillQty &&
            check3.tpPrice === expectedTP &&
            check3.slPrice === expectedSL &&
            check3.stopLossOrderId === '77889911' &&
            check3.status === 'open' &&
            isGttValid
        ) {
            console.log('\n✔ TEST 3 PASSED: Order reconciled, SL/TP accurately recalculated, GTT created, status confirmed OPEN!\n');
        } else {
            console.error('✖ TEST 3 FAILED:', { check3, capturedGttPayload });
            process.exit(1);
        }

        // Clean up test data
        await TradeState.deleteMany({ tradingBotId: MOCK_BOT_ID });

        console.log('===============================================================');
        console.log('🎉 ALL MARKET-OPEN RECONCILIATION TESTS PASSED SUCCESSFULLY!');
        console.log('===============================================================');

    } finally {
        await mongoose.disconnect();
    }
}

runTests().catch((err) => {
    console.error('Test execution error:', err);
    process.exit(1);
});
