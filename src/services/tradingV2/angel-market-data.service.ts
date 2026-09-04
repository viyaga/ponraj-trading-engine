import crypto from 'crypto';
import { Candle } from './type';
import { tradingCronLogger } from './logger';
import env from '../../config/env';

// Angel One Index Symbol Tokens
const ANGEL_TOKENS: Record<string, string> = {
    'NIFTY 50': '99926000',
    'NIFTY': '99926000',
    'BANKNIFTY': '99926009',
    'NIFTY BANK': '99926009',
};

export class AngelMarketDataService {
    private static jwtToken: string | null = null;
    private static tokenExpiry: number = 0;
    private static loginPromise: Promise<string | null> | null = null;

    // ─── Candle Cache ─────────────────────────────────────────────────────────
    // Key: "${symbolToken}:${interval}"
    // Stores COMPLETED candles permanently — only invalidated when a new candle
    // boundary is crossed (i.e. a new 15m or 1H candle has formed).
    private static candleCache = new Map<string, {
        candles:             Candle[];   // all completed candles (sorted ascending)
        lastCandleBoundary: number;     // timestamp (ms) of the candle period we last updated for
    }>();

    // Candle period lengths in ms (used for boundary detection)
    private static readonly FIFTEEN_MIN_MS = 15 * 60 * 1000;
    private static readonly ONE_HOUR_MS    = 60 * 60 * 1000;

    // Bootstrap lookback: how many calendar days to fetch on the very first load
    private static readonly BOOTSTRAP_DAYS_15M =  2;  // ~50 candles, need 15
    private static readonly BOOTSTRAP_DAYS_1H  =  5;  // ~35 candles, need 12

    // Incremental lookback: how many candle periods to re-fetch when a new candle forms
    private static readonly INCREMENTAL_PERIODS_15M = 3; // fetch last 3 × 15m = 45 min window
    private static readonly INCREMENTAL_PERIODS_1H  = 3; // fetch last 3 × 1h  = 3h window

    /**
     * Clear Angel One candle cache manually if needed
     */
    static clearCache(): void {
        this.candleCache.clear();
        tradingCronLogger.debug('[AngelMarketDataService] Candle cache cleared.');
    }

    /**
     * Returns the start timestamp (ms) of the candle period that contains `nowMs`.
     * e.g. for 15m candles at 14:47 IST → returns timestamp of the 14:45 candle.
     */
    private static candleBoundary(nowMs: number, periodMs: number): number {
        return Math.floor(nowMs / periodMs) * periodMs;
    }

