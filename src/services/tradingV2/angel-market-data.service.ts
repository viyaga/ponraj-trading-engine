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

    // In-memory Candle Cache
    private static candleCache = new Map<string, { candles: Candle[]; timestamp: number }>();
    private static CACHE_TTL_MS = 60 * 1000; // 60 seconds cache TTL

    /**
     * Clear Angel One candle cache manually if needed
     */
    static clearCache(): void {
        this.candleCache.clear();
        tradingCronLogger.debug('[AngelMarketDataService] Candle cache cleared.');
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
     * Lookback: 10 calendar days (~250 15m candles) to guarantee sufficient completed trading candles.
     */
    static async get15mCandles(indexName: string): Promise<Candle[]> {
        const apiKey = env.angelOneApiKey || process.env.ANGEL_ONE_API_KEY;
        if (!apiKey) {
            tradingCronLogger.debug('[AngelMarketDataService] ANGEL_ONE_API_KEY not configured.');
            return [];
        }

        const symbolToken = ANGEL_TOKENS[indexName.toUpperCase().replace('NSE:', '')] || '99926000';
        const cacheKey = `${symbolToken}:15minute`;

        // 1. Check in-memory cache (valid for 10 minutes)
        const cached = this.candleCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL_MS) && cached.candles.length >= 15) {
            tradingCronLogger.debug(`[AngelMarketDataService] Returning ${cached.candles.length} cached 15m candles for ${indexName}`);
            return cached.candles;
        }

        const token = await this.getValidJwtToken(apiKey);
        const now = new Date();
        const from = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days lookback

        const body = {
            exchange: 'NSE',
            symboltoken: symbolToken,
            interval: 'FIFTEEN_MINUTE',
            fromdate: this.formatDate(from),
            todate: this.formatDate(now),
        };

        try {
            tradingCronLogger.info(`[AngelMarketDataService] ➔ Fetching 15m candles from Angel One for ${indexName} (token: ${symbolToken})`, {
                hasToken: Boolean(token),
                tokenPrefix: token ? `${token.slice(0, 10)}...` : 'None',
                requestBody: body,
            });
            const startTime = Date.now();
            const response = await fetch(
                'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData',
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
                    body: JSON.stringify(body),
                }
            );

            const duration = Date.now() - startTime;
            const text = await response.text();

            let json: any;
            try {
                json = JSON.parse(text);
            } catch (parseErr: any) {
                tradingCronLogger.error(`[AngelMarketDataService] ✖ Failed to parse 15m candles response as JSON (${duration}ms): ${text.slice(0, 200)}`, {
                    status: response.status,
                    rawBody: text,
                });
                return cached?.candles ?? [];
            }

            if (json?.status === true && Array.isArray(json?.data)) {
                const candles: Candle[] = json.data.map((c: any[]) => ({
                    timestamp: new Date(c[0]).getTime(),
                    open: Number(c[1]),
                    high: Number(c[2]),
                    low: Number(c[3]),
                    close: Number(c[4]),
                    volume: Number(c[5] ?? 0),
                })).sort((a: Candle, b: Candle) => a.timestamp - b.timestamp);

                // Save to in-memory cache
                this.candleCache.set(cacheKey, { candles, timestamp: Date.now() });

                tradingCronLogger.info(`[AngelMarketDataService] ✔ Successfully fetched & cached ${candles.length} 15m candles from Angel One for ${indexName} (${duration}ms)`);
                return candles;
            } else {
                tradingCronLogger.warn(`[AngelMarketDataService] ✖ Angel One returned non-success for 15m candles (${duration}ms):`, {
                    status: response.status,
                    response: json,
                });
                return cached?.candles ?? [];
            }
        } catch (err: any) {
            tradingCronLogger.error(`[AngelMarketDataService] ✖ Failed to fetch Angel One 15m candles: ${err.message}`, { error: err });
            return cached?.candles ?? [];
        }
    }

    /**
     * Fetch 1-hour (60-minute) candles from Angel One SmartAPI for UT Bot.
     * Lookback: 30 calendar days (~180 1h candles) to guarantee sufficient completed trading candles.
     */
    static async get1hCandles(indexName: string): Promise<Candle[]> {
        const apiKey = env.angelOneApiKey || process.env.ANGEL_ONE_API_KEY;
        if (!apiKey) {
            tradingCronLogger.debug('[AngelMarketDataService] ANGEL_ONE_API_KEY not configured.');
            return [];
        }

        const symbolToken = ANGEL_TOKENS[indexName.toUpperCase().replace('NSE:', '')] || '99926000';
        const cacheKey = `${symbolToken}:60minute`;

        // 1. Check in-memory cache (valid for 10 minutes)
        const cached = this.candleCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL_MS) && cached.candles.length >= 12) {
            tradingCronLogger.debug(`[AngelMarketDataService] Returning ${cached.candles.length} cached 1h candles for ${indexName}`);
            return cached.candles;
        }

        // Small 350ms delay to prevent exceeding Angel One's 3 requests/sec rate limit when called right after 15m
        await new Promise((resolve) => setTimeout(resolve, 350));

        const token = await this.getValidJwtToken(apiKey);
        const now = new Date();
        const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days lookback

        const body = {
            exchange: 'NSE',
            symboltoken: symbolToken,
            interval: 'ONE_HOUR',
            fromdate: this.formatDate(from),
            todate: this.formatDate(now),
        };

        try {
            tradingCronLogger.info(`[AngelMarketDataService] ➔ Fetching 1h candles from Angel One for ${indexName} (token: ${symbolToken})`, {
                hasToken: Boolean(token),
                tokenPrefix: token ? `${token.slice(0, 10)}...` : 'None',
                requestBody: body,
            });
            const startTime = Date.now();
            const response = await fetch(
                'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData',
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
                    body: JSON.stringify(body),
                }
            );

            const duration = Date.now() - startTime;
            const text = await response.text();

            let json: any;
            try {
                json = JSON.parse(text);
            } catch (parseErr: any) {
                tradingCronLogger.error(`[AngelMarketDataService] ✖ Failed to parse 1h candles response as JSON (${duration}ms): ${text.slice(0, 200)}`, {
                    status: response.status,
                    rawBody: text,
                });
                return cached?.candles ?? [];
            }

            if (json?.status === true && Array.isArray(json?.data)) {
                const candles: Candle[] = json.data.map((c: any[]) => ({
                    timestamp: new Date(c[0]).getTime(),
                    open: Number(c[1]),
                    high: Number(c[2]),
                    low: Number(c[3]),
                    close: Number(c[4]),
                    volume: Number(c[5] ?? 0),
                })).sort((a: Candle, b: Candle) => a.timestamp - b.timestamp);

                // Save to in-memory cache
                this.candleCache.set(cacheKey, { candles, timestamp: Date.now() });

                tradingCronLogger.info(`[AngelMarketDataService] ✔ Successfully fetched & cached ${candles.length} 1h candles from Angel One for ${indexName} (${duration}ms)`);
                return candles;
            } else {
                tradingCronLogger.warn(`[AngelMarketDataService] ✖ Angel One returned non-success for 1h candles (${duration}ms):`, {
                    status: response.status,
                    response: json,
                });
                return cached?.candles ?? [];
            }
        } catch (err: any) {
            tradingCronLogger.error(`[AngelMarketDataService] ✖ Failed to fetch Angel One 1h candles: ${err.message}`, { error: err });
            return cached?.candles ?? [];
        }
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
