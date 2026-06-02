# Architecture

## Purpose

This document gives a fast system map for working on Whale Tracker Bot.

## Runtime Overview

- Entry point: `src/index.ts`
- Core services started on boot:
  - MongoDB connection via `src/services/db/index.ts`
  - Redis connection via `src/services/redis.ts`
  - Telegram bot via `src/services/telegram.ts`
  - Trackers via `src/services/trackers/index.ts`
  - Health endpoint via `src/healthz.ts`

Boot order in `src/index.ts`:

1. `connectDB()`
2. `connectRedis()`
3. `telegram.start(...)`
4. Start enabled tracker services (`HyperliquidService`, `StakeService`, `PolymarketService`, `CoinglassService` / OI — selected via `ENABLED_TRACKERS`)
5. Start health server (`/healthz`)

Shutdown path handles `SIGINT` and `SIGTERM` and stops health, Telegram, DB/Redis, and trackers.

## Main Components

### Tracker Base and Shared Runtime

- `src/common/runner.ts`: base runner lifecycle contract.
- `src/common/tracker.ts`: tracker base class, watchdogs, health semantics, shared `screenshoter` integration.
- `src/common/mutex.ts`: serializes batch flush operations.
- `src/common/utils.ts`: retry/timeout formatting and helper utilities.

### Trackers

- `src/services/trackers/hyperliquid.ts`
  - Ingests Hyperliquid perps and spot trades over WebSocket.
  - Aggregates positions and sends whale alerts.
  - Supports manual position tracking commands.

- `src/services/trackers/polymarket.ts`
  - Backfills recent trades via REST and consumes live trades via WebSocket.
  - Classifies markets and sends threshold-based alerts.

- `src/services/trackers/stake.ts`
  - Uses Puppeteer/browser-side websocket logic for Stake bet stream ingestion.
  - Converts bet currencies to USD and sends high-value bet alerts.

- `src/services/trackers/oi.ts`
  - Polls Coinglass per-exchange OI history and collects Hyperliquid OI directly.
  - Runs EWMA / robust z-score / CUSUM detection and sends OI anomaly alerts.

### Persistence

- MongoDB services:
  - `src/services/db/hyperliquid.ts`
  - `src/services/db/polymarket.ts`
  - `src/services/db/stake.ts`
  - `src/services/db/oi.ts`
- Redis client: `src/services/redis.ts`
  - Caches API data and runtime values (for example stake currency rates and OI cooldown keys).

### Delivery and Control Plane

- Telegram messaging and command handlers:
  - Service: `src/services/telegram.ts`
  - Command wiring: `src/index.ts`
- Health endpoint: `src/healthz.ts` (`GET /healthz`)

## External Boundaries

- Hyperliquid APIs: `src/services/api/hyperliquid.ts`
- Polymarket APIs: `src/services/api/polymarket.ts`
- CoinGlass API: `src/services/api/coinglass.ts`
- Aster API: `src/services/api/aster.ts`
- Stake GraphQL + websocket flow handled in `src/services/trackers/stake.ts`
- Optional OpenRouter client: `src/services/api/openrouter.ts`

## Health Model (Important)

Health is not only process liveness.

- `Tracker.watchDog(...)` tracks "no data" conditions.
- `Tracker.scanWatchDog(...)` tracks stalled scan loops.
- `HealthService` in `src/healthz.ts` marks unhealthy when counters cross thresholds.
- On unhealthy status, `src/index.ts` always sends an owner alert and optionally triggers shutdown when `RESTART_ON_UNHEALTHY=true`.

## Known Architectural Footguns

- Config drift between docs/examples and runtime keys can break startup. Canonical source is `src/config.ts`.
- `src/index.ts` includes one hardcoded extra Polymarket destination in tracker channel config.
- Tracker `start()` calls are fire-and-forget; startup failures can be asynchronous.

## Where To Change What

- Add new tracker: `src/services/trackers/*`, `src/services/db/*`, `src/config.ts`, `src/index.ts`.
- Change thresholds/topic routing: `src/config.ts` and `src/index.ts`.
- Change alert message templates: tracker files in `src/services/trackers/*`.
- Change health behavior: `src/common/tracker.ts` and `src/healthz.ts`.

## Related Docs

- `docs/data-flow.md`
- `docs/components/hyperliquid.md`
- `docs/components/polymarket.md`
- `docs/components/oi.md`
- `docs/components/stake.md`
- `docs/configuration.md`
- `docs/operations.md`
