# Hyper-bot

Minimal Telegram bot that watches Hyperliquid trades, aggregates per wallet/coin/direction, and alerts when a threshold is crossed.

## Requirements

- Node.js
- MongoDB
- Redis(caches portfolio/clearinghouse responses)
- Telegram bot token with access to the target chat

## Environment

Create a `.env` file with the variables below.

| Variable | Description |
| --- | --- |
| `BOT_TOKEN` | Telegram bot token |
| `TARGET_GROUP_ID` | Chat or channel ID where alerts are posted |
| `MONGODB_URI` | Connection string for MongoDB |
| `DB_NAME` | Database name (default `hyper-bot`) |
| `REDIS_URL` | Redis connection URL (default `redis://localhost:6379`) |
| `OWNER_USER_ID` | Optional Telegram user ID for privileged commands |
| `MIN_NOTIONAL_USD` | Alert threshold (default `100000`) |
| `AGGREGATION_WINDOW_MS` | Rolling window length in ms (default `86400000`) |

## Install and run

```bash
npm install
cp .env.example .env # or create manually
npm run start
```
