// =============================================================================
// KiteExchange — Unified Zerodha Kite Connect Service
// Replaces: binance-exchange.ts + delta-exchange.ts
// =============================================================================
// kiteconnect is a CommonJS module — use require for compatibility
// eslint-disable-next-line @typescript-eslint/no-require-imports
const kiteConnectModule = require('kiteconnect');
const KiteConnect  = kiteConnectModule.KiteConnect  as new (params: { api_key: string; root?: string; debug?: boolean; timeout?: number }) => any;
const KiteTicker   = kiteConnectModule.KiteTicker   as new (params: { api_key: string; access_token: string; reconnect?: boolean; max_retry?: number; max_delay?: number }) => any;

import {
    Candle,
    KiteInstrument,
    KiteOrder,
    KitePlaceOrderParams,
    KitePosition,
    KiteQuote,
    KiteTick,
} from './type';
import { tradingCronLogger } from './logger';

// ─── Kite interval constants ────────────────────────────────────────────────

export const KITE_INTERVALS = {
    '1minute':  '1minute',
    '3minute':  '3minute',
    '5minute':  '5minute',
    '10minute': '10minute',
    '15minute': '15minute',
    '30minute': '30minute',
    '60minute': '60minute',
    '1day':     'day',
} as const;

// Canonical instrument strings
export const NIFTY_INDEX  = 'NSE:NIFTY 50';       // spot index
export const NIFTY_TOKEN  = 256265;                 // Kite WS token for NIFTY 50
export const NIFTY_STEP   = 50;                     // strike step size
export const BANKNIFTY_INDEX = 'NSE:NIFTY BANK';
export const BANKNIFTY_TOKEN = 260105;
export const BANKNIFTY_STEP  = 100;

// ─── Helper: parse Kite candle response ─────────────────────────────────────

function parseKiteCandles(raw: any[]): Candle[] {
    return raw.map((c: any) => ({
        timestamp: new Date(c.date).getTime(),
        open:   Number(c.open),
        high:   Number(c.high),
        low:    Number(c.low),
        close:  Number(c.close),
        volume: Number(c.volume ?? 0),
    })).sort((a, b) => a.timestamp - b.timestamp);
}

// ─── KiteExchange class ──────────────────────────────────────────────────────

export class KiteExchange {
    private kc: any;
    private ticker: any | null = null;
    private readonly apiKey: string;

    constructor(apiKey: string, accessToken: string) {
        this.apiKey = apiKey;
        this.kc = new KiteConnect({ api_key: apiKey });
        this.kc.setAccessToken(accessToken);
    }

    // ─── Market Data ─────────────────────────────────────────────────────────

    /**
     * Fetch historical OHLCV candles for an instrument.
     * @param instrument  e.g. "NSE:NIFTY 50"
     * @param interval    e.g. "5minute"
     * @param from        Date object (lookback start)
     * @param to          Date object (end, usually now)
     */
    async getCandlestickData(
        instrument: string,
        interval: string,
        from: Date,
        to: Date
    ): Promise<Candle[]> {
        try {
            const raw = await this.kc.getHistoricalData(
                instrument,
                interval,
                from,
                to,
                false,  // continuous = false
                false   // oi = false
            );
            return parseKiteCandles(raw);
        } catch (err: any) {
            tradingCronLogger.error(`[KiteExchange] getCandlestickData failed for ${instrument}: ${err.message}`);
            return [];
        }
    }

    /**
     * Get last traded price for multiple instruments.
     * @param instruments  e.g. ["NSE:NIFTY 50", "NFO:NIFTY24JAN25000CE"]
     */
    async getLTP(instruments: string[]): Promise<Record<string, { last_price: number }>> {
        try {
            const res = await this.kc.getLTP(instruments);
            return res as Record<string, { last_price: number }>;
        } catch (err: any) {
            tradingCronLogger.error(`[KiteExchange] getLTP failed: ${err.message}`);
            return {};
        }
    }

    /**
     * Get full quote data (OHLC, volume, OI, etc.)
     */
    async getQuote(instruments: string[]): Promise<Record<string, KiteQuote>> {
        try {
            return await this.kc.getQuote(instruments) as Record<string, KiteQuote>;
        } catch (err: any) {
            tradingCronLogger.error(`[KiteExchange] getQuote failed: ${err.message}`);
            return {};
        }
    }

