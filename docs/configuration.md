# Configuration

## Source of Truth

Canonical runtime configuration is `src/config.ts`.

If this document and `README.md` disagree, follow `src/config.ts`.

## Required Environment Variables

These are required at startup (`requireEnv(...)` in `src/config.ts`):

- `BOT_TOKEN`
- `HS_FRESH_WALLET_CHAT_ID`
- `HS_WHALE_ACTIVITY_CHAT_ID`
- `HS_BIG_WHALE_CHAT_ID`
- `HS_TWAP_CHAT_ID`
- `HS_TRACK_CHAT_ID`
- `STAKE_CHAT_ID`
- `POLY_CHAT_ID`
- `OWNER_USER_ID`
- `OPENROUTER_API_KEY`
- `COINGLASS_API_KEY`
- `COINGLASS_CHAT_ID`

## Optional Environment Variables (Selected)

General/runtime:

- `NODE_ENV`
- `LOG_FILE_ENABLED`
- `LOG_LEVEL`
- `HEALTH_SERVER_PORT`

DB/cache:

- `MONGODB_URI`
- `DB_NAME`
- `REDIS_URL`
- `REDIS_PASSWORD`
- `DB_AUTO_INDEX`
- `DB_ENSURE_INDEXES_ON_START`

Hyperliquid:

- `HS_MIN_NOTIONAL_USD`
- `HS_MIN_SPOT_NOTIONAL_USD`
- `HS_AGGREGATION_WINDOW_MS`
- `HS_POS_CHANGE_ALERT_PERCENT`
- `HS_POS_CHANGE_ALERT_USD`

### Alert Branch Thresholds

| Variable | Default | Description |
|----------|---------|-------------|
| `HS_FRESH_WINDOW_MS` | `180000000` (50h) | Time window to consider a wallet "fresh" |
| `HS_FRESH_MIN_USD` | `200000` | Min position for fresh wallet alert (other coins) |
| `HS_FRESH_MAIN_COIN_MIN_USD` | `450000` | Min position for fresh wallet alert (main coins: BNB, XRP, DOGE, SOL, ZEC, HYPE) |
| `HS_WHALE_MIN_USD` | `300000` | Min position for whale activity alert (excl. BTC/ETH) |
| `HS_BIG_WHALE_MIN_USD` | `1000000` | Min position for big whale alert (all coins) |
| `HS_TWAP_BTC_ETH_MIN_USD` | `1000000` | Min accumulation for TWAP alert (BTC/ETH) |
| `HS_TWAP_OTHER_MIN_USD` | `300000` | Min accumulation for TWAP alert (other coins) |
| `HS_POS_CHANGE_ALERT_PERCENT` | `9` | Re-alert growth threshold (%) |

Note: Fresh Wallet and Whale Activity branches exclude BTC and ETH entirely.

Polymarket:

- `POLY_ALERT_THRESHOLD_USD`
- `POLY_SPORT_BET_ALERT_THRESHOLD_USD`
- `POLY_MAX_PRICE_FILTER`
- `POLY_POS_CHANGE_ALERT_PERCENT`
- `POLY_POS_CHANGE_ALERT_USD`
- `POLY_AGGREGATION_WINDOW_MS`

Stake:

- `STAKE_MIN_BET_USD`

Puppeteer:

- `PUPPETEER_SCREENSHOT_ENABLED`
- `PUPPETEER_USER_DIR`
- `PUPPETEER_HEADLESS`
- `PUPPETEER_PROXIES_PATH`
- `PUPPETEER_PROXIES`
- `PUPPETEER_EXECUTABLE_PATH` (read directly by tracker/screenshoter services)

OpenRouter:

- `OPENROUTER_CLASSIFIER_PROMPT_TEMPLATE_PATH`
- `OPENROUTER_FAST_MODEL`

CoinGlass OI Anomaly Tracker:

- `COINGLASS_EXCHANGES` (default: `Binance,OKX,Bybit`)
- `COINGLASS_REFRESH_INTERVAL_MS` (default: `3600000` / 1h)
- `COINGLASS_BLACKLIST` (default: empty — comma-separated tokens to exclude from detection)
- `COINGLASS_WARMUP_CONCURRENCY` (default: `5` — parallel warmup batch size)

### CoinGlass Detection Parameters (hardcoded in config.ts)

| Parameter | Value | Description |
|-----------|-------|-------------|
| Scan interval | 30 min | Evaluation frequency per pair |
| EWMA lookback | 96 intervals (48h) | Window for mean/variance |
| EWMA α | ~0.02062 | Decay factor |
| Fast spike (z) | > 4 | Single-interval robust z-score → HIGH |
| Slow accumulation (Σz) | > 6 | Cumulative z over 4 candles → HIGH |
| CUSUM threshold | > 8 | Sustained build → CRITICAL |
| CUSUM drift k | 1 | Sensitivity parameter |
| Stealth price | ≤ 2% | Price move to flag stealth positioning |
| Warmup | 96 candles | Before pair can alert |
| Cooldown | 6 hours | Per-pair suppression |

## Channel Routing

Each alert branch routes to its own dedicated Telegram channel (no topics):

| Branch | Env Variable |
|--------|-------------|
| Fresh Wallet | `HS_FRESH_WALLET_CHAT_ID` |
| Whale Activity | `HS_WHALE_ACTIVITY_CHAT_ID` |
| Big Whale | `HS_BIG_WHALE_CHAT_ID` |
| Big TWAP | `HS_TWAP_CHAT_ID` |
| Tracked Wallets | `HS_TRACK_CHAT_ID` |
| Stake | `STAKE_CHAT_ID` |
| Polymarket | `POLY_CHAT_ID` |
| CoinGlass OI | `COINGLASS_CHAT_ID` |

## Configuration Ownership Map

- Parsing and defaults: `src/config.ts`
- App startup and channel wiring: `src/index.ts`
- Health thresholds usage: `src/healthz.ts`, `src/common/tracker.ts`
- Tracker thresholds and timings:
  - `src/services/trackers/hyperliquid.ts`
  - `src/services/trackers/polymarket.ts`
  - `src/services/trackers/stake.ts`
  - `src/services/trackers/coinglass.ts`

## Operational Guidance

- Keep secrets only in local/runtime env files, never in git.
- When adding a new env var:
  1. Add it in `src/config.ts`.
  2. Document it in `README.md` and this file.
  3. Add example value in `.env.example`.
- Treat topic IDs and chat IDs as deployment configuration, not code constants.

## Related Docs

- `docs/architecture.md`
- `docs/operations.md`
