# Operations Runbook

## Purpose

Practical operating guide for running, monitoring, and troubleshooting Whale Tracker Bot.

## Runtime Modes

### Local (Bun)

Commands:

- `bun install`
- `bun run start`

### Docker Compose

Command:

- `docker compose up --build`

Compose services (`compose.yaml`):

- `mongo`
- `redis`
- `mongo-express`
- `bot`

## Health Checks

- Endpoint: `GET /healthz`
- Owner file: `src/healthz.ts`
- Returns:
  - `200` when all trackers are healthy
  - `504` when one or more trackers are unhealthy

Unhealthy conditions come from tracker watchdog counters in `src/common/tracker.ts`:

- no-data watchdog breaches
- scan-stall watchdog breaches

When unhealthy is detected, callback in `src/index.ts` sends owner alert and triggers shutdown.

## Logs and Observability

- Console logging via `src/common/logger.ts`.
- Optional file logging controlled by `LOG_FILE_ENABLED`.
- File log directory: `./logs/`.
- Useful startup signals:
  - DB connected
  - Redis connected
  - Telegram started
  - Tracker start logs
  - Health server listening

## Common Failure Cases

### Startup fails with missing env variable

Symptom:

- process exits with `Missing required environment variable`.

Action:

1. Compare runtime env with `src/config.ts` required keys.
2. Fix naming drift issues (especially Hyperliquid topic IDs).

### Bot unhealthy / repeated restarts

Symptom:

- `/healthz` returns `504`.
- owner receives unhealthy alert.

Action:

1. Inspect tracker-specific logs for no-data or scan-stall messages.
2. Check upstream API/websocket status for affected tracker.
3. Confirm DB/Redis connectivity.

### Stake tracker unstable

Symptom:

- frequent reconnect/reinit logs from Stake service.

Action:

1. Validate Chromium and required runtime libs.
2. Check proxy configuration and Puppeteer flags.
3. Verify Stake endpoint availability.

### Telegram alerts stop sending

Symptom:

- ingestion logs present but no outbound message success.

Action:

1. Verify bot token/chat/topic IDs.
2. Confirm bot admin permissions in target group.
3. Check `checkMessageSource` constraints for command handlers.

### Hyperliquid Direct OI Source

**First deployment**: Hyperliquid pairs will not alert until warmup completes (96 intervals = ~24h at 15min). This is expected — there is no external backfill.

**Failed cycles**: If a Hyperliquid OI collection cycle fails, a warning is logged and the next cycle retries automatically. No manual intervention needed unless failures persist.

**Storage growth**: The `oiobservations` MongoDB collection is automatically pruned by a cleanup loop that removes observations older than 5 days (cleanupTTLms). No manual intervention needed.

**Verify status**: Check cycle logs for Hyperliquid OI tracker output showing pair state counts (READY/WARMUP/DEGRADED). After ~24h all pairs should transition to READY.

### Coinglass OI Local History

**Restart behavior**: On restart, Coinglass pairs attempt local-first warmup from MongoDB. If sufficient local history exists (96 candles), no external API calls are needed. Startup logs distinguish "local-seeded" vs "external-seeded" pairs.

**Gap handling**: After significant downtime (≥3 missed 30min intervals by default), affected pairs enter DEGRADED_DATA, suppress alerts, and re-warm through normal scan cycles. Unaffected pairs continue normally. No manual intervention needed.

**Tuning**: Adjust `COINGLASS_GAP_THRESHOLD_INTERVALS` to control gap sensitivity (default: 3 intervals = 90 min).

## Safe Ops Practices

- Do not log or commit secrets.
- Keep environment-specific values in env files/secrets manager.
- Validate config changes in a non-production environment first.
- Prefer targeted changes over broad restarts/refactors during incidents.

## Release/Change Checklist

Before declaring an ops change complete:

1. `bun run typecheck`
2. Start app successfully in target mode.
3. Verify `/healthz` returns expected response.
4. Confirm at least one tracker is ingesting and scanning.
5. Confirm Telegram delivery path is healthy.

## Related Docs

- `docs/architecture.md`
- `docs/configuration.md`
- `docs/data-flow.md`
