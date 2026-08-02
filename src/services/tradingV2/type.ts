// 13.201.79.47,

export interface ConfigType {
    id: string,
    USER_ID: string,
    API_KEY: string,
    SECRET_KEY: string,
    BASE_URL: string,
    RUN_MINUTES: number[],
    PRODUCT_ID: number,
    SYMBOL: string,
    LOT_SIZE: number,
    PRICE_DECIMAL_PLACES: number,
    TIMEFRAME: string,
    CONFIRMATION_TIMEFRAME: string,
    STRUCTURE_TIMEFRAME: string,
    LEVERAGE: number,
    INITIAL_BASE_QUANTITY?: number,
    MAX_QUANTITY?: number,
    MIN_TRADE_SIZE: number,
    MAX_TRADE_SIZE: number,
    DAILY_LOSS_LIMIT: number,
    MAX_CONCURRENT_TRADES: number,
    CAPITAL_AMOUNT: number,
    TRADING_MODE: "conservative" | "balanced" | "aggressive" | "meme"
    SL_TRIGGER_BUFFER_PERCENT: number,
    SL_LIMIT_BUFFER_PERCENT: number;
    TP_TRIGGER_BUFFER_PERCENT: number;
    TP_LIMIT_BUFFER_PERCENT: number;
    MAX_ALLOWED_PRICE_MOVEMENT_PERCENT: number;
    DRY_RUN: boolean;
    IS_TESTING: boolean;
    IS_TRAILING_SL_ENABLED?: boolean;
    SL_SELECTION_MODE?: "active_tf" | "structure" | "tightest" | "lookback_3" | "doji_filter" | "fixed_atr";
    TP_SELECTION_MODE?: "dynamic_atr" | "fixed_atr" | "fixed_rr";
    SL_ATR_MULTIPLIER?: number;
    TP_ATR_MULTIPLIER?: number;
    LOOKBACK?: number;
    CONFIRMATION_LOOKBACK?: number;
    MIN_RR?: number;
    MIN_RR_ENFORCEMENT_MODE?: "tp" | "sl";
    MIN_SL_SAFETY_BUFFER_PERCENT?: number;
    MIN_TP_PRICE_MOVEMENT_PERCENT?: number;
    MAX_TP_PRICE_MOVEMENT_PERCENT?: number;
    MAX_SL_PRICE_MOVEMENT_PERCENT?: number;
    IS_CANDLE_LIMIT_EXIT_ENABLED?: boolean;
    MAX_HOLDING_CANDLES_MAP?: Record<string, number>;
    ESTIMATED_FEE_PERCENT: number;
    IS_WEEKEND_SAFETY_ENABLED: boolean;
    EXCHANGE?: string;
    MIN_ENTRY_SCORE?: number;
    MIN_CONFIRMATION_SCORE?: number;
    MIN_STRUCTURE_SCORE?: number;
    MIN_FINAL_SCORE?: number;
    IS_MOMENTUM_INVALIDATION_EXIT_ENABLED?: boolean;
    MOMENTUM_INVALIDATION_SCORE_THRESHOLD?: number;
    MOMENTUM_INVALIDATION_CONFIRMATION_THRESHOLD?: number;
    MOMENTUM_INVALIDATION_STRUCTURE_THRESHOLD?: number;
    MOMENTUM_INVALIDATION_CONSECUTIVE_CYCLES?: number;
    IS_TP_REDUCTION_ENABLED?: boolean;
}

export type MarketEvaluationMode = "structure" | "confirmation" | "entry";

export interface InternalChopConfig {
    ATR_PERIOD: number;
    ADX_PERIOD: number;

    ADX_WEAK_THRESHOLD: number;
    LOOKBACK: number;
    CONFIRMATION_LOOKBACK?: number;

    SMALL_BODY_PERCENT_THRESHOLD: number;
    SMALL_BODY_MIN_COUNT: number;

    MIN_REQUIRED_CANDLES: number;
    PROBABILITY_THRESHOLD: number;
};

/* ───────────────────────
   Common Enums & Aliases
─────────────────────── */

export type OrderSide = "buy" | "sell";
export type OrderState = "open" | "closed" | "cancelled" | "pending";
export type OrderType = "limit_order" | "market_order";
export type StopOrderType = "stop_loss_order" | "take_profit_order" | null;
export type TimeInForce = "gtc";

/* ───────────────────────
   Market Data
─────────────────────── */

export interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface TargetCandle extends Candle {
    color: "green" | "red";
}

export interface TickerData {
    // identifiers
    symbol: string;
    product_id: number;
    description: string;
    contract_type: "perpetual_futures" | string;

    // prices (numbers in payload)
    open: number;
    high: number;
    low: number;
    close: number;
    mark_price: string; // comes as string
    spot_price: string;

    // bids & asks (duplicated both top-level and quotes)
    best_ask: string;
    best_bid: string;

    // volume & size
    volume: number;
    size: number;
    turnover: number;
    turnover_usd: number;
    turnover_symbol: string;

