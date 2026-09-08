import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { AngelMarketDataService } from './angel-market-data.service';
import { LiveCandleBuilder } from './live-candle-builder';
import { tradingCronLogger } from './logger';

export interface AngelStreamTick {
    token: string;
    exchangeType: number;
    ltp: number;
    timestamp: number;
    sequenceNumber?: string;
}

export class AngelStreamService {
    private static instance: AngelStreamService | null = null;
    private ws: WebSocket | null = null;
    private emitter = new EventEmitter();
    private pingTimer: NodeJS.Timeout | null = null;
    private watchdogTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private lastMessageTime: number = 0;
    private reconnectAttempts: number = 0;
    private isManualClose: boolean = false;
    private isConnecting: boolean = false;
    private lastRateLimitTime: number = 0;

    // In-memory cache of latest prices: token -> { ltp, timestamp }
    private static latestPrices = new Map<string, { ltp: number; timestamp: number }>();

    // Subscribed token configurations
    private subscribedTokens = new Map<string, { exchangeType: number; token: string }>();

    private static readonly WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';
    private static readonly PING_INTERVAL_MS = 10000;          // Send 'ping' every 10s
    private static readonly WATCHDOG_INTERVAL_MS = 60000;      // Reconnect if no message in 60s (safer for slow/pre-market ticks)
    private static readonly RATE_LIMIT_COOLDOWN_MS = 45000;    // 45s cooldown on HTTP 429 rate limit

    private constructor() {
        this.emitter.setMaxListeners(50);
        // Default error handler to prevent unhandled error event crash in Node.js
        this.emitter.on('error', (err) => {
            tradingCronLogger.warn(`[AngelStream] Handled stream error event: ${err?.message}`);
        });
        // Default subscription: NIFTY 50 (token: 99926000, exchangeType: 1)
        this.subscribedTokens.set('99926000', { exchangeType: 1, token: '99926000' });
    }

    public static getInstance(): AngelStreamService {
        if (!this.instance) {
            this.instance = new AngelStreamService();
        }
        return this.instance;
    }

    /**
     * Get the latest real-time LTP for a token from memory
     */
    public static getLtp(token: string = '99926000'): number | null {
        const item = this.latestPrices.get(token);
        return item ? item.ltp : null;
    }

    /**
     * Register a tick listener
     */
    public onTick(listener: (tick: AngelStreamTick) => void): () => void {
        this.emitter.on('tick', listener);
        return () => this.emitter.off('tick', listener);
    }

    /**
     * Check if connection attempt is currently in progress
     */
    public isConnectingNow(): boolean {
        return this.isConnecting || Boolean(this.ws && this.ws.readyState === WebSocket.CONNECTING);
    }

    /**
     * Connect to Angel One SmartStream WebSocket
     */
    public async connect(): Promise<void> {
        if (this.isConnecting || (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))) {
            return;
        }

        const timeSinceRateLimit = Date.now() - this.lastRateLimitTime;
        if (timeSinceRateLimit < AngelStreamService.RATE_LIMIT_COOLDOWN_MS) {
            const remaining = Math.ceil((AngelStreamService.RATE_LIMIT_COOLDOWN_MS - timeSinceRateLimit) / 1000);
            tradingCronLogger.warn(`[AngelStream] ⏳ In 429 rate-limit cooldown window (${remaining}s remaining) — skipping connect attempt.`);
            return;
        }

        this.isConnecting = true;
        this.isManualClose = false;

