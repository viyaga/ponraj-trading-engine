import mongoose, { Document, Schema } from 'mongoose';

export interface IBotError extends Document {
    botId: string;
    status?: string;
    message?: string;
    isActive?: boolean;
    updatedAt: Date;
    createdAt: Date;
}

const BotErrorSchema: Schema = new Schema(
    {
        botId: { type: String, required: true, index: true, unique: true },
        status: { type: String },
        message: { type: String },
        isActive: { type: Boolean },
    },
    { 
        timestamps: true 
    }
);

export const BotError = mongoose.model<IBotError>('BotError', BotErrorSchema);
