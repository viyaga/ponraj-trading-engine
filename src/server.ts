import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import { env, connectDB } from './config';
import app from './app';
import startCronJobs from './cron';
import { tradingCronLogger } from './services/tradingV2/logger';
import errorLogger from './utils/errorLogger';



import { AngelStreamService } from './services/tradingV2/angel-stream.service';

const startServer = async (): Promise<void> => {
    // Connect to MongoDB
    await connectDB();

    // Start Angel One SmartStream WebSocket
    const angelStream = AngelStreamService.getInstance();
    angelStream.connect().catch((err) => {
        tradingCronLogger.warn(`[Server] AngelStream initial connect error: ${err.message}`);
    });

    // Start cron jobs
    startCronJobs();

    // Start the Express server
    app.listen(env.port, () => {
        tradingCronLogger.info(`Server running on port ${env.port}`);
        tradingCronLogger.info(`Access API at http://localhost:${env.port}`);
    });
};

// Graceful shutdown
const handleShutdown = () => {
    tradingCronLogger.info('[Server] Shutting down, disconnecting AngelStream...');
    AngelStreamService.getInstance().disconnect();
};
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

// Handle process-level errors
process.on('uncaughtException', (err) => {
    errorLogger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...', err);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    errorLogger.error('UNHANDLED REJECTION! (Process kept alive)', err);
});

startServer();