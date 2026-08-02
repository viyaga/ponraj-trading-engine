import mongoose from 'mongoose';
import errorLogger from '../utils/errorLogger';
import { tradingCronLogger } from '../services/tradingV2/logger';
import env from './env';

const connectDB = async (): Promise<void> => {
    try {
        await mongoose.connect(env.mongoUri);
        tradingCronLogger.info('MongoDB connected successfully.');
    } catch (error) {
        errorLogger.error('MongoDB connection error:', error);
        tradingCronLogger.warn('Server will start without database connection. Database operations will fail.');
        // Don't exit the process - allow server to start without DB
    }
};

export default connectDB;
