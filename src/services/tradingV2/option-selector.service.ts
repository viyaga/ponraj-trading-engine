// =============================================================================
// OptionSelectorService — Smart Option Selection Pipeline
// =============================================================================
//
// Pipeline:
//   1. Filter NFO instruments by index + option type + valid (future) expiry
//   2. Build a candidate strike range: ATM ± N steps around spot price
//   3. Fetch live LTP for all candidate tradingsymbols via Zerodha getLTP()
//   4. Filter to options priced within OPTION_MIN_PREMIUM–OPTION_MAX_PREMIUM
//   5. Score and pick the best:
//        - Primary:   closest to ATM (minimise | strike - spot |)
//        - Secondary: highest LTP within range (more liquid premium)
//   6. Log all candidates and the winner
//
// Falls back gracefully if no option is found in the LTP range:
//   → Tries expanding search by ±2 extra strikes before giving up
//   → If still none, skips the trade (returns null)
// =============================================================================

import { KiteInstrument, OptionType, ConfigType } from './type';
import { KiteExchange } from './kite-exchange';
import { tradingCronLogger, tradingCycleErrorLogger } from './logger';
import env from '../../config/env';

// How many strikes on each side of ATM to check (e.g. 6 = ATM, ATM±50, ATM±100, ..., ATM±300)
const STRIKE_SCAN_RADIUS      = 6;
// How many extra strikes to add on each side when no option is found in the primary radius
const STRIKE_SCAN_EXPAND_BY   = 2;
// Max instruments per Kite getLTP call (Kite caps at ~500 but we keep it small)
const KITE_LTP_BATCH_SIZE     = 50;

export interface SelectedOption {
    instrument:     KiteInstrument;
    ltp:            number;     // live premium price
    strikeDistance: number;     // | strike - ATM | in points
}

export class OptionSelectorService {

