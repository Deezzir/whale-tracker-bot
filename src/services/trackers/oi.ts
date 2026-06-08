import { ChatChannel, Tracker } from '../../common/tracker';
import { config } from '../../config';
import { Markup } from 'telegraf';
import APIService, { Interval, OICandle } from '../api/coinglass';
import DBService, { TriggerType, Severity } from '../db/oi';
import { getRedisClient } from '../redis';
import { sleep } from '../../common/utils';
import { InlineKeyboardMarkup } from 'telegraf/types';
import Tg from '../telegram';
import HyperliquidAPI, { PerpsMeta } from '../api/hyperliquid';

const COINGLASS_CANDLE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

type PairStatus = 'WARMUP' | 'READY' | 'DEGRADED_DATA';
type OISource = 'COINGLASS' | 'HYPERLIQUID';

interface PairStatisticalState {
    exchange: string;
    instrumentId: string;
    baseAsset: string;
    ewmaMean: number;
    ewmaVariance: number;
    cusumScore: number;
    recentDeltaOI: number[];
    recentZScores: number[];
    lastOI: number | null;
    lastObservationAt: Date | null;
    candleCount: number;
    status: PairStatus;
    source: OISource;
    suppressPostGapDelta?: boolean;
}

interface HyperliquidOISnapshot {
    exchange: 'Hyperliquid';
    source: 'HYPERLIQUID';
    instrumentId: string;
    baseAsset: string;
    quoteAsset: 'USD';
    rawOpenInterest: number;
    openInterest: number;
    markPrice: number;
    midPrice: number | null;
    isDelisted: boolean;
    observedAt: Date;
}

export function normalizeHLPerpContexts(meta: PerpsMeta): HyperliquidOISnapshot[] {
    const now = new Date();
    const snapshots: HyperliquidOISnapshot[] = [];

    for (let i = 0; i < meta.universe.length; i++) {
        const asset = meta.universe[i];
        const ctx = meta.assetMeta[i];
        if (!asset || !ctx) continue;

        const isDelisted = !!(asset as { isDelisted?: boolean }).isDelisted;
        if (isDelisted) continue;

        const rawOpenInterest = parseFloat(ctx.openInterest);
        const markPrice = parseFloat(ctx.markPx);
        const midPx = parseFloat(ctx.midPx);

        if (!isFinite(rawOpenInterest) || rawOpenInterest <= 0) continue;
        if (!isFinite(markPrice) || markPrice <= 0) continue;

        const midPrice = isFinite(midPx) && midPx > 0 ? midPx : null;
        const openInterest = rawOpenInterest * markPrice;

        snapshots.push({
            exchange: 'Hyperliquid',
            source: 'HYPERLIQUID',
            instrumentId: asset.name,
            baseAsset: asset.name,
            quoteAsset: 'USD',
            rawOpenInterest,
            openInterest,
            markPrice,
            midPrice,
            isDelisted: false,
            observedAt: now
        });
    }

    return snapshots;
}

function normalizeIntervalStart(timestamp: number, intervalMs: number): Date {
    return new Date(Math.floor(timestamp / intervalMs) * intervalMs);
}

function isHyperliquidSource(source: OISource): boolean {
    return source === 'HYPERLIQUID';
}

function isCoinglassSource(source: OISource): boolean {
    return source === 'COINGLASS';
}

