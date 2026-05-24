import { Tracker } from '../../common/tracker';
import { config } from '../../config';
import APIService, { Interval, OICandle, PriceCandle } from '../api/coinglass';
import DBService, { TriggerType, Severity } from '../db/coinglass';
import { getRedisClient } from '../redis';
import Tg from '../telegram';
import { sleep } from '../../common/utils';
import { InlineKeyboardMarkup } from 'telegraf/types';

export type PairStatus = 'WARMUP' | 'READY' | 'DEGRADED_DATA';

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
    candleCount: number;
    status: PairStatus;
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
    const alpha = config.coinglass.ewmaAlpha;
    state.ewmaMean = alpha * deltaOI + (1 - alpha) * state.ewmaMean;
    const diff = deltaOI - state.ewmaMean;
    state.ewmaVariance = alpha * diff * diff + (1 - alpha) * state.ewmaVariance;

    // Update recentDeltaOI ring buffer (keep last 192)
    state.recentDeltaOI.push(deltaOI);
    if (state.recentDeltaOI.length > config.coinglass.ewmaLookback) {
        state.recentDeltaOI.shift();
    }

    // Compute robust z-score using MAD
    const { median, mad } = computeMAD(state.recentDeltaOI);
    const zScore = computeRobustZScore(deltaOI, median, mad);

    // Update recentZScores ring buffer (keep last cumulativeZWindow)
    state.recentZScores.push(zScore);
    if (state.recentZScores.length > config.coinglass.cumulativeZWindow) {
        state.recentZScores.shift();
    }

    // Update CUSUM: S_t = max(0, S_{t-1} + (z_t - k))
    state.cusumScore = Math.max(0, state.cusumScore + (zScore - config.coinglass.cusumDrift));

    // Transition from WARMUP to READY
    if (state.status === 'WARMUP' && state.candleCount >= config.coinglass.warmupCandles) {
        state.status = 'READY';
    }
}

