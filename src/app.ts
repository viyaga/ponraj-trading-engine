import express, { Application } from 'express';
import path from 'path';
import errorHandler from './middleware/errorHandler';
import engineAuth from './middleware/engineAuth';

import tradingRoutes from './routes/trading.routes';

const app: Application = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Basic route for health check
app.get('/', (req, res) => {
    res.sendFile(path.resolve(process.cwd(), 'index.html'));
});

// Trading routes
app.use('/api/trading', tradingRoutes);

// Global error handler
app.use(errorHandler);

export default app;
