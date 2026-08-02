import fs from "fs";
import path from "path";
import util from "util";

const LOG_DIR = path.join(process.cwd(), "logs");
const MAX_LOG_FILES = 10;
const FILE_PATTERN = /^cycle_\d{8}_\d{6}\.log$/; // matches cycle_YYYYMMDD_HHmmss.log

let activeLogFile: string | null = null;
let originalLog: typeof console.log | null = null;
let originalError: typeof console.error | null = null;
let originalWarn: typeof console.warn | null = null;

/**
 * Starts cycle logging by creating a log file for the current cycle and intercepting console output.
 */
export function startCycleLogging(): void {
    try {
        // Ensure log directory exists
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }

        // Clean up old log files before starting a new one
        rotateLogs();

        // Generate filename using the current timestamp in UTC
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, "0");
        const day = String(now.getUTCDate()).padStart(2, "0");
        const hours = String(now.getUTCHours()).padStart(2, "0");
        const minutes = String(now.getUTCMinutes()).padStart(2, "0");
        const seconds = String(now.getUTCSeconds()).padStart(2, "0");

        const dateStr = `${year}${month}${day}_${hours}${minutes}${seconds}`;
        activeLogFile = path.join(LOG_DIR, `cycle_${dateStr}.log`);

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
        const files = fs.readdirSync(LOG_DIR);
        const logFiles = files
            .filter(f => FILE_PATTERN.test(f))
            .map(f => {
                const filePath = path.join(LOG_DIR, f);
                let time = 0;
                try {
                    time = fs.statSync(filePath).mtimeMs;
                } catch {
                    // fall back to parsing timestamp from name if fs.stat fails
                    const match = f.match(/cycle_(\d{8})_(\d{6})\.log/);
                    if (match) {
                        const dateStr = match[1];
                        const timeStr = match[2];
                        const year = parseInt(dateStr.substring(0, 4), 10);
                        const month = parseInt(dateStr.substring(4, 6), 10) - 1;
                        const day = parseInt(dateStr.substring(6, 8), 10);
                        const hour = parseInt(timeStr.substring(0, 2), 10);
                        const min = parseInt(timeStr.substring(2, 4), 10);
                        const sec = parseInt(timeStr.substring(4, 6), 10);
                        time = Date.UTC(year, month, day, hour, min, sec);
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