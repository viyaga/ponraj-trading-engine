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
    clientServerUrl: string;
    payloadUrl: string;
    payloadApiKey: string;
    serverIp: string;
}

const env: EnvConfig = {
    port: parseInt(process.env.PORT || '3001', 10),
    mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/express_api_db',
    cronSchedule: process.env.CRON_SCHEDULE || '*/5 * * * *',
    clientServerUrl: process.env.CLIENT_SERVER_URL || 'http://localhost:3000',
    payloadUrl: process.env.PAYLOAD_URL || 'http://localhost:4000',
    payloadApiKey: process.env.PAYLOAD_API_KEY || '',
    serverIp: process.env.SERVER_IP || '127.0.0.1'
};

export default env;