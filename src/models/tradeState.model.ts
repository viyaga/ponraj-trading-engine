import mongoose, { Schema, Document } from 'mongoose';

// TradeState Interface (matches Payload CMS structure)
export interface ITradeState {
    id: string;
    userId: string;
    tradingBotId: string;
    symbol: string;
    productId: number;
    currentLevel: number;
    entryOrderId?: string | null;
    entryClientOrderId?: string | null;
    stopLossOrderId?: string | null;
    takeProfitOrderId?: string | null;
    entryPrice?: number | null;
    slPrice?: number | null;
    tpPrice?: number | null;
    quantity?: number | null;
    tradeOutcome: 'win' | 'loss' | 'pending' | 'cancelled' | 'partialWin' | 'none';
    pnl: number;
    cumulativeFees: number;
    dailyPnl: number;
    dailyLossLimitUSD: number;
    allTimePnl: number;
    allTimeFees: number;
    side?: 'buy' | 'sell' | null;
    leverage?: number | null;
    tradeAmountInUse?: number | null;
    pnlPercentage?: number | null;
    riskRewardRatio?: number | null;
    tpPercentage?: number | null;
    slPercentage?: number | null;
    exitPrice?: number | null;
    finalScore?: number | null;
    entryScore?: number | null;
    confirmationProbability?: number | null;
    structureProbability?: number | null;
    tradingMode?: string | null;
    breakoutTimeframe?: string | null;
    entryFilledAt?: Date | null;
    consecutiveLowMomentumCycles?: number;
    lastTradeSettledAt?: Date | null;
    status: 'open' | 'closed';
    updatedAt: Date;
    createdAt: Date;
}

// TradeState Schema
const TradeStateSchema: Schema = new Schema(
    {
        userId: { type: String, required: true, index: true },
        tradingBotId: { type: String, required: true, index: true },
        status: { type: String, enum: ['open', 'closed'], required: true, default: 'open', index: true },
        symbol: { type: String, required: true, index: true },
        productId: { type: Number },
        currentLevel: { type: Number, required: true, default: 1 },
        tradeOutcome: {
            type: String,
            enum: ['win', 'loss', 'pending', 'cancelled', 'none', 'partialWin'],
            required: true,
            default: 'pending'
        },
        entryOrderId: { type: String, default: null },
        entryClientOrderId: { type: String, default: null },
        stopLossOrderId: { type: String, default: null },
        takeProfitOrderId: { type: String, default: null },
        entryPrice: { type: Number, default: null },
        slPrice: { type: Number, default: null },
        tpPrice: { type: Number, default: null },
        quantity: { type: Number, default: null },
        pnl: { type: Number, required: true, default: 0 },
        cumulativeFees: { type: Number, required: true, default: 0 },
        dailyPnl: { type: Number, required: true, default: 0 },
        dailyLossLimitUSD: { type: Number, required: true, default: 0 },
        allTimePnl: { type: Number, required: true, default: 0 },
        allTimeFees: { type: Number, required: true, default: 0 },
        lastTradeSettledAt: { type: Date, default: null },
        side: { type: String, enum: ['buy', 'sell'], default: null },
        leverage: { type: Number, default: null },
        tradeAmountInUse: { type: Number, default: null },
        pnlPercentage: { type: Number, default: null },
        riskRewardRatio: { type: Number, default: null },
        tpPercentage: { type: Number, default: null },
        slPercentage: { type: Number, default: null },
        exitPrice: { type: Number, default: null },
        finalScore: { type: Number, default: null },
        entryScore: { type: Number, default: null },
        confirmationProbability: { type: Number, default: null },
        structureProbability: { type: Number, default: null },
        tradingMode: { type: String, default: null },
        breakoutTimeframe: { type: String, default: null },
        entryFilledAt: { type: Date, default: null },
        consecutiveLowMomentumCycles: { type: Number, default: 0 },
    },
    {
        timestamps: true
    }
);

TradeStateSchema.index({ updatedAt: 1, tradingBotId: 1 });
TradeStateSchema.index({ tradingBotId: 1, status: 1 });

// Export the model with generic type parameter
export const TradeState = mongoose.model<ITradeState>(
    'TradeState',
    TradeStateSchema
);