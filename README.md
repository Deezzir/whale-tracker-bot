# Whale Tracker Bot

Telegram bot for monitoring high-value activity across:

- Hyperliquid perp trades
- Polymarket trades
- Stake sports bets

The bot stores data in MongoDB, uses Redis for caching/deduplication, and sends alerts to configured Telegram forum topics. It also supports manual Hyperliquid wallet tracking commands.

## Features

- Real-time ingestion from WebSocket/API feeds
- Threshold-based whale alerts for Hyperliquid, Polymarket, and Stake
- Re-alerts when tracked positions grow significantly
- Hyperliquid manual tracking commands: `/track`, `/untrack`, `/tracked`, `/stats`
- Optional Screenshots via Puppeteer

## Requirements

- Bun (runtime used by scripts)
- MongoDB
- Redis
- Telegram bot token
- Telegram supergroup where the bot is an administrator
- OpenRouter API key for analysis/classification features

## Environment

Create a `.env` file in the project root.

### Required

| Variable | Description |
| --- | --- |
| `BOT_TOKEN` | Telegram bot token |
| `CHAT_ID` | Target Telegram supergroup ID where alerts are posted |
| `HS_MAIN_TOPIC_ID` | Topic ID for major Hyperliquid alerts |
| `HS_OTHER_TOPIC_ID` | Topic ID for secondary Hyperliquid alerts |
| `STAKE_TOPIC_ID` | Topic ID for Stake alerts |
| `TRACK_TOPIC_ID` | Topic ID for Hyperliquid track notifications |
| `POLY_TOPIC_ID` | Topic ID for Polymarket alerts |
| `OWNER_USER_ID` | Telegram user ID used for owner-level checks and watchdog alerts |
| `OPENROUTER_API_KEY` | OpenRouter API key |

### Optional (with defaults)

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment (`development` or `production`) |
| `LOG_FILE_ENABLED` | `false` | Write logs to `./logs/YYYY-MM-DD.log` |
| `MONGODB_URI` | `mongodb://root:example@localhost:27017` | MongoDB connection URI |
| `DB_NAME` | `whale-tracker-bot` | Database name (`-dev` suffix is added in development) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `REDIS_PASSWORD` | `` | Redis password |
| `HS_MIN_NOTIONAL_USD` | `250000` | Hyperliquid minimum aggregated notional alert threshold |
| `HS_AGGREGATION_WINDOW_MS` | `86400000` | Hyperliquid aggregation window |
| `HS_POS_CHANGE_ALERT_PERCENT` | `20` | Hyperliquid tracked-position re-alert percent |
| `HS_POS_CHANGE_ALERT_USD` | `50000` | Hyperliquid tracked-position re-alert minimum USD move |
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

## Telegram commands

- `/stats <coin>`: Show Hyperliquid stats for a coin
- `/tracked`: List manually tracked Hyperliquid positions
- `/track <wallet> <coin> <long|short>`: Add a tracked Hyperliquid position
- `/untrack <wallet> <coin> <long|short>`: Remove a tracked Hyperliquid position

Commands are restricted to the configured group and require admin/owner permissions.