function normalizeCoinglassCandleTimestampMs(timestamp: number): number {
    return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function normalizeCoinglassIntervalStart(candleTimestamp: number): Date {
    return normalizeIntervalStart(normalizeCoinglassCandleTimestampMs(candleTimestamp), COINGLASS_CANDLE_INTERVAL_MS);
}

function isCoinglassDataStale(lastObservationAt: Date | null, now: Date): boolean {
    if (!lastObservationAt) return false;
    const elapsed = now.getTime() - lastObservationAt.getTime();
    const threshold = config.oi.coinglassGapThresholdIntervals * COINGLASS_CANDLE_INTERVAL_MS;
    return elapsed > threshold;
}

function detectCoinglassGap(state: PairStatisticalState, now: Date): boolean {
    return isCoinglassDataStale(state.lastObservationAt, now);
}

function enterDegraded(state: PairStatisticalState): void {
    state.status = 'DEGRADED_DATA';
    state.cusumScore = 0;
    state.recentZScores = [];
    state.suppressPostGapDelta = true;
}

interface OIAnomalyEvent {
    exchange: string;
    instrumentId: string;
    baseAsset: string;
    triggerType: TriggerType;
    triggerValue: number;
    previousOI: number;
    currentOI: number;
    deltaOI: number;
    deltaOIPercent: number;
    deltaOITokens?: number;
    severity: Severity;
    detectedAt: Date;
}

function computeMAD(values: number[]): { median: number; mad: number } {
    if (values.length === 0) return { median: 0, mad: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const deviations = values.map((v) => Math.abs(v - median));
    const sortedDev = [...deviations].sort((a, b) => a - b);
    const madMid = Math.floor(sortedDev.length / 2);
    const mad = sortedDev.length % 2 === 0 ? (sortedDev[madMid - 1] + sortedDev[madMid]) / 2 : sortedDev[madMid];
    return { median, mad };
}

function computeRobustZScore(value: number, median: number, mad: number, oiLevel = 0): number {
    const madFloor = Math.max(0, oiLevel) * config.oi.madFloorFraction;
    const scaledMAD = Math.max(1.4826 * mad, madFloor);
    if (scaledMAD === 0) return 0;
    return (value - median) / scaledMAD;
}

function updatePairState(state: PairStatisticalState, newOIClose: number): void {
    if (state.lastOI === null) {
        state.lastOI = newOIClose;
        state.candleCount++;
        return;
    }

    const deltaOI = newOIClose - state.lastOI;
    state.lastOI = newOIClose;
    state.candleCount++;

    // Update EWMA mean and variance
    const alpha = config.oi.ewmaAlpha;
    state.ewmaMean = alpha * deltaOI + (1 - alpha) * state.ewmaMean;
    const diff = deltaOI - state.ewmaMean;
    state.ewmaVariance = alpha * diff * diff + (1 - alpha) * state.ewmaVariance;

    // Update recentDeltaOI ring buffer (keep last 192)
    state.recentDeltaOI.push(deltaOI);
    if (state.recentDeltaOI.length > config.oi.warmupCandles) {
        state.recentDeltaOI.shift();
    }

    // Compute robust z-score using MAD
    const { median, mad } = computeMAD(state.recentDeltaOI);
    const zScore = computeRobustZScore(deltaOI, median, mad, newOIClose);

    // Update recentZScores ring buffer (keep last cumulativeZWindow)
    state.recentZScores.push(zScore);
    if (state.recentZScores.length > config.oi.cumulativeZWindow) {
        state.recentZScores.shift();
    }

    // Update CUSUM: S_t = max(0, S_{t-1} + (z_t - k))
    state.cusumScore = Math.max(0, state.cusumScore + (zScore - config.oi.cusumDrift));

    // Transition from WARMUP to READY
    if (state.status === 'WARMUP' && state.candleCount >= config.oi.warmupCandles) {
        state.status = 'READY';
    }
}

function detectAnomaly(state: PairStatisticalState): Omit<OIAnomalyEvent, 'priceContext' | 'detectedAt'> | null {
    if (state.status !== 'READY') return null;
    if (state.recentZScores.length === 0) return null;

    const latestZ = state.recentZScores[state.recentZScores.length - 1];
    const previousOI =
        state.lastOI !== null && state.recentDeltaOI.length > 0
            ? state.lastOI - state.recentDeltaOI[state.recentDeltaOI.length - 1]
            : 0;
    const currentOI = state.lastOI || 0;
    const deltaOI = state.recentDeltaOI.length > 0 ? state.recentDeltaOI[state.recentDeltaOI.length - 1] : 0;
    const deltaOIPercent = previousOI > 0 ? (deltaOI / previousOI) * 100 : 0;

    if (deltaOI <= 0) return null;
    if (deltaOIPercent < config.oi.minDeltaOIPercent) return null;

    // Check CUSUM first (CRITICAL severity)
    if (state.cusumScore > config.oi.cusumThreshold) {
        return {
            exchange: state.exchange,
            instrumentId: state.instrumentId,
            baseAsset: state.baseAsset,
            triggerType: 'SUSTAINED_BUILD',
            triggerValue: state.cusumScore,
            previousOI,
            currentOI,
            deltaOI,
            deltaOIPercent,
            severity: 'CRITICAL'
        };
    }

    // Check cumulative z-score (sum over window)
    if (state.recentZScores.length >= config.oi.cumulativeZWindow) {
        const cumulativeZ = state.recentZScores.reduce((sum, z) => sum + z, 0);
        if (cumulativeZ > config.oi.cumulativeZThreshold) {
            return {
                exchange: state.exchange,
                instrumentId: state.instrumentId,
                baseAsset: state.baseAsset,
                triggerType: 'SLOW_ACCUMULATION',
                triggerValue: cumulativeZ,
                previousOI,
                currentOI,
                deltaOI,
                deltaOIPercent,
                severity: 'HIGH'
            };
        }
    }

    // Check single-interval robust z-score (positive only - OI increases)
    if (latestZ > config.oi.zScoreThreshold) {
        return {
            exchange: state.exchange,
            instrumentId: state.instrumentId,
            baseAsset: state.baseAsset,
            triggerType: 'FAST_SPIKE',
            triggerValue: latestZ,
            previousOI,
            currentOI,
            deltaOI,
            deltaOIPercent,
            severity: 'HIGH'
        };
    }

    return null;
}

function finalizeAnomalyUsd(
    candidate: Omit<OIAnomalyEvent, 'priceContext' | 'detectedAt'>,
    price: number
): Omit<OIAnomalyEvent, 'priceContext' | 'detectedAt'> | null {
    if (!isFinite(price) || price <= 0) return null;

    const currentOIUsd = candidate.currentOI * price;
    const previousOIUsd = candidate.previousOI * price;
    const deltaOIUsd = candidate.deltaOI * price;

    if (currentOIUsd < config.oi.minOIThreshold) return null;
    if (deltaOIUsd < config.oi.minDeltaOIUsd) return null;

    return {
        ...candidate,
        deltaOITokens: candidate.deltaOI,
        previousOI: previousOIUsd,
        currentOI: currentOIUsd,
        deltaOI: deltaOIUsd
    };
}

export default class OIService extends Tracker {
    private api = new APIService();
    private hlApi = new HyperliquidAPI();
    private pairStates = new Map<string, PairStatisticalState>();
    private defaultInterval: Interval = '30m';
    private oiChannels: ChatChannel[];
    private hlOIChannels: ChatChannel[];

    constructor(tg: Tg, oiChannels: ChatChannel[], hlOIChannels: ChatChannel[], screenshotEnabled = false) {
        super(tg, [], screenshotEnabled);
        this.oiChannels = oiChannels;
        this.hlOIChannels = hlOIChannels;
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.logger.info('Monitoring started');
        this.logger.info(`Exchanges: [${config.oi.coinglassExchanges.join(', ')}]`);
        await this.refreshUniverse();
        await this.backfill();
        this.monitorTask = this.mainLoop();
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        await this.monitorTask?.catch((error) => this.logger.error(`Error while awaiting monitor task: ${error}`));
        this.monitorTask = undefined;
        await this.screenshoter.stop();
        this.logger.info('Monitoring stopped');
    }

    async blacklistById(id: string): Promise<{ msg: string; success: boolean }> {
        try {
            const entry = await DBService.getWhitelistEntryById(id);
            if (!entry) return { msg: `No entry found with ID ${id}.`, success: false };

            await DBService.removeFromWhitelist(entry.exchange, entry.instrumentId);
            return {
                msg: `Blacklisted ${entry.exchange}:${entry.instrumentId} successfully.`,
                success: true
            };
        } catch (error) {
            this.logger.error(`Failed to blacklist ${id}: ${error}`);
            return { msg: `An error occurred while blacklisting ${id}. Please try again later.`, success: false };
        }
    }

    private async mainLoop(): Promise<void> {
        const refreshUniverseLoop = async () => {
            await this.cancellableSleep(config.oi.refreshIntervalMs);
            while (this.running) {
                try {
                    await this.refreshUniverse();
                } catch (error) {
                    this.logger.error(`Failed to refresh the token universe: ${error}`);
                }
                if (!this.running) break;
                await this.cancellableSleep(config.oi.refreshIntervalMs);
            }
        };

        const coinglassScanLoop = async () => {
            while (this.running) {
                try {
                    await this.coinglassScanAllPairs();
                } catch (error) {
                    this.logger.error(`Failed to run a scan loop: ${error}`);
                }
                if (!this.running) break;
                await this.cancellableSleep(config.oi.coinglassIntervalMs);
            }
        };

        const hlScanLoop = async () => {
            while (this.running) {
                try {
                    await this.hlScanAllPairs();
                } catch (error) {
                    this.logger.error(`Failed to run Hyperliquid scan cycle: ${error}`);
                }
                if (!this.running) break;
                await this.cancellableSleep(config.oi.hlIntervalMs);
            }
        };

        const cleanupLoop = async () => {
            while (this.running) {
                try {
                    const deletedObs = await DBService.cleanOldObservations(config.oi.cleanupTTLms);
                    if (deletedObs > 0) {
                        this.logger.info(`Cleanup: deleted ${deletedObs} old observations`);
                    }
                } catch (error) {
                    this.logger.error(`Failed to cleanup: ${error}`);
                }
                if (!this.running) break;
                await this.cancellableSleep(config.monitor.cleanupIntervalMs);
            }
        };

        const alertNoDataLoop = this.watchDog(config.oi.noDataTimeoutMs);
        const scanWatchDog = this.scanWatchDog(config.oi.scanStallTimeoutMs);

        await Promise.all([
            coinglassScanLoop(),
            hlScanLoop(),
            cleanupLoop(),
            refreshUniverseLoop(),
            alertNoDataLoop,
            scanWatchDog
        ]);
    }

    private async refreshCoinglassUniverse(whitelist: Set<string>): Promise<number> {
        let totalPairs = 0;

        for (const exchange of config.oi.coinglassExchanges) {
            try {
                let pairs = await this.api.fetchExchangePairs(exchange);
                if (!pairs) throw new Error(`No pairs returned for ${exchange}`);
                await DBService.upsertInstrumentUniverse(exchange, pairs);

                const allPairsCount = pairs.length;
                pairs =
                    whitelist.size > 0 ? pairs.filter((p) => whitelist.has(`${exchange}:${p.instrumentId}`)) : pairs;

                for (const pair of pairs) {
                    const key = `${exchange}:${pair.instrumentId}`;
                    if (!this.pairStates.has(key)) {
                        this.pairStates.set(key, {
                            exchange,
                            instrumentId: pair.instrumentId,
                            baseAsset: pair.baseAsset,
                            ewmaMean: 0,
                            ewmaVariance: 0,
                            cusumScore: 0,
                            recentDeltaOI: [],
                            recentZScores: [],
                            lastOI: null,
                            lastObservationAt: null,
                            candleCount: 0,
                            status: 'WARMUP',
                            source: 'COINGLASS'
                        });
                    }
                }

                totalPairs += pairs.length;
                this.logger.info(
                    `${exchange}: ${pairs.length} pairs loaded${whitelist.size > 0 ? ` (filtered from ${allPairsCount})` : ''}`
                );
                await sleep(1500);
            } catch (error) {
                this.logger.error(`Failed to refresh ${exchange}: ${error}`);
            }
        }

        return totalPairs;
    }

    private async refreshHyperliquidUniverse(whitelist: Set<string>): Promise<number> {
        let totalPairs = 0;

        try {
            const meta = await this.hlApi.fetchPerpMeta();
            if (!meta || !meta.universe || !meta.assetMeta) {
                throw new Error('Invalid Hyperliquid meta response');
            }
            let pairs = normalizeHLPerpContexts(meta);
            const instruments = pairs.map((snap) => ({
                instrumentId: snap.instrumentId,
                baseAsset: snap.baseAsset,
                quoteAsset: 'USD' as const
            }));
            await DBService.upsertInstrumentUniverse('Hyperliquid', instruments);

            const allPairsCount = pairs.length;
            pairs = whitelist.size > 0 ? pairs.filter((p) => whitelist.has(`Hyperliquid:${p.instrumentId}`)) : pairs;

            for (const snap of pairs) {
                const key = `Hyperliquid:${snap.instrumentId}`;
                if (!this.pairStates.has(key)) {
                    this.pairStates.set(key, {
                        exchange: 'Hyperliquid',
                        instrumentId: snap.instrumentId,
                        baseAsset: snap.baseAsset,
                        ewmaMean: 0,
                        ewmaVariance: 0,
                        cusumScore: 0,
                        recentDeltaOI: [],
                        recentZScores: [],
                        lastOI: null,
                        lastObservationAt: null,
                        candleCount: 0,
                        status: 'WARMUP',
                        source: 'HYPERLIQUID'
                    });
                }
            }

            totalPairs += pairs.length;
            this.logger.info(
                `Hyperliquid: ${pairs.length} pairs loaded${whitelist.size > 0 ? ` (filtered from ${allPairsCount})` : ''}`
            );
        } catch (error) {
            this.logger.error(`Failed to refresh Hyperliquid: ${error}`);
        }

        return totalPairs;
    }

    private async refreshUniverse(): Promise<void> {
        this.logger.info('Refreshing token universe...');

        const whitelist = await DBService.getWhitelist();
        const whitelistSet = new Set(whitelist.map((w) => `${w.exchange}:${w.instrumentId}`));
        if (whitelist.length > 0) this.logger.info(`OI whitelisting: (${whitelist.length} tokens included)`);

        const result = await Promise.all([
            this.refreshCoinglassUniverse(whitelistSet),
            this.refreshHyperliquidUniverse(whitelistSet)
        ]);
        const totalPairs = result.reduce((sum, count) => sum + count, 0);

        if (totalPairs === 0) throw new Error(`No pairs detected for OI tracker`);
        this.logger.info(`Universe refresh complete: ${totalPairs} total pairs`);
        this.lastDataTimestamp = Date.now();
    }

    private async coinglassBackfill(
        entries: [string, PairStatisticalState][],
        startTime: number
    ): Promise<{ filled: number; failed: number; rateLimited: number; retried: number; localSeeded: number }> {
        const MAX_RETRIES = 3;
        let CONCURRENCY = 4;
        let filled = 0;
        let failed = 0;
        let rateLimited = 0;
        let retried = 0;
        let localSeeded = 0;

        const needsExternal: [string, PairStatisticalState][] = [];
        const backfillNow = new Date();
        for (const [key, state] of entries) {
            try {
                const observations = await DBService.getRecentOIObservations(
                    state.exchange,
                    state.instrumentId,
                    config.oi.warmupCandles
                );
                const newestAt = observations.length > 0 ? observations[observations.length - 1].intervalStart : null;
                const stale = isCoinglassDataStale(newestAt, backfillNow);

                if (observations.length >= config.oi.warmupCandles && !stale) {
                    this.replayDBHistory(
                        state,
                        observations.map((o) => ({ openInterest: o.openInterest, intervalStart: o.intervalStart }))
                    );
                    localSeeded++;
                    filled++;
                } else if (observations.length > 0) {
                    this.replayDBHistory(
                        state,
                        observations.map((o) => ({ openInterest: o.openInterest, intervalStart: o.intervalStart }))
                    );
                    needsExternal.push([key, state]);
                } else {
                    needsExternal.push([key, state]);
                }
            } catch (error) {
                this.logger.error(`Local warmup failed for ${key}: ${error}`);
                needsExternal.push([key, state]);
            }
        }

        if (localSeeded > 0 || needsExternal.length > 0) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            this.logger.info(
                `Coinglass local warmup: ${localSeeded} pairs seeded from local history, ${needsExternal.length} need external fetch [${elapsed}s]`
            );
        }

        if (needsExternal.length === 0) return { filled, failed, rateLimited, retried, localSeeded };

        const queue = [...needsExternal];
        const retryQueue: [string, PairStatisticalState][] = [];

        const processOne = async (entry: [string, PairStatisticalState]): Promise<boolean> => {
            const [, state] = entry;
            try {
                const candles = await this.api.fetchOIHistory(
                    state.exchange,
                    state.instrumentId,
                    this.defaultInterval,
                    config.oi.warmupCandles
                );
                if (candles && candles.length > 0) {
                    this.replayHistory(state, candles);
                    const observations = candles
                        .filter((c) => c.close > 0)
                        .map((c) => this.buildCoinglassObservation(state, c, normalizeCoinglassIntervalStart(c.time)));

                    if (observations.length > 0) {
                        await DBService.upsertOIObservations(observations).catch((err) =>
                            this.logger.error(
                                `Failed to persist backfill for ${state.exchange}:${state.instrumentId}: ${err}`
                            )
                        );
                    }
                    return true;
                }
            } catch (error) {}
            return false;
        };

        const runPool = async (q: [string, PairStatisticalState][], isRetry: boolean) => {
            let idx = 0;
            const total = q.length;

            const worker = async () => {
                while (true) {
                    if (!this.running) return;
                    const i = idx++;
                    if (i >= total) return;
                    const entry = q[i];

                    const result = await processOne(entry);

                    if (result) {
                        filled++;
                    } else {
                        rateLimited++;
                        if (!isRetry) {
                            retryQueue.push(entry);
                        } else {
                            failed++;
                            entry[1].status = 'DEGRADED_DATA';
                        }
                    }

                    const processed = filled + failed + rateLimited;
                    if (processed % 50 === 0 || processed === entries.length) {
                        const { usage, max } = this.api.getRateLimitUsage();
                        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                        this.logger.info(
                            `Backfill progress: ${processed}/${entries.length} (${filled} ok, ${failed} failed, ${rateLimited} rate-limited, ${localSeeded} local) [${elapsed}s, concurrency=${CONCURRENCY}, API: ${usage}/${max}]`
                        );
                    }
                }
            };

            const workers: Promise<void>[] = [];
            for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
            await Promise.all(workers);
        };

        await runPool(queue, false);

        for (let attempt = 0; attempt < MAX_RETRIES && retryQueue.length > 0; attempt++) {
            if (!this.running) break;
            const batch = retryQueue.splice(0);
            this.logger.info(`Backfill retry pass ${attempt + 1}/${MAX_RETRIES}: ${batch.length} pairs to retry`);
            await sleep(2000 + Math.random() * 1000);
            await runPool(batch, attempt === MAX_RETRIES - 1);
            retried += batch.length - retryQueue.length;
        }

        for (const [, state] of retryQueue) {
            state.status = 'DEGRADED_DATA';
            failed++;
        }

        return { filled, failed, rateLimited, retried, localSeeded };
    }

    private async hyperliquidBackfill(
        entries: [string, PairStatisticalState][],
        startTime: number
    ): Promise<{ filled: number; failed: number; rateLimited: number }> {
        let filled = 0;
        let failed = 0;
        let rateLimited = 0;

        for (const [, state] of entries) {
            if (!this.running) break;
            try {
                const observations = await DBService.getRecentOIObservations(
                    state.exchange,
                    state.instrumentId,
                    config.oi.warmupCandles
                );
                if (observations.length > 0) {
                    this.replayDBHistory(
                        state,
                        observations.map((o) => ({ openInterest: o.openInterest, intervalStart: o.intervalStart }))
                    );
                    filled++;
                }
            } catch (error) {
                failed++;
                state.status = 'DEGRADED_DATA';
                this.logger.error(`Warmup failed for Hyperliquid:${state.instrumentId}: ${error}`);
            }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (entries.length > 0) {
            this.logger.info(
                `Warmup progress (Hyperliquid): ${entries.length} pairs replayed from local history (${filled} ok, ${failed} failed) [${elapsed}s elapsed]`
            );
        }

        return { filled, failed, rateLimited };
    }

    private async backfill(): Promise<void> {
        this.logger.info(`Starting backfill for ${this.pairStates.size} pairs...`);

        const entries = [...this.pairStates.entries()];
        const coinglassEntries = entries.filter(([, s]) => isCoinglassSource(s.source));
        const hyperliquidEntries = entries.filter(([, s]) => isHyperliquidSource(s.source));
        const startTime = Date.now();

        const result = await Promise.all([
            this.coinglassBackfill(coinglassEntries, startTime),
            this.hyperliquidBackfill(hyperliquidEntries, startTime)
        ]);
        const filled = result.reduce((sum, r) => sum + r.filled, 0);
        const failed = result.reduce((sum, r) => sum + r.failed, 0);
        const rateLimited = result.reduce((sum, r) => sum + r.rateLimited, 0);
        const retried = result.reduce((sum, r) => sum + ('retried' in r ? r.retried : 0), 0);
        const localSeeded = result.reduce((sum, r) => sum + ('localSeeded' in r ? r.localSeeded : 0), 0);

        const readyCount = [...this.pairStates.values()].filter((s) => s.status === 'READY').length;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        this.logger.info(
            `Backfill complete in ${elapsed}s: ${filled} filled (${localSeeded} local-seeded), ${readyCount} ready, ${failed} failed (${rateLimited} rate-limited, ${retried} retried)`
        );
        this.lastDataTimestamp = Date.now();
    }

    private replayHistory(state: PairStatisticalState, candles: OICandle[]): void {
        for (const candle of candles) {
            if (!(candle.close > 0)) continue;
            updatePairState(state, candle.close);
            state.lastObservationAt = normalizeCoinglassIntervalStart(candle.time);
        }
        state.cusumScore = 0;
        state.recentZScores = [];
    }

    private replayDBHistory(
        state: PairStatisticalState,
        observations: { openInterest: number; intervalStart: Date }[]
    ): void {
        for (const obs of observations) updatePairState(state, obs.openInterest);
        state.cusumScore = 0;
        state.recentZScores = [];
        if (observations.length > 0) {
            state.lastObservationAt = observations[observations.length - 1].intervalStart;
        }
    }

    private buildCoinglassObservation(
        state: PairStatisticalState,
        candle: OICandle,
        intervalStart: Date
    ): {
        exchange: string;
        instrumentId: string;
        baseAsset: string;
        quoteAsset: string;
        source: 'COINGLASS';
        intervalStart: Date;
        observedAt: Date;
        openInterest: number;
        valid: boolean;
    } {
        return {
            exchange: state.exchange,
            instrumentId: state.instrumentId,
            baseAsset: state.baseAsset,
            quoteAsset: 'USD',
            source: 'COINGLASS',
            intervalStart,
            observedAt: new Date(),
            openInterest: candle.close,
            valid: candle.close > 0
        };
    }

    private async hlScanAllPairs(): Promise<void> {
        if (!this.running) return;

        const cycleStart = Date.now();
        const meta = await this.hlApi.fetchPerpMeta();
        if (!meta || !meta.universe || !meta.assetMeta) {
            this.logger.error('Invalid Hyperliquid meta response, skipping cycle');
            return;
        }
        const snapshots = normalizeHLPerpContexts(meta);
        if (snapshots.length === 0) {
            this.logger.warn('Hyperliquid collection failed: no snapshots returned, skipping cycle');
            return;
        }

        const snapshotMap = new Map<string, HyperliquidOISnapshot>();
        for (const snap of snapshots) snapshotMap.set(snap.instrumentId, snap);

        const intervalStart = normalizeIntervalStart(Date.now(), config.oi.hlIntervalMs);
        const now = new Date();

        const observations: Array<{
            exchange: string;
            instrumentId: string;
            baseAsset: string;
            quoteAsset: string;
            source: 'HYPERLIQUID';
            intervalStart: Date;
            observedAt: Date;
            openInterest: number;
            rawOpenInterest: number;
            markPrice: number;
            midPrice?: number;
            valid: boolean;
        }> = [];

        const hlPairs = [...this.pairStates.entries()].filter(
            ([, s]) => isHyperliquidSource(s.source) && (s.status === 'READY' || s.status === 'WARMUP')
        );

        let stored = 0;
        let skipped = 0;
        let anomaliesDetected = 0;
        let transitioned = 0;

        for (const [, state] of hlPairs) {
            const snap = snapshotMap.get(state.instrumentId);
            if (!snap || snap.isDelisted || snap.openInterest <= 0) {
                skipped++;
                continue;
            }

            observations.push({
                exchange: snap.exchange,
                instrumentId: snap.instrumentId,
                baseAsset: snap.baseAsset,
                quoteAsset: snap.quoteAsset,
                source: 'HYPERLIQUID',
                intervalStart,
                observedAt: now,
                openInterest: snap.rawOpenInterest,
                rawOpenInterest: snap.rawOpenInterest,
                markPrice: snap.markPrice,
                midPrice: snap.midPrice ?? undefined,
                valid: true
            });
        }

        if (observations.length > 0) stored = await DBService.upsertOIObservations(observations);

        for (const [pairKey, state] of hlPairs) {
            try {
                if (!this.running) break;
                const snap = snapshotMap.get(state.instrumentId);
                if (!snap || snap.isDelisted || snap.openInterest <= 0) continue;

                const whitelistEntry = await DBService.getWhitelistEntry(state.exchange, state.instrumentId);
                if (!whitelistEntry) {
                    this.logger.debug(`Hyperliquid pair ${pairKey} is not whitelisted, skipping anomaly detection`);
                    continue;
                }

                const prevStatus = state.status;
                if (state.status === 'DEGRADED_DATA' && state.candleCount >= config.oi.warmupCandles) {
                    state.status = 'READY';
                }

                updatePairState(state, snap.rawOpenInterest);
                state.lastObservationAt = intervalStart;

                if (prevStatus === 'WARMUP' && state.status === 'READY') {
                    transitioned++;
                }

                const detection = detectAnomaly(state);
                if (detection) {
                    state.cusumScore = 0;
                    const event = finalizeAnomalyUsd(detection, snap.markPrice);
                    if (event) {
                        anomaliesDetected++;
                        this.lastDataTimestamp = Date.now();

                        await this.sendAlert(
                            {
                                ...event,
                                detectedAt: new Date(),
                                pairEntryId: whitelistEntry.id
                            },
                            this.hlOIChannels
                        );
                    }
                }
            } catch (error) {
                this.logger.error(`Error evaluating Hyperliquid pair ${pairKey}: ${error}`);
            }
        }

        this.lastScanTimestamp = Date.now();
        this.lastDataTimestamp = Date.now();
        const cycleDuration = (Date.now() - cycleStart) / 1000;
        const allHlStates = [...this.pairStates.values()].filter((s) => isHyperliquidSource(s.source));
        const ready = allHlStates.filter((s) => s.status === 'READY').length;
        const warming = allHlStates.filter((s) => s.status === 'WARMUP').length;
        const degraded = allHlStates.filter((s) => s.status === 'DEGRADED_DATA').length;

        this.logger.info(
            `Hyperliquid scan complete: ${hlPairs.length} attempted, ${stored} stored, ${skipped} skipped, ${anomaliesDetected} anomalies, ${transitioned} transitioned [${cycleDuration.toFixed(1)}s] | ` +
                `Status: ${ready} READY, ${warming} WARMUP, ${degraded} DEGRADED`
        );
    }

    private async coinglassScanAllPairs(): Promise<void> {
        if (!this.running) return;

        const CONCURRENCY = 2;
        const safeRpsLimit = Math.max(config.coinglass.rateLimit.requestsPerSecond, 0.1);
        const targetRpm = safeRpsLimit * 60;
        const perWorkerIntervalMs = Math.ceil((1000 * CONCURRENCY) / safeRpsLimit);
        let anomaliesDetected = 0;
        let idx = 0;
        let scanned = 0;
        let failed = 0;
        let transitioned = 0;
        const exchangeStats = new Map<string, { scanned: number; failed: number }>();
        const progressInterval = 500;
        const cycleStart = Date.now();
        const now = new Date();
        this.logger.info(
            `Coinglass scan cycle starting... [concurrency=${CONCURRENCY}, target=${targetRpm.toFixed(1)} rpm (${safeRpsLimit.toFixed(2)} rps), workerInterval=${perWorkerIntervalMs}ms]`
        );

        const allCoinglassPairs = [...this.pairStates.entries()].filter(([, s]) => isCoinglassSource(s.source));
        let gapDetected = 0;
        for (const [, state] of allCoinglassPairs) {
            if (state.status === 'READY' && detectCoinglassGap(state, now)) {
                enterDegraded(state);
                gapDetected++;
            }
        }
        if (gapDetected > 0) this.logger.info(`Gap detection: ${gapDetected} pairs transitioned to DEGRADED_DATA`);

        const readyPairs = [...this.pairStates.entries()].filter(
            ([, s]) =>
                (s.status === 'READY' || s.status === 'WARMUP' || s.status === 'DEGRADED_DATA') &&
                isCoinglassSource(s.source)
        );

        const worker = async () => {
            while (true) {
                if (!this.running) return;
                const iterationStartedAt = Date.now();
                const i = idx++;
                if (i >= readyPairs.length) return;
                const [pairKey, state] = readyPairs[i];
                const prevStatus = state.status;

                try {
                    const whitelistEntry = await DBService.getWhitelistEntry(state.exchange, state.instrumentId);
                    if (!whitelistEntry) {
                        this.logger.debug(`${state.exchange} ${pairKey} is not whitelisted, skipping evaluation`);
                        continue;
                    }

                    const anomaly = await this.evaluateCoinglassPair(state);
                    scanned++;
                    const stats = exchangeStats.get(state.exchange) || { scanned: 0, failed: 0 };
                    stats.scanned++;
                    exchangeStats.set(state.exchange, stats);

                    if (prevStatus === 'WARMUP' && state.status === 'READY') {
                        transitioned++;
                    }

                    if (anomaly) {
                        anomaliesDetected++;
                        await this.sendAlert({ ...anomaly, pairEntryId: whitelistEntry.id }, this.oiChannels);
                    }
                } catch (error) {
                    failed++;
                    const stats = exchangeStats.get(state.exchange) || { scanned: 0, failed: 0 };
                    stats.failed++;
                    exchangeStats.set(state.exchange, stats);
                    this.logger.debug(`Error evaluating ${pairKey}: ${error}`);
                }

                if ((scanned + failed) % progressInterval === 0) {
                    const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
                    this.logger.info(
                        `Coinglass scan progress: ${scanned + failed}/${readyPairs.length} pairs [${elapsed}s elapsed, ${failed} failed]`
                    );
                }

                const elapsedMs = Date.now() - iterationStartedAt;
                const waitMs = perWorkerIntervalMs - elapsedMs;
                if (waitMs > 0) await sleep(waitMs);
            }
        };

        const workers: Promise<void>[] = [];
        for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
        await Promise.all(workers);

        this.lastScanTimestamp = Date.now();
        const cycleDuration = (Date.now() - cycleStart) / 1000;
        const allStates = [...this.pairStates.values()].filter((s) => isCoinglassSource(s.source));
        const ready = allStates.filter((s) => s.status === 'READY').length;
        const warming = allStates.filter((s) => s.status === 'WARMUP').length;
        const degraded = allStates.filter((s) => s.status === 'DEGRADED_DATA').length;

        this.logger.info(
            `Coinglass scan complete: ${readyPairs.length} pairs, ${anomaliesDetected} anomalies, ${failed} failed, ${transitioned} transitioned [${cycleDuration.toFixed(1)}s] | ` +
                `Status: ${ready} READY, ${warming} WARMUP, ${degraded} DEGRADED`
        );
        if (exchangeStats.size > 0) {
            const breakdown = [...exchangeStats.entries()]
                .map(([ex, s]) => `${ex}: ${s.scanned}${s.failed > 0 ? ` (${s.failed} err)` : ''}`)
                .join(', ');
            this.logger.info(`Coinglass scan breakdown: ${breakdown}`);
        }
    }

    private async evaluateCoinglassPair(state: PairStatisticalState): Promise<OIAnomalyEvent | null> {
        const candles = await this.api.fetchOIHistory(
            state.exchange,
            state.instrumentId,
            this.defaultInterval,
            config.oi.coinglassScanFetchLimit
        );

        if (!candles) throw new Error(`Failed to fetch OI history for ${state.exchange}:${state.instrumentId}`);

        if (candles.length === 0) {
            if (state.status === 'READY') enterDegraded(state);
            return null;
        }

        const newCandles = candles.filter(
            (c) =>
                c.close > 0 &&
                (!state.lastObservationAt ||
                    normalizeCoinglassIntervalStart(c.time).getTime() > state.lastObservationAt.getTime())
        );

        if (newCandles.length === 0) return null;

        if (state.status === 'DEGRADED_DATA' && state.candleCount >= config.oi.warmupCandles) {
            state.status = 'READY';
            this.logger.debug(`Pair recovered: ${state.exchange}:${state.instrumentId} re-warmed, now READY`);
        }

        const observations = newCandles.map((c) =>
            this.buildCoinglassObservation(state, c, normalizeCoinglassIntervalStart(c.time))
        );
        try {
            await DBService.upsertOIObservations(observations);
        } catch (error) {
            this.logger.error(`Failed to persist observations for ${state.exchange}:${state.instrumentId}: ${error}`);
        }

        this.lastDataTimestamp = Date.now();

        const suppress = state.suppressPostGapDelta;
        if (suppress) {
            state.suppressPostGapDelta = false;
            state.lastOI = null;
        }

        for (const c of newCandles) {
            updatePairState(state, c.close);
            state.lastObservationAt = normalizeCoinglassIntervalStart(c.time);
        }

        if (suppress) {
            state.cusumScore = 0;
            return null;
        }

        const detection = detectAnomaly(state);
        if (!detection) return null;

        state.cusumScore = 0;

        const priceCandles = await this.api.fetchPriceHistory(
            state.exchange,
            state.instrumentId,
            this.defaultInterval,
            1
        );
        const price = priceCandles && priceCandles.length > 0 ? priceCandles[priceCandles.length - 1].close : NaN;
        if (!isFinite(price) || price <= 0) {
            this.logger.warn(
                `No price for ${state.exchange}:${state.instrumentId}, cannot resolve USD for anomaly, suppressing`
            );
            return null;
        }

        const event = finalizeAnomalyUsd(detection, price);
        if (!event) return null;

        return {
            ...event,
            detectedAt: new Date()
        };
    }

    private async sendAlert(event: OIAnomalyEvent & { pairEntryId: string }, channels: ChatChannel[]): Promise<void> {
        const redis = getRedisClient();
        const cooldownKey = `oi:cooldown:${event.exchange}:${event.instrumentId}`;

        const cooldownActive = await redis.get(cooldownKey);
        if (cooldownActive) {
            this.logger.debug(`Cooldown active for ${event.exchange}:${event.instrumentId}, suppressing alert`);
            return;
        }

        this.logger.info(
            `OI anomaly detected for ${event.exchange}:${event.instrumentId} (severity: ${event.severity}, trigger: ${event.triggerType}, OI change: ${event.deltaOIPercent.toFixed(1)}%), sending alert`
        );

        const result = this.formatAlertMessage(event);
        if (!result) return;
        const { msg, buttons } = result;

        let screenshot: Buffer | null = null;
        if (this.screenshoter) {
            const query = `${event.baseAsset} ${event.exchange} open interest`;
            try {
                screenshot = await this.screenshoter.capture(
                    `https://coinalyze.net`,
                    'div[id="chart-elm"]',
                    undefined,
                    async (page) => {
                        await page.click('input[placeholder="Search"]');
                        await page.type('input[placeholder="Search"]', query, { delay: 100 });
                        await page.waitForSelector('ul.symbol-search li:nth-child(2)', {
                            visible: true,
                            timeout: 10000
                        });
                        const items = await page.$$('ul.symbol-search li');
                        if (items.length < 2) throw new Error('Less than 2 search results found');
                        await items[1].click();
                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });

                        const frame = page.frames().find((f) => {
                            return f.url().includes('blob:');
                        });
                        if (!frame) return;
                        await sleep(1000);
                        await frame.click('[data-name="open-indicators-dialog"]');
                        await sleep(1000);
                        await frame.type('input[data-role="search"]', 'Funding Rate');
                        await frame.click('div[data-id="FundingRateSingleValue@tv-basicstudies"]');

                        await page.keyboard.press('Escape');
                        try {
                            await frame.waitForSelector('input[data-role="search"]', { hidden: true, timeout: 2000 });
                        } catch {
                            await page.keyboard.press('Escape');
                        }
                    }
                );
            } catch (error) {
                this.logger.warn(
                    `Failed to capture Coinalyze screenshot for ${event.exchange}:${event.instrumentId}, sending text alert only: ${error}`
                );
                screenshot = null;
            }
        }

        for (let i = 0; i < channels.length; i++) {
            if (i > 0) await sleep(1000);
            const channel = channels[i];
            try {
                let messageId: number | undefined;
                if (screenshot) {
                    messageId = await this.tg.sendPhoto(channel.chatId, screenshot, msg, {
                        reply_markup: buttons,
                        message_thread_id: channel.topicId
                    });
                } else {
                    messageId = await this.tg.sendMessage(channel.chatId, msg, {
                        reply_markup: buttons,
                        message_thread_id: channel.topicId
                    });
                }
                await redis.set(cooldownKey, event.severity, { EX: config.oi.cooldownSeconds });
            } catch (error) {
                this.logger.error(`Failed to send alert for ${event.exchange}:${event.instrumentId}: ${error}`);
            }
        }
    }

    private formatAlertMessage(
        event: OIAnomalyEvent & { pairEntryId: string }
    ): { msg: string; buttons: InlineKeyboardMarkup } | null {
        const severityEmoji = event.severity === 'CRITICAL' ? '🚨' : '⚠️';
        const triggerLabel = {
            FAST_SPIKE: '⚡ Fast Spike',
            SLOW_ACCUMULATION: '📈 Slow Accumulation',
            SUSTAINED_BUILD: '🔥 Sustained Build'
        }[event.triggerType];

        const fmtOI = (n: number) =>
            n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${(n / 1_000).toFixed(1)}K`;
        const fmtTokens = (n: number) =>
            n >= 1_000_000
                ? `${(n / 1_000_000).toFixed(3)}M`
                : n >= 1_000
                  ? `${(n / 1_000).toFixed(2)}K`
                  : n.toFixed(0);
        const pct = `${event.deltaOIPercent >= 0 ? '+' : ''}${event.deltaOIPercent.toFixed(1)}%`;
        const tokenDeltaLine =
            event.deltaOITokens !== undefined
                ? `🧮 Token Delta: <b>${event.deltaOITokens >= 0 ? '+' : ''}${fmtTokens(event.deltaOITokens)}</b>`
                : null;

        const lines: string[] = [
            `${severityEmoji} <b>OI Anomaly • ${event.severity} • ${triggerLabel}</b>`,
            `🪙 <b>${event.baseAsset}</b> • ${event.exchange}`,
            ``,
            `📊 OI (USD): <b>${fmtOI(event.previousOI)} → ${fmtOI(event.currentOI)}</b>`,
            `📈 Change: <b>${pct}</b>`
        ];

        if (tokenDeltaLine) lines.push(tokenDeltaLine);

        lines.push(
            `📏 Trigger: <b>${event.triggerValue.toFixed(2)}</b> (threshold: ${this.getThresholdForType(event.triggerType)})`,
            ``,
            `🕐 ${event.detectedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`
        );

        return {
            msg: lines.join('\n'),
            buttons: {
                inline_keyboard: [
                    [{ text: '📊 View OI on Coinalyze', url: 'https://coinalyze.net/' }],
                    [Markup.button.callback('🚫 Blacklist', `bl:${event.pairEntryId}`, true)]
                ]
            }
        };
    }

    private getThresholdForType(triggerType: TriggerType): string {
        switch (triggerType) {
            case 'FAST_SPIKE':
                return `z>${config.oi.zScoreThreshold}`;
            case 'SLOW_ACCUMULATION':
                return `Σz>${config.oi.cumulativeZThreshold}`;
            case 'SUSTAINED_BUILD':
                return `CUSUM>${config.oi.cusumThreshold}`;
        }
    }
}