        try {
            const creds = await AngelMarketDataService.getStreamCredentials();
            if (!creds) {
                tradingCronLogger.warn('[AngelStream] ⚠️ Missing Angel One credentials or failed login — stream cannot connect.');
                this.isConnecting = false;
                this.scheduleReconnect();
                return;
            }

            tradingCronLogger.info(`[AngelStream] ➔ Connecting to SmartStream WebSocket (${AngelStreamService.WS_URL})...`);

            const headers = {
                'x-client-code': creds.clientCode,
                'Authorization': creds.jwtToken,
                'x-api-key': creds.apiKey,
                'x-feed-token': creds.feedToken,
            };

            await new Promise<void>((resolve) => {
                const connectTimeout = setTimeout(() => {
                    this.isConnecting = false;
                    tradingCronLogger.warn('[AngelStream] ⚠️ WebSocket connection timed out after 10s.');
                    resolve();
                }, 10000);

                this.ws = new WebSocket(AngelStreamService.WS_URL, { headers });

                this.ws.on('open', () => {
                    clearTimeout(connectTimeout);
                    tradingCronLogger.info('[AngelStream] ✔ Connected to Angel One SmartStream WebSocket.');
                    this.isConnecting = false;
                    this.reconnectAttempts = 0;
                    this.lastRateLimitTime = 0;
                    this.lastMessageTime = Date.now();

                    this.startHeartbeat();
                    this.sendSubscriptions();
                    this.emitter.emit('connect');
                    resolve();
                });

                this.ws.on('message', (data: WebSocket.RawData) => {
                    this.lastMessageTime = Date.now();
                    this.handleMessage(data);
                });

                this.ws.on('error', (err: Error) => {
                    clearTimeout(connectTimeout);
                    const is429 = err.message?.includes('429');
                    if (is429) {
                        this.lastRateLimitTime = Date.now();
                        tradingCronLogger.warn('[AngelStream] ⚠️ 429 Too Many Requests on WebSocket — entering 45s cooldown.');
                    } else {
                        tradingCronLogger.error(`[AngelStream] ✖ WebSocket error: ${err.message}`, { error: err });
                    }
                    try {
                        this.emitter.emit('error', err);
                    } catch {}
                    this.isConnecting = false;
                    resolve(); // Resolve safely to prevent unhandled rejection crashes
                });

                this.ws.on('close', (code: number, reason: Buffer) => {
                    tradingCronLogger.warn(`[AngelStream] ⚠️ WebSocket closed (code: ${code}, reason: ${reason.toString() || 'none'})`);
                    this.cleanup();
                    try {
                        this.emitter.emit('close', code);
                    } catch {}
                    if (!this.isManualClose) {
                        this.scheduleReconnect(code === 1002 || code === 4429);
                    }
                });
            });

        } catch (err: any) {
            const is429 = err?.message?.includes('429');
            if (is429) {
                this.lastRateLimitTime = Date.now();
            }
            tradingCronLogger.error(`[AngelStream] ✖ Connection failed: ${err.message}`, { error: err });
            this.isConnecting = false;
            this.scheduleReconnect(is429);
        }
    }

    /**
     * Send subscription packet for all registered tokens in LTP mode (mode 1)
     */
    private sendSubscriptions(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        // Group by exchange type
        const byExchange = new Map<number, string[]>();
        for (const { exchangeType, token } of this.subscribedTokens.values()) {
            if (!byExchange.has(exchangeType)) {
                byExchange.set(exchangeType, []);
            }
            byExchange.get(exchangeType)!.push(token);
        }

        const tokenList = Array.from(byExchange.entries()).map(([exchangeType, tokens]) => ({
            exchangeType,
            tokens,
        }));

        const subReq = {
            action: 1, // 1 = Subscribe
            params: {
                mode: 1, // 1 = LTP Mode
                tokenList,
            },
        };

        this.ws.send(JSON.stringify(subReq));
        tradingCronLogger.info(`[AngelStream] ➔ Subscribed to ${this.subscribedTokens.size} tokens in LTP mode:`, {
            tokens: Array.from(this.subscribedTokens.keys()),
        });
    }

    /**
     * Parse binary tick message
     */
    private handleMessage(data: WebSocket.RawData): void {
        if (typeof data === 'string') {
            if (data === 'pong') return;
            try {
                const parsed = JSON.parse(data);
                tradingCronLogger.debug('[AngelStream] Text message received:', parsed);
            } catch {
                // Ignore raw text
            }
            return;
        }

        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (buf.length < 2) return;

        const mode = buf.readInt8(0);

        // Mode 1: LTP packet (47 bytes)
        if (mode === 1 && buf.length >= 47) {
            try {
                const exchangeType = buf.readInt8(1);
                const token = buf.subarray(2, 27).toString('utf-8').replace(/\0/g, '').trim();
                const sequenceNumber = buf.readBigInt64LE(27).toString();
                const exchangeTimestamp = Number(buf.readBigInt64LE(35));
                const rawPrice = buf.readInt32LE(43);
                const ltp = rawPrice / 100; // paise to rupees

                const tick: AngelStreamTick = {
                    token,
                    exchangeType,
                    ltp,
                    timestamp: exchangeTimestamp > 0 ? exchangeTimestamp : Date.now(),
                    sequenceNumber,
                };

                AngelStreamService.latestPrices.set(token, { ltp, timestamp: tick.timestamp });
                LiveCandleBuilder.onTick(token, ltp, tick.timestamp);
                this.emitter.emit('tick', tick);
            } catch (err: any) {
                tradingCronLogger.debug(`[AngelStream] Failed to parse LTP packet: ${err.message}`);
            }
        }
    }

    /**
     * Start periodic ping and watchdog
     */
    private startHeartbeat(): void {
        this.stopHeartbeat();

        this.pingTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send('ping');
            }
        }, AngelStreamService.PING_INTERVAL_MS);

        this.watchdogTimer = setInterval(() => {
            const elapsed = Date.now() - this.lastMessageTime;
            if (elapsed > AngelStreamService.WATCHDOG_INTERVAL_MS) {
                tradingCronLogger.warn(`[AngelStream] ⚠️ Watchdog timeout: no message in ${Math.round(elapsed / 1000)}s — reconnecting...`);
                if (this.ws) {
                    try { this.ws.terminate(); } catch {}
                }
            }
        }, 5000);
    }

    private stopHeartbeat(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    }

    private cleanup(): void {
        this.stopHeartbeat();
        this.isConnecting = false;
        this.ws = null;
    }

    private scheduleReconnect(isRateLimited: boolean = false): void {
        if (this.isManualClose || this.reconnectTimer) return;

        this.reconnectAttempts++;
        const isCurrentlyRateLimited = isRateLimited || (Date.now() - this.lastRateLimitTime < AngelStreamService.RATE_LIMIT_COOLDOWN_MS);
        
        let delayMs: number;
        if (isCurrentlyRateLimited) {
            const elapsed = Date.now() - this.lastRateLimitTime;
            const remaining = Math.max(15000, AngelStreamService.RATE_LIMIT_COOLDOWN_MS - elapsed);
            delayMs = remaining;
        } else {
            delayMs = Math.min(3000 * Math.pow(1.5, Math.min(this.reconnectAttempts, 5)), 30000);
        }

        tradingCronLogger.info(`[AngelStream] Reconnect scheduled in ${(delayMs / 1000).toFixed(1)}s (attempt #${this.reconnectAttempts}${isCurrentlyRateLimited ? ', rate-limited' : ''})...`);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            await this.connect().catch(() => {});
        }, delayMs);
    }

    public isConnected(): boolean {
        return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
    }

    public disconnect(): void {
        this.isManualClose = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.cleanup();
        if (this.ws) {
            try { this.ws.close(); } catch {}
            this.ws = null;
        }
        tradingCronLogger.info('[AngelStream] Disconnected.');
    }
}
