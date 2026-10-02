import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Check if .env file exists
const envPath = path.resolve(process.cwd(), '.env');
if (!fs.existsSync(envPath)) {
    throw new Error('CRITICAL STARTUP ERROR: .env file is missing! Please create a .env file based on env.example before running the application.');
}

dotenv.config();

// Validate critical environment variables on startup
const requiredEnvVars = [
    'MONGO_URI',
    'ENGINE_JWT_SECRET',
    'EXCHANGE_KEYS_ENCRYPTION_KEY',
    'PAYLOAD_URL',
];

const missingEnvVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingEnvVars.length > 0) {
    throw new Error(`CRITICAL STARTUP ERROR: Missing required environment variables in .env: ${missingEnvVars.join(', ')}. Please update your .env file.`);
}

interface EnvConfig {
    port: number;
    mongoUri: string;
    cronSchedule: string;
    payloadUrl: string;
    payloadApiKey: string;
    serverIp: string;
    isTesting: boolean;
    useCacheCandle: boolean;
    cacheCandleTargetTime: string;
    angelOneApiKey?: string;
    angelOneClientCode?: string;
    angelOnePassword?: string;
    angelOneTotpKey?: string;
    maxLogFiles: number;
    maxDailyLogs: number;
}

const env: EnvConfig = {
    port: parseInt(process.env.PORT || '3001', 10),
    mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/express_api_db',
    cronSchedule: process.env.CRON_SCHEDULE || '*/5 * * * *',
    payloadUrl: process.env.PAYLOAD_URL || 'http://localhost:4000',
    payloadApiKey: process.env.PAYLOAD_API_KEY || '',
    serverIp: process.env.SERVER_IP || '127.0.0.1',
    isTesting: process.env.IS_TESTING === 'true',
    useCacheCandle: process.env.USE_CACHE_CANDLE === 'true' || process.env.USE_CACHED_CANDLES === 'true',
    cacheCandleTargetTime: process.env.CACHE_CANDLE_TARGET_TIME || '2026-10-01 10:00',
    angelOneApiKey: process.env.ANGEL_ONE_API_KEY || '',
    angelOneClientCode: process.env.ANGEL_ONE_CLIENT_CODE || '',
    angelOnePassword: process.env.ANGEL_ONE_PASSWORD || '',
    angelOneTotpKey: process.env.ANGEL_ONE_TOTP_KEY || '',
    maxLogFiles: Math.max(5, parseInt(process.env.MAX_LOG_FILES || '30', 10)),
    maxDailyLogs: Math.max(3, parseInt(process.env.MAX_DAILY_LOGS || '30', 10)),
};

export default env;