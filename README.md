# Hyper-bot

Monitoring bot for Hyperliquid for Telegram.

Required environment variables

- BOT_TOKEN
- TARGET_GROUP_ID
- MONGODB_URI
- DB_NAME (optional, default: hyper-bot)
- REDIS_URL (optional, default: redis://localhost:6379)
- OWNER_USER_ID (optional)
- MIN_NOTIONAL_USD (optional, default: 100000)
- AGGREGATION_WINDOW_MS (optional, default: 86400000)

Quick start

1. Install deps

```bash
   npm install
```

2. Configure environment (create a .env file)

3. Run

```bash
   npm run start
```
