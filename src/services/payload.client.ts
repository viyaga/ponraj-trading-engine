import axios, { AxiosInstance } from 'axios';
import env from '../config/env';

import { syncLogger } from './tradingV2/logger';

export class PayloadClient {
    private static baseUrl = env.payloadUrl;
    private static apiKey = env.payloadApiKey;
    private static _instance: AxiosInstance;

    private static get instance(): AxiosInstance {
        if (!this._instance) {
            const headers: any = {
                'Content-Type': 'application/json',
            };
            if (this.apiKey) {
                headers['Authorization'] = `users API-Key ${this.apiKey}`;
            }

            this._instance = axios.create({
                baseURL: this.baseUrl,
                headers,
                timeout: 30000,
                // 🚀 Keep-alive for better connection reuse during bulk sync
                httpAgent: new (require('http').Agent)({ keepAlive: true }),
                httpsAgent: new (require('https').Agent)({ keepAlive: true }),
            });

        }
        return this._instance;
    }

    static async updatePnl(updates: { botId: string; allTimePnl: number }[]) {
        try {
            const response = await this.instance.post('/api/trading-bots/update-pnl', updates);
            syncLogger.info(`[PayloadClient] PNL updated successfully for ${updates.length} bots`);
            return response.data;
        } catch (error: any) {
            syncLogger.error(`[PayloadClient] PNL update failed:`, error.response?.data || error.message);
            throw error;
        }
    }

    static async bulkUpsertTradeStates(data: any[]) {
        try {
            const response = await this.instance.post('/api/trade-states/bulk', data);
            syncLogger.info(`[PayloadClient] Trade states synced successfully: ${data.length} records`);
            return response.data;
        } catch (error: any) {
            syncLogger.error(`[PayloadClient] Trade states bulk sync failed:`, error.response?.data || error.message);
            throw error;
        }
    }

    static async bulkUpdateBots(updates: { botId: string; errorMessage?: string; status?: string; isActive?: boolean }[]) {
        try {
            const response = await this.instance.post('/api/trading-bots/bulk-update', updates);
            syncLogger.info(`[PayloadClient] Bots bulk updated successfully: ${updates.length} bots`);
            return response.data;
        } catch (error: any) {
            syncLogger.error(`[PayloadClient] Bulk bot update failed:`, error.response?.data || error.message);
            throw error;
        }
    }
}

