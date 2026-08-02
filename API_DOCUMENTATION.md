# Trading Cycle API Documentation

## Endpoint: POST /api/trading/trigger-cycle

Manually trigger the trading cycle with custom configuration. This endpoint allows you to run the trading cycle cron job once with specific config parameters and receive immediate feedback on success or failure.

## Request Format

### URL
```
POST http://localhost:3000/api/trading/trigger-cycle
```

### Headers
```
Content-Type: application/json
```

### Request Body

```json
{
  "config": {
    "USER_ID": "12345",
    "PRODUCT_ID": 3136,
    "SYMBOL": "ETHUSD",
    "TIMEFRAME": "4h",
    "INITIAL_BASE_QUANTITY": 10,
    "DRY_RUN": true
  }
}
```

**Note:** All fields in the `config` object are optional. Any fields you provide will override the default configuration. Fields not provided will use the default values from `TradingConfig`.

### Available Config Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `USER_ID` | string | User identifier | `"12345"` |
| `DELTAEX_USER_ID` | number | Delta Exchange user ID | `70111043` |
| `API_KEY` | string | API key for Delta Exchange | `"your-api-key"` |
| `SECRET_KEY` | string | Secret key for Delta Exchange | `"your-secret-key"` |
| `BASE_URL` | string | Base URL for Delta Exchange India | `"https://api.india.delta.exchange/v2"` |
| `PRODUCT_ID` | number | Product ID to trade | `3136` |
| `SYMBOL` | string | Trading symbol | `"ETHUSD"` |
| `LOT_SIZE` | number | Size of each lot | `0.01` |
| `PRICE_DECIMAL_PLACES` | number | Decimal places for price | `2` |
| `TIMEFRAME` | string | Candle timeframe | `"4h"` |
| `INITIAL_BASE_QUANTITY` | number | Initial quantity to trade | `10` |
| `MIN_CANDLE_BODY_PERCENT` | number | Minimum candle body percentage | `0.2` |
| `MAX_ALLOWED_PRICE_MOVEMENT_PERCENT` | number | Maximum allowed price movement | `4` |
| `MIN_ALLOWED_PRICE_MOVEMENT_PERCENT` | number | Minimum allowed price movement | `0.2` |
| `TAKE_PROFIT_PERCENT` | number | Take profit percentage (30x = 3000%) | `3000` |
| `SL_TRIGGER_BUFFER_PERCENT` | number | Stop loss trigger buffer | `0.1` |
| `SL_LIMIT_BUFFER_PERCENT` | number | Stop loss limit buffer | `0.2` |
| `TP_TRIGGER_BUFFER_PERCENT` | number | Take profit trigger buffer | `0.2` |
| `TP_LIMIT_BUFFER_PERCENT` | number | Take profit limit buffer | `0.3` |
| `DRY_RUN` | boolean | Enable dry run mode (no actual trades) | `true` |
| `IS_TESTING` | boolean | Enable testing mode | `false` |

## Response Format

### Success Response (200 OK)

```json
{
  "success": true,
  "message": "Trading cycle executed successfully",
  "timestamp": "2026-02-03T16:05:35+05:30",
  "config": {
    "USER_ID": "12345",
    "PRODUCT_ID": 3136,
    "SYMBOL": "ETHUSD",
    "TIMEFRAME": "4h",
    "INITIAL_BASE_QUANTITY": 10,
    "DRY_RUN": true
  }
}
```

### Error Response (500 Internal Server Error)

```json
{
  "success": false,
  "message": "Trading cycle execution failed",
  "timestamp": "2026-02-03T16:05:35+05:30",
  "error": "Detailed error message here",
  "config": {
    "PRODUCT_ID": 3136,
    "SYMBOL": "ETHUSD"
  }
}
```

## Usage Examples

### Example 1: Minimal Request (Use Defaults)

```bash
curl -X POST http://localhost:3000/api/trading/trigger-cycle \
  -H "Content-Type: application/json" \
  -d '{
    "config": {}
  }'
```

This will execute the trading cycle with all default configuration values.

### Example 2: Override Specific Fields

```bash
curl -X POST http://localhost:3000/api/trading/trigger-cycle \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "SYMBOL": "BTCUSD",
      "PRODUCT_ID": 3137,
      "DRY_RUN": true
    }
  }'
```

This will execute the trading cycle for BTCUSD with dry run enabled, using defaults for all other fields.

### Example 3: Full Custom Configuration

```bash
curl -X POST http://localhost:3000/api/trading/trigger-cycle \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "USER_ID": "test-user",
      "PRODUCT_ID": 3136,
      "SYMBOL": "ETHUSD",
      "TIMEFRAME": "1h",
      "INITIAL_BASE_QUANTITY": 5,
      "TAKE_PROFIT_PERCENT": 2000,
      "DRY_RUN": true
    }
  }'
```

### Example 4: Using Postman

1. Create a new POST request
2. Set URL to: `http://localhost:3000/api/trading/trigger-cycle`
3. Set Headers: `Content-Type: application/json`
4. Set Body (raw JSON):
```json
{
  "config": {
    "SYMBOL": "ETHUSD",
    "DRY_RUN": true
  }
}
```
5. Click Send

### Example 5: Using JavaScript/Fetch

```javascript
const response = await fetch('http://localhost:3000/api/trading/trigger-cycle', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    config: {
      SYMBOL: 'ETHUSD',
      PRODUCT_ID: 3136,
      DRY_RUN: true
    }
  })
});

const result = await response.json();
console.log(result);
```

## Important Notes

1. **Async Execution**: The endpoint waits for the trading cycle to complete before returning a response. This ensures you get accurate success/failure status.

2. **Config Isolation**: Each API call uses `AsyncLocalStorage` to isolate the config, so concurrent requests won't interfere with each other.

3. **No Impact on Cron**: Calling this API does not affect the scheduled cron job. The cron continues to run independently with its own configuration.

4. **Dry Run Mode**: For testing, always set `DRY_RUN: true` to prevent actual trades from being placed.

5. **Error Handling**: The endpoint catches all errors and returns them in the response. Check the `success` field to determine if the execution was successful.

6. **Logging**: All executions are logged with timestamps and config details for debugging purposes.

## Testing Recommendations

1. **Start with Dry Run**: Always test with `DRY_RUN: true` first
2. **Verify Config**: Check the returned config in the response to ensure your overrides were applied
3. **Monitor Logs**: Watch the server logs for detailed execution information
4. **Test Error Cases**: Try invalid configs to ensure error handling works correctly
