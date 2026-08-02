import util from "util";

const createConsoleLogger = (serviceName: string) => {
    const log = (level: string, message: string, meta?: any) => {
        const timestamp = new Date().toISOString();
        let msg = `${timestamp} [${level.toUpperCase()}] [${serviceName}]: ${message}`;
        if (meta) {
            if (meta instanceof Error) {
                msg += `\n${meta.stack || meta.message}`;
            } else if (Object.keys(meta).length > 0) {
                msg += ` ${util.inspect(meta, { depth: 4 })}`;
            }
        }
        if (level === "error") {
            console.error(msg);
        } else if (level === "warn") {
            console.warn(msg);
        } else {
            console.log(msg);
        }
    };

    return {
        debug: (message: string, meta?: any) => log("debug", message, meta),
        info: (message: string, meta?: any) => log("info", message, meta),
        warn: (message: string, meta?: any) => log("warn", message, meta),
        error: (message: string, meta?: any) => log("error", message, meta)
    };
};

export const tradingCycleErrorLogger = createConsoleLogger("trading-error");
export const marketDetectorLogger = createConsoleLogger("market-detector");
export const skipTradingLogger = createConsoleLogger("skip-trading");
export const tradingCronLogger = createConsoleLogger("trading-cron");
export const configDebugLogger = createConsoleLogger("config-debug");
export const tradesLogger = createConsoleLogger("trades");
export const syncLogger = createConsoleLogger("sync");
export const mtfAllowedLogger = createConsoleLogger("mtf-allowed");
export const placedOrdersLogger = createConsoleLogger("placed-orders");

export const getContextualLogger = (
    logger: ReturnType<typeof createConsoleLogger>,
    context: { cycleId?: string; symbol?: string; tradingBotId?: string } = {}
) => {
    const wrap = (fn: Function) => (message: string, meta?: any) => {
        if (meta instanceof Error) {
            return fn(message, { ...context, error: meta });
        }
        return fn(message, { ...context, ...meta });
    };

    return {
        debug: wrap(logger.debug),
        info: wrap(logger.info),
        warn: wrap(logger.warn),
        error: wrap(logger.error)
    };
};
