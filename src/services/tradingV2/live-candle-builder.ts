import { Candle } from './type';
import { AngelMarketDataService } from './angel-market-data.service';
import { CandleStorageService } from './candle-storage.service';
import { tradingCronLogger } from './logger';

export class LiveCandleBuilder {
    // Current accumulating live candles: token -> Candle
    private static live1hMap = new Map<string, Candle>();
    private static live15mMap = new Map<string, Candle>();
    // Last completed 15m candle (archived when boundary rolls): token -> Candle
    private static lastCompleted15mMap = new Map<string, Candle>();

    /**
     * Process incoming WebSocket tick and update forming 15m and 1H candles
     */
    public static onTick(token: string, ltp: number, timestamp: number): void {
        const now = timestamp > 0 ? timestamp : Date.now();

        // ── 1. Update Live 1-Hour Candle ──────────────────────────────────────
        const boundary1h = AngelMarketDataService.candleBoundary1h(now);
        const candle1h = this.live1hMap.get(token);

        if (!candle1h || candle1h.timestamp !== boundary1h) {
            // If previous 1H candle existed and rolled over, persist to DB
            if (candle1h && candle1h.timestamp < boundary1h) {
                CandleStorageService.saveCandles(token, '60minute', [{ ...candle1h }]).catch(() => {});
            }

            const timeStr = new Date(boundary1h).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
            tradingCronLogger.info(`[LiveCandleBuilder] 🕯️ New 1H bar started [${timeStr} IST] | Open: ₹${ltp.toFixed(2)}`);
            this.live1hMap.set(token, {
                timestamp: boundary1h,
                open: ltp,
                high: ltp,
                low: ltp,
                close: ltp,
                volume: 0,
            });
        } else {
            // Accumulate high, low, close on active 1H bar
            if (ltp > candle1h.high) {
                tradingCronLogger.debug(`[LiveCandleBuilder] 📈 1H High updated: ₹${ltp.toFixed(2)} (prev: ₹${candle1h.high.toFixed(2)})`);
                candle1h.high = ltp;
            }
            if (ltp < candle1h.low) {
                tradingCronLogger.debug(`[LiveCandleBuilder] 📉 1H Low updated: ₹${ltp.toFixed(2)} (prev: ₹${candle1h.low.toFixed(2)})`);
                candle1h.low = ltp;
            }
            candle1h.close = ltp;
        }

        // ── 2. Update Live 15-Minute Candle ───────────────────────────────────
        const boundary15m = AngelMarketDataService.candleBoundary15m(now);
        const candle15m = this.live15mMap.get(token);

        if (!candle15m || candle15m.timestamp !== boundary15m) {
            // If previous candle existed and belongs to the prior boundary, archive it as completed
            if (candle15m && candle15m.timestamp < boundary15m) {
                const completed = { ...candle15m };
                this.lastCompleted15mMap.set(token, completed);
                CandleStorageService.saveCandles(token, '15minute', [completed]).catch(() => {});

                const prevTimeStr = new Date(candle15m.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
                tradingCronLogger.info(
                    `[LiveCandleBuilder] ✔ 15m candle completed [${prevTimeStr} IST] | ` +
                    `O: ₹${candle15m.open.toFixed(2)} H: ₹${candle15m.high.toFixed(2)} L: ₹${candle15m.low.toFixed(2)} C: ₹${candle15m.close.toFixed(2)}`
                );
            }

            // Start a new 15m candle at boundary
            this.live15mMap.set(token, {
                timestamp: boundary15m,
                open: ltp,
                high: ltp,
                low: ltp,
                close: ltp,
                volume: 0,
            });
        } else {
            candle15m.high = Math.max(candle15m.high, ltp);
            candle15m.low = Math.min(candle15m.low, ltp);
            candle15m.close = ltp;
        }
    }

    /**
     * Get the active accumulating live 1H candle.
     * If cold start mid-hour, can seed O/H/L from completed 15m bars of this hour.
     */
    public static getLive1hCandle(
        token: string,
        currentSpot: number,
        completed15mCandles?: Candle[]
    ): Candle {
        const now = Date.now();
        const boundary1h = AngelMarketDataService.candleBoundary1h(now);
        let live = this.live1hMap.get(token);

        if (!live || live.timestamp !== boundary1h) {
            // Cold start initialization
            let open = currentSpot;
            let high = currentSpot;
            let low = currentSpot;

            // Seed from completed 15m candles falling within this 1H boundary
            if (completed15mCandles && completed15mCandles.length > 0) {
                const hourBars = completed15mCandles.filter(
                    (b) => b.timestamp >= boundary1h && b.timestamp < boundary1h + 3600000
                );
                if (hourBars.length > 0) {
                    open = hourBars[0].open;
                    high = Math.max(...hourBars.map((b) => b.high), currentSpot);
                    low = Math.min(...hourBars.map((b) => b.low), currentSpot);
                }
            }

            live = {
                timestamp: boundary1h,
                open,
                high,
                low,
                close: currentSpot,
                volume: 0,
            };
            this.live1hMap.set(token, live);
        } else {
            // Ensure latest spot is reflected
            live.high = Math.max(live.high, currentSpot);
            live.low = Math.min(live.low, currentSpot);
            live.close = currentSpot;
        }

        return { ...live };
    }

    /**
     * Get the active accumulating live 15m candle
     */
    public static getLive15mCandle(token: string, currentSpot: number): Candle {
        const now = Date.now();
        const boundary15m = AngelMarketDataService.candleBoundary15m(now);
        let live = this.live15mMap.get(token);

        if (!live || live.timestamp !== boundary15m) {
            live = {
                timestamp: boundary15m,
                open: currentSpot,
                high: currentSpot,
                low: currentSpot,
                close: currentSpot,
                volume: 0,
            };
            this.live15mMap.set(token, live);
        } else {
            live.high = Math.max(live.high, currentSpot);
            live.low = Math.min(live.low, currentSpot);
            live.close = currentSpot;
        }

        return { ...live };
    }

    /**
     * Get the last completed 15m candle formed from live WebSocket stream
     */
    public static getLastCompleted15mCandle(token: string): Candle | null {
        const c = this.lastCompleted15mMap.get(token);
        return c ? { ...c } : null;
    }

    public static clear(): void {
        this.live1hMap.clear();
        this.live15mMap.clear();
        this.lastCompleted15mMap.clear();
    }
}
