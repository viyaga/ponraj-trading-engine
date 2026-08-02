import { Request, Response, NextFunction } from 'express';

import errorLogger from '../utils/errorLogger';

interface CustomError extends Error {
    statusCode?: number;
}

interface ErrorResponseError {
    message?: string;
    [key: string]: any;
}

export const errorResponse = (
    res: Response,
    statusCode: number,
    message: string,
    error: ErrorResponseError | string = {}
) => {
    return res.status(statusCode).json({
        success: false,
        message,
        error: typeof error === 'string' ? error : error.message || error,
    });
};

const errorHandler = (
    err: CustomError,
    req: Request,
    res: Response,
    next: NextFunction
): void => {
    errorLogger.error(err.stack || err.message);

    const statusCode = err.statusCode || 500;
    const message = err.message || 'Internal Server Error';

    errorResponse(res, statusCode, message, err);
};

export default errorHandler;
