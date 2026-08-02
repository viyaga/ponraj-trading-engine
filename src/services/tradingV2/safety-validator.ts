import { ConfigType } from "./type";

export class SafetyValidator {
    static validate(
        c: ConfigType,
        state: any,
        mtf: any,
        now: Date,
        cronLogger: any,
        skipLogger: any
    ): boolean {
        const symbol = c.SYMBOL;

        // ───────────────── DAILY LOSS CHECK ─────────────────
        const dailyLossLimitUSD =
            state.dailyLossLimitUSD || c.CAPITAL_AMOUNT * (c.DAILY_LOSS_LIMIT / 100);
        if (
            state.dailyPnl < 0 &&
            Math.abs(state.dailyPnl) >= dailyLossLimitUSD &&
            dailyLossLimitUSD > 0
        ) {
            skipLogger.warn(
                `[DailyLoss] SKIP: Daily loss limit reached for ${symbol}. Current Loss: $${Math.abs(
                    state.dailyPnl
                ).toFixed(2)}, Limit: $${dailyLossLimitUSD.toFixed(2)} (${c.DAILY_LOSS_LIMIT}%)`
            );
            return false;
        }

        // ───────────────── CONSECUTIVE LOSS COOLDOWN CHECK ─────────────────
        if (state?.cooldownUntil) {
            const cooldownDate = new Date(state.cooldownUntil);
            if (cooldownDate > now && !c.IS_TESTING) {
                const remainingMs = cooldownDate.getTime() - now.getTime();
                const remainingMins = Math.ceil(remainingMs / (60 * 1000));
                skipLogger.warn(
                    `[Cooldown] SKIP: Trading paused for ${symbol} after ${state.consecutiveLosses || 3} consecutive losses. ${remainingMins} minutes remaining in cooldown (Active until: ${cooldownDate.toLocaleString()})`
                );
                return false;
            }
        }

        // ───────────────── WEEKEND FILTER ─────────────────
        const dayOfWeek = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
        if (
            c.IS_WEEKEND_SAFETY_ENABLED &&
            !c.IS_TESTING &&
            (dayOfWeek === 6 || dayOfWeek === 0)
        ) {
            skipLogger.info(
                `[SKIP] ${symbol}: Weekend trading disabled for safety (Day of week: ${dayOfWeek})`
            );
            return false;
        }

        // ───────────────── RUN MINUTES check ─────────────────
        const istMinutes = Number(
            now.toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
                minute: "numeric"
            })
        );
        cronLogger.debug(`Current time check for run minutes`, { istMinutes, now });

        if (!c.IS_TESTING && !c.RUN_MINUTES.includes(istMinutes)) {
            skipLogger.info(
                `[SKIP] ${symbol}: Not in RUN_MINUTES (Current: ${istMinutes}, Target List: ${c.RUN_MINUTES.join(
                    ","
                )})`
            );
            return false;
        }

        if (c.IS_TESTING && !c.RUN_MINUTES.includes(istMinutes)) {
            cronLogger.info(
                `[TESTING] Bypassing RUN_MINUTES check for ${symbol} (Current: ${istMinutes})`
            );
        }

        // ───────────────── MTF ALLOWED check ─────────────────
        if (!mtf.isAllowed) {
            skipLogger.info(
                `[SKIP] ${symbol}: MTF evaluation result is not allowed (Score: ${mtf.finalScore}, Decision: ${mtf.decision})`
            );
            return false;
        }

        return true;
    }
}
