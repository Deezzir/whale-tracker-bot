# Hyperliquid Tracker

## Owner

- Tracker: `src/services/trackers/hyperliquid.ts`
- API client: `src/services/api/hyperliquid.ts`
- DB service: `src/services/db/hyperliquid.ts`

## What It Does

Monitors Hyperliquid perp and spot trade activity, aggregates by wallet/coin/direction, and posts high-value alerts to Telegram topics. Also supports manual wallet tracking workflows.

## Ingestion

- Loads coin universe and spot pairs at start.
- Builds socket groups and subscribes to `trades` channels.
- Handles message payloads in `handleTrade(...)`.

Normalization details:
- Perps:
  - Buy taker -> `long`
  - Sell taker -> `short`
- Spot:
  - Buyer and seller both materialized with opposite notional signs.

## Aggregation and Scan

- Buffers records in `tradeBatch`.
- Flushes via `flushTradeBatch()` on interval and size threshold.
- Uses `affectedKeys` to limit scans to touched wallet+position keys.
- Runs `scanAndAlert()` loop for candidate processing.
- Runs `trackAndAlert()` loop for manually tracked wallets.

## Alert Rules

- Base thresholds from `config.hyperliquid`:
  - `minNotionalUSD` (perps)
  - `minSpotNotionalUSD` (spot)
- Candidate validation uses upstream trader state to avoid stale/false signals.
- Re-alert only when growth exceeds dynamic threshold:
  - max(percent growth threshold, fixed USD threshold)

Alert destinations:
- Perps and spot route to separate main/other channel groups.
- Manual track updates route to dedicated tracking channel(s).

## Manual Tracking

Command wiring in `src/index.ts`:
- `/track <wallet> <coin> <long|short>`
- `/untrack <wallet> <coin> <long|short>`
- `/tracked`
- `/stats <coin>`

Callback workflows:
- `track:<id>` and `untrack:<id>` inline actions are handled via Telegram callback actions.

## Persistence

`src/services/db/hyperliquid.ts` manages:
- Aggregations collection.
- Sent alerts collection.
- Tracked wallet collection.

Common operations:
- Bulk upsert on flush.
- Candidate reads for scan loop.
- Alert history reads for re-alert logic.
- TTL-like cleanup loops for old records.

## Health and Recovery

- No-data watchdog can force websocket reconnect.
- Scan watchdog detects stalled scan loop.
- Both feed `HealthService` status via base `Tracker` counters.

## Known Pitfalls

- Topic ID configuration drift in docs can break startup; use `src/config.ts` names.
- This service is stateful (in-memory batch and affected-keys map); always account for flush behavior when changing loops.
- Re-alert logic depends on previous alert records per channel.

## Safe Change Points

- Threshold/routing changes: `src/config.ts`, tracker constructor wiring in `src/index.ts`.
- Message formatting changes: `formatAlertMessage(...)` and related formatter helpers.
- Position classification logic: private helper methods inside this tracker.

## Verification After Changes

- `bun run typecheck`
- Start bot in a controlled env and verify:
  - websocket connects
  - batch flush logs appear
  - `/stats` and tracking commands still work

## Related Docs

- `docs/architecture.md`
- `docs/data-flow.md`
- `docs/configuration.md`
