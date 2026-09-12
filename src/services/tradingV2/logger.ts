import fs from "fs";
import path from "path";
import util from "util";

const LOG_DIR = path.join(process.cwd(), "logs");

function appendToDailyLog(text: string): void {
    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, "0");
        const day = String(now.getUTCDate()).padStart(2, "0");
        const dailyFile = path.join(LOG_DIR, `trading_${year}${month}${day}.log`);
        const clean = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
        fs.appendFileSync(dailyFile, clean + "\n");
    } catch {
        // Silently ignore disk write error to prevent crash
    }
}

const createConsoleLogger = (serviceName: string) => {
    const log = (level: string, message: string, meta?: any) => {
        const timestamp = new Date().toISOString();
        let msg = `${timestamp} [${level.toUpperCase()}] [${serviceName}]: ${message}`;
        if (meta !== undefined) {
            if (meta instanceof Error) {
                msg += `\n${meta.stack || meta.message}`;
            } else if (typeof meta === 'object' && meta !== null) {
                // If meta contains an error property
                if (meta.error instanceof Error) {
                    const { error, ...rest } = meta;
                    msg += `\nError: ${error.stack || error.message}`;
                    if (Object.keys(rest).length > 0) {
                        msg += `\nDetails: ${util.inspect(rest, { depth: 6, colors: false })}`;
                    }
                } else {
                    msg += `\n${util.inspect(meta, { depth: 6, colors: false })}`;
                }
            } else {
                msg += ` ${meta}`;
            }
        }
        // Always write to daily log file for continuous debugging
        appendToDailyLog(msg);

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
