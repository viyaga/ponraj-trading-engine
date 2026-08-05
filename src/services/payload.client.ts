// =============================================================================
// PayloadClient — HTTP client for Payload CMS backend sync
// Uses native fetch (Node 18+) instead of axios
// =============================================================================

import env from '../config/env';
import { syncLogger } from './tradingV2/logger';

const baseUrl   = env.payloadUrl;
const apiKey    = env.payloadApiKey;

function getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `users API-Key ${apiKey}`;
    return headers;
}

async function post(path: string, data: any): Promise<any> {
    const res = await fetch(`${baseUrl}${path}`, {
        method:  'POST',
        headers: getHeaders(),
        body:    JSON.stringify(data),
        signal:  AbortSignal.timeout(30000),
    });
    if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new Error(`[PayloadClient] ${path} → HTTP ${res.status}: ${msg}`);
    }
    return res.json();
}

export class PayloadClient {

    static async updatePnl(updates: { botId: string; allTimePnl: number }[]) {
        try {
            const data = await post('/api/trading-bots/update-pnl', updates);
            syncLogger.info(`[PayloadClient] PNL updated for ${updates.length} bots`);
            return data;
        } catch (error: any) {
            syncLogger.error(`[PayloadClient] PNL update failed: ${error.message}`);
            throw error;
        }
    }

    static async bulkUpsertTradeStates(data: any[]) {
        try {
            const result = await post('/api/trade-states/bulk', data);
            syncLogger.info(`[PayloadClient] Trade states synced: ${data.length} records`);
            return result;
        } catch (error: any) {
            syncLogger.error(`[PayloadClient] Trade states bulk sync failed: ${error.message}`);
            throw error;
        }
    }

    static async bulkUpdateBots(updates: { botId: string; errorMessage?: string; status?: string; isActive?: boolean }[]) {
        try {
            const result = await post('/api/trading-bots/bulk-update', updates);
            syncLogger.info(`[PayloadClient] Bots bulk updated: ${updates.length} bots`);
            return result;
        } catch (error: any) {
            syncLogger.error(`[PayloadClient] Bulk bot update failed: ${error.message}`);
            throw error;
        }
    }
}
