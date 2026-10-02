import dotenv from 'dotenv';
dotenv.config();
import { connectDB } from '../src/config';
import mongoose from 'mongoose';
import { Data } from '../src/services/tradingV2/data';
import { TradeState } from '../src/models/tradeState.model';

async function main() {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) {
        console.error('No DB connection!');
        process.exit(1);
    }
    const cols = await db.listCollections().toArray();
    console.log('Collections in DB:', cols.map(c => c.name));

    for (const c of cols) {
        const count = await db.collection(c.name).countDocuments();
        console.log(`- ${c.name}: ${count} documents`);
    }

    try {
        const configs = await Data.fetchTradingConfigs({ limit: 10 });
        console.log(`\nFetched ${configs.length} active bot configs via Data.fetchTradingConfigs:`);
        for (const cfg of configs) {
            console.log({
                id: cfg.id,
                INDEX: cfg.INDEX,
                DRY_RUN: cfg.DRY_RUN,
                CANDLE_PATTERN_STRATEGY_ENABLED: cfg.CANDLE_PATTERN_STRATEGY_ENABLED,
                UT_BOT_ENABLED: cfg.UT_BOT_ENABLED,
                ATR_STRATEGY_ENABLED: cfg.ATR_STRATEGY_ENABLED,
                API_KEY_PRESENT: Boolean(cfg.API_KEY),
                ACCESS_TOKEN_PRESENT: Boolean(cfg.ACCESS_TOKEN),
            });
        }
    } catch (e: any) {
        console.error('Error fetching configs:', e.message);
    }

    try {
        const trades = await TradeState.find().sort({ createdAt: -1 }).limit(10).lean();
        console.log(`\nLatest ${trades.length} TradeStates in DB:`);
        for (const t of trades) {
            console.log({
                id: t._id,
                tradingBotId: t.tradingBotId,
                symbol: t.symbol,
                status: t.status,
                signal: t.signal,
                entryPrice: t.entryPrice,
                exitPrice: t.exitPrice,
                pnl: t.pnl,
                createdAt: t.createdAt,
            });
        }
    } catch (e: any) {
        console.error('Error querying TradeState:', e.message);
    }

    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
