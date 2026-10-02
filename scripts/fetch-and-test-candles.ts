import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

import { AngelMarketDataService } from '../src/services/tradingV2/angel-market-data.service';
import { CandleStorageService } from '../src/services/tradingV2/candle-storage.service';
import { connectDB } from '../src/config';
import { Candle } from '../src/services/tradingV2/type';

async function main() {
    console.log('Connecting to DB...');
    try {
        await connectDB();
    } catch (e: any) {
        console.warn('DB connect failed, proceeding with direct API...', e.message);
    }

    console.log('Fetching NIFTY 15m candles via AngelMarketDataService...');
    const candles = await AngelMarketDataService.get15mCandles('NIFTY');
    console.log(`Fetched ${candles.length} candles.`);

    if (candles.length === 0) {
        console.error('No candles returned! Check credentials or network.');
        process.exit(1);
    }

    // Ensure cache directory exists
    const cacheDir = path.join(process.cwd(), 'cache');
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    const cacheFile = path.join(cacheDir, 'nifty_15m_cached.json');
    fs.writeFileSync(cacheFile, JSON.stringify(candles, null, 2));
    console.log(`Cached all ${candles.length} candles to ${cacheFile}`);

    // Print range
    const first = candles[0];
    const last = candles[candles.length - 1];
    const fmt = (ts: number) => new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    console.log(`Earliest candle: ${fmt(first.timestamp)} (Open: ${first.open}, Close: ${first.close})`);
    console.log(`Latest candle:   ${fmt(last.timestamp)} (Open: ${last.open}, Close: ${last.close})`);

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error in fetch script:', err);
    process.exit(1);
});
