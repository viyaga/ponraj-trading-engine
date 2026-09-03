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
    const targetUrl = `${baseUrl}${path}`;
    const payloadPreview = typeof data === 'object' ? JSON.stringify(data) : String(data);
    const truncatedPayload = payloadPreview.length > 500 ? `${payloadPreview.slice(0, 500)}... [truncated, total length: ${payloadPreview.length}]` : payloadPreview;

    syncLogger.info(`[PayloadClient] ➔ Sending POST to Backend: ${targetUrl}`, {
        path,
        dataCount: Array.isArray(data) ? data.length : (data ? 1 : 0),
        payload: truncatedPayload
    });

    const startTime = Date.now();
    try {
        const res = await fetch(targetUrl, {
            method:  'POST',
            headers: getHeaders(),
            body:    JSON.stringify(data),
            signal:  AbortSignal.timeout(30000),
        });

        const duration = Date.now() - startTime;
        if (!res.ok) {
            const msg = await res.text().catch(() => res.statusText);
            syncLogger.error(`[PayloadClient] ✖ Backend Error Response: ${path} → HTTP ${res.status} (${duration}ms)`, {
                status: res.status,
                statusText: res.statusText,
                errorResponse: msg
            });
            throw new Error(`[PayloadClient] ${path} → HTTP ${res.status}: ${msg}`);
        }

        const json = await res.json();
        const responsePreview = JSON.stringify(json);
        const truncatedResponse = responsePreview.length > 500 ? `${responsePreview.slice(0, 500)}... [truncated]` : responsePreview;

        syncLogger.info(`[PayloadClient] ✔ Backend Response Received: ${path} (HTTP ${res.status}, ${duration}ms)`, {
            response: truncatedResponse
        });
        return json;
    } catch (error: any) {
        if (!error.message?.includes('[PayloadClient]')) {
            syncLogger.error(`[PayloadClient] ✖ Backend Request Failed (${path}): ${error.message}`, { error });
        }
        throw error;
    }
}

export class PayloadClient {

    static async updatePnl(updates: { botId: string; allTimePnl: number }[]) {
        try {
            syncLogger.info(`[PayloadClient] Syncing PNL update to backend for ${updates.length} bots`);
            const data = await post('/api/trading-bots/update-pnl', updates);
            syncLogger.info(`[PayloadClient] PNL updated successfully for ${updates.length} bots`);
            return data;
        } catch (error: any) {
            syncLogger.error(`[PayloadClient] PNL update failed for ${updates.length} bots: ${error.message}`);
            throw error;
        }
    }

    static async bulkUpsertTradeStates(data: any[]) {
        try {
            syncLogger.info(`[PayloadClient] Sending bulk trade states to backend (${data.length} records)`);
            const result = await post('/api/trade-states/bulk', data);
            syncLogger.info(`[PayloadClient] Trade states synced successfully: ${data.length} records`);
            return result;
        } catch (error: any) {
            syncLogger.error(`[PayloadClient] Trade states bulk sync failed (${data.length} records): ${error.message}`);
            throw error;
        }
    }

    static async bulkUpdateBots(updates: { botId: string; errorMessage?: string; status?: string; isActive?: boolean }[]) {
        try {
            syncLogger.info(`[PayloadClient] Sending bulk bot status updates to backend (${updates.length} bots)`);
            const result = await post('/api/trading-bots/bulk-update', updates);
            syncLogger.info(`[PayloadClient] Bots bulk updated successfully: ${updates.length} bots`);
            return result;
        } catch (error: any) {
            syncLogger.error(`[PayloadClient] Bulk bot update failed (${updates.length} bots): ${error.message}`);
            throw error;
        }
    }
}
