# Configuration

## Source of Truth

Canonical runtime configuration is `src/config.ts`.

If this document and `README.md` disagree, follow `src/config.ts`.

## Required Environment Variables

These are required at startup (`requireEnv(...)` in `src/config.ts`):

- `BOT_TOKEN`
- `HL_FRESH_WALLET_CHAT_ID`
- `HL_WHALE_ACTIVITY_CHAT_ID`
- `HL_BIG_WHALE_CHAT_ID`
- `HL_TWAP_CHAT_ID`
- `HL_TRACK_CHAT_ID`
- `STAKE_CHAT_ID`
- `POLY_CHAT_ID`
- `OWNER_USER_ID`
- `OPENROUTER_API_KEY`
- `COINGLASS_API_KEY`
- `OI_CHAT_ID`
- `OI_HL_CHAT_ID`

## Optional Environment Variables (Selected)

General/runtime:

- `NODE_ENV`
- `LOG_FILE_ENABLED`
- `LOG_LEVEL`
- `HEALTH_SERVER_PORT`
- `RESTART_ON_UNHEALTHY` (default `false`; when `true`, the process exits with code `1` after the unhealthy alert so an orchestrator can restart it)

DB/cache:

- `MONGODB_URI`
- `DB_NAME`
- `REDIS_MODE`
- `REDIS_URL`
- `REDIS_PASSWORD`
- `DB_AUTO_INDEX`
- `DB_ENSURE_INDEXES_ON_START`

Hyperliquid:

- `HL_EXCLUDE_DEXES`
- `HL_MIN_NOTIONAL_USD`
- `HL_MIN_SPOT_NOTIONAL_USD`
- `HL_AGGREGATION_WINDOW_MS`
- `HL_POS_CHANGE_ALERT_PERCENT`
- `HL_POS_CHANGE_ALERT_USD`
- `HL_SCREENSHOT_ENABLED`

### Alert Branch Thresholds

| Variable | Default | Description |
|----------|---------|-------------|
| `HL_FRESH_WINDOW_MS` | `180000000` (50h) | Time window to consider a wallet "fresh" |
| `HL_FRESH_MIN_USD` | `200000` | Min position for fresh wallet alert (other coins) |
| `HL_FRESH_MAIN_COIN_MIN_USD` | `450000` | Min position for fresh wallet alert (main coins: BTC, ETH, BNB, XRP, ZEC, DOGE, SOL, HYPE) |
| `HL_WHALE_MIN_USD` | `300000` | Min position for whale activity alert (excl. BTC/ETH) |
| `HL_BIG_WHALE_MIN_USD` | `1000000` | Min position for big whale alert (all coins) |
| `HL_TWAP_BTC_ETH_MIN_USD` | `1000000` | Min accumulation for TWAP alert (BTC/ETH) |
| `HL_TWAP_OTHER_MIN_USD` | `300000` | Min accumulation for TWAP alert (other coins) |
| `HL_POS_CHANGE_ALERT_PERCENT` | `9` | Re-alert growth threshold (%) |

Note: Fresh Wallet and Whale Activity branches exclude BTC and ETH entirely.

Polymarket:

- `POLY_ALERT_THRESHOLD_USD`
- `POLY_SPORT_BET_ALERT_THRESHOLD_USD`
- `POLY_MAX_PRICE_FILTER`
- `POLY_POS_CHANGE_ALERT_PERCENT`
- `POLY_POS_CHANGE_ALERT_USD`
- `POLY_AGGREGATION_WINDOW_MS`
- `POLY_SCREENSHOT_ENABLED`

Stake:

- `STAKE_MIN_BET_USD`
- `STAKE_SCREENSHOT_ENABLED`

Puppeteer (browser runtime used by the shared screenshoter):

