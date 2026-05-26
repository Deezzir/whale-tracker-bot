import { Tracker } from '../../common/tracker';
import { config } from '../../config';
import APIService, { Interval, OICandle, PriceCandle } from '../api/coinglass';
import DBService, { TriggerType, Severity } from '../db/oi';
import { getRedisClient } from '../redis';
import Tg from '../telegram';
import { sleep } from '../../common/utils';
import { InlineKeyboardMarkup } from 'telegraf/types';
import HyperliquidAPI, { PerpsMeta } from '../api/hyperliquid';

export type PairStatus = 'WARMUP' | 'READY' | 'DEGRADED_DATA';
export type OISource = 'COINGLASS' | 'HYPERLIQUID';

export interface PairStatisticalState {
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
}

export interface HyperliquidOISnapshot {
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

export function normalizeIntervalStart(timestamp: number, intervalMs: number): Date {
    return new Date(Math.floor(timestamp / intervalMs) * intervalMs);
}

export function isHyperliquidSource(source: OISource): boolean {
    return source === 'HYPERLIQUID';
}

export function isCoinglassSource(source: OISource): boolean {
    return source === 'COINGLASS';
}

export interface OIAnomalyEvent {
    exchange: string;
    instrumentId: string;
    baseAsset: string;
    triggerType: TriggerType;
    triggerValue: number;
    previousOI: number;
    currentOI: number;
    deltaOI: number;
    deltaOIPercent: number;
    severity: Severity;
    priceContext: {
        priceChangePercent: number | null;
        isStealthPositioning: boolean;
    };
    detectedAt: Date;
}

export function computeMAD(values: number[]): { median: number; mad: number } {
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

export function computeRobustZScore(value: number, median: number, mad: number): number {
    const scaledMAD = 1.4826 * mad;
    if (scaledMAD === 0) return 0;
    return (value - median) / scaledMAD;
}

export function updatePairState(state: PairStatisticalState, newOIClose: number): void {
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
    if (state.recentDeltaOI.length > config.oi.ewmaLookback) {
        state.recentDeltaOI.shift();
    }

    // Compute robust z-score using MAD
    const { median, mad } = computeMAD(state.recentDeltaOI);
    const zScore = computeRobustZScore(deltaOI, median, mad);

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

export function detectAnomaly(state: PairStatisticalState): Omit<OIAnomalyEvent, 'priceContext' | 'detectedAt'> | null {
    if (state.status !== 'READY') return null;
    if (state.recentZScores.length === 0) return null;
    if ((state.lastOI || 0) < config.oi.minOIThreshold) return null;

    const latestZ = state.recentZScores[state.recentZScores.length - 1];
    const previousOI =
        state.lastOI !== null && state.recentDeltaOI.length > 0
            ? state.lastOI - state.recentDeltaOI[state.recentDeltaOI.length - 1]
            : 0;
    const currentOI = state.lastOI || 0;
    const deltaOI = state.recentDeltaOI.length > 0 ? state.recentDeltaOI[state.recentDeltaOI.length - 1] : 0;
    const deltaOIPercent = previousOI > 0 ? (deltaOI / previousOI) * 100 : 0;

    // Global quality gates to reduce low-signal noise
    if (deltaOI <= 0) return null;
    if (deltaOI < config.oi.minDeltaOIUsd) return null;
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

export function computePriceContext(priceCandles: PriceCandle[]): {
    priceChangePercent: number | null;
    isStealthPositioning: boolean;
} {
    if (priceCandles.length < 2) {
        return { priceChangePercent: null, isStealthPositioning: false };
    }
    const oldest = priceCandles[0].close;
    const latest = priceCandles[priceCandles.length - 1].close;
    const priceChangePercent = oldest > 0 ? ((latest - oldest) / oldest) * 100 : 0;
    const isStealthPositioning = Math.abs(priceChangePercent) <= config.oi.stealthPriceThreshold;
    return { priceChangePercent, isStealthPositioning };
}

export default class OIService extends Tracker {
    private api = new APIService();
    private hlApi = new HyperliquidAPI();
    private pairStates = new Map<string, PairStatisticalState>();
    private backfillDone = false;
    private defaultInterval: Interval = '30m';

    constructor(tg: Tg, channels: { chatId: number }[]) {
        super(tg, channels);
        if (config.oi.coinglassExchanges.length === 0 && !config.oi.hyperliquidDirectEnabled)
            throw new Error(`No exchanges provided for the CoinGlass tracker and Hyperliquid direct is disabled`);
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.logger.info('Monitoring started');
        this.logger.info(`Exchanges: [${config.oi.coinglassExchanges.join(', ')}]`);
        if (config.oi.hyperliquidDirectEnabled) {
            this.logger.info(`Hyperliquid direct: enabled (interval: ${config.oi.hyperliquidIntervalMs}ms)`);
        }

        await this.refreshUniverse();
        await this.backfill();
        this.monitorTask = this.mainLoop();
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        await this.monitorTask?.catch((error) => this.logger.error(`Error while awaiting monitor task: ${error}`));
        this.monitorTask = undefined;
        this.logger.info('Monitoring stopped');
    }

    private async mainLoop(): Promise<void> {
        const refreshUniverseLoop = async () => {
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
                await this.cancellableSleep(config.oi.intervalMs);
            }
        };

        const hlScanLoop = async () => {
            if (!config.oi.hyperliquidDirectEnabled) return;
            while (this.running) {
                try {
                    await this.hlScanAllPairs();
                } catch (error) {
                    this.logger.error(`Failed to run Hyperliquid scan cycle: ${error}`);
                }
                if (!this.running) break;
                await this.cancellableSleep(config.oi.hyperliquidIntervalMs);
            }
        };

        const alertNoDataLoop = this.watchDog(config.oi.noDataTimeoutMs);
        const scanWatchDog = this.scanWatchDog(config.oi.scanStallTimeoutMs);

        await Promise.all([coinglassScanLoop(), hlScanLoop(), refreshUniverseLoop(), alertNoDataLoop, scanWatchDog]);
    }

    private async refreshCoinglassUniverse(): Promise<number> {
        const blacklist = config.oi.coinglassTokenBlacklist;
        let totalPairs = 0;

        for (const exchange of config.oi.coinglassExchanges) {
            try {
                let pairs = await this.api.fetchExchangePairs(exchange);
                await DBService.upsertInstrumentUniverse(exchange, pairs);

                const allPairsCount = pairs.length;
                if (blacklist.length > 0) {
                    pairs = pairs.filter((p) => !blacklist.includes(p.baseAsset.toUpperCase()));
                }

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
                    `${exchange}: ${pairs.length} pairs loaded${blacklist.length > 0 ? ` (filtered from ${allPairsCount})` : ''}`
                );
            } catch (error) {
                this.logger.error(`Failed to refresh ${exchange}: ${error}`);
            }
        }

        return totalPairs;
    }

    private async refreshHyperliquidUniverse(): Promise<number> {
        if (!config.oi.hyperliquidDirectEnabled) return 0;

        const blacklist = config.oi.coinglassTokenBlacklist;
        let totalPairs = 0;

        try {
            const meta = await this.hlApi.fetchPerpMeta();
            if (!meta || !meta.universe || !meta.assetMeta) {
                throw new Error('Invalid Hyperliquid meta response');
            }
            const snapshots = normalizeHLPerpContexts(meta);
            const instruments = snapshots.map((snap) => ({
                instrumentId: snap.instrumentId,
                baseAsset: snap.baseAsset,
                quoteAsset: 'USD' as const
            }));
            await DBService.upsertInstrumentUniverse('Hyperliquid', instruments);

            const allCount = snapshots.length;
            const filtered =
                blacklist.length > 0
                    ? snapshots.filter((s) => !blacklist.includes(s.baseAsset.toUpperCase()))
                    : snapshots;

            for (const snap of filtered) {
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

            totalPairs += filtered.length;
            this.logger.info(
                `Hyperliquid: ${filtered.length} pairs loaded${blacklist.length > 0 ? ` (filtered from ${allCount})` : ''}`
            );
        } catch (error) {
            this.logger.error(`Failed to refresh Hyperliquid: ${error}`);
        }

        return totalPairs;
    }

    private async refreshUniverse(): Promise<void> {
        this.logger.info('Refreshing token universe...');
        const blacklist = config.oi.coinglassTokenBlacklist;
        if (blacklist.length > 0) this.logger.info(`Blacklist (${blacklist.length} tokens excluded)`);

        const result = await Promise.all([this.refreshCoinglassUniverse(), this.refreshHyperliquidUniverse()]);
        const totalPairs = result.reduce((sum, count) => sum + count, 0);

        if (totalPairs === 0) throw new Error(`No pairs detected for OI tracker`);
        this.logger.info(`Universe refresh complete: ${totalPairs} total pairs`);
        this.lastDataTimestamp = Date.now();
    }

    private async coinglassBackfill(
        entries: [string, PairStatisticalState][],
        startTime: number
    ): Promise<{ filled: number; failed: number; rateLimited: number }> {
        const concurrency = config.oi.coinglassBackfillConcurrency;
        let filled = 0;
        let failed = 0;
        let rateLimited = 0;

        for (let i = 0; i < entries.length; i += concurrency) {
            if (!this.running) break;

            const batch = entries.slice(i, i + concurrency);
            const results = await Promise.allSettled(
                batch.map(async ([, state]) => {
                    const candles = await this.api.fetchOIHistory(
                        state.exchange,
                        state.instrumentId,
                        this.defaultInterval,
                        config.oi.warmupCandles
                    );

                    if (candles.length > 0) {
                        this.replayHistory(state, candles);
                        return 'ok';
                    }
                    return 'empty';
                })
            );

            for (let j = 0; j < results.length; j++) {
                const result = results[j];
                if (result.status === 'fulfilled' && result.value === 'ok') {
                    filled++;
                } else if (result.status === 'rejected') {
                    const errMsg = String(result.reason);
                    if (errMsg.includes('429') || errMsg.includes('Too Many')) {
                        rateLimited++;
                    }
                    failed++;
                    batch[j][1].status = 'DEGRADED_DATA';
                }
            }

            const processed = Math.min(i + concurrency, entries.length);
            if (processed % (concurrency * 10) === 0 || processed === entries.length) {
                const { usage, max } = this.api.getRateLimitUsage();
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                this.logger.info(
                    `Backfill progress (CoinGlass): ${processed}/${entries.length} (${filled} ok, ${failed} failed, ${rateLimited} rate-limited) [${elapsed}s elapsed, API: ${usage}/${max}]`
                );
            }

            await sleep(1200);
        }

        return { filled, failed, rateLimited };
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
        if (this.backfillDone) return;
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

        this.backfillDone = true;
        const readyCount = [...this.pairStates.values()].filter((s) => s.status === 'READY').length;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        this.logger.info(
            `Backfill complete in ${elapsed}s: ${filled} filled, ${readyCount} ready, ${failed} failed (${rateLimited} rate-limited)`
        );
        this.lastDataTimestamp = Date.now();
    }

    private replayHistory(state: PairStatisticalState, candles: OICandle[]): void {
        for (const candle of candles) updatePairState(state, candle.close);
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

    private async computeHLPriceContext(instrumentId: string): Promise<{
        priceChangePercent: number | null;
        isStealthPositioning: boolean;
    }> {
        try {
            const recent = await DBService.getRecentOIObservations('Hyperliquid', instrumentId, 4);
            const prices = recent.filter((o) => o.markPrice != null && o.markPrice > 0).map((o) => o.markPrice!);
            if (prices.length < 2) return { priceChangePercent: null, isStealthPositioning: false };
            const oldest = prices[0];
            const latest = prices[prices.length - 1];
            const priceChangePercent = oldest > 0 ? ((latest - oldest) / oldest) * 100 : 0;
            const isStealthPositioning = Math.abs(priceChangePercent) <= config.oi.stealthPriceThreshold;
            return { priceChangePercent, isStealthPositioning };
        } catch {
            return { priceChangePercent: null, isStealthPositioning: false };
        }
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

        const intervalStart = normalizeIntervalStart(Date.now(), config.oi.hyperliquidIntervalMs);
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
                openInterest: snap.openInterest,
                rawOpenInterest: snap.rawOpenInterest,
                markPrice: snap.markPrice,
                midPrice: snap.midPrice ?? undefined,
                valid: true
            });
        }

        if (observations.length > 0) {
            stored = await DBService.upsertOIObservations(observations);
        }

        for (const [pairKey, state] of hlPairs) {
            if (!this.running) break;
            const snap = snapshotMap.get(state.instrumentId);
            if (!snap || snap.isDelisted || snap.openInterest <= 0) continue;

            try {
                if (state.status === 'DEGRADED_DATA' && state.candleCount >= config.oi.warmupCandles) {
                    state.status = 'READY';
                }

                updatePairState(state, snap.openInterest);
                state.lastObservationAt = intervalStart;

                const detection = detectAnomaly(state);
                if (detection) {
                    anomaliesDetected++;
                    state.cusumScore = 0;
                    this.lastDataTimestamp = Date.now();

                    const priceContext = await this.computeHLPriceContext(state.instrumentId);

                    await this.sendAlert({
                        ...detection,
                        priceContext,
                        detectedAt: new Date()
                    });
                }
            } catch (error) {
                this.logger.error(`Error evaluating Hyperliquid pair ${pairKey}: ${error}`);
            }
        }

        this.lastScanTimestamp = Date.now();
        this.lastDataTimestamp = Date.now();
        const cycleDuration = Date.now() - cycleStart;
        const allHlStates = [...this.pairStates.values()].filter((s) => isHyperliquidSource(s.source));
        const ready = allHlStates.filter((s) => s.status === 'READY').length;
        const warming = allHlStates.filter((s) => s.status === 'WARMUP').length;
        const degraded = allHlStates.filter((s) => s.status === 'DEGRADED_DATA').length;

        this.logger.info(
            `Hyperliquid scan complete: ${hlPairs.length} attempted, ${stored} stored, ${skipped} skipped, ${anomaliesDetected} anomalies [${cycleDuration}ms] | ` +
                `Status: ${ready} READY, ${warming} WARMUP, ${degraded} DEGRADED`
        );
    }

    private async coinglassScanAllPairs(): Promise<void> {
        if (!this.running) return;

        const cycleStart = Date.now();
        const readyPairs = [...this.pairStates.entries()].filter(
            ([, s]) => (s.status === 'READY' || s.status === 'WARMUP') && isCoinglassSource(s.source)
        );

        let anomaliesDetected = 0;

        for (const [pairKey, state] of readyPairs) {
            if (!this.running) break;
            try {
                const anomaly = await this.evaluatePair(state);
                if (anomaly) {
                    anomaliesDetected++;
                    await this.sendAlert(anomaly);
                }
            } catch (error) {
                this.logger.error(`Error evaluating ${pairKey}: ${error}`);
            }
            await sleep(150);
        }

        this.lastScanTimestamp = Date.now();
        const cycleDuration = Date.now() - cycleStart;
        const allHlStates = [...this.pairStates.values()].filter((s) => isCoinglassSource(s.source));
        const ready = allHlStates.filter((s) => s.status === 'READY').length;
        const warming = allHlStates.filter((s) => s.status === 'WARMUP').length;
        const degraded = allHlStates.filter((s) => s.status === 'DEGRADED_DATA').length;

        this.logger.info(
            `Coinglass scan complete: ${readyPairs.length} pairs scanned, ${anomaliesDetected} anomalies [${cycleDuration}ms] | ` +
                `Status: ${ready} READY, ${warming} WARMUP, ${degraded} DEGRADED`
        );
    }

    private async evaluatePair(state: PairStatisticalState): Promise<OIAnomalyEvent | null> {
        const candles = await this.api.fetchOIHistory(state.exchange, state.instrumentId, this.defaultInterval, 1);

        if (candles.length === 0) {
            if (state.status === 'READY') state.status = 'DEGRADED_DATA';
            return null;
        }

        if (state.status === 'DEGRADED_DATA' && state.candleCount >= config.oi.warmupCandles) {
            state.status = 'READY';
        }

        const latestCandle = candles[candles.length - 1];
        updatePairState(state, latestCandle.close);

        const detection = detectAnomaly(state);
        if (!detection) return null;

        let priceContext: { priceChangePercent: number | null; isStealthPositioning: boolean } = {
            priceChangePercent: null,
            isStealthPositioning: false
        };

        try {
            const priceCandles = await this.api.fetchPriceHistory(
                state.exchange,
                state.instrumentId,
                this.defaultInterval,
                4
            );
            priceContext = computePriceContext(priceCandles);
        } catch (error) {
            this.logger.warn(`Price context fetch failed for ${state.exchange}:${state.instrumentId}`);
        }

        state.cusumScore = 0;
        this.lastDataTimestamp = Date.now();

        return {
            ...detection,
            priceContext,
            detectedAt: new Date()
        };
    }

    private async sendAlert(event: OIAnomalyEvent): Promise<void> {
        const redis = getRedisClient();
        const cooldownKey = `oi:cooldown:${event.exchange}:${event.instrumentId}`;

        const cooldownActive = await redis.get(cooldownKey);
        if (cooldownActive) {
            this.logger.debug(`Cooldown active for ${event.exchange}:${event.instrumentId}, suppressing alert`);
            return;
        }

        const result = this.formatAlertMessage(event);
        if (!result) return;
        const { msg, buttons } = result;

        let screenshot: Buffer | null = null;
        if (config.puppeteer.screenshotEnabled) {
            const query = `${event.baseAsset} ${event.exchange} open interest`;
            try {
                screenshot = await this.screenshoter.capture(
                    `https://coinalyze.net/`,
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
                        console.log('Clicked indicators dialog');
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

        for (let i = 0; i < this.channels.length; i++) {
            if (i > 0) await sleep(1000);
            const channel = this.channels[i];
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
                await DBService.insertAlert({
                    ...event,
                    sentAt: new Date(),
                    chatId: channel.chatId,
                    messageId,
                    cooldownUntil: new Date(Date.now() + config.oi.cooldownSeconds * 1000)
                } as any);
            } catch (error) {
                this.logger.error(`Failed to send alert for ${event.exchange}:${event.instrumentId}: ${error}`);
            }
        }
    }

    private formatAlertMessage(event: OIAnomalyEvent): { msg: string; buttons: InlineKeyboardMarkup } | null {
        const severityEmoji = event.severity === 'CRITICAL' ? '🚨' : '⚠️';
        const triggerLabel = {
            FAST_SPIKE: '⚡ Fast Spike',
            SLOW_ACCUMULATION: '📈 Slow Accumulation',
            SUSTAINED_BUILD: '🔥 Sustained Build'
        }[event.triggerType];

        const fmtOI = (n: number) =>
            n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${(n / 1_000).toFixed(1)}K`;

        const lines: string[] = [
            `${severityEmoji} <b>OI Anomaly: ${event.severity}</b>`,
            ``,
            `<b>${triggerLabel}</b>`,
            `🪙 <b>${event.baseAsset}</b> on <b>${event.exchange}</b>`,
            ``,
            `📊 OI: ${fmtOI(event.previousOI)} → ${fmtOI(event.currentOI)} (<b>${event.deltaOIPercent >= 0 ? '+' : ''}${event.deltaOIPercent.toFixed(1)}%</b>)`,
            `📏 Trigger: ${event.triggerValue.toFixed(2)} (threshold: ${this.getThresholdForType(event.triggerType)})`
        ];

        if (event.priceContext.priceChangePercent !== null) {
            const priceDir = event.priceContext.priceChangePercent >= 0 ? '📈' : '📉';
            lines.push(
                `${priceDir} Price: ${event.priceContext.priceChangePercent >= 0 ? '+' : ''}${event.priceContext.priceChangePercent.toFixed(2)}%`
            );
        }

        lines.push(``, `🕐 ${event.detectedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`);

        return {
            msg: lines.join('\n'),
            buttons: {
                inline_keyboard: [[{ text: '📊 View OI on Coinalyze', url: 'https://coinalyze.net/' }]]
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
