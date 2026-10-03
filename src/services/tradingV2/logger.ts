import fs from "fs";
import path from "path";
import util from "util";
import { isIndianMarketTime, getISTDetails } from "../../utils/indianMarketTime";
import env from "../../config/env";
import { TradingConfig } from "./config";

const LOG_DIR = path.join(process.cwd(), "logs");
const MAX_DAILY_LOG_FILES = Math.max(3, parseInt(process.env.MAX_DAILY_LOGS || "30", 10));
const DAILY_FILE_PATTERN = /^trading_.*\.log$/;
let lastDailyRotateDate = "";

/**
 * Checks whether logging to disk is permitted outside official Indian market hours.
 * Permitted if: USE_CACHE_CANDLE is true, IS_TESTING is true, DRY_RUN is true, or FORCE_LOG is true.
 */
export function isLoggingAllowedOutsideMarket(): boolean {
    if (process.env.FORCE_LOG === "true") return true;
    if (env.useCacheCandle || (process.env.USE_CACHE_CANDLE || "").trim() === "true" || (process.env.USE_CACHED_CANDLES || "").trim() === "true") return true;
    if (env.isTesting || (process.env.IS_TESTING || "").trim() === "true") return true;
    if (env.dryRun || (process.env.DRY_RUN || "").trim() === "true") return true;
    try {
        const activeConfig = TradingConfig?.configStore?.getStore();
        if (activeConfig?.DRY_RUN || activeConfig?.USE_CACHE_CANDLE) return true;
    } catch {}
    return false;
}

function rotateDailyLogs(todayDateStr: string): void {
    if (lastDailyRotateDate === todayDateStr) return;
    lastDailyRotateDate = todayDateStr;
    try {
        if (!fs.existsSync(LOG_DIR)) return;
        const files = fs.readdirSync(LOG_DIR);
        const dailyFiles = files
            .filter(f => DAILY_FILE_PATTERN.test(f))
            .sort(); // Oldest first
        if (dailyFiles.length > MAX_DAILY_LOG_FILES) {
            const deleteCount = dailyFiles.length - MAX_DAILY_LOG_FILES;
            for (let i = 0; i < deleteCount; i++) {
                try {
                    fs.unlinkSync(path.join(LOG_DIR, dailyFiles[i]));
                } catch {
                    // Silently ignore deletion error
                }
            }
        }
    } catch {
        // Silently ignore
    }
}

function appendToDailyLog(text: string): void {
    // If outside Indian market hours, log anytime when cache candle, is testing, or dry run is true (or forced)
    if (!isIndianMarketTime() && !isLoggingAllowedOutsideMarket()) {
        return;
    }

    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
        const ist = getISTDetails();
        const dateStr = ist.dateStr; // Market date in IST as YYYYMMDD (e.g. trading_20261003.log)

        // Ensure old daily logs beyond MAX_DAILY_LOG_FILES are cleaned up
        rotateDailyLogs(dateStr);

        const dailyFile = path.join(LOG_DIR, `trading_${dateStr}.log`);
        const clean = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
        fs.appendFileSync(dailyFile, clean + "\n");
    } catch {
        // Silently ignore disk write error to prevent crash
    }
}

const createConsoleLogger = (serviceName: string) => {
    const log = (level: string, message: string, meta?: any) => {
        const ist = getISTDetails();
        let msg = `[${ist.isoDate} ${ist.displayTime}] [${level.toUpperCase()}] [${serviceName}]: ${message}`;
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