- `PUPPETEER_USER_DIR`
- `PUPPETEER_HEADLESS`
- `PUPPETEER_CONCURRENT_CAPTURES` (default `false`: captures are serialized through a singleton FIFO queue; set to `true` to allow concurrent captures across trackers)
- `PUPPETEER_PROXIES_PATH`
- `PUPPETEER_PROXIES`
- `PUPPETEER_EXECUTABLE_PATH` (read directly by the screenshoter service)

Per-tracker screenshot enablement is controlled by `HL_SCREENSHOT_ENABLED`, `STAKE_SCREENSHOT_ENABLED`, `POLY_SCREENSHOT_ENABLED`, and `OI_SCREENSHOT_ENABLED`. The screenshoter itself is a process-wide singleton shared by all trackers.

OpenRouter:

- `OPENROUTER_CLASSIFIER_PROMPT_TEMPLATE_PATH`
- `OPENROUTER_FAST_MODEL`

CoinGlass OI Anomaly Tracker:

- `COINGLASS_EXCHANGES` (default: `Gate,Bybit,Binance,OKX,Kraken`; do not include `Hyperliquid` or `Aster`, which are managed by direct sources)
- `COINGLASS_REFRESH_INTERVAL_MS` (default: `3600000` / 1h)
- `COINGLASS_GAP_THRESHOLD_INTERVALS` (default: `3` — missed intervals before a pair enters DEGRADED_DATA)
- `OI_SCREENSHOT_ENABLED` (default: `true`)

The Hyperliquid OI collection interval (15 min) and the Coinglass scan sleep (5 min) are hardcoded in `config.oi` and are not environment-configurable.

### CoinGlass Detection Parameters (hardcoded in config.ts)

| Parameter | Value | Description |
|-----------|-------|-------------|
| Coinglass scan sleep | 5 min | Sleep between Coinglass scan cycles (hardcoded) |
| Hyperliquid scan interval | 15 min | Direct Hyperliquid OI collection cycle (hardcoded) |
| Candle interval | 30 min | Coinglass OI candle granularity |
| Warmup candles | 96 (48h) | Ring buffer size and minimum candles before alerting |
| EWMA α | ~0.02062 | Decay factor (2 / (warmupCandles + 1)) |
| Fast spike (z) | > 4 | Single-interval robust z-score → HIGH |
| Slow accumulation (Σz) | > 8 | Cumulative z over 4 candles → HIGH |
| CUSUM threshold | > 12 | Sustained build → CRITICAL |
| CUSUM drift k | 1 | Sensitivity parameter |
| Min OI | >= $1.0M | Ignore low-OI markets |
| Min delta OI (USD) | >= $100K | Global gate for all triggers |
| Min delta OI (%) | >= 1.5% | Global gate for all triggers |
| Stealth price | ≤ 2% | Price move to flag stealth positioning |
| Warmup | 96 candles | Before pair can alert |
| Cooldown | 6 hours | Per-pair suppression |

## Channel Routing

Each alert branch routes to its own dedicated Telegram channel (no topics):

| Branch | Env Variable |
|--------|-------------|
| Fresh Wallet | `HL_FRESH_WALLET_CHAT_ID` |
| Whale Activity | `HL_WHALE_ACTIVITY_CHAT_ID` |
| Big Whale | `HL_BIG_WHALE_CHAT_ID` |
| Big TWAP | `HL_TWAP_CHAT_ID` |
| Tracked Wallets | `HL_TRACK_CHAT_ID` |
| Stake | `STAKE_CHAT_ID` |
| Polymarket | `POLY_CHAT_ID` |
| CoinGlass OI | `OI_CHAT_ID` |
| Hyperliquid OI | `OI_HL_CHAT_ID` |

## Configuration Ownership Map

- Parsing and defaults: `src/config.ts`
- App startup and channel wiring: `src/index.ts`
- Health thresholds usage: `src/healthz.ts`, `src/common/tracker.ts`
- Tracker thresholds and timings:
  - `src/services/trackers/hyperliquid.ts`
  - `src/services/trackers/polymarket.ts`
  - `src/services/trackers/stake.ts`
  - `src/services/trackers/oi.ts`

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
