# 📘 Trading Engine Configuration Guide

This guide explains every configuration parameter in the trading engine, what it does, how it affects trade execution, and recommended values for high-leverage crypto trading.

---

## 🎯 1. Risk-Reward & Level Management (TP / SL / Trailing)

### `MIN_RR`
* **Type:** `number` (e.g. `1.0`, `1.5`, `2.0`)
* **Default:** `1.0`
* **Explanation:** The minimum required **Net Risk-Reward Ratio** (after exchange fees) for a trade to be allowed. If a calculated setup has an RR below this number, the engine adjusts or skips the trade.
* **Usage:** Prevents taking trades where potential loss exceeds potential profit.

### `MIN_RR_ENFORCEMENT_MODE`
* **Type:** `"tp"` | `"sl"`
* **Default:** `"tp"` ⭐ *(Recommended)*
* **Explanation:** 
  * `"tp"` *(Recommended)*: Keeps the Stop Loss anchored to the real market structure and **extends Take Profit** to satisfy `MIN_RR`.
  * `"sl"`: Shortens Stop Loss closer to entry to satisfy `MIN_RR` (clamped by `MIN_SL_SAFETY_BUFFER_PERCENT`).
* **Usage:** Prevents stop-outs by keeping SL at real structural swing levels.

### `IS_TRAILING_SL_ENABLED`
* **Type:** `boolean` (`true` | `false`)
* **Default:** `true` ⭐ *(Recommended)*
* **Explanation:** When enabled, the engine recalculates swing levels on every candle cycle and **trails the Stop Loss forward into profit** behind the price action.
* **Usage:** Prevents winning trades from reversing into full Stop Loss losses.

### `SL_SELECTION_MODE`
* **Type:** `"structure"` | `"lookback_3"` | `"doji_filter"` | `"active_tf"` | `"tightest"` | `"fixed_atr"`
* **Default:** `"structure"`
* **Explanation:** Controls how the Stop Loss swing high/low anchor is chosen:
  1. **`"structure"`** ⭐: Anchors to 1h/15m structure candles. Filters out all 5m noise. Best for trend following.
  2. **`"doji_filter"`**: Inspects recent candles and skips small dojis (`bodyPercent < 40%`), anchoring SL to solid breakout candles.
  3. **`"lookback_3"`**: Takes the lowest low (BUY) or highest high (SELL) across the last 3 candles.
  4. **`"active_tf"`**: Anchors strictly to the active breakout candle's swing level.
  5. **`"tightest"`**: Picks the shortest SL among all timeframes within maximum movement limits.
  6. **`"fixed_atr"`**: Anchors SL purely to ATR distance (`SL_ATR_MULTIPLIER` x ATR), ignoring candle highs/lows.

### `SL_ATR_MULTIPLIER`
* **Type:** `number` (e.g. `1.0`, `1.5`, `2.0`)
* **Default:** `1.0`
* **Explanation:** The ATR multiplier used when `SL_SELECTION_MODE` is set to `"fixed_atr"`.

### `TP_SELECTION_MODE`
* **Type:** `"dynamic_atr"` | `"fixed_atr"` | `"fixed_rr"`
* **Default:** `"dynamic_atr"`
* **Explanation:** Controls how the Take Profit target is selected:
  1. **`"dynamic_atr"`** ⭐: Dynamically scales ATR (1.0x - 2.5x) based on entry score, HTF trend alignment (+0.3x), and volume surge (+0.2x).
  2. **`"fixed_atr"`**: Uses ATR distance (`TP_ATR_MULTIPLIER` x ATR) from entry price.
  3. **`"fixed_rr"`**: Calculates TP directly from the configured Risk-to-Reward ratio (`MIN_RR`).

### `TP_ATR_MULTIPLIER`
* **Type:** `number` (e.g. `1.5`, `2.0`, `3.0`)
* **Default:** `2.0`
* **Explanation:** The ATR multiplier used when `TP_SELECTION_MODE` is set to `"fixed_atr"`.

### `MIN_SL_SAFETY_BUFFER_PERCENT`
* **Type:** `number` (e.g. `0.2` = `0.2%`)
* **Default:** `0.2`
* **Explanation:** The absolute minimum safe distance between entry price and Stop Loss. Even if RR adjustment shortens SL, it will **never tighten SL closer than this floor**.
* **Usage:** Protects trades from getting stopped out instantly by order book spread or micro-noise.

### `MIN_TP_PRICE_MOVEMENT_PERCENT`
* **Type:** `number` (e.g. `0.4` = `0.4%`)
* **Default:** `0.4`
* **Explanation:** The minimum distance for Take Profit from entry price.
* **Usage:** Ensures TP is far enough that trading fees (0.1%) don't consume profits.

### `MAX_TP_PRICE_MOVEMENT_PERCENT`
* **Type:** `number` (e.g. `3.0` = `3.0%`)
* **Default:** `3.0`
* **Explanation:** The maximum upper ceiling for Take Profit distance.
* **Usage:** Prevents the bot from setting unrealistic TP targets on extreme volatility spikes.

