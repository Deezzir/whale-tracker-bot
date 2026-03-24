import { InlineKeyboardMarkup } from 'telegraf/types';
import { Tracker } from '../../common/tracker';
import { config } from '../../config';
import PolymarketAPIService, { Trade } from '../api/polymarket';
import PolymarketDBService, { PolyAggregationRecord, PolyTradeInput, PositionKey } from '../db/polymarket';
import { escapeHtml, formatCurrency, formatDate, sleep, withTimeout } from '../../common/utils';

type MarketCategory = 'sport' | 'esports' | 'regular';
type AccountTag = 'FRESH' | 'DORMANT' | 'SMALL' | 'MEDIUM' | 'LARGE';
type TradeTag = 'FRESH' | 'BASIC' | 'CONFIDENT' | 'MEGABET' | 'WEAK';

interface WsMessage {
    topic: string;
    type: string;
    payload?: Trade;
}

interface AlertMessageData {
    positionUSD: number;
    outcome: string;
    marketTitle: string;
    eventTicker: string;
    wallet: string;
    tags: string[];
    nickname: string | null;
    firstTradeDate: Date | null;
    avgPrice: number;
    category: MarketCategory;
    accountTag: AccountTag;
    tradeTag: TradeTag;
    tradeMedianUSD: number;
}

function classifyAccountTag(
    firstTradeDate: Date | null,
    lastTradeTimestamp: number | null,
    totalBuyTrades: number
): AccountTag {
    const now = Date.now();
    if (firstTradeDate && now - new Date(firstTradeDate).getTime() < 7 * 24 * 60 * 60 * 1000) return 'FRESH';
    if (lastTradeTimestamp && now - lastTradeTimestamp > 10 * 24 * 60 * 60 * 1000) return 'DORMANT';
    if (totalBuyTrades < 10) return 'SMALL';
    if (totalBuyTrades <= 30) return 'MEDIUM';
    return 'LARGE';
}

