import dotenv from 'dotenv';
dotenv.config();
import { connectDB } from '../src/config';
import { TradeState } from '../src/models/tradeState.model';

async function main() {
    await connectDB();
    const trades = await TradeState.find().sort({ createdAt: -1 }).limit(5).lean();

    console.log(`Latest ${trades.length} trades in DB:`);
    for (const t of trades) {
        console.log({
            _id: t._id,
            botId: t.tradingBotId,
            symbol: t.symbol,
            status: t.status,
            entryOrderId: t.entryOrderId,
            quantity: t.quantity,
            entryPrice: t.entryPrice,
            createdAt: t.createdAt,
            updatedAt: (t as any).updatedAt,
        });
    }
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
