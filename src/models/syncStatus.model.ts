import mongoose, { Schema, Document } from 'mongoose';

export interface ISyncStatus extends Document {
    collectionName: string;
    lastSyncedAt: Date;
}

const SyncStatusSchema: Schema = new Schema(
    {
        collectionName: { type: String, required: true, unique: true },
        lastSyncedAt: { type: Date, required: true, default: () => new Date(0) }
    },
    {
        timestamps: true
    }
);

export const SyncStatus = mongoose.model<ISyncStatus>('SyncStatus', SyncStatusSchema);
