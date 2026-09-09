import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ICandleDoc extends Document {
    symbol:     string;     // e.g. '99926000' (NIFTY) or '99926009' (BANKNIFTY)
    interval:   string;     // '15minute' | '60minute'
    timestamp:  number;     // Epoch ms of candle start
    candleTime: Date;       // Date object (used for queries, human readability & TTL auto-cleanup)
    open:       number;
    high:       number;
    low:        number;
    close:      number;
    volume:     number;
    createdAt:  Date;
    updatedAt:  Date;
}

const CandleSchema: Schema = new Schema(
    {
        symbol:     { type: String, required: true, index: true },
        interval:   { type: String, required: true, index: true },
        timestamp:  { type: Number, required: true },
        candleTime: { type: Date,   required: true },
        open:       { type: Number, required: true },
        high:       { type: Number, required: true },
        low:        { type: Number, required: true },
        close:      { type: Number, required: true },
        volume:     { type: Number, default: 0 },
    },
    {
        timestamps: true,
    }
);

// ── Compound Unique Index ────────────────────────────────────────────────────
// Guarantees only one candle per (symbol, interval, timestamp) and ultra-fast range queries
CandleSchema.index({ symbol: 1, interval: 1, timestamp: -1 }, { unique: true });

// ── Automatic TTL Index (Automatic Cleanup) ──────────────────────────────────
// Automatically deletes candles older than 45 days (3,888,000 seconds) in background
CandleSchema.index({ candleTime: 1 }, { expireAfterSeconds: 45 * 24 * 60 * 60 });

export const CandleModel: Model<ICandleDoc> =
    mongoose.models.MarketCandle || mongoose.model<ICandleDoc>('MarketCandle', CandleSchema);
