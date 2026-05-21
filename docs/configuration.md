# Configuration

## Source of Truth

Canonical runtime configuration is `src/config.ts`.

If this document and `README.md` disagree, follow `src/config.ts`.

## Required Environment Variables

These are required at startup (`requireEnv(...)` in `src/config.ts`):

- `BOT_TOKEN`
- `CHAT_ID`
- `HS_MAIN_PERPS_TOPIC_ID`
- `HS_OTHER_PERPS_TOPIC_ID`
- `HS_MAIN_SPOT_TOPIC_ID`
- `HS_OTHER_SPOT_TOPIC_ID`
- `STAKE_TOPIC_ID`
- `TRACK_TOPIC_ID`
- `POLY_TOPIC_ID`
- `OWNER_USER_ID`
- `OPENROUTER_API_KEY`

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
| `HS_FRESH_MAIN_COIN_MIN_USD` | `450000` | Min position for fresh wallet alert (main coins) |
| `HS_FRESH_BTC_ETH_MIN_USD` | `2000000` | Min position for fresh wallet alert (BTC/ETH) |
| `HS_WHALE_MIN_USD` | `300000` | Min position for whale activity alert (all coins) |
| `HS_BIG_WHALE_MIN_USD` | `1000000` | Min position for big whale alert (all coins) |
| `HS_TWAP_BTC_ETH_MIN_USD` | `1000000` | Min accumulation for TWAP alert (BTC/ETH) |
| `HS_TWAP_OTHER_MIN_USD` | `300000` | Min accumulation for TWAP alert (other coins) |
| `HS_POS_CHANGE_ALERT_PERCENT` | `9` | Re-alert growth threshold (%) |

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

## Important Naming Drift

Legacy docs/examples may still reference:

- `HS_MAIN_TOPIC_ID`
- `HS_OTHER_TOPIC_ID`

Current code expects split topic keys:

- `HS_MAIN_PERPS_TOPIC_ID`
- `HS_OTHER_PERPS_TOPIC_ID`
- `HS_MAIN_SPOT_TOPIC_ID`
- `HS_OTHER_SPOT_TOPIC_ID`

Using legacy names will fail startup because required vars are missing.

## Configuration Ownership Map

- Parsing and defaults: `src/config.ts`
- App startup and channel wiring: `src/index.ts`
- Health thresholds usage: `src/healthz.ts`, `src/common/tracker.ts`
- Tracker thresholds and timings:
  - `src/services/trackers/hyperliquid.ts`
  - `src/services/trackers/polymarket.ts`
  - `src/services/trackers/stake.ts`

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
