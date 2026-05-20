# Data Flow

## Purpose

This document describes how data moves through the bot from upstream feeds to Telegram alerts.

## Shared Pipeline Pattern

All trackers follow a similar high-level shape:

1. Ingest events (WebSocket and/or REST backfill).
2. Normalize event payload into internal records.
3. Buffer events in memory batch.
4. Flush batch to MongoDB using bulk/upsert operations.
5. Mark affected keys for focused scan.
6. Scan candidate positions/bets based on thresholds.
7. Enrich candidate with external state where needed.
8. Send Telegram alert and persist sent-alert metadata.

Core shared behavior lives in:
- `src/common/tracker.ts`
- `src/common/mutex.ts`
- `src/common/utils.ts`

## Hyperliquid Flow

Code owner: `src/services/trackers/hyperliquid.ts`

- Ingest:
  - WebSocket subscriptions for perps and spot pairs.
  - Handles per-trade normalization in `handleTrade(...)`.
- Normalization:
  - Perps mapped to `long`/`short` from side+taker.
  - Spot mapped to `spot` direction with buyer/seller polarity.
- Batch/flush:
  - In-memory `tradeBatch` + periodic/size-triggered `flushTradeBatch()`.
  - Flush serialized via `flushMutex`.
- Candidate selection:
  - Uses `affectedKeys` map to avoid broad scans.
  - Pulls candidates from DB by notional thresholds.
- Enrichment:
  - Prefetches wallet state/portfolio in bounded concurrency.
  - Applies timeout wrappers per candidate.
- Alerting:
  - First alert sends full message (+ optional screenshot).
  - Re-alert requires growth beyond dynamic threshold.
  - Writes alert history for dedup/reply threading.

## Polymarket Flow

Code owner: `src/services/trackers/polymarket.ts`

- Ingest:
  - REST backfill (`getRecentTrades`) and live websocket (`orders_matched`).
- Normalization:
  - Converts raw trade to `PolyTradeInput` in `transformTrade(...)`.
  - Filters out tiny trades and near-certain prices.
- Batch/flush:
  - `tradeBatch` + `flushTradeBatch()` under mutex lock.
- Candidate selection:
  - `affectedKeys` keyed by wallet + condition + outcome index.
  - DB query uses regular vs sport thresholds.
- Enrichment:
  - Loads market metadata + wallet profile/stats.
  - Classifies market/account/trade tags.
- Alerting:
  - New alert sends full message (+ optional screenshot).
  - Re-alert sends concise growth reply when dynamic threshold is met.

## Stake Flow

Code owner: `src/services/trackers/stake.ts`

- Ingest:
  - Puppeteer page opens Stake and injects websocket clients in browser context.
  - Receives messages via `page.exposeFunction('onWSMessage', ...)`.
- Normalization:
  - Parses GraphQL payload into typed outcomes (`SwishBet`, `SportBet`, `RacingBet`).
  - Converts native amount to USD using cached currency rates.
- Batch/flush:
  - `betsBatch` + `flushBetsBatch()` under mutex.
  - Dedup by `iid` before DB write.
- Candidate selection:
  - Finds unalerted bets above threshold and within alert age window.
- Alerting:
  - Sends one alert per bet, then marks alert timestamp in DB.

## State and Storage

- MongoDB stores:
  - Aggregated positions/trades/bets.
  - Alert history for dedup/re-alert logic.
  - Hyperliquid manual tracking state.
- Redis stores:
  - Cached API responses and auxiliary runtime values.

## Reliability Mechanics

- Mutex: prevents concurrent flush races.
- Retry/backoff: used by Telegram sender and selected API calls.
- Rate limits: explicit in Polymarket API client.
- Watchdogs:
  - No data timeout.
  - Scan stall timeout.
- Health callback in `src/index.ts` triggers alert + process shutdown on unhealthy state.

## Failure Semantics

- Tracker loops generally catch per-iteration errors and continue.
- External feed disconnects trigger reconnect logic in tracker-specific code.
- DB/Redis startup failures are fatal and stop process initialization.

## Extension Checklist (New Tracker)

1. Add tracker class under `src/services/trackers/` extending `Tracker`.
2. Add DB service/model under `src/services/db/`.
3. Implement batch + scan + cleanup loops.
4. Persist sent alerts for dedup/re-alert behavior.
5. Wire tracker in `src/services/trackers/index.ts` and `src/index.ts`.
6. Add env/config in `src/config.ts` and document in `docs/configuration.md`.

## Related Docs

- `docs/architecture.md`
- `docs/components/hyperliquid.md`
- `docs/components/polymarket.md`
- `docs/components/stake.md`
