# Whale Tracker Bot

Telegram bot for monitoring high-value activity across:

- Hyperliquid perp trades
- Polymarket trades
- Stake sports bets
- CoinGlass exchange OI anomalies (statistical detection)

The bot stores data in MongoDB, uses Redis for caching/deduplication, and sends alerts to dedicated Telegram channels (one per alert branch). It also supports manual Hyperliquid wallet tracking commands.

## Features

- Real-time ingestion from WebSocket/API feeds
- 4-branch Hyperliquid alert system:
  - **Fresh Wallet** — new wallets (≤50h) opening positions ≥$200K (excl. BTC/ETH)
  - **Whale Activity** — established wallets with positions ≥$300K (excl. BTC/ETH)
  - **Big Whale** — any position ≥$1M (all coins)
  - **Big TWAP** — spot accumulation detection (BTC/ETH ≥$1M, others ≥$300K)
- Re-alerts when tracked positions grow +9% from last alert
- Hyperliquid manual tracking commands: `/track`, `/untrack`, `/tracked`, `/stats`
- Polymarket and Stake whale alerts
- CoinGlass OI anomaly detection (EWMA/CUSUM/MAD statistical methods, per-exchange)
- Optional Screenshots via Puppeteer

## Requirements

- Bun (runtime used by scripts)
- MongoDB
- Redis
- Telegram bot token
- Telegram channels/groups where the bot is an administrator
- OpenRouter API key for analysis/classification features
- CoinGlass API key (STARTUP plan, 30m OI history)

## Environment

Create a `.env` file in the project root.

### Required

| Variable | Description |
| --- | --- |
| `BOT_TOKEN` | Telegram bot token |
| `HS_FRESH_WALLET_CHAT_ID` | Channel ID for Fresh Wallet alerts |
| `HS_WHALE_ACTIVITY_CHAT_ID` | Channel ID for Whale Activity alerts |
| `HS_BIG_WHALE_CHAT_ID` | Channel ID for Big Whale alerts |
| `HS_TWAP_CHAT_ID` | Channel ID for TWAP alerts |
| `HS_TRACK_CHAT_ID` | Channel ID for tracked wallet notifications |
| `STAKE_CHAT_ID` | Channel ID for Stake alerts |
| `POLY_CHAT_ID` | Channel ID for Polymarket alerts |
| `OWNER_USER_ID` | Telegram user ID used for owner-level checks and watchdog alerts |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `COINGLASS_API_KEY` | CoinGlass API key (STARTUP plan) |
| `COINGLASS_CHAT_ID` | Channel ID for CoinGlass OI anomaly alerts |

### Optional (with defaults)

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment (`development` or `production`) |
| `LOG_LEVEL` | `INFO` | Log verbosity (`INFO`, `WARN`, `ERROR`, `DEBUG`) |
| `LOG_FILE_ENABLED` | `false` | Write logs to `./logs/YYYY-MM-DD.log` |
| `MONGODB_URI` | `mongodb://root:example@localhost:27017` | MongoDB connection URI |
| `DB_NAME` | `whale-tracker-bot` | Database name (`-dev` suffix is added in development) |
| `DB_AUTO_INDEX` | `true` in development, `false` in production | Enable Mongoose auto-indexing on connect |
| `DB_ENSURE_INDEXES_ON_START` | `true` | Explicitly runs `createIndexes()` for all models at startup |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `REDIS_PASSWORD` | `` | Redis password |
| `HS_MIN_NOTIONAL_USD` | `250000` | Hyperliquid minimum aggregated notional to consider |
| `HS_AGGREGATION_WINDOW_MS` | `86400000` | Hyperliquid aggregation window |
| `HS_POS_CHANGE_ALERT_PERCENT` | `9` | Re-alert growth threshold (%) |
| `HS_POS_CHANGE_ALERT_USD` | `50000` | Re-alert minimum USD move |
| `HS_FRESH_WINDOW_MS` | `180000000` | Fresh wallet time window (50h) |
| `HS_FRESH_MIN_USD` | `200000` | Fresh wallet min position (other coins) |
| `HS_FRESH_MAIN_COIN_MIN_USD` | `450000` | Fresh wallet min position (main coins) |
| `HS_WHALE_MIN_USD` | `300000` | Whale activity min position |
| `HS_BIG_WHALE_MIN_USD` | `1000000` | Big whale min position |
| `HS_TWAP_BTC_ETH_MIN_USD` | `1000000` | TWAP min for BTC/ETH |
| `HS_TWAP_OTHER_MIN_USD` | `300000` | TWAP min for other coins |
| `STAKE_MIN_BET_USD` | `10000` | Stake minimum bet size for alerts |
| `POLY_ALERT_THRESHOLD_USD` | `100000` | Polymarket regular market alert threshold |
| `POLY_SPORT_BET_ALERT_THRESHOLD_USD` | `500000` | Polymarket sport market alert threshold |
| `POLY_RE_ALERT_THRESHOLD_PERCENT` | `20` | Polymarket re-alert threshold percent |
| `POLY_MAX_PRICE_FILTER` | `0.98` | Polymarket max price filter |
| `POLY_POS_CHANGE_ALERT_PERCENT` | `20` | Polymarket growing-position percent threshold |
| `POLY_POS_CHANGE_ALERT_USD` | `9000` | Polymarket growing-position minimum USD threshold |
| `PUPPETEER_SCREENSHOT_ENABLED` | `true` | Include screenshots in Stake alerts |
| `PUPPETEER_USER_DIR` | `` | Puppeteer user data directory |
| `PUPPETEER_HEADLESS` | `true` | Run Puppeteer in headless mode |
| `PUPPETEER_PROXIES_PATH` | `./resources/ports.txt` | File with proxies for Puppeteer |
| `PUPPETEER_PROXIES` | `` | Comma-separated proxy list |
| `OPENROUTER_CLASSIFIER_PROMPT_TEMPLATE_PATH` | `./resources/trade_classifier_prompt.txt` | Prompt template path |
| `OPENROUTER_FAST_MODEL` | `gpt-3.5-turbo` | OpenRouter model used for fast classification |
| `COINGLASS_EXCHANGES` | `Binance,OKX,Bybit` | Comma-separated exchanges to monitor |
| `COINGLASS_REFRESH_INTERVAL_MS` | `3600000` | Token universe refresh interval (1h) |
| `COINGLASS_BLACKLIST` | `` | Comma-separated tokens to exclude from OI detection |
| `COINGLASS_WARMUP_CONCURRENCY` | `4` | Parallel warmup batch size |

## Run locally

```bash
bun install
bun run start
```

## Run with Docker Compose

```bash
docker compose up --build
```

This starts MongoDB, Redis, and the bot container.

## Documentation

- Architecture: `docs/architecture.md`
- Data flow: `docs/data-flow.md`
- Tracker deep dives:
  - `docs/components/hyperliquid.md`
  - `docs/components/polymarket.md`
  - `docs/components/stake.md`
  - `docs/components/coinglass.md`
- Configuration: `docs/configuration.md`
- Operations runbook: `docs/operations.md`

## Telegram commands

- `/stats <coin>`: Show Hyperliquid stats for a coin
- `/tracked`: List manually tracked Hyperliquid positions
- `/track <wallet> <coin> <long|short>`: Add a tracked Hyperliquid position
- `/untrack <wallet> <coin> <long|short>`: Remove a tracked Hyperliquid position

Commands are restricted to the configured channels and require admin/owner permissions.
