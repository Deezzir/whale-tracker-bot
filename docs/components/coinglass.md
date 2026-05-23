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
4. **Three trigger channels**:
   - Fast Spike: single-interval z > 4 → HIGH
   - Slow Accumulation: cumulative z over 4 candles > 6 → HIGH
   - Sustained Build: CUSUM > 8 (drift k=1) → CRITICAL
5. **Price context**: annotates alerts with stealth positioning flag when |price change| ≤ 2%

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

## Files

- `src/services/api/coinglass.ts` — HTTP client
- `src/services/db/coinglass.ts` — Mongoose models & persistence
- `src/services/trackers/coinglass.ts` — Tracker + detection engine
- `src/config.ts` — `config.coinglass` block
