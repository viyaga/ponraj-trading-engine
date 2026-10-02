// =============================================================================
// Indian Market Time & Trading Hours Utility
// =============================================================================
// Single source of truth for Indian Standard Time (IST, UTC+05:30),
// NSE/BSE market trading hours, holiday calendar, and bot execution windows.
// =============================================================================

import type { ConfigType } from '../services/tradingV2/type';

export const IST_TIMEZONE = 'Asia/Kolkata';
// IST offset is fixed at +5h30m (19,800,000 ms). India does NOT observe Daylight Saving Time (DST).
export const IST_OFFSET_MS = 19800000;

// ── Official NSE/BSE Market Session Hours (Regular Trading) ──
// Regular market trading session: 09:15 AM to 03:30 PM IST (Mon-Fri)
export const NSE_MARKET_OPEN_HOUR  = 9;
export const NSE_MARKET_OPEN_MIN   = 15;
export const NSE_MARKET_CLOSE_HOUR = 15;
export const NSE_MARKET_CLOSE_MIN  = 30;

// ── Default Automated Bot Execution Window (09:30 AM to 03:15 PM IST) ──
// Allows 15m for opening bell volatility to settle; cuts off new entries 15m before market close
export const BOT_TRADING_WINDOW_START_HOUR = 9;  // 09:30 AM IST
export const BOT_TRADING_WINDOW_START_MIN  = 30;
export const BOT_TRADING_WINDOW_END_HOUR   = 15; // 03:15 PM IST
export const BOT_TRADING_WINDOW_END_MIN    = 15;

// ── UT Bot Strategy Trading Window (10:15 AM to 03:15 PM IST) ──
// Avoids 09:15 - 10:15 AM opening gap / false breakout noise
export const UT_BOT_TRADING_WINDOW_START_HOUR = 10; // 10:15 AM IST
export const UT_BOT_TRADING_WINDOW_START_MIN  = 15;
export const UT_BOT_TRADING_WINDOW_END_HOUR   = 15; // 03:15 PM IST
export const UT_BOT_TRADING_WINDOW_END_MIN    = 15;

// ── ATR-14 Strategy Sub-Window (03:00 PM to 03:15 PM IST) ──
export const ATR14_TRADING_WINDOW_START_HOUR = 15; // 03:00 PM IST
export const ATR14_TRADING_WINDOW_START_MIN  = 0;
export const ATR14_TRADING_WINDOW_END_HOUR   = 15; // 03:15 PM IST
export const ATR14_TRADING_WINDOW_END_MIN    = 15;

// ── Official NSE Trading Holidays (YYYY-MM-DD in IST) ──
export const NSE_TRADING_HOLIDAYS: ReadonlySet<string> = new Set([
    // 2025 Holidays
    '2025-02-26', // Mahashivratri
    '2025-03-14', // Holi
    '2025-03-31', // Id-Ul-Fitr
    '2025-04-10', // Shri Mahavir Jayanti
    '2025-04-14', // Dr. Baba Saheb Ambedkar Jayanti
    '2025-04-18', // Good Friday
    '2025-05-01', // Maharashtra Day
    '2025-08-15', // Independence Day
    '2025-08-27', // Ganesh Chaturthi
    '2025-10-02', // Mahatma Gandhi Jayanti
    '2025-10-21', // Diwali Laxmi Pujan (Muhurat Trading only)
    '2025-10-22', // Diwali-Balipratipada
    '2025-11-05', // Guru Nanak Jayanti
    '2025-12-25', // Christmas

    // 2026 Holidays
    '2026-01-26', // Republic Day
    '2026-03-03', // Holi
    '2026-03-26', // Shri Ram Navami
    '2026-03-31', // Shri Mahavir Jayanti
    '2026-04-03', // Good Friday
    '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
    '2026-05-01', // Maharashtra Day
    '2026-05-28', // Bakri Id
    '2026-06-26', // Muharram
    '2026-09-14', // Ganesh Chaturthi
    '2026-10-02', // Mahatma Gandhi Jayanti
    '2026-10-20', // Dussehra
    '2026-11-10', // Diwali-Balipratipada
    '2026-11-24', // Sri Guru Nanak Dev Jayanti
    '2026-12-25', // Christmas

    // 2027 Holidays (Known national/fixed holidays)
    '2027-01-26', // Republic Day
    '2027-04-14', // Dr. Ambedkar Jayanti
    '2027-05-01', // Maharashtra Day
    '2027-08-15', // Independence Day
    '2027-10-02', // Mahatma Gandhi Jayanti
    '2027-12-25', // Christmas
]);

