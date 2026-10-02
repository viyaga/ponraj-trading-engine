import fs from "fs";
import path from "path";
import util from "util";
import { getISTDetails, isIndianMarketTime, IST_OFFSET_MS } from "./indianMarketTime";

const LOG_DIR = path.join(process.cwd(), "logs");
const MAX_LOG_FILES = Math.max(5, parseInt(process.env.MAX_LOG_FILES || "30", 10));
const FILE_PATTERN = /^cycle_.*\.log$/; // matches cycle_YYYY-MM-DD_HH-mm-ss_IST.log and legacy names

let activeLogFile: string | null = null;
let originalLog: typeof console.log | null = null;
let originalError: typeof console.error | null = null;
let originalWarn: typeof console.warn | null = null;
let activeLoggingDepth = 0;

/**
 * Starts cycle logging by creating a log file for the current cycle and intercepting console output.
 * STRICT REQUIREMENT: Cycle logs are ONLY created during Indian market time (09:15 - 15:30 IST, Mon-Fri, non-holiday).
 * Outside Indian market time, cycle logging is cleanly skipped so unnecessary log files are not produced.
 */
export function startCycleLogging(options?: { force?: boolean }): void {
    // Only create cycle logs during Indian market hours, unless explicitly forced
    if (!options?.force && !isIndianMarketTime()) {
        return;
    }

    activeLoggingDepth++;
    if (activeLoggingDepth > 1 && activeLogFile) {
        return; // Already logging to an active cycle file
    }

    try {
        // Ensure log directory exists
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }

        // Clean up old log files before starting a new one
        rotateLogs();

        // Generate filename using the current timestamp in Indian Standard Time (IST)
        const ist = getISTDetails();
        activeLogFile = path.join(LOG_DIR, `cycle_${ist.timestampStr}.log`);

        // Intercept console functions if not already intercepted
        if (!originalLog) {
            originalLog = console.log;
            originalError = console.error;
            originalWarn = console.warn;

            console.log = (...args: any[]) => {
                originalLog!(...args);
                writeToLog(util.format(...args));
            };

            console.error = (...args: any[]) => {
                originalError!(...args);
                writeToLog(util.format(...args));
            };

            console.warn = (...args: any[]) => {
                originalWarn!(...args);
                writeToLog(util.format(...args));
            };
        }
    } catch (err) {
        if (originalError) {
            originalError("Failed to start cycle logging:", err);
        } else {
            console.error("Failed to start cycle logging:", err);
        }
    }
}

/**
 * Ends cycle logging by resetting the active file and restoring original console functions.
 */
export function endCycleLogging(): void {
    if (activeLoggingDepth === 0 && !activeLogFile) {
        return; // Logging was not active (e.g. skipped because outside Indian market hours)
    }

    activeLoggingDepth = Math.max(0, activeLoggingDepth - 1);
    if (activeLoggingDepth > 0) {
        return; // Still within an outer logging cycle
    }

    activeLogFile = null;
    if (originalLog) {
        console.log = originalLog;
        console.error = originalError!;
        console.warn = originalWarn!;
        originalLog = null;
        originalError = null;
        originalWarn = null;
    }
}

/**
 * Appends text content to the active log file, ensuring no ANSI colors are written.
 */
function writeToLog(text: string): void {
    if (activeLogFile) {
        try {
            // Strip any ANSI color codes if they exist
            const cleanText = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
            fs.appendFileSync(activeLogFile, cleanText + "\n");
        } catch (err) {
            if (originalError) {
                originalError("Failed to write to cycle log:", err);
            }
        }
    }
}

/**
 * Retains only the most recent (MAX_LOG_FILES - 1) log files to allow space for the new cycle log.
 */
function rotateLogs(): void {
    try {
        if (!fs.existsSync(LOG_DIR)) {
            return;
        }
        const files = fs.readdirSync(LOG_DIR);
        const logFiles = files
            .filter(f => FILE_PATTERN.test(f))
            .map(f => {
                const filePath = path.join(LOG_DIR, f);
                let time = 0;
                try {
                    time = fs.statSync(filePath).mtimeMs;
                } catch {
                    // fall back to parsing IST timestamp from filename if fs.stat fails
                    const ddmmyyMatch = f.match(/cycle_(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(AM|PM)/i);
                    if (ddmmyyMatch) {
                        const day = parseInt(ddmmyyMatch[1], 10);
                        const month = parseInt(ddmmyyMatch[2], 10) - 1;
                        const year = 2000 + parseInt(ddmmyyMatch[3], 10);
                        let hour = parseInt(ddmmyyMatch[4], 10);
                        const min = parseInt(ddmmyyMatch[5], 10);
                        const ampm = ddmmyyMatch[6].toUpperCase();
                        if (ampm === "PM" && hour < 12) hour += 12;
                        if (ampm === "AM" && hour === 12) hour = 0;
                        time = Date.UTC(year, month, day, hour, min, 0) - IST_OFFSET_MS;
                    } else {
                        const match = f.match(/cycle_(\d{4})-?(\d{2})-?(\d{2})[_-](\d{2})-?(\d{2})-?(\d{2})/);
                        if (match) {
                            const year = parseInt(match[1], 10);
                            const month = parseInt(match[2], 10) - 1;
                            const day = parseInt(match[3], 10);
                            const hour = parseInt(match[4], 10);
                            const min = parseInt(match[5], 10);
                            const sec = parseInt(match[6], 10);
                            time = Date.UTC(year, month, day, hour, min, sec) - IST_OFFSET_MS;
                        }
                    }
                }
                return { name: f, path: filePath, time };
            })
            .sort((a, b) => a.time - b.time); // Oldest first

        // Keep at most MAX_LOG_FILES - 1
        const keepCount = MAX_LOG_FILES - 1;
        if (logFiles.length > keepCount) {
            const deleteCount = logFiles.length - keepCount;
            for (let i = 0; i < deleteCount; i++) {
                try {
                    fs.unlinkSync(logFiles[i].path);
                } catch (unlinkErr) {
                    if (originalError) {
                        originalError(`Failed to delete old log file ${logFiles[i].name}:`, unlinkErr);
                    }
                }
            }
        }
    } catch (err) {
        if (originalError) {
            originalError("Error rotating logs:", err);
        } else {
            console.error("Error rotating logs:", err);
        }
    }
}