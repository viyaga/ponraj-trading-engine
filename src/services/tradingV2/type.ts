// =============================================================================
// Zerodha Kite API — Type Definitions
// NIFTY 50 Options Trading Engine
// =============================================================================

/* ───────────────────────────────────────
   Bot Configuration (per trading bot)
──────────────────────────────────────── */

export interface ConfigType {
    id: string;
    USER_ID: string;

    // Kite credentials (per user account)
    API_KEY: string;
    ACCESS_TOKEN: string;

    // Instrument settings
    INDEX: 'NIFTY' | 'BANKNIFTY';
    EXCHANGE: 'NFO';
    LOT_SIZE: number;           // 75 for NIFTY, 15 for BANKNIFTY
    NUMBER_OF_LOTS: number;
    EXPIRY_TYPE: 'weekly' | 'monthly';

    // Timeframe (fixed to 15minute)
    TIMEFRAME: string;              // default: "15minute"

    // ATR-14 Strategy Parameters (3:00 PM - 3:15 PM)
    ATR_PERIOD: number;             // default: 14
    TARGET_PROFIT_PCT: number;      // legacy: used as fallback if per-strategy TP not set
    STOP_LOSS_PCT: number;          // legacy: used as fallback if per-strategy SL not set
    MAX_LOSS_PER_DAY: number;       // max daily loss in ₹ (default: 2500)

    // Per-Strategy TP / SL overrides
    ATR_STRATEGY_TP_PCT:     number; // ATR 15m strategy TP% (default: 10)
    ATR_STRATEGY_SL_PCT:     number; // ATR 15m strategy SL% (default: 5)
    UT_BOT_STRATEGY_TP_PCT:  number; // UT Bot 1H strategy TP% (default: 20)
    UT_BOT_STRATEGY_SL_PCT:  number; // UT Bot 1H strategy SL% (default: 10)

    // Option LTP Range Filter — only trade options priced within this window
    OPTION_MIN_PREMIUM: number;     // default: 120 (₹)
    OPTION_MAX_PREMIUM: number;     // default: 150 (₹)

    // UT Bot Alerts Strategy (1H Candle - 1st Priority)
    UT_BOT_ENABLED?: boolean;       // default: true
    UT_BOT_KEY_VALUE?: number;      // default: 1.0
    UT_BOT_ATR_PERIOD?: number;     // default: 10
    UT_BOT_USE_HEIKIN_ASHI?: boolean;// default: false

    // Trailing SL
    IS_TRAILING_SL_ENABLED: boolean;

    // Order settings
    ORDER_TYPE: 'MARKET' | 'LIMIT';
    PRODUCT: 'MIS' | 'NRML';       // MIS = intraday (recommended)

    // Risk filters
    MAX_CONCURRENT_TRADES: number;  // default: 1
    DAILY_LOSS_LIMIT: number;       // % of capital (default: 10)
    IS_WEEKEND_SAFETY_ENABLED: boolean;

    // Engine flags
    DRY_RUN: boolean;               // true = log only, no real orders
}

/* ───────────────────────────────────────
   Candle / Market Data
──────────────────────────────────────── */

export interface Candle {
    timestamp: number;  // Unix milliseconds
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface TargetCandle extends Candle {
    color: 'green' | 'red';
}

/* ───────────────────────────────────────
   Kite Instrument
──────────────────────────────────────── */

export interface KiteInstrument {
    instrument_token: number;
    exchange_token: number;
    tradingsymbol: string;
    name: string;
    expiry: string;             // 'YYYY-MM-DD'
    strike: number;
    tick_size: number;
    lot_size: number;
    instrument_type: 'CE' | 'PE' | 'EQ' | 'FUT';
    segment: string;
    exchange: string;
}

/* ───────────────────────────────────────
   Kite Order
──────────────────────────────────────── */

export type KiteOrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
export type KiteTransactionType = 'BUY' | 'SELL';
export type KiteProduct = 'MIS' | 'NRML' | 'CNC';
export type KiteValidity = 'DAY' | 'IOC';
export type KiteVariety = 'regular' | 'amo' | 'co' | 'iceberg' | 'auction';
export type KiteOrderStatus =
    | 'COMPLETE'
    | 'REJECTED'
    | 'CANCELLED'
    | 'OPEN'
    | 'TRIGGER PENDING'
    | 'OPEN PENDING'
    | 'VALIDATION PENDING'
    | 'PUT ORDER REQ RECEIVED'
    | 'MODIFY VALIDATION PENDING'
    | 'MODIFY COMPLETE';

export interface KiteOrder {
    order_id: string;
    exchange_order_id: string;
    parent_order_id: string | null;
    status: KiteOrderStatus;
    status_message: string | null;
    order_timestamp: string;
    exchange_update_timestamp: string;
    exchange_timestamp: string;

    variety: KiteVariety;
    exchange: string;
    tradingsymbol: string;
    instrument_token: number;

    order_type: KiteOrderType;
    transaction_type: KiteTransactionType;
    validity: KiteValidity;
    product: KiteProduct;

    quantity: number;
    pending_quantity: number;
    filled_quantity: number;
    disclosed_quantity: number;
    market_protection: number;

