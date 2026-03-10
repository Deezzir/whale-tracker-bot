import { InlineKeyboardMarkup } from 'telegraf/types';
import { Tracker } from '../../common/tracker';
import { config } from '../../config';
import PolymarketAPIService, { RawTrade } from '../api/polymarket';
import PolymarketDBService, { PolyAggregationRecord, PolyTrade } from '../db/polymarket';
import { escapeHtml, formatCurrency, formatDate } from '../../common/utils';
import ScreenshotService from '../screenshoter';

type MarketCategory = 'sport' | 'esports' | 'regular';
type AccountTag = 'FRESH' | 'DORMANT' | 'SMALL' | 'MEDIUM' | 'LARGE';
type TradeTag = 'FRESH' | 'BASIC' | 'CONFIDENT' | 'MEGABET' | 'WEAK';

interface WsMessage {
    topic: string;
    type: string;
    payload?: RawTrade;
}

interface AlertMessageData {
    positionUsd: number;
    outcome: string;
    marketTitle: string;
    marketSlug?: string;
    wallet: string;
    nickname: string | null;
    firstTradeDate: Date | null;
    avgPrice: number;
    isNew: boolean;
    category: MarketCategory;
    accountTag: AccountTag;
    tradeTag: TradeTag;
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

const ESPORTS_KEYWORDS = ['counter-strike', 'dota2', 'lol', 'valorant'];
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
    private screenshoter = new ScreenshotService();

