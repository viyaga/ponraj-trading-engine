import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import { env, connectDB } from './config';
import app from './app';
import startCronJobs from './cron';
import { tradingCronLogger } from './services/tradingV2/logger';
import errorLogger from './utils/errorLogger';



const startServer = async (): Promise<void> => {
    // Connect to MongoDB
    await connectDB();

    // Start cron jobs
    startCronJobs();

    // Start the Express server
    app.listen(env.port, () => {
        tradingCronLogger.info(`Server running on port ${env.port}`);
        tradingCronLogger.info(`Access API at http://localhost:${env.port}`);
    });
};

// Handle process-level errors
process.on('uncaughtException', (err) => {
    errorLogger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...', err);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    errorLogger.error('UNHANDLED REJECTION! (Process kept alive)', err);
});

startServer();