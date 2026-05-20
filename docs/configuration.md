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