    // ─── Instruments ─────────────────────────────────────────────────────────

    /**
     * Download full instrument list for an exchange.
     * NOTE: This is a large file (~30MB for NFO), cache it.
     */
    async getInstruments(exchange: 'NFO' | 'NSE' | 'BSE'): Promise<KiteInstrument[]> {
        try {
            const raw = await this.kc.getInstruments([exchange]);
            return raw as KiteInstrument[];
        } catch (err: any) {
            tradingCronLogger.error(`[KiteExchange] getInstruments failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Find the nearest weekly or monthly expiry option instrument.
     * @param instruments  Pre-loaded NFO instruments list
     * @param index        'NIFTY' | 'BANKNIFTY'
     * @param strike       Strike price (e.g. 24500)
     * @param optionType   'CE' | 'PE'
     * @param expiryType   'weekly' | 'monthly'
     */
    findOptionInstrument(
        instruments: KiteInstrument[],
        index: 'NIFTY' | 'BANKNIFTY',
        strike: number,
        optionType: 'CE' | 'PE',
        expiryType: 'weekly' | 'monthly'
    ): KiteInstrument | null {
        const today = new Date();
        const todayMs = today.getTime();

        // Filter options for this index, strike, and type
        const candidates = instruments.filter(ins =>
            ins.name === index &&
            ins.instrument_type === optionType &&
            ins.strike === strike
        );

        if (!candidates.length) {
            tradingCronLogger.warn(`[KiteExchange] No instruments found for ${index} ${strike} ${optionType}`);
            return null;
        }

        // Sort by expiry ascending (nearest first)
        const sorted = candidates
            .map(ins => ({ ...ins, expiryMs: new Date(ins.expiry).getTime() }))
            .filter(ins => ins.expiryMs >= todayMs)
            .sort((a, b) => a.expiryMs - b.expiryMs);

        if (!sorted.length) {
            tradingCronLogger.warn(`[KiteExchange] All expiries expired for ${index} ${strike} ${optionType}`);
            return null;
        }

        if (expiryType === 'weekly') {
            // Return the nearest expiry
            return sorted[0];
        } else {
            // Return the nearest MONTHLY expiry (last Thursday of month)
            const monthly = sorted.find(ins => {
                const d = new Date(ins.expiry);
                return d.getDate() >= 25; // Monthly expiry is always >= 25th
            });
            return monthly ?? sorted[0];
        }
    }

    /**
     * Select smart strike based on spot price and ATR14.
     * - ATR < 50: ATM (best premium)
     * - ATR 50–100: 1 strike OTM (lower cost)
     * - ATR > 100: ATM (high vol, fair premium)
     */
    selectStrike(
        spotPrice: number,
        optionType: 'CE' | 'PE',
        atr14: number,
        stepSize: number = 50
    ): number {
        // Round spot to nearest step
        const atm = Math.round(spotPrice / stepSize) * stepSize;

        // For low ATR, buy ATM; for medium ATR, buy 1-strike OTM
        if (atr14 >= 50 && atr14 <= 100) {
            // OTM = higher strike for CE, lower strike for PE
            return optionType === 'CE' ? atm + stepSize : atm - stepSize;
        }

        return atm; // ATM for low or very high ATR
    }

    // ─── Orders ───────────────────────────────────────────────────────────────

    /**
     * Place an order. Returns the order_id on success.
     */
    async placeOrder(params: KitePlaceOrderParams): Promise<{ order_id: string }> {
        const variety = params.variety ?? 'regular';

        const orderParams: any = {
            exchange:           params.exchange,
            tradingsymbol:      params.tradingsymbol,
            transaction_type:   params.transaction_type,
            quantity:           params.quantity,
            order_type:         params.order_type,
            product:            params.product,
            validity:           params.validity ?? 'DAY',
        };

        if (params.price)         orderParams.price         = params.price;
        if (params.trigger_price) orderParams.trigger_price = params.trigger_price;
        if (params.tag)           orderParams.tag           = params.tag;
        if (params.disclosed_quantity) orderParams.disclosed_quantity = params.disclosed_quantity;

        const result = await this.kc.placeOrder(variety, orderParams);
        return { order_id: String(result.order_id) };
    }

    /**
     * Cancel an open order.
     */
    async cancelOrder(orderId: string, variety: string = 'regular'): Promise<void> {
        await this.kc.cancelOrder(variety, orderId);
    }

    /**
     * Get all orders for today.
     */
    async getOrders(): Promise<KiteOrder[]> {
        try {
            return await this.kc.getOrders() as KiteOrder[];
        } catch (err: any) {
            tradingCronLogger.error(`[KiteExchange] getOrders failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Get full history of a single order.
     */
    async getOrderHistory(orderId: string): Promise<KiteOrder[]> {
        try {
            return await this.kc.getOrderHistory(orderId) as KiteOrder[];
        } catch (err: any) {
            tradingCronLogger.error(`[KiteExchange] getOrderHistory failed: ${err.message}`);
            return [];
        }
    }

    // ─── Portfolio ────────────────────────────────────────────────────────────

    /**
     * Get open positions for today.
     */
    async getPositions(): Promise<{ day: KitePosition[]; net: KitePosition[] }> {
        try {
            const res = await this.kc.getPositions();
            return {
                day: res.day as KitePosition[],
                net: res.net as KitePosition[],
            };
        } catch (err: any) {
            tradingCronLogger.error(`[KiteExchange] getPositions failed: ${err.message}`);
            return { day: [], net: [] };
        }
    }

    // ─── WebSocket Ticker ─────────────────────────────────────────────────────

    /**
     * Connect WebSocket ticker to receive live ticks and order updates.
     */
    connectTicker(
        instrumentTokens: number[],
        onTick: (ticks: KiteTick[]) => void,
        onOrderUpdate?: (order: KiteOrder) => void
    ): void {
        if (this.ticker) {
            this.disconnectTicker();
        }

        this.ticker = new KiteTicker({
            api_key:      this.apiKey,
            access_token: this.kc.getAccessToken?.() ?? '',
        });

        this.ticker.autoReconnect(true, -1, 5); // infinite reconnect, 5s interval

        this.ticker.on('connect', () => {
            tradingCronLogger.info(`[KiteTicker] Connected. Subscribing to ${instrumentTokens.length} tokens.`);
            this.ticker!.subscribe(instrumentTokens);
            this.ticker!.setMode(this.ticker!.modeFull, instrumentTokens);
        });

        this.ticker.on('ticks', (ticks: any[]) => {
            onTick(ticks as KiteTick[]);
        });

        if (onOrderUpdate) {
            this.ticker.on('order_update', (order: any) => {
                onOrderUpdate(order as KiteOrder);
            });
        }

        this.ticker.on('disconnect', (err: Error) => {
            tradingCronLogger.warn(`[KiteTicker] Disconnected: ${err?.message}`);
        });

        this.ticker.on('error', (err: Error) => {
            tradingCronLogger.error(`[KiteTicker] Error: ${err?.message}`);
        });

        this.ticker.on('reconnect', (count: number, interval: number) => {
            tradingCronLogger.info(`[KiteTicker] Reconnecting... attempt #${count} (interval: ${interval}s)`);
        });

        this.ticker.connect();
    }

    /**
     * Disconnect the WebSocket ticker.
     */
    disconnectTicker(): void {
        if (this.ticker) {
            try { this.ticker.disconnect(); } catch (_) { /* ignore */ }
            this.ticker = null;
            tradingCronLogger.info('[KiteTicker] Disconnected.');
        }
    }

    // ─── Utility ─────────────────────────────────────────────────────────────

    /**
     * Get the Kite login URL for OAuth flow.
     * User visits this URL, logs in, and gets a request_token in the redirect URL.
     */
    getLoginURL(): string {
        return this.kc.getLoginURL();
    }

    /**
     * Generate a session from a request_token.
     * Returns { access_token, user_id, user_name, email, ... }
     */
    async generateSession(requestToken: string, apiSecret: string): Promise<any> {
        return this.kc.generateSession(requestToken, apiSecret);
    }

    /**
     * Invalidate the current access token (logout).
     */
    async invalidateToken(): Promise<void> {
        await this.kc.invalidateAccessToken();
    }
}
