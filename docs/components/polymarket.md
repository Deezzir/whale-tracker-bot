# Polymarket Tracker

## Owner

- Tracker: `src/services/trackers/polymarket.ts`
- API client: `src/services/api/polymarket.ts`
- DB service: `src/services/db/polymarket.ts`

## What It Does

Tracks Polymarket matched orders, aggregates position exposure per wallet+market+outcome, classifies context, and sends threshold-based Telegram alerts.

## Ingestion

- Startup backfill via REST (`getRecentTrades`).
- Live stream via WebSocket subscription to `activity/orders_matched`.
- Reconnect logic handles connection timeouts and close/error events.

## Normalization and Filtering

- `transformTrade(...)` converts raw feed records to `PolyTradeInput`.
- Drops low-signal events:
  - tiny USD amount
  - prices at or above max-price filter

## Aggregation and Candidate Scan

- In-memory `tradeBatch` with mutex-protected flush.
- `affectedKeys` tracks touched `(proxyWallet, conditionId, outcomeIndex)`.
- `scanAndAlert()` queries DB only for affected keys.

## Alert Logic

- Candidate threshold differs by market category:
  - sport uses `sportAlertThresholdUsd`
  - regular/esports uses `alertThresholdUsd`
- Category tagging uses title heuristics.
- Account/trade tags are derived from wallet history.
- Re-alert sends only when growth exceeds dynamic threshold.

Alert outputs include:

- position size
- outcome + market context
- wallet/profile links
- tags and median sizing signals

## Persistence

`src/services/db/polymarket.ts` stores:

- aggregated position records
- sent alerts history

Behavior depends on:

- bulk upsert aggregation logic
- per-channel last-alert lookups for reply threading and dedup

## Operational Notes

- Watchdog can force websocket reconnection when no data arrives.
- Cleanup loop removes stale trade and alert records.
- Optional screenshot uses profile page capture when enabled.

## Known Pitfalls

- Heuristic market categorization is intentionally simple and keyword-driven.
- Alert behavior can be surprising if thresholds are changed without considering re-alert dynamics.
- Channel routing is configured at service construction in `src/index.ts`.

## Safe Change Points

- Thresholds/filters: `src/config.ts`.
- Parsing/normalization: `transformTrade(...)`.
- Alert message format/tags: `formatAlertMessage(...)` and classifier helpers.

## Verification After Changes

- `bun run typecheck`
- Runtime sanity checks:
  - backfill executes on startup
  - websocket connects and pings
  - batch flush and scan logs appear

## Related Docs

- `docs/architecture.md`
- `docs/data-flow.md`
- `docs/configuration.md`