function getMedianAmount(amounts: number[]): number | null {
    if (amounts.length === 0) return null;
    const sorted = [...amounts].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function classifyTradeTag(currentUsd: number, previousBuyAmounts: number[]): TradeTag {
    if (previousBuyAmounts.length === 0) return 'FRESH';
    const median = getMedianAmount(previousBuyAmounts);
    if (median === null || median === 0) return 'FRESH';
    const ratio = currentUsd / median;
    if (ratio > 3) return 'MEGABET';
    if (ratio >= 2) return 'CONFIDENT';
    if (ratio >= 0.7) return 'BASIC';
    return 'WEAK';
}

const ESPORTS_KEYWORDS = ['counter-strike', 'dota 2', 'lol', 'valorant'];
const SPORT_KEYWORDS = ['BNP Paribas Open', 'win on 2026-03'];

function isSportMarket(title: string): boolean {
    if (SPORT_KEYWORDS.some((kw) => title.includes(kw))) return true;
    const hasVs = title.includes(' vs. ') || title.includes(' vs ');
    const hasSpread = title.includes('Spread:');
    const hasFcWin = title.includes(' FC win on ');
    if (!hasVs && !hasSpread && !hasFcWin) return false;
    const lower = title.toLowerCase();
    return !ESPORTS_KEYWORDS.some((kw) => lower.includes(kw));
}

function isEsportsMarket(title: string): boolean {
    const lower = title.toLowerCase();
    return ESPORTS_KEYWORDS.some((kw) => lower.includes(kw));
}

export default class PolymarketService extends Tracker {
    private api = new PolymarketAPIService();
    private static readonly CONNECT_TIMEOUT_MS = 15_000;
    private tradeBatch: PolyTradeInput[] = [];
    private batchInterval: NodeJS.Timeout | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private connectTimeout: NodeJS.Timeout | null = null;
    private affectedKeys = new Map<string, PositionKey>();
    private ws: WebSocket | null = null;

    async start(): Promise<void> {
        if (this.monitoring) return;
        this.monitoring = true;
        this.logger.info('Monitoring started');

        await this.backfill();
        await this.subscribeToLiveTrades();

        this.batchInterval = setInterval(() => {
            this.flushTradeBatch().catch((error) => this.logger.error(`Error flushing trade batch: ${error}`));
        }, config.polymarket.batchFlushIntervalMs);

        this.monitorTask = this.mainLoop();
    }

    async stop(): Promise<void> {
        if (!this.monitoring) return;
        this.monitoring = false;
        await this.monitorTask?.catch((error) => this.logger.error(`Error while awaiting monitor task: ${error}`));
        this.monitorTask = undefined;
        this.logger.info('Monitoring stopped');

        clearInterval(this.batchInterval!);
        this.affectedKeys.clear();
        if (this.connectTimeout) clearTimeout(this.connectTimeout);
        if (this.ws) this.ws.close();
        if (this.batchInterval) clearInterval(this.batchInterval);
    }

    private async mainLoop(): Promise<void> {
        const scanLoop = async () => {
            while (this.monitoring) {
                try {
                    await this.scanAndAlert();
                } catch (error) {
                    this.logger.error(`Failed to alert: ${error}`);
                }
                if (!this.monitoring) break;
                await this.cancellableSleep(config.monitor.intervalMs);
            }
        };

        const cleanupLoop = async () => {
            while (this.monitoring) {
                try {
                    await PolymarketDBService.cleanTrades(config.polymarket.cleanupTTLms);
                    await PolymarketDBService.cleanAlerts(config.polymarket.cleanupTTLms);
                } catch (error) {
                    this.logger.error(`Failed to cleanup: ${error}`);
                }
                if (!this.monitoring) break;
                await this.cancellableSleep(config.monitor.cleanupIntervalMs);
            }
        };

        const watchDog = this.watchDog(config.monitor.noDataTimeoutMs, async () => {
            this.logger.warn('Forcing WebSocket reconnection due to no data received.');
            this.reconnectWebSocket();
        });

        const scanWatchDog = this.scanWatchDog(config.monitor.scanStallTimeoutMs);

        await Promise.all([scanLoop(), cleanupLoop(), watchDog, scanWatchDog]);
    }

    private async backfill() {
        try {
            const backfill = await this.api.getRecentTrades();
            if (backfill.length > 0) backfill.forEach((trade) => this.handleTrade(trade));
        } catch (err) {
            this.logger.error('Backfill failed (continuing with live stream)', err);
        }
    }

    private async scanAndAlert(): Promise<void> {
        const CANDIDATE_TIMEOUT_MS = 20_000;

        if (this.affectedKeys.size === 0) {
            this.logger.info('No affected positions to scan');
            this.lastScanTimestamp = Date.now();
            return;
        }

        const keysToScan = Array.from(this.affectedKeys.values());
        this.affectedKeys.clear();

        const candidates = await PolymarketDBService.getTradesToAlert(
            keysToScan,
            config.polymarket.alertThresholdUsd,
            config.polymarket.sportAlertThresholdUsd,
            config.polymarket.aggregationWindowMs
        );

        this.logger.info(`Found ${candidates.length} candidates needing alert`);
        for (const candidate of candidates) {
            try {
                await withTimeout(
                    this.processAlertCandidate(candidate),
                    CANDIDATE_TIMEOUT_MS,
                    `processAlertCandidate(${candidate.wallet}/${candidate.conditionId})`
                );
            } catch (error) {
                this.logger.error(`Failed to alert wallet ${candidate.wallet} / ${candidate.conditionId}: ${error}`);
            }
        }
        this.lastScanTimestamp = Date.now();
    }

    private async processAlertCandidate(candidate: PolyAggregationRecord): Promise<void> {
        const [marketInfo, walletInfo, walletStats] = await Promise.all([
            this.api.getMarketBySlug(candidate.slug),
            this.api.getFirstTrade(candidate.wallet),
            this.api.getWalletStats(candidate.wallet)
        ]);

        const title = candidate.title;
        const tags = marketInfo ? (marketInfo.tags || []).map((t) => t.label) : [];
        const eventTicker =
            marketInfo && marketInfo.events && marketInfo.events.length > 0
                ? marketInfo.events[0].ticker
                : marketInfo
                  ? marketInfo.slug
                  : 'unknown';
        const category: MarketCategory = isEsportsMarket(title)
            ? 'esports'
            : isSportMarket(title)
              ? 'sport'
              : 'regular';
        const threshold =
            category === 'sport' ? config.polymarket.sportAlertThresholdUsd : config.polymarket.alertThresholdUsd;
        if (candidate.netUsd < threshold) {
            this.logger.debug(
                `Skipping ${candidate.wallet} (${candidate.conditionId}): netUsd ${candidate.netUsd} < threshold ${threshold}`
            );
            return;
        }

        const accountTag = classifyAccountTag(
            walletInfo.date,
            walletStats.lastTradeTimestamp,
            walletStats.totalBuyTrades
        );
        const tradeTag = classifyTradeTag(candidate.netUsd, walletStats.buyTradeAmounts);
        const tradeMedianUSD = getMedianAmount(walletStats.buyTradeAmounts);

        const lastAlerts = await PolymarketDBService.getLastAlerts(
            candidate.wallet,
            candidate.conditionId,
            candidate.outcomeIndex,
            this.channels.map((c) => c.chatId)
        );
        if (lastAlerts.size > 0) {
            const latestAlert = [...lastAlerts.values()].reduce((a, b) =>
                new Date(a.sentAt) > new Date(b.sentAt) ? a : b
            );
            const growth = candidate.netUsd - latestAlert.positionUsd;
            const dynamicThreshold = Math.max(
                (latestAlert.positionUsd * config.polymarket.minimalGrowthPercent) / 100,
                config.polymarket.minimalGrowthUSD
            );
            if (growth < dynamicThreshold) {
                this.logger.debug(
                    `Skipping ${candidate.wallet} (${candidate.conditionId}): growth ${growth} < dynamicThreshold ${dynamicThreshold}`
                );
                return;
            }

            this.logger.info(
                `Position growth detected for ${candidate.wallet} (${candidate.conditionId}): growth ${growth} >= dynamicThreshold ${dynamicThreshold}, sending update alert`
            );
            const replyText = this.formatGrowingPositionMessage(candidate.netUsd, latestAlert.positionUsd);
            for (let i = 0; i < this.channels.length; i++) {
                if (i > 0) await sleep(1000);
                const channel = this.channels[i];
                const prevAlert = lastAlerts.get(channel.chatId);
                let messageId: number | undefined;
                if (prevAlert?.messageId) {
                    await this.tg.sendReply(channel.chatId, replyText, prevAlert.messageId);
                    messageId = prevAlert.messageId;
                } else {
                    messageId = await this.tg.sendMessage(channel.chatId, replyText, {
                        message_thread_id: channel.topicId
                    });
                }
                await PolymarketDBService.insertAlert({
                    proxyWallet: candidate.wallet,
                    conditionId: candidate.conditionId,
                    outcomeIndex: candidate.outcomeIndex,
                    positionUsd: candidate.netUsd,
                    sentAt: new Date(),
                    chatId: channel.chatId,
                    messageId
                });
            }
            return;
        }

        this.logger.info(
            `New high-value position detected for ${candidate.wallet} (${candidate.conditionId}): ${formatCurrency(candidate.netUsd)}, sending alert`
        );
        const result = this.formatAlertMessage({
            positionUSD: candidate.netUsd,
            outcome: candidate.outcome,
            marketTitle: title || 'Unknown Market',
            eventTicker: eventTicker,
            tags,
            wallet: candidate.wallet,
            nickname: walletInfo.nickname,
            firstTradeDate: walletInfo.date,
            avgPrice: candidate.avgPrice,
            category,
            accountTag,
            tradeTag,
            tradeMedianUSD: tradeMedianUSD || 0
        });
        if (!result) return;
        const { msg, buttons } = result;

        await this.sendAlert(candidate, msg, buttons);
    }

    private reconnectWebSocket() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.connectTimeout) clearTimeout(this.connectTimeout);
        const ws = this.ws;
        this.ws = null;
        if (ws) ws.close();
        if (this.monitoring) this.subscribeToLiveTrades();
    }

    private async subscribeToLiveTrades() {
        const ws = new WebSocket(config.polymarket.wss);

        this.connectTimeout = setTimeout(() => {
            this.connectTimeout = null;
            this.logger.warn(
                `WebSocket did not open within ${PolymarketService.CONNECT_TIMEOUT_MS / 1000}s — forcing reconnect`
            );
            this.reconnectWebSocket();
        }, PolymarketService.CONNECT_TIMEOUT_MS);

        ws.onopen = () => {
            if (this.connectTimeout) {
                clearTimeout(this.connectTimeout);
                this.connectTimeout = null;
            }
            this.logger.info('WebSocket connected, subscribing to orders_matched...');
            ws.send(
                JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'activity', type: 'orders_matched' }] })
            );
            this.pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send('PING');
            }, 5_000);
        };

        ws.onmessage = (event) => {
            const rawData = typeof event.data === 'string' ? event.data : event.data.toString();
            let message: WsMessage;
            try {
                message = JSON.parse(rawData) as WsMessage;
            } catch {
                return;
            }
            if (message.topic === 'activity' && message.type === 'orders_matched' && message.payload) {
                this.handleTrade(message.payload);
            }
        };

        let closed = false;
        const handleClose = () => {
            if (closed) return;
            closed = true;
            this.reconnectWebSocket();
        };

        ws.onerror = (error) => {
            this.logger.error(`WebSocket error: ${error}`);
            if (ws.readyState !== WebSocket.OPEN) handleClose();
        };

        ws.onclose = (event) => {
            const reason = event.reason || 'unknown';
            this.logger.info(`WebSocket closed, reason: ${reason}`);
            if (this.ws === ws) handleClose();
        };

        this.ws = ws;
    }

    private async handleTrade(raw: Trade): Promise<void> {
        const trade = this.transformTrade(raw);
        if (!trade) return;

        this.tradeBatch.push(trade);
        if (this.tradeBatch.length >= config.polymarket.batchSize) await this.flushTradeBatch();
    }

    async flushTradeBatch(): Promise<void> {
        await this.flushMutex.runExclusive(async () => {
            if (this.tradeBatch.length === 0) return;
            const batchToFlush = [...this.tradeBatch];
            this.tradeBatch = [];
            this.lastDataTimestamp = Date.now();

            try {
                this.logger.info(`Flushing trade batch of size ${batchToFlush.length}`);
                await PolymarketDBService.addTradesBulk(batchToFlush, config.polymarket.aggregationWindowMs);
                for (const trade of batchToFlush) {
                    const keyStr = `${trade.proxyWallet}:${trade.conditionId}:${trade.outcomeIndex}`;
                    if (!this.affectedKeys.has(keyStr)) {
                        this.affectedKeys.set(keyStr, {
                            proxyWallet: trade.proxyWallet,
                            conditionId: trade.conditionId,
                            outcomeIndex: trade.outcomeIndex
                        });
                    }
                }
            } catch (error) {
                this.logger.error(`Error flushing trade batch: ${error}`);
            }
        });
    }

    private formatAlertMessage(data: AlertMessageData): {
        msg: string;
        buttons: InlineKeyboardMarkup;
    } | null {
        const categoryIcon = (category: MarketCategory): string => {
            if (category === 'sport') return '⚽';
            if (category === 'esports') return '🎮';
            return '🎰';
        };

        const tagLabel = (tag: AccountTag | TradeTag): string => `#${tag}`;

        const icon = categoryIcon(data.category);
        const lines = [
            `<b>${icon} ${escapeHtml(data.marketTitle)}</b>`,
            ``,
            `<b>🏆 ${formatCurrency(data.positionUSD)}</b> on <b>${data.outcome}</b>`,
            `<b>Trader:</b> ${data.nickname ? `#${escapeHtml(data.nickname)}` : `<code>${data.wallet}</code>`}`,
            `<b>Avg Price:</b> ${Math.round(data.avgPrice * 100)}¢`,
            `<b>First Trade:</b> ${formatDate(data.firstTradeDate)}`,
            `<b>Account:</b> ${tagLabel(data.accountTag)}`,
            ``,
            `<b>Trade:</b> ${tagLabel(data.tradeTag)}`,
            `<b>Trade Median:</b> ${formatCurrency(data.tradeMedianUSD)}`,
            ``,
            `${
                data.tags.length > 0
                    ? data.tags
                          .slice(0, 2)
                          .map((t) => `${escapeHtml(t)}`)
                          .join(', ')
                    : ''
            }`,
            ``
        ];

        return {
            msg: lines.join('\n'),
            buttons: {
                inline_keyboard: [
                    [
                        {
                            text: '👤 Profile',
                            url: `https://polymarket.com/profile/${data.wallet}`
                        },
                        {
                            text: '📊 Market',
                            url: `https://polymarket.com/event/${data.eventTicker}`
                        }
                    ]
                ]
            }
        };
    }

    private formatGrowingPositionMessage(currentUSD: number, previousUSD: number): string {
        const lines = [
            `🔥 <b>Growing position</b>`,
            ``,
            `<b>${formatCurrency(currentUSD)}</b>  ⬅  ${formatCurrency(previousUSD)}`
        ];
        return lines.join('\n');
    }

    private transformTrade(raw: Trade): PolyTradeInput | null {
        const MIN_TRADE_USD = 50;
        const price = raw.price;
        const size = raw.size;
        const usdAmount = size * price;

        if (price >= config.polymarket.maxPriceFilter) return null;
        if (usdAmount < MIN_TRADE_USD) return null;

        return {
            proxyWallet: raw.proxyWallet,
            conditionId: raw.conditionId,
            side: raw.side,
            price,
            usdAmount,
            outcome: raw.outcome,
            outcomeIndex: raw.outcomeIndex,
            timestamp: new Date(raw.timestamp * 1000),
            title: raw.title,
            slug: raw.slug
        };
    }

    private async sendAlert(
        candidate: PolyAggregationRecord,
        msg: string,
        buttons: InlineKeyboardMarkup
    ): Promise<void> {
        try {
            let screenshot: Buffer | null = null;
            if (config.puppeteer.screenshotEnabled) {
                screenshot = await this.screenshoter.capture(`${config.polymarket.url}/profile/${candidate.wallet}`);
            }

            for (let i = 0; i < this.channels.length; i++) {
                if (i > 0) await sleep(1000);
                const channel = this.channels[i];
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
                await PolymarketDBService.insertAlert({
                    proxyWallet: candidate.wallet,
                    conditionId: candidate.conditionId,
                    outcomeIndex: candidate.outcomeIndex,
                    positionUsd: candidate.netUsd,
                    sentAt: new Date(),
                    chatId: channel.chatId,
                    messageId
                });
            }
        } catch (error) {
            this.logger.error(`Failed to send alert for ${candidate.wallet} (${candidate.conditionId}): ${error}`);
        }
    }
}