    // open interest
    oi: string;
    oi_contracts: string;
    oi_value: string;
    oi_value_usd: string;
    oi_value_symbol: string;
    oi_change_usd_6h: string;

    // funding & leverage
    funding_rate: string;
    leverage: number;
    contract_value: string;

    // market status
    product_trading_status: "operational" | string;
    sort_priority: number;
    tags: string[];

    // time
    timestamp: number; // microseconds
    time: string; // ISO string

    // price band
    price_band: {
        lower_limit: string;
        upper_limit: string;
    };

    // mark & changes
    mark_basis: string;
    mark_change_24h: string;
    ltp_change_24h: string;

    // tick
    tick_size: string;

    // asset
    underlying_asset_symbol: string;

    // quotes block
    quotes: {
        best_ask: string;
        best_bid: string;
        ask_size: string;
        bid_size: string;

        ask_iv: string | null;
        bid_iv: string | null;
        mark_iv: string;
        impact_mid_price: string | null;
    };

    // optional / nullable
    greeks: null | Record<string, unknown>;
}

/* ───────────────────────
   Delta Exchange – Product
─────────────────────── */

export interface DeltaProduct {
    id: number;
    symbol: string;
    contract_type: string;
    contract_value: string;
    tick_size: string;
}

/* ───────────────────────
   Delta Exchange – Metadata
─────────────────────── */

export interface OrderMetaData {
    pnl?: string;
    roe?: string;
    cashflow?: string;
    entry_price?: string;
    avg_exit_price?: string;
    trigger_price?: string;
    source?: string;
    [key: string]: any;
}

/* ───────────────────────
   Delta Exchange – Order
─────────────────────── */

export interface OrderDetails {
    id: string;
    product_id: number;
    product_symbol: string;

    side: OrderSide;
    size: number;

    order_type?: OrderType;
    state?: OrderState;

    limit_price: string | null;
    average_fill_price: string | null;

    stop_price?: string | null;
    stop_order_type?: StopOrderType;
    stop_trigger_method?: "last_traded_price" | null;

    reduce_only?: boolean;
    bracket_order?: boolean | null;

    unfilled_size?: number;
    time_in_force?: TimeInForce;

    commission?: string;
    paid_commission?: string;

    client_order_id: string | null;
    cancellation_reason?: string | null;

    created_at?: string;
    updated_at?: string;

    meta_data?: OrderMetaData;
    product?: DeltaProduct;
    status: string;
}


/* ───────────────────────
   Delta Exchange – Position
─────────────────────── */

export interface Position {
    entry_price: string | null;
    size: number;
}

/* ───────────────────────
   Delta Exchange – Cancel All Orders
─────────────────────── */

type ContractType = "perpetual_futures" | "futures" | "options";

export interface CancelAllOrdersFilter {
    contract_types?: ContractType;
    cancel_limit_orders?: boolean;
    cancel_stop_orders?: boolean;
    cancel_reduce_only_orders?: boolean;
    product_id?: number | string;
}

export interface CancelAllOrdersPayload {
    contract_types: ContractType;
    cancel_limit_orders: boolean;
    cancel_stop_orders: boolean;
    cancel_reduce_only_orders: boolean;
    product_id?: number | string;
}

export interface EditOrderPayload {
    id: number | string;
    product_id: number;
    product_symbol: string;
    limit_price: string;
    stop_price: string;
    size?: number; // size is optional in the update based on docs logic, but required in payload sample. treating as optional for partial updates if allowed, but strict per sample. Let's make it optional as we primarily care about price updates. Documentation says "Order which needs to be edited". Usually ID is enough to identify, but other fields update.
    // The user requirement specifically asked to update stop price and limit price ONLY.
    // However, the API might require other fields. The sample shows size, mmp, post_only etc.
    // Minimally we need what the user asked for.
}

export interface ActiveSubscribedBot {
    id: string
    USER_ID: string
    EXCHANGE?: string
    API_KEY: string
    SECRET_KEY: string
    SYMBOL: string
    PRODUCT_ID: string | number
    LEVERAGE: number
    MIN_TRADE_SIZE: number
    MAX_TRADE_SIZE: number
    TRADING_MODE: "conservative" | "balanced" | "aggressive" | "meme"
    MIN_RR?: number
    MIN_TP_PRICE_MOVEMENT_PERCENT?: number
    MAX_TP_PRICE_MOVEMENT_PERCENT?: number
    MAX_SL_PRICE_MOVEMENT_PERCENT?: number
    MIN_FINAL_SCORE?: number
    DAILY_LOSS_LIMIT: number
    MAX_CONCURRENT_TRADES: number
    CAPITAL_AMOUNT: number
    IS_WEEKEND_SAFETY_ENABLED?: boolean
    IS_CANDLE_LIMIT_EXIT_ENABLED?: boolean
    MAX_HOLDING_CANDLES_MAP?: Record<string, number>
}