### `MAX_ALLOWED_PRICE_MOVEMENT_PERCENT`
* **Type:** `number` (e.g. `1.5` = `1.5%`)
* **Default:** `1.5`
* **Explanation:** Maximum allowed distance for initial Stop Loss.
* **Usage:** If a candle swing low/high is further than `1.5%` away, the trade is rejected to prevent huge drawdown on 40x leverage.

### `SL_TRIGGER_BUFFER_PERCENT` & `TP_TRIGGER_BUFFER_PERCENT`
* **Type:** `number` (e.g. `0.2` = `0.2%`)
* **Default:** `0.2`
* **Explanation:** Safety offset added beyond candle high/low.
* **Usage:** Protects SL from getting triggered by exchange liquidity wicks.

### `IS_TP_REDUCTION_ENABLED`
* **Type:** `boolean` (`true` | `false`)
* **Default:** `true`
* **Explanation:** If market momentum slows down while in an open trade, the engine automatically **lowers the target TP** to capture profit before a reversal.

---

## 🛡️ 2. Exit Strategies & Safety Controls

### `IS_CANDLE_LIMIT_EXIT_ENABLED` & `MAX_HOLDING_CANDLES_MAP`
* **Type:** `boolean` & `Record<string, number>`
* **Default:** `{ "5m": 12, "15m": 8, "1h": 6, "4h": 4 }`
* **Explanation:** Automatically closes stagnating trades after a fixed number of candles (e.g. 12 candles on 5m = 1 hour max hold time).
* **Usage:** Prevents capital from being trapped in dead/ranging trades.

### `IS_MOMENTUM_INVALIDATION_EXIT_ENABLED`
* **Type:** `boolean` (`true` | `false`)
* **Default:** `true`
* **Explanation:** Closes open positions early if multi-timeframe score drops below thresholds for `MOMENTUM_INVALIDATION_CONSECUTIVE_CYCLES` (e.g. 2 consecutive cycles).
* **Usage:** Cuts losses early if market structure breaks against your trade.

### `IS_WEEKEND_SAFETY_ENABLED`
* **Type:** `boolean` (`true` | `false`)
* **Default:** `true`
* **Explanation:** Adjusts risk or pauses new entries during low-liquidity weekend hours.

---

## 📊 3. Multi-Timeframe Scoring System

### `TIMEFRAME`, `CONFIRMATION_TIMEFRAME`, `STRUCTURE_TIMEFRAME`
* **Defaults:** `"5m"` (Entry), `"15m"` (Confirmation), `"1h"` (Structure)
* **Explanation:** The 3 timeframes evaluated in parallel:
  * **5m (25% weight):** Entry timing & immediate breakout velocity.
  * **15m (45% weight):** Medium trend confirmation & candle probability.
  * **1h (30% weight):** Macro market structure & EMA 20 trend alignment.

### `MIN_FINAL_SCORE`
* **Type:** `number` (e.g. `70`)
* **Default:** `70`
* **Explanation:** Minimum combined multi-timeframe score required to allow a trade.
  * `>= 75`: STRONG_TRADE
  * `70–74`: GOOD_TRADE
  * `< 70`: SKIP / REJECTED

---

## 💰 4. Money & Account Management

### `LEVERAGE`
* **Type:** `number` (e.g. `40`)
* **Explanation:** Position leverage multiplier on exchange orders.

### `CAPITAL_AMOUNT`, `MIN_TRADE_SIZE`, `MAX_TRADE_SIZE`
* **Explanation:** Capital allocation and position margin boundaries per trade in USD.

### `DAILY_LOSS_LIMIT`
* **Type:** `number` (e.g. `10` = `$10` or `10%`)
* **Explanation:** Hard daily loss limit. Trading pauses if total daily PnL breaches this limit.

### `MAX_CONCURRENT_TRADES`
* **Type:** `number` (e.g. `3`)
* **Explanation:** Maximum number of open positions across all trading bots simultaneously.

---

## ⚙️ Summary of Recommended Production Config

```typescript
{
    MIN_RR: 1.0,
    MIN_RR_ENFORCEMENT_MODE: "tp",      // ✅ Structural SL + Extended TP
    IS_TRAILING_SL_ENABLED: true,       // ✅ Dynamic SL Trailing active
    SL_SELECTION_MODE: "structure",     // ✅ Options: "structure" | "doji_filter" | "lookback_3" | "fixed_atr"
    MIN_SL_SAFETY_BUFFER_PERCENT: 0.2,
    MIN_TP_PRICE_MOVEMENT_PERCENT: 0.4,
    MAX_ALLOWED_PRICE_MOVEMENT_PERCENT: 1.5,
    IS_TP_REDUCTION_ENABLED: true,      // ✅ Dynamic TP Reduction
    IS_CANDLE_LIMIT_EXIT_ENABLED: true, // ✅ Time-based exit for dead trades
    IS_MOMENTUM_INVALIDATION_EXIT_ENABLED: true,
    MIN_FINAL_SCORE: 70
}
```