export function detectAnomaly(state: PairStatisticalState): Omit<OIAnomalyEvent, 'priceContext' | 'detectedAt'> | null {
    if (state.status !== 'READY') return null;
    if (state.recentZScores.length === 0) return null;
    if ((state.lastOI || 0) < config.coinglass.minOIThreshold) return null;

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
    if (deltaOI < config.coinglass.minDeltaOIUsd) return null;
    if (deltaOIPercent < config.coinglass.minDeltaOIPercent) return null;

    // Check CUSUM first (CRITICAL severity)
    if (state.cusumScore > config.coinglass.cusumThreshold) {
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
    if (state.recentZScores.length >= config.coinglass.cumulativeZWindow) {
        const cumulativeZ = state.recentZScores.reduce((sum, z) => sum + z, 0);
        if (cumulativeZ > config.coinglass.cumulativeZThreshold) {
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
    if (latestZ > config.coinglass.zScoreThreshold) {
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
    const isStealthPositioning = Math.abs(priceChangePercent) <= config.coinglass.stealthPriceThreshold;
    return { priceChangePercent, isStealthPositioning };
}

export default class CoinglassService extends Tracker {
    private api = new APIService();
    private pairStates = new Map<string, PairStatisticalState>();
    private warmupDone = false;
    private defaultInterval: Interval = '30m';

    constructor(tg: Tg, channels: { chatId: number }[]) {
        super(tg, channels);
        if (config.coinglass.exchanges.length === 0) throw new Error(`No exchanges provided for the CoinGlass tracker`);
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.logger.info('Monitoring started');
        this.logger.info(`Exchanges: [${config.coinglass.exchanges.join(', ')}]`);

        await this.refreshTokenUniverse();
        await this.coldStartWarmup();
        this.monitorTask = this.mainLoop();
    }

    async stop(): Promise<void> {
        if (this.running) {
            this.running = false;
            await this.monitorTask?.catch((error) => this.logger.error(`Error while awaiting monitor task: ${error}`));
            this.monitorTask = undefined;
            this.logger.info('Monitoring stopped');
            this.logger.info(
                `CoinglassService stopped. Final state: ${this.pairStates.size} pairs tracked, ` +
                    `${[...this.pairStates.values()].filter((s) => s.status === 'READY').length} READY`
            );
        }
    }

    private async mainLoop(): Promise<void> {
        const refreshUniverseLoop = async () => {
            while (this.running) {
                try {
                    await this.refreshTokenUniverse();
                } catch (error) {
                    this.logger.error(`Failed to refresh the token universe: ${error}`);
                }
                if (!this.running) break;
                await this.cancellableSleep(config.coinglass.refreshIntervalMs);
            }
        };

        const scanLoop = async () => {
            while (this.running) {
                try {
                    await this.scanAllPairs();
                } catch (error) {
                    this.logger.error(`Failed to run a scan loop: ${error}`);
                }
                if (!this.running) break;
                await this.cancellableSleep(config.coinglass.intervalMs);
            }
        };

        const alertNoDataLoop = this.watchDog(config.coinglass.noDataTimeoutMs);
        const scanWatchDog = this.scanWatchDog(config.coinglass.scanStallTimeoutMs);

        await Promise.all([scanLoop(), refreshUniverseLoop(), alertNoDataLoop, scanWatchDog]);
    }

    private async refreshTokenUniverse(): Promise<void> {
        this.logger.info('Refreshing token universe...');
        const blacklist = config.coinglass.blacklist;
        if (blacklist.length > 0) {
            this.logger.info(`Blacklist active: ${blacklist.join(', ')} (${blacklist.length} tokens excluded)`);
        }
        let totalPairs = 0;

        for (const exchange of config.coinglass.exchanges) {
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
                            candleCount: 0,
                            status: 'WARMUP'
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

        if (totalPairs === 0) throw new Error(`No pairs detected for Coinglass tracker`);
        this.logger.info(
            `Universe refresh complete: ${totalPairs} total pairs across ${config.coinglass.exchanges.length} exchanges`
        );
        this.lastDataTimestamp = Date.now();
    }

    private async coldStartWarmup(): Promise<void> {
        if (this.warmupDone) return;
        const concurrency = config.coinglass.warmupConcurrency;
        this.logger.info(
            `Starting cold-start warmup for ${this.pairStates.size} pairs (concurrency: ${concurrency})...`
        );

        let warmedUp = 0;
        let failed = 0;
        let rateLimited = 0;
        const entries = [...this.pairStates.entries()];
        const startTime = Date.now();

        for (let i = 0; i < entries.length; i += concurrency) {
            if (!this.running) break;

            const batch = entries.slice(i, i + concurrency);
            const results = await Promise.allSettled(
                batch.map(async ([, state]) => {
                    const candles = await this.api.fetchOIHistory(
                        state.exchange,
                        state.instrumentId,
                        this.defaultInterval,
                        config.coinglass.warmupCandles
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
                    warmedUp++;
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
                    `Warmup progress: ${processed}/${entries.length} (${warmedUp} ok, ${failed} failed, ${rateLimited} rate-limited) [${elapsed}s elapsed, API: ${usage}/${max}]`
                );
            }

            // Delay between batches to respect rate limits
            await sleep(1200);
        }

        this.warmupDone = true;
        const readyCount = [...this.pairStates.values()].filter((s) => s.status === 'READY').length;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        this.logger.info(
            `Warmup complete in ${elapsed}s: ${warmedUp} warmed, ${readyCount} READY, ${failed} failed (${rateLimited} rate-limited)`
        );
        this.lastDataTimestamp = Date.now();
    }

    private replayHistory(state: PairStatisticalState, candles: OICandle[]): void {
        for (const candle of candles) {
            updatePairState(state, candle.close);
        }
        // Reset CUSUM after warmup — historical data is for calibrating EWMA, not triggering
        state.cusumScore = 0;
        state.recentZScores = [];
    }

    private async scanAllPairs(): Promise<void> {
        if (!this.running) return;
        this.lastScanTimestamp = Date.now();

        const readyPairs = [...this.pairStates.entries()].filter(
            ([, s]) => s.status === 'READY' || s.status === 'WARMUP'
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

            await sleep(100);
        }

        if (anomaliesDetected > 0) {
            this.logger.info(`Scan complete: ${anomaliesDetected} anomalies detected`);
        }
    }

    private async evaluatePair(state: PairStatisticalState): Promise<OIAnomalyEvent | null> {
        const candles = await this.api.fetchOIHistory(state.exchange, state.instrumentId, this.defaultInterval, 1);

        if (candles.length === 0) {
            if (state.status === 'READY') state.status = 'DEGRADED_DATA';
            return null;
        }

        if (state.status === 'DEGRADED_DATA' && state.candleCount >= config.coinglass.warmupCandles) {
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
                await redis.set(cooldownKey, event.severity, { EX: config.coinglass.cooldownSeconds });
                await DBService.insertAlert({
                    ...event,
                    sentAt: new Date(),
                    chatId: channel.chatId,
                    messageId,
                    cooldownUntil: new Date(Date.now() + config.coinglass.cooldownSeconds * 1000)
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

        if (event.priceContext.isStealthPositioning) {
            lines.push(``, `🕵️ <b>STEALTH POSITIONING</b> — OI anomaly with flat price (≤2% move)`);
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
                return `z>${config.coinglass.zScoreThreshold}`;
            case 'SLOW_ACCUMULATION':
                return `Σz>${config.coinglass.cumulativeZThreshold}`;
            case 'SUSTAINED_BUILD':
                return `CUSUM>${config.coinglass.cusumThreshold}`;
        }
    }
}
