# CoinGlass OI Anomaly Tracker

## Overview

Monitors open interest across configured exchanges using statistical anomaly detection to identify potential insider positioning.

## Architecture

```
CoinglassService (tracker)
├── Token Universe Refresh (1h cycle)
│   └── CoinglassAPI.fetchExchangePairs() → CoinglassDBService.upsertInstrumentUniverse()
├── Cold-Start Warmup (parallel batches, configurable concurrency)
│   └── fetchOIHistory(96 candles) → replayHistory() → EWMA calibration only
│       └── CUSUM + recentZScores reset after warmup (prevents false-positive burst)
└── Scan Cycle (30min)
    ├── evaluatePair() → fetchOIHistory(1) → updatePairState() → detectAnomaly()
    ├── Price context: fetchPriceHistory(4) → computePriceContext()
    └── sendAlert() → cooldown check → Telegram (with Coinalyze OI chart button) → persist OIAlertRecord
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

Alerts include an inline button linking to the exchange-specific OI chart on Coinalyze (`https://coinalyze.net/{coin}/{quote}/{exchange}/open-interest-chart/{pair}_perp_oi/`).

## Token Filtering

- **Blacklist** (`COINGLASS_BLACKLIST`): comma-separated tokens excluded from in-memory tracking
- Full universe is persisted to MongoDB regardless of blacklist (for future expansion)

## State Management

- **In-memory**: `Map<string, PairStatisticalState>` for hot-path detection
- **Redis**: cooldown keys with 6h TTL (`oi:cooldown:{exchange}:{instrumentId}`)
- **MongoDB**: ExchangeInstrumentUniverse (universe), OIAlertRecord (audit)

## Cold Start Behavior

On restart, fetches 96 candles (48h at 30m intervals) per pair from CoinGlass API in parallel batches and replays through the detection engine to calibrate EWMA mean/variance. CUSUM and recentZScores are reset to zero after warmup to prevent false-positive floods. Only truly new listings (< 48h old) remain in WARMUP.

## API Requirements

- Plan: STARTUP (80 req/min, 30m minimum interval for OI history, 90-day depth)
- 15m interval requires STANDARD plan ($49/mo) — returns 403 on STARTUP
- Warmup parallelized with configurable concurrency (default 5) and 1.2s batch delays
- 429 detection with 5s backoff; throttles at 90% rate budget usage

## Hyperliquid Direct OI Source

Hyperliquid pairs are collected directly from the Hyperliquid API rather than through CoinGlass. This avoids CoinGlass plan limitations and provides native data access.

### Source Routing

- **Hyperliquid pairs**: collected via direct Hyperliquid API (`OI_HYPERLIQUID_DIRECT_ENABLED=true`)
- **All other exchanges**: collected via CoinGlass API as before
- `COINGLASS_EXCHANGES` must **not** include `Hyperliquid` or `Aster` — a config guard rejects startup if they are present

### Collection Interval

Hyperliquid direct source runs on a **15-minute** cycle (`OI_HYPERLIQUID_INTERVAL_MS=900000`), independent of the CoinGlass 30-minute scan cycle.

### Warmup

On first deployment (or after data loss), Hyperliquid pairs warm up from **local MongoDB history only** — there is no backfill from external sources. A pair needs 96 intervals (~24h at 15min) of local observations before it can trigger alerts.

### Detection

Same anomaly detection pipeline (EWMA/MAD/CUSUM), same alert format, same cooldown. Alerts link to `https://app.hyperliquid.xyz/trade/{baseAsset}` instead of Coinalyze.

### Persistence

OI observations are stored in the `oiobservations` MongoDB collection with index `{exchange, instrumentId, intervalStart}`.

## Files

- `src/services/api/coinglass.ts` — HTTP client
- `src/services/db/coinglass.ts` — Mongoose models & persistence
- `src/services/trackers/coinglass.ts` — Tracker + detection engine
- `src/config.ts` — `config.coinglass` block
