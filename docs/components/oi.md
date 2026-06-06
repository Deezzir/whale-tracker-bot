# CoinGlass OI Anomaly Tracker

## Overview

Monitors open interest across configured exchanges using statistical anomaly detection to identify potential insider positioning.

## Architecture

```
OIService (tracker)
├── Token Universe Refresh (1h cycle)
│   └── CoinglassAPI.fetchExchangePairs() → OIDBService.upsertInstrumentUniverse()
├── Startup Warmup (local-first)
│   ├── Query local oiobservations per pair
│   ├── If sufficient local history → replayDBHistory() → READY (no API calls)
│   └── If insufficient → fetchOIHistory(96 candles) → replayHistory() → READY
│       └── CUSUM + recentZScores reset after warmup (prevents false-positive burst)
├── Coinglass Scan Cycle (5min sleep between cycles)
│   ├── Gap detection → DEGRADED_DATA transition if ≥3 intervals missed
│   ├── evaluatePair() → fetchOIHistory(1) → persist observation → updatePairState() → detectAnomaly()
│   ├── Price context: fetchPriceHistory(4) → computePriceContext()
│   └── sendAlert() → cooldown check → Telegram (with Coinalyze OI chart button) → persist OIAlertRecord
└── Hyperliquid Scan Cycle (15min)
    ├── fetchPerpMeta() → normalizeHLPerpContexts() → persist observations
    └── updatePairState() → detectAnomaly() → sendAlert()
```

## Detection Pipeline

1. **ΔOI computation**: interval-over-interval OI change
2. **EWMA normalization**: exponentially weighted mean & variance (α ≈ 0.02062, 48h effective window at 30m intervals)
3. **MAD-based robust z-score**: resistant to fat-tailed outliers
4. **Global quality gates** (apply before trigger checks):
   - current OI must be >= $1.0M
   - current candle must have positive ΔOI
   - current candle must have ΔOI >= $100K
   - current candle must have ΔOI >= 1.5%
5. **Three trigger channels**:
   - Fast Spike: single-interval z > 4 → HIGH
   - Slow Accumulation: cumulative z over 4 candles > 8 → HIGH
   - Sustained Build: CUSUM > 12 (drift k=1) → CRITICAL
6. **Price context**: annotates alerts with stealth positioning flag when |price change| ≤ 2%

## Alert Format

Each alert carries two inline buttons:

- **📊 View OI on Coinalyze** — link to the Coinalyze OI chart (currently a static `https://coinalyze.net/` link).
- **🚫 Blacklist** — callback `bl:<allowlistEntryId>` that removes the pair from the OI allowlist so it stops alerting (see Token Gating).

Coinglass alerts route to `OI_CHAT_ID`; Hyperliquid OI alerts route to `OI_HS_CHAT_ID`.

## Token Gating (Allowlist) and Blacklist

The `OIWhitelistEntry` collection (keyed by `{exchange, instrumentId}`) is the **single source of truth** for which pairs alert:

- During each scan cycle, every candidate pair is checked with `getWhitelistEntry(exchange, instrumentId)`. **Pairs not present in the allowlist are skipped** for both Coinglass and Hyperliquid sources.
- The full instrument universe is still discovered and persisted to MongoDB (`ExchangeInstrumentUniverse`) regardless of the allowlist. `refreshCoinglassUniverse` only warms up pairs that are on the allowlist.
- The allowlist is **seeded once** (e.g. `bun run src/test.ts`, optionally narrowed by a `COINGLASS_WHITELIST` env list of base assets). The periodic universe refresh deliberately does **not** re-seed it, so removals persist.
- The **🚫 Blacklist** button (`bl:<allowlistEntryId>`) deletes the matching allowlist entry via `removeFromWhitelist`, narrowing the source-of-truth list and permanently suppressing that pair's alerts. The handler accepts the action from either the Coinglass (`OI_CHAT_ID`) or Hyperliquid (`OI_HS_CHAT_ID`) channel.

> A fresh deployment with an empty `OIWhitelistEntry` collection emits no alerts until the allowlist is seeded.

