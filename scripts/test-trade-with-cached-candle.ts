import dotenv from 'dotenv';
dotenv.config();
import { connectDB } from '../src/config';
import { Data } from '../src/services/tradingV2/data';
import { TradingV2 } from '../src/services/tradingV2';
import { TradingConfig } from '../src/services/tradingV2/config';
import { TradeState } from '../src/models/tradeState.model';

async function main() {
    console.log('='.repeat(90));
    console.log('TESTING BOT EXECUTION WITH CACHED 01/10/2026 10:00 CANDLE');
    console.log('='.repeat(90));

    console.log('\nStep 1: Connecting to MongoDB...');
    await connectDB();

    console.log('\nStep 2: Fetching active bot configuration...');
    const configs = await Data.fetchTradingConfigs({ limit: 1 });
    if (!configs.length) {
        console.error('No active bot configs found in database or backend!');
        process.exit(1);
    }

    const baseCfg = configs[0];
    console.log(`Found bot: ${baseCfg.id} for index ${baseCfg.INDEX}`);
    console.log(`Current bot settings: DRY_RUN=${baseCfg.DRY_RUN}, CANDLE_PATTERN_STRATEGY_ENABLED=${baseCfg.CANDLE_PATTERN_STRATEGY_ENABLED}`);

    // Merge bot config with cache candle settings
    const testCfg = TradingConfig.buildConfig({
        ...baseCfg,
        USE_CACHE_CANDLE: true,
        CACHE_CANDLE_TARGET_TIME: '2026-10-01 10:00',
    });

    console.log('\nStep 3: Executing TradingV2.runTradingCycle with USE_CACHE_CANDLE=true (01/10/2026 10:00 IST)...');
    await TradingConfig.configStore.run(testCfg, async () => {
        await TradingV2.runTradingCycle(testCfg);
    });

    console.log('\nStep 4: Checking TradeState collection for created trade record...');
    const latestTrades = await TradeState.find({ tradingBotId: testCfg.id }).sort({ createdAt: -1 }).limit(3).lean();
    console.log(`Total trade records for bot ${testCfg.id}: ${latestTrades.length}`);
    for (const t of latestTrades) {
        console.log({
            id: t._id,
            symbol: t.symbol,
            status: t.status,
            signal: t.signal,
            quantity: t.quantity,
            entryPrice: t.entryPrice,
            orderId: t.entryOrderId,
            gttRuleId: t.gttRuleId,
            createdAt: t.createdAt,
        });
    }

    console.log('\n='.repeat(90));
    console.log('TEST RUN COMPLETED');
    console.log('='.repeat(90));
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error running cached candle trade test:', err);
    process.exit(1);
});
