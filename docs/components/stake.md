# Stake Tracker

## Owner

- Tracker: `src/services/trackers/stake.ts`
- DB service: `src/services/db/stake.ts`

## What It Does

Consumes Stake sports bet events, converts stake currency amounts to USD, and posts high-value bet alerts to Telegram.

## Ingestion Architecture

Stake ingestion is browser-driven (not a simple server websocket client):

1. Launches Puppeteer browser/page.
2. Navigates to Stake site.
3. Injects websocket management logic in page context.
4. Receives messages through `page.exposeFunction('onWSMessage', ...)`.

This design is important for maintenance and deployment troubleshooting.

## Message Handling Pipeline

- `handleMessage(...)` parses browser-forwarded payloads.
- Supports reconnect signals emitted from injected page script.
- Converts raw bet outcomes into typed structures by bet type.
- Converts amount to USD using cached currency rates.
- Filters low-value bets before batching.

## Batch, Persistence, and Alerting

- Batches bets in `betsBatch`.
- Flushes via `flushBetsBatch()` with mutex protection.
- Deduplicates by `iid` before DB write.
- `scanAndAlert()` loads unalerted high-value candidates.
- Sends alert once and marks record as alerted.

## Currency Conversion and Redis

- Fetches currency configuration from Stake GraphQL endpoint.
- Caches currency-to-USD rates in Redis (`stake:currencies`).
- Cache TTL ties to monitor cache settings in `src/config.ts`.

## Recovery Behavior

- On websocket disconnect/reconnect signal, service reinitializes browser/page and resubscribes.
- Startup failures send a "Unable to start stake monitoring" message to configured channels.

## Known Pitfalls

- Requires compatible Chromium runtime and dependencies.
- More operationally fragile than pure API polling due to browser/session complexity.
- Proxy and headless settings can materially change reliability.

## Safe Change Points

- Bet parsing logic: `handleMessage(...)` and outcome conversion blocks.
- Alert formatting: `formatAlertMessage(...)` and `getEventDetails(...)`.
- Runtime behavior: browser args and reconnect flow methods.

## Verification After Changes

- `bun run typecheck`
- Runtime checks:
  - Puppeteer initializes
  - websocket subscriptions are acknowledged
  - candidate alerts are marked as alerted

## Related Docs

- `docs/architecture.md`
- `docs/data-flow.md`
- `docs/configuration.md`
- `docs/operations.md`
