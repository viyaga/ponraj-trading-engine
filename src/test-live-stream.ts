import { AngelStreamService } from './services/tradingV2/angel-stream.service';
import { LiveCandleBuilder } from './services/tradingV2/live-candle-builder';

async function testLiveWebSocketStream() {
    console.log('='.repeat(80));
    console.log('📡 TESTING REAL-TIME ANGEL ONE SMARTSTREAM WEBSOCKET (5 SECONDS)...');
    console.log('='.repeat(80));

    const stream = AngelStreamService.getInstance();
    let tickCount = 0;

    const unsub = stream.onTick((tick) => {
        tickCount++;
        const live1h = LiveCandleBuilder.getLive1hCandle(tick.token, tick.ltp);
        console.log(
            `  ⚡ TICK #${tickCount}: Token: ${tick.token} | LTP: ₹${tick.ltp.toFixed(2)} | ` +
            `Live 1H Bar -> O: ₹${live1h.open.toFixed(2)} H: ₹${live1h.high.toFixed(2)} L: ₹${live1h.low.toFixed(2)} C: ₹${live1h.close.toFixed(2)}`
        );
    });

    console.log('Connecting to Angel One SmartStream WebSocket...');
    await stream.connect();

    // Wait 5 seconds
    await new Promise((resolve) => setTimeout(resolve, 5000));

    unsub();
    stream.disconnect();

    console.log('='.repeat(80));
    console.log(`🏁 Stream test complete. Total live ticks received: ${tickCount}`);
    console.log('='.repeat(80));

    process.exit(0);
}

testLiveWebSocketStream().catch((err) => {
    console.error('Stream test error:', err);
    process.exit(1);
});