export interface ISTDetails {
    year: number;
    month: number;        // 1-12
    day: number;          // 1-31
    hours: number;        // 0-23
    minutes: number;      // 0-59
    seconds: number;      // 0-59
    dayOfWeek: number;    // 0=Sun, 1=Mon, ..., 6=Sat
    totalMinutes: number; // hours * 60 + minutes
    dateStr: string;      // YYYYMMDD
    timeStr: string;      // HHmmss
    isoDate: string;      // YYYY-MM-DD
    timestampStr: string; // YYYYMMDD_HHmmss
    displayTime: string;  // HH:mm:ss IST
}

/**
 * Returns exact Indian Standard Time breakdown for any given Date or timestamp.
 * Uses UTC getters shifted by +19,800,000ms for deterministic, cross-platform precision.
 */
export function getISTDetails(date: Date = new Date()): ISTDetails {
    const istMs = date.getTime() + IST_OFFSET_MS;
    const d = new Date(istMs);

    const year      = d.getUTCFullYear();
    const month     = d.getUTCMonth() + 1;
    const day       = d.getUTCDate();
    const hours     = d.getUTCHours();
    const minutes   = d.getUTCMinutes();
    const seconds   = d.getUTCSeconds();
    const dayOfWeek = d.getUTCDay();
    const totalMinutes = hours * 60 + minutes;

    const yStr   = String(year);
    const mStr   = String(month).padStart(2, '0');
    const dStr   = String(day).padStart(2, '0');
    const hStr   = String(hours).padStart(2, '0');
    const minStr = String(minutes).padStart(2, '0');
    const sStr   = String(seconds).padStart(2, '0');

    return {
        year,
        month,
        day,
        hours,
        minutes,
        seconds,
        dayOfWeek,
        totalMinutes,
        dateStr: `${yStr}${mStr}${dStr}`,
        timeStr: `${hStr}${minStr}${sStr}`,
        isoDate: `${yStr}-${mStr}-${dStr}`,
        timestampStr: `${yStr}${mStr}${dStr}_${hStr}${minStr}${sStr}`,
        displayTime: `${hStr}:${minStr}:${sStr} IST`,
    };
}

/**
 * Returns true if the given date is an official NSE market trading holiday.
 */
export function isNSEHoliday(date: Date = new Date()): boolean {
    const { isoDate } = getISTDetails(date);
    return NSE_TRADING_HOLIDAYS.has(isoDate);
}

/**
 * Returns true if the given date is an active NSE trading weekday (Monday–Friday, non-holiday).
 */
export function isNSETradingDay(date: Date = new Date()): boolean {
    const ist = getISTDetails(date);
    if (ist.dayOfWeek === 0 || ist.dayOfWeek === 6) return false; // Saturday or Sunday
    if (isNSEHoliday(date)) return false;
    return true;
}

/**
 * Returns true if the Indian stock market (NSE/BSE) is officially OPEN:
 * Mon–Fri, non-holiday, strictly between 09:15 AM and 03:30 PM IST (09:15 - 15:30).
 */
export function isNSEMarketOpen(date: Date = new Date()): boolean {
    if (!isNSETradingDay(date)) return false;

    const { totalMinutes } = getISTDetails(date);
    const openMins  = NSE_MARKET_OPEN_HOUR * 60 + NSE_MARKET_OPEN_MIN;   // 555 (09:15 IST)
    const closeMins = NSE_MARKET_CLOSE_HOUR * 60 + NSE_MARKET_CLOSE_MIN; // 930 (15:30 IST)

    return totalMinutes >= openMins && totalMinutes <= closeMins;
}

