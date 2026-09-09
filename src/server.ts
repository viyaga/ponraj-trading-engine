import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import { env, connectDB } from './config';
import app from './app';
import startCronJobs from './cron';
import { tradingCronLogger } from './services/tradingV2/logger';
import errorLogger from './utils/errorLogger';



import { AngelStreamService } from './services/tradingV2/angel-stream.service';
import { CandleStorageService } from './services/tradingV2/candle-storage.service';

let isShuttingDown = false;
let serverInstance: any = null;

const startServer = async (): Promise<void> => {
    // Connect to MongoDB
    await connectDB();

    // Prune expired candles older than 45 days on startup
    CandleStorageService.pruneOldCandles(45).catch(() => {});

    // Start Angel One SmartStream WebSocket
    const angelStream = AngelStreamService.getInstance();
    angelStream.connect().catch((err) => {
        tradingCronLogger.warn(`[Server] AngelStream initial connect error: ${err.message}`);
    });

    // Start cron jobs
    startCronJobs();

    // Start the Express server
    serverInstance = app.listen(env.port, () => {
        tradingCronLogger.info(`Server running on port ${env.port}`);
        tradingCronLogger.info(`Access API at http://localhost:${env.port}`);
    });
};

// Graceful shutdown
const handleShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    tradingCronLogger.info(`[Server] Received ${signal}. Shutting down gracefully...`);
    try {
        AngelStreamService.getInstance().disconnect();
    } catch {}
    if (serverInstance) {
        try {
            serverInstance.close();
        } catch {}
    }
    setTimeout(() => {
        tradingCronLogger.info('[Server] Process exited cleanly.');
        process.exit(0);
    }, 300);
};
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// Handle process-level errors
process.on('uncaughtException', (err) => {
    errorLogger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...', err);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    errorLogger.error('UNHANDLED REJECTION! (Process kept alive)', err);
});

startServer();