    /**
     * Parse raw Angel One candle array into sorted Candle objects.
     */
    private static parseCandles(raw: any[][]): Candle[] {
        return raw
            .map((c: any[]) => ({
                timestamp: new Date(c[0]).getTime(),
                open:   Number(c[1]),
                high:   Number(c[2]),
                low:    Number(c[3]),
                close:  Number(c[4]),
                volume: Number(c[5] ?? 0),
            }))
            .sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Merge new candles into an existing array, deduplicating by timestamp.
     * Returns the merged array sorted ascending.
     */
    private static mergeCandles(existing: Candle[], incoming: Candle[]): Candle[] {
        const byTs = new Map<number, Candle>();
        for (const c of existing) byTs.set(c.timestamp, c);
        for (const c of incoming) byTs.set(c.timestamp, c); // incoming wins (fresher close)
        return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Generate 6-digit TOTP code natively using Node.js crypto module
     */
    private static generateTOTP(secret: string): string {
        const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = '';
        const cleanSecret = secret.replace(/=/g, '').toUpperCase().replace(/\s+/g, '');
        for (let i = 0; i < cleanSecret.length; i++) {
            const val = base32chars.indexOf(cleanSecret.charAt(i));
            if (val >= 0) bits += val.toString(2).padStart(5, '0');
        }
        const bytes = new Uint8Array(Math.floor(bits.length / 8));
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(bits.substring(i * 8, i * 8 + 8), 2);
        }

        const epoch = Math.floor(Date.now() / 1000 / 30);
        const msg = Buffer.alloc(8);
        msg.writeUInt32BE(0, 0);
        msg.writeUInt32BE(epoch, 4);

        const hmac = crypto.createHmac('sha1', Buffer.from(bytes));
        hmac.update(msg);
        const digest = hmac.digest();

        const offset = digest[digest.length - 1] & 0x0f;
        const code =
            ((digest[offset] & 0x7f) << 24) |
            ((digest[offset + 1] & 0xff) << 16) |
            ((digest[offset + 2] & 0xff) << 8) |
            (digest[offset + 3] & 0xff);

        return String(code % 1000000).padStart(6, '0');
    }

    /**
     * Auto-authenticate with Angel One SmartAPI using TOTP & password
     */
    private static async autoLogin(apiKey: string): Promise<string | null> {
        const clientCode = env.angelOneClientCode || process.env.ANGEL_ONE_CLIENT_CODE;
        const password   = env.angelOnePassword || process.env.ANGEL_ONE_PASSWORD;
        const totpKey    = env.angelOneTotpKey || process.env.ANGEL_ONE_TOTP_KEY;

        if (!clientCode || !password || !totpKey) {
            tradingCronLogger.warn('[AngelMarketDataService] Missing credentials for auto-login:', {
                hasClientCode: Boolean(clientCode),
                hasPassword: Boolean(password),
                hasTotpKey: Boolean(totpKey),
                hasApiKey: Boolean(apiKey),
            });
            return null;
        }

        try {
            tradingCronLogger.info(`[AngelMarketDataService] ➔ Attempting TOTP auto-login for client: ${clientCode.slice(0, 3)}***`, {
                clientCodeMasked: `${clientCode.slice(0, 3)}***`,
                apiKeyMasked: `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`,
            });
            const startTime = Date.now();
            const totp = this.generateTOTP(totpKey);
            const response = await fetch(
                'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'X-UserType': 'USER',
                        'X-SourceID': 'WEB',
                        'X-ClientLocalIP': '127.0.0.1',
                        'X-ClientPublicIP': '127.0.0.1',
                        'X-MACAddress': 'FE:80:00:00:00:00',
                        'X-PrivateKey': apiKey,
                    },
                    body: JSON.stringify({
                        clientcode: clientCode,
                        password: password,
                        totp: totp,
                    }),
                }
            );

            const duration = Date.now() - startTime;
            const text = await response.text();

            let json: any;
            try {
                json = JSON.parse(text);
            } catch (parseErr: any) {
                tradingCronLogger.error(`[AngelMarketDataService] ✖ Auto-login raw response failed to parse as JSON (${duration}ms): ${text.slice(0, 200)}`, {
                    status: response.status,
                    statusText: response.statusText,
                    rawBody: text,
                });
                return null;
            }

            tradingCronLogger.debug(`[AngelMarketDataService] Auto-login response (${duration}ms):`, {
                status: response.status,
                apiStatus: json?.status,
                message: json?.message,
                errorCode: json?.errorCode,
                hasJwt: Boolean(json?.data?.jwtToken),
                feedToken: json?.data?.feedToken ? 'Present' : 'None',
            });

            if (json?.status === true && json?.data?.jwtToken) {
                this.jwtToken = json.data.jwtToken;
                // Token valid for 20 hours
                this.tokenExpiry = Date.now() + 20 * 60 * 60 * 1000;
                tradingCronLogger.info(`[AngelMarketDataService] ✔ Angel One TOTP Auto-Login Successful (${duration}ms)! Token expires in 20h.`);
                return this.jwtToken;
            } else {
                tradingCronLogger.warn(`[AngelMarketDataService] ✖ Auto-login rejected (${duration}ms):`, { response: json });
                return null;
            }
        } catch (err: any) {
            tradingCronLogger.error(`[AngelMarketDataService] ✖ Auto-login network exception: ${err.message}`, { error: err });
            return null;
        }
    }

    /**
     * Get valid JWT token (auto-refreshes if expired, concurrency-safe)
     */
    private static async getValidJwtToken(apiKey: string): Promise<string | null> {
        if (this.jwtToken && Date.now() < this.tokenExpiry) {
            return this.jwtToken;
        }

        if (this.loginPromise) {
            tradingCronLogger.debug('[AngelMarketDataService] Awaiting existing auto-login promise...');
            return await this.loginPromise;
        }

        this.loginPromise = this.autoLogin(apiKey).finally(() => {
            this.loginPromise = null;
        });

        return await this.loginPromise;
    }

    /**
     * Helper to format Date into Angel One's required format in IST (Indian Standard Time): "YYYY-MM-DD HH:mm"
     * Angel One SmartAPI expects IST timestamp strings regardless of server locale / UTC.
     */
    private static formatDate(date: Date): string {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(date);

        const map: Record<string, string> = {};
        for (const p of parts) {
            map[p.type] = p.value;
        }

        return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
    }

    /**
     * Fetch 15-minute candles from Angel One SmartAPI.
     *
     * Cache strategy:
     *   • COLD START  : fetch BOOTSTRAP_DAYS_15M calendar days (~50 candles)
     *   • SAME PERIOD : return cache immediately — 0 API calls
     *   • NEW CANDLE  : fetch last INCREMENTAL_PERIODS_15M × 15m, merge into cache
     */
    static async get15mCandles(indexName: string): Promise<Candle[]> {
        const apiKey = env.angelOneApiKey || process.env.ANGEL_ONE_API_KEY;
        if (!apiKey) {
            tradingCronLogger.debug('[AngelMarketDataService] ANGEL_ONE_API_KEY not configured.');
            return [];
        }

        const symbolToken = ANGEL_TOKENS[indexName.toUpperCase().replace('NSE:', '')] || '99926000';
        const cacheKey    = `${symbolToken}:15minute`;
        const nowMs       = Date.now();
        const boundary    = this.candleBoundary(nowMs, this.FIFTEEN_MIN_MS);

        const cached = this.candleCache.get(cacheKey);

        // ── SAME CANDLE PERIOD: serve from cache instantly ───────────────────
        if (cached && cached.lastCandleBoundary === boundary) {
            tradingCronLogger.debug(
                `[AngelMarketDataService] 15m cache HIT (same period) — ` +
                `${cached.candles.length} candles for ${indexName}, boundary: ${new Date(boundary).toISOString()}`
            );
            return cached.candles;
        }

        const isColdStart   = !cached || cached.candles.length === 0;
        const lookbackDays  = isColdStart ? this.BOOTSTRAP_DAYS_15M : 0;
        const lookbackMs    = isColdStart
            ? lookbackDays * 24 * 60 * 60 * 1000
            : this.INCREMENTAL_PERIODS_15M * this.FIFTEEN_MIN_MS;

        const from = new Date(nowMs - lookbackMs);
        const to   = new Date(nowMs);

        tradingCronLogger.info(
            `[AngelMarketDataService] 15m cache ${isColdStart ? 'COLD START' : 'NEW CANDLE'} — ` +
            `fetching ${isColdStart ? `last ${lookbackDays} days` : `last ${this.INCREMENTAL_PERIODS_15M} periods (${this.INCREMENTAL_PERIODS_15M * 15}m)`} ` +
            `for ${indexName} | prev boundary: ${cached ? new Date(cached.lastCandleBoundary).toISOString() : 'none'} → new: ${new Date(boundary).toISOString()}`
        );

        const body = {
            exchange:    'NSE',
            symboltoken: symbolToken,
            interval:    'FIFTEEN_MINUTE',
            fromdate:    this.formatDate(from),
            todate:      this.formatDate(to),
        };

        // Try up to 2 attempts with backoff if rate-limited
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const token     = await this.getValidJwtToken(apiKey);
                const startTime = Date.now();
                const response  = await fetch(
                    'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept':       'application/json',
                            'X-UserType':   'USER',
                            'X-SourceID':   'WEB',
                            'X-ClientLocalIP':  '127.0.0.1',
                            'X-ClientPublicIP': '127.0.0.1',
                            'X-MACAddress': 'FE:80:00:00:00:00',
                            'X-PrivateKey': apiKey,
                            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                        },
                        body: JSON.stringify(body),
                    }
                );

                const duration = Date.now() - startTime;
                const text     = await response.text();

                let json: any;
                try {
                    json = JSON.parse(text);
                } catch {
                    tradingCronLogger.warn(
                        `[AngelMarketDataService] ⚠️ 15m candles response non-JSON ` +
                        `(HTTP ${response.status}, ${duration}ms, attempt ${attempt}): ${text.slice(0, 120)}`
                    );
                    if (attempt < 2) { await new Promise(r => setTimeout(r, 1000)); continue; }
                    return cached?.candles ?? [];
                }

                if (json?.status === true && Array.isArray(json?.data)) {
                    const incoming = this.parseCandles(json.data);
                    // Filter out the currently-forming candle (boundary = current period start)
                    const completed = incoming.filter(c => c.timestamp < boundary);

                    const merged = isColdStart
                        ? completed
                        : this.mergeCandles(cached!.candles, completed);

                    this.candleCache.set(cacheKey, { candles: merged, lastCandleBoundary: boundary });

                    tradingCronLogger.info(
                        `[AngelMarketDataService] ✔ 15m candles updated for ${indexName} (${duration}ms) | ` +
                        `fetched: ${incoming.length} raw → ${completed.length} completed | ` +
                        `cache total: ${merged.length} candles | ` +
                        `${isColdStart ? 'cold start' : `+${completed.length - (cached?.candles.filter(c => c.timestamp >= boundary - this.FIFTEEN_MIN_MS).length ?? 0)} new`}`
                    );
                    return merged;
                } else {
                    tradingCronLogger.warn(
                        `[AngelMarketDataService] ✖ Angel One non-success for 15m candles ` +
                        `(HTTP ${response.status}, ${duration}ms, attempt ${attempt}): ` +
                        `status=${json?.status}, message="${json?.message ?? 'N/A'}"`
                    );
                    if (attempt < 2) { await new Promise(r => setTimeout(r, 1000)); continue; }
                    return cached?.candles ?? [];
                }
            } catch (err: any) {
                tradingCronLogger.error(`[AngelMarketDataService] ✖ 15m fetch error (attempt ${attempt}): ${err.message}`, { error: err });
                if (attempt < 2) { await new Promise(r => setTimeout(r, 1000)); continue; }
                return cached?.candles ?? [];
            }
        }
        return cached?.candles ?? [];
    }

    /**
     * Fetch 1-hour candles from Angel One SmartAPI for UT Bot.
     *
     * Cache strategy:
     *   • COLD START  : fetch BOOTSTRAP_DAYS_1H calendar days (~35 candles)
     *   • SAME PERIOD : return cache immediately — 0 API calls
     *   • NEW CANDLE  : fetch last INCREMENTAL_PERIODS_1H × 1h, merge into cache
     */
    static async get1hCandles(indexName: string): Promise<Candle[]> {
        const apiKey = env.angelOneApiKey || process.env.ANGEL_ONE_API_KEY;
        if (!apiKey) {
            tradingCronLogger.debug('[AngelMarketDataService] ANGEL_ONE_API_KEY not configured.');
            return [];
        }

        const symbolToken = ANGEL_TOKENS[indexName.toUpperCase().replace('NSE:', '')] || '99926000';
        const cacheKey    = `${symbolToken}:60minute`;
        const nowMs       = Date.now();
        const boundary    = this.candleBoundary(nowMs, this.ONE_HOUR_MS);

        const cached = this.candleCache.get(cacheKey);

        // ── SAME CANDLE PERIOD: serve from cache instantly ───────────────────
        if (cached && cached.lastCandleBoundary === boundary) {
            tradingCronLogger.debug(
                `[AngelMarketDataService] 1h cache HIT (same period) — ` +
                `${cached.candles.length} candles for ${indexName}, boundary: ${new Date(boundary).toISOString()}`
            );
            return cached.candles;
        }

        const isColdStart  = !cached || cached.candles.length === 0;
        const lookbackMs   = isColdStart
            ? this.BOOTSTRAP_DAYS_1H * 24 * 60 * 60 * 1000
            : this.INCREMENTAL_PERIODS_1H * this.ONE_HOUR_MS;

        const from = new Date(nowMs - lookbackMs);
        const to   = new Date(nowMs);

        tradingCronLogger.info(
            `[AngelMarketDataService] 1h cache ${isColdStart ? 'COLD START' : 'NEW CANDLE'} — ` +
            `fetching ${isColdStart ? `last ${this.BOOTSTRAP_DAYS_1H} days` : `last ${this.INCREMENTAL_PERIODS_1H} periods (${this.INCREMENTAL_PERIODS_1H}h)`} ` +
            `for ${indexName} | prev boundary: ${cached ? new Date(cached.lastCandleBoundary).toISOString() : 'none'} → new: ${new Date(boundary).toISOString()}`
        );

        // Small delay to respect Angel One's rate limit after 15m fetch
        if (!isColdStart) await new Promise(r => setTimeout(r, 350));

        const body = {
            exchange:    'NSE',
            symboltoken: symbolToken,
            interval:    'ONE_HOUR',
            fromdate:    this.formatDate(from),
            todate:      this.formatDate(to),
        };

        try {
            const token     = await this.getValidJwtToken(apiKey);
            const startTime = Date.now();
            const response  = await fetch(
                'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept':       'application/json',
                        'X-UserType':   'USER',
                        'X-SourceID':   'WEB',
                        'X-ClientLocalIP':  '127.0.0.1',
                        'X-ClientPublicIP': '127.0.0.1',
                        'X-MACAddress': 'FE:80:00:00:00:00',
                        'X-PrivateKey': apiKey,
                        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                    },
                    body: JSON.stringify(body),
                }
            );

            const duration = Date.now() - startTime;
            const text     = await response.text();

            let json: any;
            try {
                json = JSON.parse(text);
            } catch {
                tradingCronLogger.error(
                    `[AngelMarketDataService] ✖ 1h candles non-JSON (HTTP ${response.status}, ${duration}ms): ${text.slice(0, 200)}`
                );
                return cached?.candles ?? [];
            }

            if (json?.status === true && Array.isArray(json?.data)) {
                const incoming  = this.parseCandles(json.data);
                const completed = incoming.filter(c => c.timestamp < boundary);

                const merged = isColdStart
                    ? completed
                    : this.mergeCandles(cached!.candles, completed);

                this.candleCache.set(cacheKey, { candles: merged, lastCandleBoundary: boundary });

                tradingCronLogger.info(
                    `[AngelMarketDataService] ✔ 1h candles updated for ${indexName} (${duration}ms) | ` +
                    `fetched: ${incoming.length} raw → ${completed.length} completed | ` +
                    `cache total: ${merged.length} candles | ` +
                    `${isColdStart ? 'cold start' : `+${completed.length - (cached?.candles.filter(c => c.timestamp >= boundary - this.ONE_HOUR_MS).length ?? 0)} new`}`
                );
                return merged;
            } else {
                tradingCronLogger.warn(
                    `[AngelMarketDataService] ✖ Angel One non-success for 1h candles ` +
                    `(HTTP ${response.status}, ${duration}ms): ` +
                    `status=${json?.status}, message="${json?.message ?? 'N/A'}"`
                );
                return cached?.candles ?? [];
            }
        } catch (err: any) {
            tradingCronLogger.error(`[AngelMarketDataService] ✖ 1h fetch error: ${err.message}`, { error: err });
            return cached?.candles ?? [];
        }
    }


    /**
     * Fetch live LTP for a batch of NFO option symbols from Angel One's Quote API.
     * @param tokens  Array of { symbolToken, tradingsymbol } for NFO options
     * @returns Map of symbolToken → LTP (₹)
     */
    static async getOptionsLTP(
        tokens: Array<{ symbolToken: string; tradingsymbol: string }>
    ): Promise<Map<string, number>> {
        const result = new Map<string, number>();
        if (!tokens.length) return result;

        const apiKey = env.angelOneApiKey || process.env.ANGEL_ONE_API_KEY;
        if (!apiKey) {
            tradingCronLogger.warn('[AngelMarketDataService] ⚠️  getOptionsLTP: ANGEL_ONE_API_KEY not configured — skipping NFO options LTP fetch. Option LTP filter will have no data.');
            return result;
        }

        const CHUNK_SIZE = 50;
        const totalChunks = Math.ceil(tokens.length / CHUNK_SIZE);

        tradingCronLogger.info(
            `[AngelMarketDataService] getOptionsLTP: fetching LTPs for ${tokens.length} NFO option tokens ` +
            `(${totalChunks} chunk${totalChunks > 1 ? 's' : ''} of ≤${CHUNK_SIZE})`
        );

        try {
            const jwtToken = await this.getValidJwtToken(apiKey);
            tradingCronLogger.debug(
                `[AngelMarketDataService] getOptionsLTP: JWT ${jwtToken ? '✔ present' : '✖ missing (will try unauthenticated)'}`
            );

            for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
                const chunk = tokens.slice(i, i + CHUNK_SIZE);
                const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
                const nfoTokens = chunk.map(t => t.symbolToken);
                const symbolNames = chunk.map(t => t.tradingsymbol);

                tradingCronLogger.debug(
                    `[AngelMarketDataService] getOptionsLTP chunk ${chunkNum}/${totalChunks}: ` +
                    `requesting tokens [${symbolNames.join(', ')}]`
                );

                const startTime = Date.now();
                const response = await fetch(
                    'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'X-UserType': 'USER',
                            'X-SourceID': 'WEB',
                            'X-ClientLocalIP': '127.0.0.1',
                            'X-ClientPublicIP': '127.0.0.1',
                            'X-MACAddress': 'FE:80:00:00:00:00',
                            'X-PrivateKey': apiKey,
                            ...(jwtToken ? { 'Authorization': `Bearer ${jwtToken}` } : {}),
                        },
                        body: JSON.stringify({
                            mode: 'LTP',
                            exchangeTokens: {
                                NFO: nfoTokens,
                            },
                        }),
                    }
                );

                const duration = Date.now() - startTime;
                const text = await response.text();

                tradingCronLogger.debug(
                    `[AngelMarketDataService] getOptionsLTP chunk ${chunkNum}/${totalChunks}: ` +
                    `HTTP ${response.status} in ${duration}ms | raw response: ${text.slice(0, 300)}`
                );

                let json: any;
                try {
                    json = JSON.parse(text);
                } catch {
                    tradingCronLogger.warn(
                        `[AngelMarketDataService] ✖ getOptionsLTP chunk ${chunkNum}/${totalChunks}: ` +
                        `JSON parse failed (${duration}ms) — HTTP ${response.status}. ` +
                        `Raw body: ${text.slice(0, 200)}`
                    );
                    continue;
                }

                if (json?.status === true && Array.isArray(json?.data?.fetched)) {
                    const fetched = json.data.fetched;
                    const tokensPriced = new Set(fetched.map((f: any) => String(f.symbolToken)));
                    const missingTokens = nfoTokens.filter(t => !tokensPriced.has(t));

                    for (const item of fetched) {
                        if (item?.symbolToken && item?.ltp != null) {
                            result.set(String(item.symbolToken), Number(item.ltp));
                            tradingCronLogger.debug(
                                `[AngelMarketDataService]   ↳ ${item.tradingSymbol ?? item.symbolToken}: ₹${Number(item.ltp).toFixed(2)}`
                            );
                        }
                    }

                    tradingCronLogger.info(
                        `[AngelMarketDataService] ✔ getOptionsLTP chunk ${chunkNum}/${totalChunks} (${duration}ms): ` +
                        `${fetched.length}/${chunk.length} prices received` +
                        (missingTokens.length
                            ? ` | ⚠️  Missing tokens: ${missingTokens.join(', ')}`
                            : ' | ✅ All tokens priced')
                    );
                } else {
                    tradingCronLogger.warn(
                        `[AngelMarketDataService] ✖ getOptionsLTP chunk ${chunkNum}/${totalChunks} (${duration}ms): ` +
                        `Angel One returned non-success. HTTP ${response.status}. ` +
                        `status=${json?.status}, message="${json?.message ?? 'N/A'}", ` +
                        `errorcode="${json?.errorcode ?? 'N/A'}". ` +
                        `Full response: ${text.slice(0, 300)}`
                    );
                }

                // Small delay between chunks to stay within rate limits
                if (i + CHUNK_SIZE < tokens.length) {
                    tradingCronLogger.debug(`[AngelMarketDataService] getOptionsLTP: waiting 300ms before next chunk...`);
                    await new Promise(r => setTimeout(r, 300));
                }
            }
        } catch (err: any) {
            tradingCronLogger.error(
                `[AngelMarketDataService] ✖ getOptionsLTP: unexpected error — ${err.message}`,
                { error: err, stack: err.stack }
            );
        }

        tradingCronLogger.info(
            `[AngelMarketDataService] getOptionsLTP complete: ${result.size}/${tokens.length} NFO option LTPs fetched successfully`
        );

        return result;
    }

    /**
     * Fetch spot LTP from Angel One SmartAPI with fallback to cached candle close.
     */
    static async getLTP(indexName: string): Promise<number | null> {
        const apiKey = env.angelOneApiKey || process.env.ANGEL_ONE_API_KEY;
        const symbolToken = ANGEL_TOKENS[indexName.toUpperCase().replace('NSE:', '')] || '99926000';

        if (!apiKey) {
            tradingCronLogger.debug('[AngelMarketDataService] ANGEL_ONE_API_KEY not configured.');
            return null;
        }

        try {
            const token = await this.getValidJwtToken(apiKey);
            const startTime = Date.now();
            const response = await fetch(
                'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'X-UserType': 'USER',
                        'X-SourceID': 'WEB',
                        'X-ClientLocalIP': '127.0.0.1',
                        'X-ClientPublicIP': '127.0.0.1',
                        'X-MACAddress': 'FE:80:00:00:00:00',
                        'X-PrivateKey': apiKey,
                        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                    },
                    body: JSON.stringify({
                        mode: 'LTP',
                        exchangeTokens: {
                            NSE: [symbolToken],
                        },
                    }),
                }
            );

            const duration = Date.now() - startTime;
            const text = await response.text();
            let json: any;
            try {
                json = JSON.parse(text);
            } catch (err) {
                tradingCronLogger.warn(`[AngelMarketDataService] Quote API parse error (${duration}ms): ${text.slice(0, 100)}`);
                return null;
            }

            if (json?.status === true && Array.isArray(json?.data?.fetched)) {
                const item = json.data.fetched.find((f: any) => String(f.symbolToken) === String(symbolToken));
                if (item?.ltp) {
                    const price = Number(item.ltp);
                    tradingCronLogger.info(`[AngelMarketDataService] ✔ Spot LTP fetched from Angel One quote API: ₹${price.toFixed(2)} (${duration}ms)`);
                    return price;
                }
            }

            // Fallback: check last cached 15m candle close
            const cached15m = this.candleCache.get(`${symbolToken}:15minute`);
            if (cached15m?.candles?.length) {
                const lastCandle = cached15m.candles[cached15m.candles.length - 1];
                tradingCronLogger.info(`[AngelMarketDataService] ℹ Using last Angel One 15m candle close as spot price fallback: ₹${lastCandle.close.toFixed(2)}`);
                return lastCandle.close;
            }

            return null;
        } catch (err: any) {
            tradingCronLogger.error(`[AngelMarketDataService] ✖ Failed to fetch LTP from Angel One: ${err.message}`, { error: err });
            return null;
        }
    }
}

// Export token map so OptionSelectorService can resolve Angel One tokens for NFO instruments
export { ANGEL_TOKENS };