/**
 * Alias for isNSEMarketOpen() — explicitly represents Indian trading market time.
 * Used by cycleLogger to ensure cycle logs are ONLY generated during Indian market time.
 */
export function isIndianMarketTime(date: Date = new Date()): boolean {
    return isNSEMarketOpen(date);
}

/**
 * Returns true if current time is within the bot trading window for new order entries.
 * Default: Mon–Fri, non-holiday, 09:30 AM to 03:15 PM IST.
 */
export function isNSETradingHours(c?: Partial<ConfigType>, date: Date = new Date()): boolean {
    if (!isNSETradingDay(date)) return false;

    const { totalMinutes } = getISTDetails(date);
    const startHour = c?.UT_BOT_START_HOUR ?? BOT_TRADING_WINDOW_START_HOUR;
    const startMin  = c?.UT_BOT_START_MIN  ?? BOT_TRADING_WINDOW_START_MIN;
    const endHour   = c?.UT_BOT_END_HOUR   ?? BOT_TRADING_WINDOW_END_HOUR;
    const endMin    = c?.UT_BOT_END_MIN    ?? BOT_TRADING_WINDOW_END_MIN;

    const openMins  = startHour * 60 + startMin;
    const closeMins = endHour * 60 + endMin;

    return totalMinutes >= openMins && totalMinutes <= closeMins;
}

/**
 * Returns true if current time is within the UT Bot strategy entry window (default: 10:15 - 15:15 IST).
 */
export function isUTBotTradingWindow(c?: Partial<ConfigType>, date: Date = new Date()): boolean {
    if (!isNSETradingDay(date)) return false;

    const { totalMinutes } = getISTDetails(date);
    const startHour = c?.UT_BOT_START_HOUR ?? UT_BOT_TRADING_WINDOW_START_HOUR;
    const startMin  = c?.UT_BOT_START_MIN  ?? UT_BOT_TRADING_WINDOW_START_MIN;
    const endHour   = c?.UT_BOT_END_HOUR   ?? UT_BOT_TRADING_WINDOW_END_HOUR;
    const endMin    = c?.UT_BOT_END_MIN    ?? UT_BOT_TRADING_WINDOW_END_MIN;

    const startMins = startHour * 60 + startMin;
    const endMins   = endHour * 60 + endMin;

    return totalMinutes >= startMins && totalMinutes <= endMins;
}

/**
 * Returns true if current time is within the 03:00 PM – 03:15 PM IST ATR strategy execution window.
 */
export function is3pmTo315pmWindow(date: Date = new Date()): boolean {
    if (!isNSETradingDay(date)) return false;

    const { totalMinutes } = getISTDetails(date);
    const startMins = ATR14_TRADING_WINDOW_START_HOUR * 60 + ATR14_TRADING_WINDOW_START_MIN;
    const endMins   = ATR14_TRADING_WINDOW_END_HOUR * 60 + ATR14_TRADING_WINDOW_END_MIN;

    return totalMinutes >= startMins && totalMinutes <= endMins;
}

/**
 * Returns true if timestamp corresponds to the 09:15 AM opening candle in IST.
 */
export function isOpening915Candle(timestamp: number): boolean {
    const ist = getISTDetails(new Date(timestamp));
    return ist.hours === 9 && ist.minutes === 15;
}

/**
 * Returns the number of minutes remaining until bot trading cutoff (15:15 IST) or market close (15:30 IST).
 */
export function getMinutesToMarketClose(date: Date = new Date()): number {
    const { totalMinutes } = getISTDetails(date);
    const closeMins = BOT_TRADING_WINDOW_END_HOUR * 60 + BOT_TRADING_WINDOW_END_MIN;
    return closeMins - totalMinutes;
}