    private tradeBatch: PolyTrade[] = [];
    private batchInterval: NodeJS.Timeout | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
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
                } catch (error) {
                    this.logger.error(`Failed to cleanup: ${error}`);
                }
                if (!this.monitoring) break;
                await this.cancellableSleep(config.monitor.cleanupIntervalMs);
            }
        };

        const alertNoDataLoop = this.alertNoData(config.monitor.noDataTimeoutMs, async () => {
            this.logger.warn('Forcing WebSocket reconnection due to no data received.');
            this.reconnectWebSocket();
        });

        await Promise.all([scanLoop(), cleanupLoop(), alertNoDataLoop]);
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
        const candidates = await PolymarketDBService.getTradesToAlert(
            config.polymarket.alertThresholdUsd,
            config.polymarket.sportAlertThresholdUsd,
            config.polymarket.cleanupTTLms
        );

        this.logger.info(`Found ${candidates.length} candidates needing alert`);
        for (const candidate of candidates) {
            try {
                await this.processAlertCandidate(candidate);
            } catch (error) {
                this.logger.error(`Failed to alert wallet ${candidate.wallet} / ${candidate.conditionId}: ${error}`);
            }
        }
    }

    private async processAlertCandidate(candidate: PolyAggregationRecord): Promise<void> {
        const [walletInfo, walletStats] = await Promise.all([
            this.api.getFirstTradeInfo(candidate.wallet),
            this.api.getWalletStats(candidate.wallet)
        ]);

        const title = candidate.title;
        const category: MarketCategory = isEsportsMarket(title)
            ? 'esports'
            : isSportMarket(title)
              ? 'sport'
              : 'regular';
        const threshold =
            category === 'sport' ? config.polymarket.sportAlertThresholdUsd : config.polymarket.alertThresholdUsd;

        if (candidate.netUsd < threshold) return;

        const accountTag = classifyAccountTag(
            walletInfo.date,
            walletStats.lastTradeTimestamp,
            walletStats.totalBuyTrades
        );
        const tradeTag = classifyTradeTag(candidate.netUsd, walletStats.buyTradeAmounts);

        const lastAlert = await PolymarketDBService.getLastAlert(
            candidate.wallet,
            candidate.conditionId,
            candidate.outcomeIndex
        );

        if (lastAlert) {
            const growth = candidate.netUsd - lastAlert.positionUsd;
            const dynamicThreshold = Math.max(
                (lastAlert.positionUsd * config.polymarket.minimalGrowthPercent) / 100,
                config.polymarket.minimalGrowthUSD
            );
            if (growth < dynamicThreshold) return;
        }

        if (lastAlert) {
            const replyText = this.formatGrowingPositionMessage(candidate.netUsd, lastAlert.positionUsd);
            let messageId: number | undefined = lastAlert.messageId;
            if (lastAlert.messageId) {
                await this.tg.sendReply(config.telegram.chatID, replyText, lastAlert.messageId);
            } else {
                messageId = await this.tg.sendMessage(config.telegram.chatID, replyText, {
                    message_thread_id: config.telegram.polyTopicID
                });
            }
            await PolymarketDBService.insertAlert({
                proxyWallet: candidate.wallet,
                conditionId: candidate.conditionId,
                outcomeIndex: candidate.outcomeIndex,
                positionUsd: candidate.netUsd,
                sentAt: new Date(),
                messageId
            });
        } else {
            const result = this.formatAlertMessage({
                positionUsd: candidate.netUsd,
                outcome: candidate.outcome,
                marketTitle: title || 'Unknown Market',
                marketSlug: candidate.slug,
                wallet: candidate.wallet,
                nickname: walletInfo.nickname,
                firstTradeDate: walletInfo.date,
                avgPrice: candidate.avgPrice,
                isNew: true,
                category,
                accountTag,
                tradeTag
            });
            if (!result) return;
            const { msg, buttons } = result;

            let messageId: number | undefined;
            let sentWithPhoto = false;
            if (config.polymarket.screenshotEnabled) {
                const screenshot = await this.screenshoter.capture(
                    `https://polymarket.com/profile/${candidate.wallet}`
                );
                if (screenshot) {
                    messageId = await this.tg.sendPhoto(config.telegram.chatID, screenshot, msg, {
                        reply_markup: buttons,
                        message_thread_id: config.telegram.polyTopicID
                    });
                    sentWithPhoto = true;
                }
            }
            if (!sentWithPhoto) {
                messageId = await this.tg.sendMessage(config.telegram.chatID, msg, {
                    reply_markup: buttons,
                    message_thread_id: config.telegram.polyTopicID
                });
            }
            await PolymarketDBService.insertAlert({
                proxyWallet: candidate.wallet,
                conditionId: candidate.conditionId,
                outcomeIndex: candidate.outcomeIndex,
                positionUsd: candidate.netUsd,
                sentAt: new Date(),
                messageId
            });
        }
    }

    private reconnectWebSocket() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.ws) this.ws.close();
        if (this.monitoring) this.subscribeToLiveTrades();
    }

    private async subscribeToLiveTrades() {
        const ws = new WebSocket(config.polymarket.wss);
        ws.onopen = () => {
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
                this.logger.debug(`Non-JSON WS message: ${rawData}`);
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
            handleClose();
        };

        this.ws = ws;
    }

    private async handleTrade(raw: RawTrade): Promise<void> {
        const trade = this.transformTrade(raw);
        if (!trade) return;

        this.tradeBatch.push(trade);
        if (this.tradeBatch.length >= config.hyperliquid.batchSize) await this.flushTradeBatch();
    }

    async flushTradeBatch(): Promise<void> {
        await this.flushMutex.runExclusive(async () => {
            if (this.tradeBatch.length === 0) return;
            const batchToFlush = [...this.tradeBatch];
            this.tradeBatch = [];
            this.lastDataTimestamp = Date.now();

            try {
                this.logger.info(`Flushing trade batch of size ${batchToFlush.length}`);
                await PolymarketDBService.addTradesBulk(batchToFlush);
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

        const accountTagLabel = (tag: AccountTag): string => {
            if (tag === 'FRESH') return '🌱 #FRESH';
            if (tag === 'DORMANT') return '💤 #DORMANT';
            if (tag === 'SMALL') return '🐣 #SMALL';
            if (tag === 'MEDIUM') return '🐟 #MEDIUM';
            return '🐋 #LARGE';
        };

        const tradeTagLabel = (tag: TradeTag): string => {
            if (tag === 'FRESH') return '🆕 #FRESH';
            if (tag === 'MEGABET') return '💥 #MEGABET';
            if (tag === 'CONFIDENT') return '💪 #CONFIDENT';
            if (tag === 'WEAK') return '😐 #WEAK';
            return '📊 #BASIC';
        };

        const icon = categoryIcon(data.category);
        const lines = [
            `<b>${icon} ${escapeHtml(data.marketTitle)}</b>`,
            ``,
            `<b>🏆 ${formatCurrency(data.positionUsd)}</b> on <b>${data.outcome}</b>`,
            `<b>Trader:</b> ${data.nickname ? `#${escapeHtml(data.nickname)}` : `<code>${data.wallet}</code>`}`,
            `<b>Avg Price:</b> ${Math.round(data.avgPrice * 100)}¢`,
            `<b>First Trade:</b> ${formatDate(data.firstTradeDate)}`,
            `<b>Account:</b> ${accountTagLabel(data.accountTag)}`,
            `<b>Trade:</b> ${tradeTagLabel(data.tradeTag)}`,
            ``,
            data.isNew ? `🆕 New position detected` : `📈 Position increased significantly`
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
                            url: `https://polymarket.com/event/${data.marketSlug}`
                        }
                    ]
                ]
            }
        };
    }

    private formatGrowingPositionMessage(currentUsd: number, previousUsd: number): string {
        return `🔥 <b>Growing position!</b>\n<b>${formatCurrency(currentUsd)}</b>  ⬅  ${formatCurrency(previousUsd)}`;
    }

    private transformTrade(raw: RawTrade): PolyTrade | null {
        const price = raw.price;
        const size = raw.size;
        const usdAmount = size * price;

        if (price >= config.polymarket.maxPriceFilter) return null;
        if (usdAmount < config.polymarket.minTradeUSD) return null;

        return {
            transactionHash: raw.transactionHash,
            asset: raw.asset,
            proxyWallet: raw.proxyWallet,
            conditionId: raw.conditionId,
            side: raw.side,
            size,
            price,
            usdAmount,
            outcome: raw.outcome,
            outcomeIndex: raw.outcomeIndex,
            timestamp: new Date(raw.timestamp * 1000),
            title: raw.title,
            slug: raw.slug
        };
    }
}