    /**
     * Main entry point. Scans available options, fetches live LTPs, filters by
     * the configured premium range, and returns the best match.
     *
     * @param instruments   Pre-cached NFO instrument list (from Zerodha dump)
     * @param kite          Authenticated KiteExchange instance (for getLTP)
     * @param config        Bot config (INDEX, EXPIRY_TYPE, OPTION_MIN/MAX_PREMIUM, etc.)
     * @param optionType    'CE' | 'PE' — direction from strategy signal
     * @param spotPrice     Current index spot price (for ATM calculation)
     * @param stepSize      Strike step (50 for NIFTY, 100 for BANKNIFTY)
     * @param tag           Log tag prefix (e.g. "[TradingCycle:botId:NIFTY]")
     */
    static async selectBestOption(
        instruments:  KiteInstrument[],
        kite:         KiteExchange,
        config:       ConfigType,
        optionType:   OptionType,
        spotPrice:    number,
        stepSize:     number,
        tag:          string
    ): Promise<SelectedOption | null> {

        const atm = Math.round(spotPrice / stepSize) * stepSize;
        const primaryScanRange = STRIKE_SCAN_RADIUS * stepSize;
        const expandedScanRange = (STRIKE_SCAN_RADIUS + STRIKE_SCAN_EXPAND_BY) * stepSize;

        tradingCronLogger.info(
            `\n${tag} ╔══════════════════════════════════════════════════════════════\n` +
            `${tag} ║  [OptionSelector] SCAN START\n` +
            `${tag} ║  Index:         ${config.INDEX} ${optionType}\n` +
            `${tag} ║  Spot Price:    ₹${spotPrice.toFixed(2)}\n` +
            `${tag} ║  ATM Strike:    ${atm}\n` +
            `${tag} ║  Step Size:     ${stepSize} pts\n` +
            `${tag} ║  Primary Range: ATM ± ${primaryScanRange} pts  (${STRIKE_SCAN_RADIUS * 2 + 1} strikes)\n` +
            `${tag} ║  Expand Range:  ATM ± ${expandedScanRange} pts  (${(STRIKE_SCAN_RADIUS + STRIKE_SCAN_EXPAND_BY) * 2 + 1} strikes)\n` +
            `${tag} ║  Premium Filter: ₹${config.OPTION_MIN_PREMIUM} – ₹${config.OPTION_MAX_PREMIUM}\n` +
            `${tag} ║  Expiry Type:   ${config.EXPIRY_TYPE}\n` +
            `${tag} ║  Total NFO Instruments in cache: ${instruments.length}\n` +
            `${tag} ╚══════════════════════════════════════════════════════════════`
        );

        // Try primary radius first, then expand once if nothing found
        for (const radius of [STRIKE_SCAN_RADIUS, STRIKE_SCAN_RADIUS + STRIKE_SCAN_EXPAND_BY]) {
            const isExpanded = radius > STRIKE_SCAN_RADIUS;

            tradingCronLogger.info(
                `${tag} [OptionSelector] 🔍 Pass ${isExpanded ? '2 (EXPANDED)' : '1 (primary)'} — ` +
                `scanning ATM ± ${radius * stepSize} pts (radius: ${radius} strikes)`
            );

            const result = await this.scanWithRadius(
                instruments, kite, config, optionType, spotPrice, atm, stepSize, radius, tag
            );
            if (result) return result;

            if (!isExpanded) {
                tradingCronLogger.warn(
                    `${tag} [OptionSelector] ⚠️  Pass 1 complete — no option found in ₹${config.OPTION_MIN_PREMIUM}–₹${config.OPTION_MAX_PREMIUM} ` +
                    `within ATM ± ${primaryScanRange} pts. Expanding search to ATM ± ${expandedScanRange} pts...`
                );
            }
        }

        tradingCycleErrorLogger.error(
            `${tag} [OptionSelector] ✖ SCAN FAILED — No ${config.INDEX} ${optionType} option found ` +
            `in premium range ₹${config.OPTION_MIN_PREMIUM}–₹${config.OPTION_MAX_PREMIUM} ` +
            `after scanning ATM ± ${expandedScanRange} pts. ` +
            `Consider widening OPTION_MIN_PREMIUM / OPTION_MAX_PREMIUM in bot config.`
        );
        return null;
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private static async scanWithRadius(
        instruments:  KiteInstrument[],
        kite:         KiteExchange,
        config:       ConfigType,
        optionType:   OptionType,
        spotPrice:    number,
        atm:          number,
        stepSize:     number,
        radius:       number,
        tag:          string
    ): Promise<SelectedOption | null> {

        // 1. Build candidate strikes: ATM, ATM±step, ATM±2*step … up to radius
        const strikes = new Set<number>();
        for (let i = 0; i <= radius; i++) {
            strikes.add(atm + i * stepSize);
            if (i > 0) strikes.add(atm - i * stepSize);
        }

        const sortedStrikes = [...strikes].sort((a, b) => a - b);
        tradingCronLogger.info(
            `${tag} [OptionSelector] Strike scan set (${sortedStrikes.length} strikes): ` +
            sortedStrikes.map(s => s === atm ? `[${s}=ATM]` : `${s}`).join(', ')
        );

        // 2. Filter instrument list for valid candidates
        const today = new Date();
        const todayMs = today.getTime();

        // Count rejections by reason for debug insight
        let rejName = 0, rejType = 0, rejStrike = 0, rejExpiry = 0;

        const candidates = instruments.filter(ins => {
            if (ins.name !== config.INDEX)           { rejName++;   return false; }
            if (ins.instrument_type !== optionType)  { rejType++;   return false; }
            if (!strikes.has(ins.strike))            { rejStrike++; return false; }
            const expiryMs = new Date(ins.expiry).getTime();
            if (expiryMs < todayMs)                  { rejExpiry++; return false; }
            return true;
        });

        tradingCronLogger.info(
            `${tag} [OptionSelector] Instrument filter results:\n` +
            `  Total checked:     ${instruments.length}\n` +
            `  ✅ Passed:         ${candidates.length}\n` +
            `  ❌ Wrong index:    ${rejName}\n` +
            `  ❌ Wrong type:     ${rejType}\n` +
            `  ❌ Strike not in scan range: ${rejStrike}\n` +
            `  ❌ Expired:        ${rejExpiry}`
        );

        if (!candidates.length) {
            tradingCronLogger.warn(
                `${tag} [OptionSelector] ⚠️  No live instruments found for ${config.INDEX} ${optionType} ` +
                `in strike set [${sortedStrikes.join(', ')}]. ` +
                `Check that the NFO instrument cache is populated and not stale.`
            );
            return null;
        }

        // 3. Pick nearest expiry per strike (weekly or monthly)
        const perStrike = this.selectNearestExpiries(candidates, config.EXPIRY_TYPE, tag);

        tradingCronLogger.info(
            `${tag} [OptionSelector] After expiry selection (${config.EXPIRY_TYPE}): ` +
            `${perStrike.length} instruments selected:\n` +
            perStrike
                .sort((a, b) => a.strike - b.strike)
                .map(i => `  • ${i.tradingsymbol.padEnd(22)} Strike: ${String(i.strike).padStart(6)}  Expiry: ${i.expiry}`)
                .join('\n')
        );

        // 4. Fetch live LTP for all candidates via Zerodha getLTP (batched)
        tradingCronLogger.info(
            `${tag} [OptionSelector] Fetching live LTPs from Zerodha for ${perStrike.length} symbols...`
        );
        const ltpMap = await this.fetchLTPsFromKite(kite, perStrike, tag);

        tradingCronLogger.info(
            `${tag} [OptionSelector] LTP fetch complete: ${ltpMap.size}/${perStrike.length} prices received`
        );

        if (!ltpMap.size) {
            tradingCronLogger.warn(
                `${tag} [OptionSelector] ⚠️  Zerodha returned no LTPs for any candidate. ` +
                `This may indicate a Kite API permission issue or a market holiday.`
            );
            return null;
        }

        // 5. Filter by premium range and score — log full table
        const inRange: Array<{ instrument: KiteInstrument; ltp: number; strikeDistance: number }> = [];
        const tableRows: string[] = [];

        for (const ins of perStrike.sort((a, b) => a.strike - b.strike)) {
            const key = `NFO:${ins.tradingsymbol}`;
            const ltp = ltpMap.get(key);
            const strikeDistance = Math.abs(ins.strike - atm);
            const distLabel = ins.strike === atm ? 'ATM' :
                ins.strike > atm ? `+${strikeDistance}` : `-${strikeDistance}`;

            if (ltp == null) {
                tableRows.push(
                    `  ⚠️  ${ins.tradingsymbol.padEnd(22)} Strike: ${String(ins.strike).padStart(6)} (${distLabel.padStart(5)})  LTP: N/A — no price returned`
                );
                continue;
            }

            const inPremiumRange = ltp >= config.OPTION_MIN_PREMIUM && ltp <= config.OPTION_MAX_PREMIUM;
            const tooLow  = ltp < config.OPTION_MIN_PREMIUM;
            const tooHigh = ltp > config.OPTION_MAX_PREMIUM;

            const rangeStatus = inPremiumRange ? '✅ IN RANGE' :
                tooLow  ? `❌ TOO LOW  (need ≥₹${config.OPTION_MIN_PREMIUM}, got ₹${ltp.toFixed(2)})` :
                           `❌ TOO HIGH (need ≤₹${config.OPTION_MAX_PREMIUM}, got ₹${ltp.toFixed(2)})`;

            tableRows.push(
                `  ${inPremiumRange ? '✅' : '❌'} ${ins.tradingsymbol.padEnd(22)} ` +
                `Strike: ${String(ins.strike).padStart(6)} (${distLabel.padStart(5)})  ` +
                `LTP: ₹${ltp.toFixed(2).padStart(7)}  ${rangeStatus}`
            );

            if (inPremiumRange) {
                inRange.push({ instrument: ins, ltp, strikeDistance });
            }
        }

        tradingCronLogger.info(
            `${tag} [OptionSelector] ─── Premium Scan Table (range: ₹${config.OPTION_MIN_PREMIUM}–₹${config.OPTION_MAX_PREMIUM}) ───\n` +
            tableRows.join('\n') + '\n' +
            `${tag} [OptionSelector] ─── ${inRange.length} of ${perStrike.length} options passed the premium filter ───`
        );

        if (!inRange.length) {
            // Find the nearest LTP to range to give a helpful hint
            const ltpValues = perStrike
                .map(ins => ({ sym: ins.tradingsymbol, strike: ins.strike, ltp: ltpMap.get(`NFO:${ins.tradingsymbol}`) }))
                .filter(x => x.ltp != null) as { sym: string; strike: number; ltp: number }[];

            if (ltpValues.length) {
                const byDist = ltpValues.sort((a, b) => {
                    const dA = Math.min(Math.abs(a.ltp - config.OPTION_MIN_PREMIUM), Math.abs(a.ltp - config.OPTION_MAX_PREMIUM));
                    const dB = Math.min(Math.abs(b.ltp - config.OPTION_MIN_PREMIUM), Math.abs(b.ltp - config.OPTION_MAX_PREMIUM));
                    return dA - dB;
                });
                const closest = byDist[0];
                tradingCronLogger.warn(
                    `${tag} [OptionSelector] Closest out-of-range option: ${closest.sym} @ ₹${closest.ltp.toFixed(2)} ` +
                    `(range miss: ₹${Math.abs(closest.ltp < config.OPTION_MIN_PREMIUM
                        ? config.OPTION_MIN_PREMIUM - closest.ltp
                        : closest.ltp - config.OPTION_MAX_PREMIUM).toFixed(2)})`
                );
            }
            return null;
        }

        // 6. Pick best:
        // In testing mode: pick option with lowest LTP to execute for the smallest amount possible
        // In live mode: (a) closest to ATM first  (b) highest LTP as tiebreaker
        if (env.isTesting) {
            inRange.sort((a, b) => a.ltp - b.ltp);
        } else {
            inRange.sort((a, b) => {
                if (a.strikeDistance !== b.strikeDistance) return a.strikeDistance - b.strikeDistance;
                return b.ltp - a.ltp;
            });
        }

        tradingCronLogger.info(
            `${tag} [OptionSelector] Ranking of ${inRange.length} in-range option(s):\n` +
            inRange.map((opt, idx) =>
                `  ${idx === 0 ? '🏆' : `#${idx + 1}`} ${opt.instrument.tradingsymbol.padEnd(22)} ` +
                `LTP: ₹${opt.ltp.toFixed(2)}  Distance: ${opt.strikeDistance} pts  Expiry: ${opt.instrument.expiry}`
            ).join('\n')
        );

        const winner = inRange[0];
        tradingCronLogger.info(
            `${tag} [OptionSelector] ✅ WINNER: ${winner.instrument.tradingsymbol} | ` +
            `LTP: ₹${winner.ltp.toFixed(2)} | Strike: ${winner.instrument.strike} | ` +
            `Distance from ATM: ${winner.strikeDistance} pts | Expiry: ${winner.instrument.expiry} | ` +
            `Lot size: ${winner.instrument.lot_size}`
        );

        return winner;
    }

    /**
     * From a list of candidates, pick the best (nearest) expiry per strike.
     * Honours the bot's EXPIRY_TYPE (weekly = nearest, monthly = nearest monthly).
     */
    private static selectNearestExpiries(
        candidates: KiteInstrument[],
        expiryType: 'weekly' | 'monthly',
        tag?: string
    ): KiteInstrument[] {
        const today = new Date();
        const byStrike = new Map<number, KiteInstrument[]>();

        for (const ins of candidates) {
            const list = byStrike.get(ins.strike) ?? [];
            list.push(ins);
            byStrike.set(ins.strike, list);
        }

        const result: KiteInstrument[] = [];
        for (const [strike, list] of byStrike) {
            const sorted = list
                .map(ins => ({ ins, expiryMs: new Date(ins.expiry).getTime() }))
                .filter(({ expiryMs }) => expiryMs >= today.getTime())
                .sort((a, b) => a.expiryMs - b.expiryMs);

            if (!sorted.length) {
                if (tag) tradingCronLogger.debug(`${tag} [OptionSelector] Strike ${strike}: all expiries are past — skipped`);
                continue;
            }

            if (expiryType === 'weekly') {
                const chosen = sorted[0].ins;
                if (tag) tradingCronLogger.debug(
                    `${tag} [OptionSelector] Strike ${strike}: weekly → ${chosen.tradingsymbol} (expiry: ${chosen.expiry}, ` +
                    `${sorted.length} expiries available)`
                );
                result.push(chosen);
            } else {
                // Monthly: first expiry with date >= 25 (NSE monthly expiry pattern)
                const monthly = sorted.find(({ ins }) => new Date(ins.expiry).getDate() >= 25);
                const chosen = (monthly ?? sorted[0]).ins;
                if (tag) tradingCronLogger.debug(
                    `${tag} [OptionSelector] Strike ${strike}: monthly → ${chosen.tradingsymbol} ` +
                    `(expiry: ${chosen.expiry}${!monthly ? ' [fallback to nearest]' : ''}, ` +
                    `${sorted.length} expiries available)`
                );
                result.push(chosen);
            }
        }

        return result;
    }

    /**
     * Batch-fetch LTPs from Zerodha for the given instruments.
     * Returns a map of "NFO:tradingsymbol" → last_price.
     */
    private static async fetchLTPsFromKite(
        kite:        KiteExchange,
        instruments: KiteInstrument[],
        tag:         string
    ): Promise<Map<string, number>> {
        const result = new Map<string, number>();
        const symbols = instruments.map(ins => `NFO:${ins.tradingsymbol}`);
        const totalBatches = Math.ceil(symbols.length / KITE_LTP_BATCH_SIZE);

        tradingCronLogger.debug(
            `${tag} [OptionSelector] LTP fetch: ${symbols.length} symbols, ` +
            `${totalBatches} batch(es) of ≤${KITE_LTP_BATCH_SIZE}`
        );

        for (let i = 0; i < symbols.length; i += KITE_LTP_BATCH_SIZE) {
            const batch = symbols.slice(i, i + KITE_LTP_BATCH_SIZE);
            const batchNum = Math.floor(i / KITE_LTP_BATCH_SIZE) + 1;

            tradingCronLogger.debug(
                `${tag} [OptionSelector] LTP batch ${batchNum}/${totalBatches}: ` +
                `requesting [${batch.join(', ')}]`
            );

            try {
                const startMs = Date.now();
                const ltpRes = await kite.getLTP(batch);
                const duration = Date.now() - startMs;

                const fetched = Object.keys(ltpRes).length;
                const missing = batch.filter(sym => !(sym in ltpRes));

                for (const [sym, val] of Object.entries(ltpRes)) {
                    if (val?.last_price != null) {
                        result.set(sym, Number(val.last_price));
                    }
                }

                tradingCronLogger.info(
                    `${tag} [OptionSelector] LTP batch ${batchNum}/${totalBatches} (${duration}ms): ` +
                    `${fetched}/${batch.length} prices received` +
                    (missing.length ? ` | ⚠️  Missing: ${missing.join(', ')}` : ' | ✅ All received')
                );
            } catch (err: any) {
                tradingCronLogger.warn(
                    `${tag} [OptionSelector] ⚠️  LTP batch ${batchNum}/${totalBatches} FAILED: ` +
                    `${err.message} | Symbols: ${batch.join(', ')}`
                );
            }
        }

        tradingCronLogger.debug(
            `${tag} [OptionSelector] LTP fetch total: ${result.size}/${symbols.length} prices in map`
        );

        return result;
    }
}