## State Management

- **In-memory**: `Map<string, PairStatisticalState>` for hot-path detection
- **Redis**: cooldown keys with 6h TTL (`oi:cooldown:{exchange}:{instrumentId}`)
- **MongoDB**: ExchangeInstrumentUniverse (universe), OIObservation (time-series history), OIAlertRecord (audit), OIWhitelistEntry (alerting allowlist)

## Cold Start Behavior

On restart, the tracker attempts **local-first warmup** from persisted MongoDB observations before falling back to external CoinGlass API fetch:

1. Query local `oiobservations` for each Coinglass pair (source=COINGLASS, limit=96)
2. If ≥96 valid local candles exist → replay from local history (fast, no API calls)
3. If partial local history → replay what exists, then fetch remaining from CoinGlass API
4. If no local history → full external backfill (96 candles per pair, parallel batches)

This eliminates repeated ~1800s startup warmups after the first run. Subsequent restarts typically complete warmup in seconds.

## Local History Persistence

During each scan cycle, every Coinglass pair persists its latest OI candle as an observation to MongoDB:

- **Upsert key**: `(exchange, instrumentId, intervalStart)` — idempotent, no duplicates
- **Retention**: 5-day rolling window (observations older than 5 days are cleaned up hourly)
- **Source tag**: `COINGLASS` — distinguishes from Hyperliquid observations in the same collection

## Gap Handling

When a significant gap is detected (≥3 missed intervals by default, configurable via `COINGLASS_GAP_THRESHOLD_INTERVALS`):

1. Affected pair transitions from `READY` → `DEGRADED_DATA`
2. Statistical state is reset (CUSUM, z-scores, deltaOI buffers cleared)
3. Anomaly alerts are suppressed for that pair
4. Pair re-warms through normal scan cycles until `warmupCandles` threshold is met
5. Once re-warmed, pair transitions back to `READY` and resumes alerting

**Key design choice**: No targeted external mini-backfill for short outages. Recovery is purely local re-warmup driven. This keeps complexity low and avoids operational coupling to external API availability during recovery.

Unaffected pairs continue normal detection and alerting throughout.

## API Requirements

- Plan: STARTUP (80 req/min, 30m minimum interval for OI history, 90-day depth)
- 15m interval requires STANDARD plan ($49/mo) — returns 403 on STARTUP
- Warmup parallelized with configurable concurrency (default 5) and 1.2s batch delays
- 429 detection with 5s backoff; throttles at 90% rate budget usage

## Hyperliquid Direct OI Source

Hyperliquid pairs are collected directly from the Hyperliquid API rather than through CoinGlass. This avoids CoinGlass plan limitations and provides native data access.

### Source Routing

- **Hyperliquid pairs**: always collected via the direct Hyperliquid API
- **All other exchanges**: collected via CoinGlass API as before
- `COINGLASS_EXCHANGES` must **not** include `Hyperliquid` or `Aster` — a config guard rejects startup if they are present

### Collection Interval

Hyperliquid direct source runs on a **15-minute** cycle (hardcoded in `config.oi.hyperliquidIntervalMs`), independent of the CoinGlass 5-minute scan cycle.

### Warmup

On first deployment (or after data loss), Hyperliquid pairs warm up from **local MongoDB history only** — there is no backfill from external sources. A pair needs 96 intervals (~24h at 15min) of local observations before it can trigger alerts.

### Detection

Same anomaly detection pipeline (EWMA/MAD/CUSUM), same alert format, same cooldown. Alerts link to `https://app.hyperliquid.xyz/trade/{baseAsset}` instead of Coinalyze.

### Persistence

OI observations are stored in the `oiobservations` MongoDB collection with index `{exchange, instrumentId, intervalStart}`.

## Files

- `src/services/api/coinglass.ts` — HTTP client
- `src/services/db/oi.ts` — Mongoose models & persistence (observations, alerts, instruments)
- `src/services/trackers/oi.ts` — Tracker + detection engine (backfill, warmup, gap handling, scan loops)
- `src/config.ts` — `config.coinglass` and `config.oi` blocks