    price: number;
    trigger_price: number;
    average_price: number;

    tag: string | null;
    meta: Record<string, any>;
}

export interface KitePlaceOrderParams {
    exchange: string;               // 'NFO', 'NSE'
    tradingsymbol: string;          // e.g. 'NIFTY24JAN25000CE'
    transaction_type: KiteTransactionType;
    quantity: number;
    order_type: KiteOrderType;
    product: KiteProduct;
    price?: number;                 // required for LIMIT orders
    trigger_price?: number;         // required for SL / SL-M orders
    validity?: KiteValidity;
    disclosed_quantity?: number;
    tag?: string;                   // bot ID for easy identification
    variety?: KiteVariety;
}

/* ───────────────────────────────────────
   Kite Quote / Tick
──────────────────────────────────────── */

export interface KiteQuote {
    instrument_token: number;
    timestamp: string;
    last_price: number;
    last_quantity: number;
    last_trade_time: string;
    average_price: number;
    volume: number;
    buy_quantity: number;
    sell_quantity: number;
    ohlc: {
        open: number;
        high: number;
        low: number;
        close: number;
    };
    change: number;
    oi: number;
    oi_day_high: number;
    oi_day_low: number;
}

export interface KiteTick {
    instrument_token: number;
    last_price: number;
    volume: number;
    ohlc: {
        open: number;
        high: number;
        low: number;
        close: number;
    };
    change: number;
    timestamp?: Date;
    exchange_timestamp?: Date;
}

/* ───────────────────────────────────────
   Kite Position
──────────────────────────────────────── */

export interface KitePosition {
    tradingsymbol: string;
    exchange: string;
    instrument_token: number;
    product: KiteProduct;
    quantity: number;
    overnight_quantity: number;
    multiplier: number;
    average_price: number;
    close_price: number;
    last_price: number;
    value: number;
    pnl: number;
    m2m: number;
    unrealised: number;
    realised: number;
    buy_quantity: number;
    buy_price: number;
    buy_value: number;
    buy_m2m: number;
    sell_quantity: number;
    sell_price: number;
    sell_value: number;
    sell_m2m: number;
    day_buy_quantity: number;
    day_buy_price: number;
    day_buy_value: number;
    day_sell_quantity: number;
    day_sell_price: number;
    day_sell_value: number;
}

/* ───────────────────────────────────────
   Strategy Signal
──────────────────────────────────────── */

export type TradingSignal = 'BULL' | 'BEAR' | 'NONE';
export type OptionType = 'CE' | 'PE';

export interface ATRSignalResult {
    signal: TradingSignal;
    optionType: OptionType | null;
    atr14: number;
    tr: number;
    score: number;              // 0–100 composite confidence score
    reasons: string[];          // human-readable reasons for the signal
    skipReasons: string[];      // reasons the signal was filtered
}

export interface UTBotSignalResult {
    signal: TradingSignal;
    optionType: OptionType | null;
    atr: number;
    trailingStop: number;
    score: number;
    reasons: string[];
    skipReasons: string[];
}

/* ───────────────────────────────────────
   Active Bot (fetched from backend)
──────────────────────────────────────── */

export interface ActiveSubscribedBot {
    id: string;
    USER_ID: string;

    // Kite credentials
    API_KEY: string;
    ACCESS_TOKEN: string;

    // Instrument
    INDEX: 'NIFTY' | 'BANKNIFTY';
    LOT_SIZE: number;
    NUMBER_OF_LOTS: number;
    EXPIRY_TYPE: 'weekly' | 'monthly';

    // Strategy params
    ATR_PERIOD: number;
    TARGET_PROFIT_PCT: number;
    STOP_LOSS_PCT: number;
    MAX_LOSS_PER_DAY: number;

    // Per-Strategy TP / SL overrides
    ATR_STRATEGY_TP_PCT:     number;
    ATR_STRATEGY_SL_PCT:     number;
    UT_BOT_STRATEGY_TP_PCT:  number;
    UT_BOT_STRATEGY_SL_PCT:  number;

    // Option LTP Range Filter
    OPTION_MIN_PREMIUM: number;
    OPTION_MAX_PREMIUM: number;

    // UT Bot Alerts Strategy
    UT_BOT_ENABLED?: boolean;
    UT_BOT_KEY_VALUE?: number;
    UT_BOT_ATR_PERIOD?: number;
    UT_BOT_USE_HEIKIN_ASHI?: boolean;

    IS_TRAILING_SL_ENABLED: boolean;
    ORDER_TYPE: 'MARKET' | 'LIMIT';
    PRODUCT: 'MIS' | 'NRML';
    MAX_CONCURRENT_TRADES: number;
    DAILY_LOSS_LIMIT: number;
    IS_WEEKEND_SAFETY_ENABLED: boolean;
    DRY_RUN: boolean;
}

/* ───────────────────────────────────────
   Order Side (retained for state model compatibility)
──────────────────────────────────────── */

export type OrderSide = 'buy' | 'sell';
export type OrderState = 'open' | 'closed' | 'cancelled' | 'pending';