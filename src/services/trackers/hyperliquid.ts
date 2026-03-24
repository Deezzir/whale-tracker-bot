import { config } from '../../config';
import { Markup } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/types';
import { ChatChannel, Tracker } from '../../common/tracker';
import { escapeHtml, formatCurrency, sleep } from '../../common/utils';
import Tg from '../telegram';
import HyperliquidDBService, {
    HyperAggregationRecord,
    HyperTrackedRecord,
    HyperTradeDirection,
    HyperTradeRecord,
    PositionKey
} from '../db/hyperliquid';
import HyperliquidAPI, { AssetPosition, PortfolioResponse as TraderPortfolio, TraderState } from '../api/hyperliquid';

type AccountTag = {
    tag: 'FRESH' | 'DORMANT' | 'SMALL' | 'MEDIUM' | 'LARGE';
    totalValue: number;
    perpsValue: number;
    spotValue: number;
    perpsCount: number;
    spotCount: number;
};

function getPortfolioTimestamps(portfolio: TraderPortfolio): { first: number | null; last: number | null } {
    const buckets = portfolio.filter(([label]) => label === 'perpAllTime' || label === 'allTime');
    for (const [, stats] of buckets) {
        const history = stats?.accountValueHistory ?? [];
        if (history.length > 2) {
            return { first: history[0][0], last: history[history.length - 1][0] };
        }
    }
    return { first: null, last: null };
}

function classifyAccountTag(account: TraderState, portfolio: TraderPortfolio): AccountTag {
    if (!account.perp || !account.spot)
        return { tag: 'FRESH', totalValue: 0, perpsValue: 0, spotValue: 0, perpsCount: 0, spotCount: 0 };
    const now = Date.now();
    const { first: firstTimestamp, last: lastTimestamp } = getPortfolioTimestamps(portfolio);

    const perpsValue = parseFloat(account.perp.marginSummary?.accountValue || '0');
    const perpsCount = account.perp.assetPositions ? account.perp.assetPositions.length : 0;

    const spotValue = account.spot.balances.reduce((sum, b) => sum + parseFloat(b.px) * parseFloat(b.total), 0);
    const spotCount = account.spot.balances ? account.spot.balances.filter((s) => parseFloat(s.hold) !== 0).length : 0;

    const totalValue = perpsValue + spotValue;

    if (firstTimestamp !== null && now - firstTimestamp < 7 * 24 * 60 * 60 * 1000)
        return { tag: 'FRESH', totalValue: totalValue, perpsValue, spotValue, perpsCount, spotCount };
    if (lastTimestamp !== null && now - lastTimestamp > 10 * 24 * 60 * 60 * 1000)
        return { tag: 'DORMANT', totalValue: totalValue, perpsValue, spotValue, perpsCount, spotCount };

    if (totalValue < 500_000)
        return { tag: 'SMALL', totalValue: totalValue, perpsValue, spotValue, perpsCount, spotCount };
    if (totalValue <= 1_000_000)
        return { tag: 'MEDIUM', totalValue: totalValue, perpsValue, spotValue, perpsCount, spotCount };

    return { tag: 'LARGE', totalValue: totalValue, perpsValue, spotValue, perpsCount, spotCount };
}

interface WsTrade {
    coin: string;
    side: string;
    px: string;
    sz: string;
    hash: string;
    time: number;
    tid: number;
    users: [string, string];
}

function isSpot(direction: HyperTradeDirection): boolean {
    return direction === 'spot';
}

interface AlertContext {
    candidate: HyperAggregationRecord;
    state: TraderState;
    portfolio: TraderPortfolio;
}

export default class HyperliquidService extends Tracker {
    private api = new HyperliquidAPI();
    private explorer = config.hyperliquid.explorer;
    private mainPerpChannels: ChatChannel[];
    private otherPerpChannels: ChatChannel[];
    private otherSpotChannels: ChatChannel[];
    private mainSpotChannels: ChatChannel[];
    private trackChannels: ChatChannel[];
    private sockets: Array<{
        ws: WebSocket | null;
        coins: string[];
        pingInterval: NodeJS.Timeout | null;
        reconnecting: boolean;
    }> = [];
    private tradeBatch: HyperTradeRecord[] = [];
    private batchInterval?: NodeJS.Timeout;
    private affectedKeys = new Map<string, PositionKey>();
    private spotCoinMap = new Map<string, string>();

    constructor(
        tg: Tg,
        mainPerpChannels: ChatChannel[],
        otherPerpChannels: ChatChannel[],
        mainSpotChannels: ChatChannel[],
        otherSpotChannels: ChatChannel[],
        trackChannels: ChatChannel[],
        useProxy = false,
        useProxyForScreenshots = false
    ) {
        super(tg, mainPerpChannels, useProxy, useProxyForScreenshots);
        this.mainPerpChannels = mainPerpChannels;
        this.otherPerpChannels = otherPerpChannels;
        this.mainSpotChannels = mainSpotChannels;
        this.otherSpotChannels = otherSpotChannels;
        this.trackChannels = trackChannels;
    }

    async start(): Promise<void> {
        if (this.monitoring) return;
        this.monitoring = true;
        this.logger.info('Monitoring started');

        const perpNames = await this.api.fetchCoins();
        if (perpNames.length === 0) throw new Error('Failed to fetch coin list from Hyperliquid API');

        const spotPairs = await this.api.fetchSpotCoins();
        if (spotPairs.length === 0) throw new Error('Failed to fetch spot coin list from Hyperliquid API');
        this.spotCoinMap = new Map(spotPairs.map((p) => [p.wsName, p.displayName]));
        this.logger.info(`Loaded ${spotPairs.length} spot pairs for monitoring`);

        this.sockets = this.buildSocketGroups(
            perpNames,
            spotPairs.map((p) => p.wsName)
        ).map((group) => ({
            ws: null,
            coins: group,
            pingInterval: null,
            reconnecting: false
        }));
        for (const slot of this.sockets) slot.ws = this.connectWebSocket(slot);

        this.batchInterval = setInterval(() => {
            this.flushTradeBatch().catch((error) => this.logger.error(`Error flushing trade batch: ${error}`));
        }, config.hyperliquid.batchFlushIntervalMs);

        this.monitorTask = this.mainLoop();
    }

    async stop(): Promise<void> {
        if (!this.monitoring) return;
        this.monitoring = false;
        await this.monitorTask?.catch((error) => this.logger.error(`Error while awaiting monitor task: ${error}`));
        this.monitorTask = undefined;
        this.logger.info('Monitoring stopped');

        this.affectedKeys.clear();
        this.spotCoinMap.clear();
        this.flushTradeBatch().catch((error) => this.logger.error(`Error flushing trade batch during stop: ${error}`));

        for (const slot of this.sockets) {
            if (slot.pingInterval) {
                clearInterval(slot.pingInterval);
                slot.pingInterval = null;
            }
            if (slot.ws) {
                slot.ws.onclose = null;
                slot.ws.onerror = null;
                slot.ws.close();
                slot.ws = null;
            }
        }
        this.sockets = [];
        if (this.batchInterval) clearInterval(this.batchInterval);
    }

    async track(wallet: string, coin: string, direction: HyperTradeDirection): Promise<string> {
        try {
            const found = await HyperliquidDBService.isWalletTracked(wallet, coin, direction);
            if (found)
                return `Wallet <code>${escapeHtml(wallet)}</code> is already being tracked for ${coin.toUpperCase()} ${direction.toUpperCase()}.`;

            const state = await this.api.fetchTraderState(wallet);
            if (!state.perp || !state.spot) {
                this.logger.info(`Unable to fetch state for a wallet ${wallet}`);
                return 'Failed to fetch trader state. Please ensure the wallet address is correct.';
            }

            const currentPosition = state.perp.assetPositions?.find((pos) => pos.position?.coin === coin);
            if (!currentPosition || !currentPosition.position)
                return `No open position found for wallet <code>${escapeHtml(wallet)}</code> on coin <code>$${coin.toUpperCase()}</code>.`;

            const currentSzi = parseFloat(currentPosition.position.szi || '0');
            const currentDirection: HyperTradeDirection = currentSzi > 0 ? 'long' : 'short';
            if (currentDirection !== direction)
                return (
                    `The current position direction for wallet <code>${escapeHtml(wallet)}</code> on coin <code>$${coin.toUpperCase()}</code> is <b>${currentDirection.toUpperCase()}</b>` +
                    `which does not match the requested tracking direction <b>${direction.toUpperCase()}</b>.`
                );
            const currentNotional = Math.abs(currentSzi) * parseFloat(currentPosition.position.entryPx || '0');

            await HyperliquidDBService.addUpdateTrackedWallet(wallet, coin, direction, currentNotional);
            return `Added wallet <code>${escapeHtml(wallet)}</code> for tracking (${coin.toUpperCase()} ${direction.toUpperCase()}).`;
        } catch (error) {
            this.logger.error(`Failed to track the wallet: ${error}`);
            return 'An error occurred while adding the tracked wallet. Please try again later.';
        }
    }

    async trackById(id: string): Promise<{ msg: string; buttons: InlineKeyboardMarkup | null }> {
        try {
            const trade = await HyperliquidDBService.getTradeById(id);
            if (!trade) return { msg: 'Trade not found.', buttons: null };
            const updated_buttons: InlineKeyboardMarkup = {
                inline_keyboard: [
                    [
                        {
                            text: '🔗 View on Hypurrscan',
                            url: `${this.explorer}/address/${encodeURIComponent(trade.wallet)}`
                        }
                    ]
                ]
            };

            const found = await HyperliquidDBService.isWalletTracked(trade.wallet, trade.coin, trade.direction);
            if (found)
                return {
                    msg: `Wallet <code>${escapeHtml(trade.wallet)}</code> is already being tracked for ${trade.coin.toUpperCase()} ${trade.direction.toUpperCase()}.`,
                    buttons: updated_buttons
                };
            await HyperliquidDBService.addUpdateTrackedWallet(
                trade.wallet,
                trade.coin,
                trade.direction,
                trade.totalNotional
            );
            return {
                msg: `Added wallet <code>${escapeHtml(trade.wallet)}</code> for tracking (${trade.coin.toUpperCase()} ${trade.direction.toUpperCase()}).`,
                buttons: updated_buttons
            };
        } catch (error) {
            this.logger.error(`Failed to track by id: ${error}`);
            return { msg: 'An error occurred while adding the tracked wallet. Please try again later.', buttons: null };
        }
    }

    async untrack(wallet: string, coin: string, direction: HyperTradeDirection): Promise<string> {
        try {
            const deleted = await HyperliquidDBService.removeTrackedWallet(wallet, coin, direction);
            if (deleted) return `Removed wallet <code>${escapeHtml(deleted.wallet)}</code> from tracking.`;
            else return `Wallet <code>${escapeHtml(wallet)}</code> with such order was not found in tracked list.`;
        } catch (error) {
            this.logger.error(`Failed to untrack the wallet ${error}`);
            return 'An error occurred while removing the tracked wallet. Please try again later.';
        }
    }

    async untrackById(id: string): Promise<{ msg: string; buttons: InlineKeyboardMarkup | null }> {
        try {
            const deleted = await HyperliquidDBService.removeTrackedWalletById(id);
            if (deleted) {
                const updated_buttons: InlineKeyboardMarkup = {
                    inline_keyboard: [
                        [
                            {
                                text: '🔗 View on Hypurrscan',
                                url: `${this.explorer}/address/${encodeURIComponent(deleted.wallet)}`
                            }
                        ]
                    ]
                };
                return {
                    msg: `Removed wallet <code>${escapeHtml(deleted.wallet)}</code> from tracking.`,
                    buttons: updated_buttons
                };
            }
            return { msg: `Wallet with such order was not found in tracked list.`, buttons: null };
        } catch (error) {
            this.logger.error(`Failed to untrack by id: ${error}`);
            return {
                msg: 'An error occurred while removing the tracked wallet. Please try again later.',
                buttons: null
            };
        }
    }

    async listTracked(): Promise<string> {
        try {
            const trackedWallets = await HyperliquidDBService.getTrackedWallets();
            if (trackedWallets.length === 0) {
                return 'No wallets are currently being tracked.';
            }
            const lines = ['📋 <b>Tracked Wallets:</b>', ''];
            for (const tracked of trackedWallets) {
                const compressedWallet = `${tracked.wallet.slice(0, 6)}...${tracked.wallet.slice(-4)}`;
                const directionIcon = tracked.direction === 'long' ? '🟢' : '🔴';
                const href = `${this.explorer}/address/${encodeURIComponent(tracked.wallet)}`;
                lines.push(`<b>Wallet</b> <a href="${href}">${escapeHtml(compressedWallet)}</a>`);
                lines.push(`<b>Coin:</b> ${directionIcon} <code>${tracked.coin.toUpperCase()}</code>`);
                lines.push(`<b>Size:</b> <code>$${tracked.totalNotional.toLocaleString()}</code>`);
                lines.push('');
            }
            return lines.join('\n');
        } catch (error) {
            this.logger.error(`Failed to list the tracked wallets${error}`);
            return 'An error occurred while listing tracked wallets. Please try again later.';
        }
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
                    await HyperliquidDBService.cleanTrades(config.hyperliquid.cleanupTTLms);
                    await HyperliquidDBService.cleanAlerts(config.hyperliquid.cleanupTTLms);
                } catch (error) {
                    this.logger.error(`Failed to cleanup: ${error}`);
                }
                if (!this.monitoring) break;
                await this.cancellableSleep(config.monitor.cleanupIntervalMs);
            }
        };

        const trackLoop = async () => {
            while (this.monitoring) {
                try {
                    await this.trackAndAlert();
                } catch (error) {
                    this.logger.error(`Failed to track:${error}`);
                }
                if (!this.monitoring) break;
                await this.cancellableSleep(config.hyperliquid.checkIntervalMs);
            }
        };

        const alertNoDataLoop = this.watchDog(config.monitor.noDataTimeoutMs, async () => {
            this.logger.warn('Forcing WebSocket reconnection due to no data received.');
            for (const slot of this.sockets) this.reconnectWebSocket(slot);
        });

        await Promise.all([scanLoop(), cleanupLoop(), trackLoop(), alertNoDataLoop]);
    }

    private async scanAndAlert(): Promise<void> {
        if (this.affectedKeys.size === 0) {
            this.logger.info('No affected positions to scan');
            return;
        }

        const keysToScan = Array.from(this.affectedKeys.values());
        this.affectedKeys.clear();

        const perpKeys = keysToScan.filter((k) => !isSpot(k.direction));
        const spotKeys = keysToScan.filter((k) => isSpot(k.direction));

        const perpCandidates =
            perpKeys.length > 0
                ? await HyperliquidDBService.getTradesToAlert(
                      perpKeys,
                      config.hyperliquid.minNotionalUSD,
                      config.hyperliquid.aggregationWindowMs
                  )
                : [];

        const spotCandidates =
            spotKeys.length > 0
                ? await HyperliquidDBService.getTradesToAlert(
                      spotKeys,
                      config.hyperliquid.minSpotNotionalUSD,
                      config.hyperliquid.aggregationWindowMs
                  )
                : [];

        const candidates = [...perpCandidates, ...spotCandidates];

        this.logger.info(
            `Found ${candidates.length} candidates needing alert (${perpCandidates.length} perp, ${spotCandidates.length} spot)`
        );
        for (const candidate of candidates) {
            try {
                if (isSpot(candidate.direction)) {
                    await this.processSpotAlertCandidate(candidate);
                } else {
                    await this.processAlertCandidate(candidate);
                }
            } catch (error) {
                this.logger.error(
                    `Failed to alert wallet ${candidate.wallet} / ${candidate.coin} / ${candidate.direction}: ${error}`
                );
            }
        }
    }

    private async trackAndAlert(): Promise<void> {
        const trackedWallets = await HyperliquidDBService.getExpiredTrackedWallets();
        this.logger.info(`Found ${trackedWallets.length} tracked wallets to check`);

        for (const tracked of trackedWallets) {
            try {
                await this.processTrackedWallet(tracked);
            } catch (error) {
                this.logger.error(
                    `Failed to check tracked wallet ${tracked.wallet} / ${tracked.coin} / ${tracked.direction}: ${error}`
                );
            }
        }
    }

    private async processTrackedWallet(tracked: HyperTrackedRecord): Promise<void> {
        const state = await this.api.fetchTraderState(tracked.wallet);
        if (!state.perp || !state.spot) {
            this.logger.info(`Unable to fetch state for tracked wallet ${tracked.wallet}`);
            return;
        }

        const currentPosition = state.perp.assetPositions?.find((pos) => pos.position?.coin === tracked.coin);

        if (!currentPosition || !currentPosition.position) {
            await this.sendPositionChangedMessage(
                tracked.id,
                tracked.wallet,
                tracked.coin,
                tracked.direction,
                'closed'
            );
            await HyperliquidDBService.removeTrackedWalletById(tracked.id);
            return;
        }

        const currentSzi = parseFloat(currentPosition.position.szi || '0');
        const currentDirection: HyperTradeDirection = currentSzi > 0 ? 'long' : 'short';

        if (currentDirection !== tracked.direction) {
            await this.sendPositionChangedMessage(
                tracked.id,
                tracked.wallet,
                tracked.coin,
                tracked.direction,
                'direction'
            );
            await HyperliquidDBService.removeTrackedWalletById(tracked.id);
            return;
        }

        const currentNotional = Math.abs(currentSzi) * parseFloat(currentPosition.position.entryPx || '0');
        const increaseThreshold = tracked.totalNotional * (1 + config.hyperliquid.minimalGrowthPercent / 100);
        const decreaseThreshold = tracked.totalNotional * (1 - config.hyperliquid.minimalGrowthPercent / 100);
        if (currentNotional > increaseThreshold || currentNotional < decreaseThreshold) {
            await this.sendPositionChangedMessage(tracked.id, tracked.wallet, tracked.coin, tracked.direction, 'size', {
                previousNotional: tracked.totalNotional,
                currentNotional,
                currentPosition
            });
            await HyperliquidDBService.addUpdateTrackedWallet(
                tracked.wallet,
                tracked.coin,
                tracked.direction,
                currentNotional,
                config.hyperliquid.checkIntervalMs
            );
        } else {
            await HyperliquidDBService.addUpdateTrackedWallet(
                tracked.wallet,
                tracked.coin,
                tracked.direction,
                tracked.totalNotional,
                config.hyperliquid.checkIntervalMs
            );
        }
    }

    private buildSocketGroups(perpNames: string[], spotNames: string[]): string[][] {
        const MAX_SOCKETS = 10;

        const groups: string[][] = [];
        const numRestSockets = MAX_SOCKETS - groups.length;
        const all = perpNames.concat(spotNames);

        const restChunkSize = Math.ceil(all.length / numRestSockets);
        for (let i = 0; i < all.length; i += restChunkSize) {
            groups.push(all.slice(i, i + restChunkSize));
        }

        if (groups.length > MAX_SOCKETS)
            throw new Error(`Too many socket groups: ${groups.length}, expected max ${MAX_SOCKETS}`);
        return groups;
    }

    private reconnectWebSocket(slot: {
        ws: WebSocket | null;
        coins: string[];
        pingInterval: NodeJS.Timeout | null;
        reconnecting: boolean;
    }): void {
        if (slot.reconnecting) return;
        slot.reconnecting = true;

        if (slot.pingInterval) {
            clearInterval(slot.pingInterval);
            slot.pingInterval = null;
        }
        if (slot.ws) {
            slot.ws.onclose = null;
            slot.ws.onerror = null;
            slot.ws.close();
            slot.ws = null;
        }

        if (this.monitoring) {
            setTimeout(() => {
                slot.reconnecting = false;
                if (this.monitoring) {
                    slot.ws = this.connectWebSocket(slot);
                }
            }, 5000);
        } else {
            slot.reconnecting = false;
        }
    }

    private connectWebSocket(slot: {
        ws: WebSocket | null;
        coins: string[];
        pingInterval: NodeJS.Timeout | null;
        reconnecting: boolean;
    }): WebSocket {
        const ws = new WebSocket(config.hyperliquid.wss);

        ws.onopen = () => {
            this.logger.info(
                `WebSocket connected, subscribing to ${slot.coins.length} coins: ${slot.coins.join(', ')}`
            );
            for (const coin of slot.coins) {
                ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
            }
            slot.pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'ping' }));
            }, 30000);
        };

        ws.onmessage = (event) => {
            const rawData = typeof event.data === 'string' ? event.data : event.data.toString();
            const message = JSON.parse(rawData);
            if (message.channel === 'trades') {
                for (const trade of message.data as WsTrade[]) {
                    if (
                        trade.sz === '0' ||
                        trade.hash === '0x0000000000000000000000000000000000000000000000000000000000000000'
                    ) {
                        continue;
                    }
                    void this.handleTrade(trade, trade.coin).catch((error) =>
                        this.logger.error(`Failed to handle trade for coin ${trade.coin}: ${error}`)
                    );
                }
            }
        };

        ws.onerror = (error) => {
            this.logger.error(`WebSocket error: ${error}`);
            if (ws.readyState !== WebSocket.OPEN) this.reconnectWebSocket(slot);
        };

        ws.onclose = (event) => {
            const reason = event.reason || 'unknown';
            this.logger.info(`WebSocket closed, reason: ${reason}`);
            this.reconnectWebSocket(slot);
        };

        return ws;
    }

    async getCoinStats(coin: string): Promise<string> {
        try {
            const perpsStats = await this.api.fetchPerpMeta();
            const spotStats = await this.api.fetchSpotMeta();

            if (!perpsStats || !spotStats) {
                return 'Failed to fetch market statistics. Please try again later.';
            }

            const lines: string[] = [`📊 <b>Market Stats:</b> <code>$${escapeHtml(coin)}</code>`, ''];

            const perpIndex = perpsStats.universe.findIndex((u) => u.name === coin);
            if (perpIndex !== -1) {
                const perpMetaItem = perpsStats.universe[perpIndex];
                const perpCtx = perpsStats.assetMeta[perpIndex];

                lines.push('🔷 <b>Perpetuals</b>');
                lines.push('');

                lines.push(`<b>Max Leverage:</b> <code>${perpMetaItem.maxLeverage}x</code>`);
                if (perpMetaItem.onlyIsolated) lines.push(`<b>Mode:</b> <code>Isolated Only</code>`);

                if (perpCtx) {
                    lines.push(`Mark Price: <code>$${perpCtx.markPx}</code>`);
                    lines.push(`Mid Price: <code>$${perpCtx.midPx}</code>`);
                    lines.push(`Oracle Price: <code>$${perpCtx.oraclePx}</code>`);
                    lines.push('');
                    lines.push(`24h Volume: <code>${formatCurrency(parseFloat(perpCtx.dayNtlVlm))}</code>`);
                    lines.push(`Open Interest: <code>${parseFloat(perpCtx.openInterest).toFixed(2)}</code>`);
                    lines.push(`Funding Rate: <code>${(parseFloat(perpCtx.funding) * 100).toFixed(4)}%</code>`);
                    lines.push(`Premium: <code>${(parseFloat(perpCtx.premium) * 100).toFixed(4)}%</code>`);

                    const priceChange =
                        ((parseFloat(perpCtx.markPx) - parseFloat(perpCtx.prevDayPx)) / parseFloat(perpCtx.prevDayPx)) *
                        100;
                    const changeIcon = priceChange >= 0 ? '📈' : '📉';
                    lines.push(`<b>24h Change:</b> <code>${priceChange.toFixed(2)}%</code> ${changeIcon}`);
                }
                lines.push('');
            }

            let spotPair: { name: string; tokens: number[]; index: number; isCanonical: boolean } | undefined;
            const coinToken = spotStats.tokens.find((t) => t.name === coin);
            if (coinToken) spotPair = spotStats.universe.find((u) => u.tokens[0] === coinToken.index);

            if (spotPair) {
                const baseTokenIndex = spotPair.tokens[0];
                const quoteTokenIndex = spotPair.tokens[1];
                const baseToken = spotStats.tokens[baseTokenIndex];
                const quoteToken = spotStats.tokens[quoteTokenIndex];
                const spotCtx = spotStats.assetMeta[spotPair.index];

                lines.push('🔶 <b>Spot</b>');
                lines.push('');

                if (baseToken) {
                    lines.push(`<b>Base Token:</b> <code>${escapeHtml(baseToken.name)}</code>`);
                }
                if (quoteToken) {
                    lines.push(`<b>Quote Token:</b> <code>${escapeHtml(quoteToken.name)}</code>`);
                }
                lines.push(`<b>Canonical:</b> <code>${spotPair.isCanonical ? 'Yes' : 'No'}</code>`);

                if (spotCtx) {
                    lines.push('');
                    lines.push(`Mark Price: <code>$${spotCtx.markPx}</code>`);
                    lines.push(`Mid Price: <code>$${spotCtx.midPx}</code>`);
                    lines.push('');
                    lines.push(`24h Volume: <code>${formatCurrency(parseFloat(spotCtx.dayNtlVlm))}</code>`);

                    const priceChange =
                        ((parseFloat(spotCtx.markPx) - parseFloat(spotCtx.prevDayPx)) / parseFloat(spotCtx.prevDayPx)) *
                        100;
                    const changeIcon = priceChange >= 0 ? '📈' : '📉';
                    lines.push(`<b>24h Change:</b> <code>${priceChange.toFixed(2)}%</code> ${changeIcon}`);
                }
            }

            return lines.join('\n');
        } catch (error) {
            this.logger.error(`getCoinStats error: ${error}`);
            return 'An error occurred while fetching coin stats. Please try again later.';
        }
    }

    async flushTradeBatch(): Promise<void> {
        await this.flushMutex.runExclusive(async () => {
            if (this.tradeBatch.length === 0) return;
            const batchToFlush = [...this.tradeBatch];
            this.tradeBatch = [];
            this.lastDataTimestamp = Date.now();

            try {
                this.logger.info(`Flushing trade batch of size ${batchToFlush.length}`);
                await HyperliquidDBService.addTradesBulk(batchToFlush, config.hyperliquid.aggregationWindowMs);
                for (const trade of batchToFlush) {
                    const keyStr = `${trade.wallet}:${trade.coin}:${trade.direction}`;
                    if (!this.affectedKeys.has(keyStr)) {
                        this.affectedKeys.set(keyStr, {
                            wallet: trade.wallet,
                            coin: trade.coin,
                            direction: trade.direction
                        });
                    }
                }
            } catch (error) {
                this.logger.error(`Error flushing trade batch: ${error}`);
            }
        });
    }

    async handleTrade(trade: WsTrade, coin: string): Promise<void> {
        const notional = parseFloat(trade.px) * parseFloat(trade.sz);
        if (!Number.isFinite(notional)) return;

        if (this.spotCoinMap.has(coin)) {
            const displayCoin = this.spotCoinMap.get(coin) ?? coin;
            const buyer = trade.users[0];
            const seller = trade.users[1];
            if (buyer) {
                this.tradeBatch.push({
                    wallet: buyer,
                    coin: displayCoin,
                    notional,
                    tradeTime: trade.time,
                    direction: 'spot'
                });
            }
            if (seller) {
                this.tradeBatch.push({
                    wallet: seller,
                    coin: displayCoin,
                    notional: -notional,
                    tradeTime: trade.time,
                    direction: 'spot'
                });
            }
        } else {
            const buyer = trade.users[0];
            if (!buyer) return;
            const direction: HyperTradeDirection = trade.side === 'B' ? 'long' : 'short';
            this.tradeBatch.push({ wallet: buyer, coin, notional, tradeTime: trade.time, direction });
        }

        if (this.tradeBatch.length >= config.hyperliquid.batchSize) await this.flushTradeBatch();
    }

    private async sendPositionChangedMessage(
        id: string,
        wallet: string,
        coin: string,
        direction: HyperTradeDirection,
        reason: 'closed' | 'liquidated' | 'direction' | 'size',
        extra?: {
            previousNotional?: number;
            currentNotional?: number;
            currentPosition?: AssetPosition;
        }
    ): Promise<void> {
        const directionIcon = direction === 'long' ? '🟢' : '🔴';
        const directionLabel = direction === 'long' ? 'Long' : 'Short';

        let reasonIcon: string;
        let reasonLabel: string;
        const lines: string[] = [];

        switch (reason) {
            case 'closed':
                reasonIcon = '✅';
                reasonLabel = 'Position Closed';
                lines.push(
                    `${reasonIcon} <b>${reasonLabel}</b>`,
                    '',
                    `${directionIcon} <b>Coin:</b> <code>${escapeHtml(coin)}</code> (${directionLabel})`,
                    '',
                    `Wallet: <code>${escapeHtml(wallet)}</code>`
                );
                break;

            case 'liquidated':
                reasonIcon = '⚠️';
                reasonLabel = 'Position Liquidated';
                lines.push(
                    `${reasonIcon} <b>${reasonLabel}</b>`,
                    '',
                    `${directionIcon} <b>Coin:</b> <code>${escapeHtml(coin)}</code> (${directionLabel})`,
                    '',
                    `Wallet: <code>${escapeHtml(wallet)}</code>`
                );
                break;

            case 'direction':
                reasonIcon = '🔄';
                reasonLabel = 'Position Direction Changed';
                lines.push(
                    `${reasonIcon} <b>${reasonLabel}</b>`,
                    '',
                    `${directionIcon} <b>Coin:</b> <code>${escapeHtml(coin)}</code> (${directionLabel})`,
                    '',
                    `Wallet: <code>${escapeHtml(wallet)}</code>`
                );
                break;

            case 'size':
                if (!extra?.currentPosition?.position || !extra.previousNotional || !extra.currentNotional) {
                    this.logger.error('sendPositionChangedMessage: Missing required data for increased position');
                    return;
                }

                const { rank, pnl, entryPrice } = this.api.extractPositionDetails(extra.currentPosition.position);
                const changePercent = (extra.currentNotional / extra.previousNotional) * 100 - 100;

                reasonIcon = '📈';
                reasonLabel = 'Position Size Changed';
                lines.push(
                    `${reasonIcon} <b>${reasonLabel}</b>`,
                    '',
                    `${directionIcon} <b>Coin:</b> <code>${escapeHtml(coin)}</code> (${directionLabel})`,
                    '',
                    `<b>Previous Size:</b> <code>${formatCurrency(extra.previousNotional)}</code>`,
                    `<b>Current Size:</b> <code>${formatCurrency(extra.currentNotional)}</code>`,
                    `<b>Change:</b> <code>${changePercent.toFixed(2)}%</code>`,
                    '',
                    `<b>Leverage:</b> <code>${rank.toFixed(2)}x</code>`,
                    `<b>Entry Price:</b> <code>${escapeHtml(entryPrice)}</code>`,
                    `<b>Unrealized PnL:</b> <code>${formatCurrency(pnl)}</code>`,
                    '',
                    `Wallet: <code>${escapeHtml(wallet)}</code>`
                );
                break;
        }

        const buttons: InlineKeyboardMarkup = {
            inline_keyboard: [
                [
                    {
                        text: '🔗 View on Hypurrscan',
                        url: `${this.explorer}/address/${encodeURIComponent(wallet)}`
                    }
                ],
                reason !== 'closed' && reason !== 'liquidated'
                    ? [Markup.button.callback('🗑️ Untrack Wallet', `untrack:${id}`, true)]
                    : []
            ]
        };

        try {
            for (let i = 0; i < this.trackChannels.length; i++) {
                if (i > 0) await sleep(1000);
                const channel = this.trackChannels[i];
                await this.tg.sendMessage(channel.chatId, lines.join('\n'), {
                    message_thread_id: channel.topicId,
                    reply_markup: buttons
                });
            }
        } catch (error) {
            this.logger.error(`Failed to send position changed message: ${error}`);
        }
    }

    private async processAlertCandidate(candidate: HyperAggregationRecord): Promise<void> {
        const alertChannels = this.getAlertChannels(candidate.coin, candidate.direction);
        this.logger.debug(
            `Detected high-value perps trade: ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
        );
        const portfolio = await this.api.fetchPortfolio(candidate.wallet);
        if (!portfolio) return;
        const state = await this.api.fetchTraderState(candidate.wallet);
        if (!state.perp || !state.spot) return;

        const positionState = state.perp.assetPositions?.find((pos) => pos.position?.coin === candidate.coin);
        if (!positionState || !positionState.position) {
            this.logger.debug(
                `Skipping alert for high-value perps trade (no position found): ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
            );
            return;
        }
        const direction: HyperTradeDirection = parseFloat(positionState.position.szi) > 0 ? 'long' : 'short';
        if (direction !== candidate.direction) {
            this.logger.debug(
                `Skipping alert for high-value perps trade (direction mismatch): ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
            );
            return;
        }
        const upstreamTotalNotional = Math.abs(
            parseFloat(positionState.position.szi) * parseFloat(positionState.position.entryPx || '0')
        );
        if (upstreamTotalNotional < config.hyperliquid.minNotionalUSD) {
            this.logger.debug(
                `Skipping alert for high-value perps trade (upstream notional too low): ${candidate.wallet} ${candidate.coin} ${formatCurrency(upstreamTotalNotional)} (${candidate.direction})`
            );
            return;
        }
        candidate.totalNotional = upstreamTotalNotional;
        await HyperliquidDBService.updateTradeNotional(candidate.id, candidate.totalNotional);

        const lastAlerts = await HyperliquidDBService.getLastAlerts(
            candidate.wallet,
            candidate.coin,
            candidate.direction,
            alertChannels.map((c) => c.chatId)
        );

        if (lastAlerts.size > 0) {
            const latestAlert = [...lastAlerts.values()].reduce((a, b) =>
                new Date(a.sentAt) > new Date(b.sentAt) ? a : b
            );
            const growth = candidate.totalNotional - latestAlert.totalNotional;
            const dynamicThreshold = Math.max(
                (latestAlert.totalNotional * config.hyperliquid.minimalGrowthPercent) / 100,
                config.hyperliquid.minimalGrowthUSD
            );
            if (growth < dynamicThreshold) {
                this.logger.debug(
                    `Skipping ${candidate.wallet} ${candidate.coin} (${candidate.direction}): growth ${growth} < dynamicThreshold ${dynamicThreshold}`
                );
                return;
            }

            this.logger.info(
                `Position growth detected for ${candidate.wallet} ${candidate.coin} (${candidate.direction}): growth ${growth} >= dynamicThreshold ${dynamicThreshold}, sending update alert`
            );
            const replyText = this.formatGrowingPositionMessage(candidate.totalNotional, latestAlert.totalNotional);
            for (let i = 0; i < alertChannels.length; i++) {
                if (i > 0) await sleep(1000);
                const channel = alertChannels[i];
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
                await HyperliquidDBService.insertAlert({
                    wallet: candidate.wallet,
                    coin: candidate.coin,
                    direction: candidate.direction,
                    totalNotional: candidate.totalNotional,
                    sentAt: new Date(),
                    chatId: channel.chatId,
                    messageId
                });
            }
            return;
        }

        this.logger.info(
            `Sending alert for high-value trade: ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
        );

        const result = this.formatAlertMessage({
            candidate,
            state,
            portfolio
        });
        if (!result) return;
        const { msg, buttons } = result;

        let screenshot: Buffer | null = null;
        if (config.puppeteer.screenshotEnabled) {
            screenshot = await this.screenshoter.capture(
                `${this.explorer}/address/${candidate.wallet}#perps`,
                undefined,
                () => {
                    const result = document.evaluate(
                        '//div[text()=" Overview "]/div/span',
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                    );
                    const el = result.singleNodeValue as Element | null;
                    if (!el?.textContent) return false;
                    const num = parseFloat(el.textContent.replace(/,/g, '').replace('$', ''));
                    return !isNaN(num) && num > 0;
                }
            );
        }
        for (let i = 0; i < alertChannels.length; i++) {
            if (i > 0) await sleep(1000);
            const channel = alertChannels[i];
            let messageId: number | undefined;
            if (screenshot) {
                messageId = await this.tg.sendPhoto(channel.chatId, screenshot, msg, {
                    reply_markup: buttons,
                    message_thread_id: channel.topicId
                });
            } else {
                messageId = await this.tg.sendMessage(channel.chatId, msg, {
                    message_thread_id: channel.topicId,
                    reply_markup: buttons
                });
            }
            await HyperliquidDBService.insertAlert({
                wallet: candidate.wallet,
                coin: candidate.coin,
                direction: candidate.direction,
                totalNotional: candidate.totalNotional,
                sentAt: new Date(),
                chatId: channel.chatId,
                messageId
            });
        }
    }

    private async processSpotAlertCandidate(candidate: HyperAggregationRecord): Promise<void> {
        const alertChannels = this.getAlertChannels(candidate.coin, candidate.direction);

        this.logger.debug(
            `Detected high-value spot trade: ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
        );

        const portfolio = await this.api.fetchPortfolio(candidate.wallet);
        if (!portfolio) return;
        const state = await this.api.fetchTraderState(candidate.wallet);
        if (!state.perp || !state.spot) return;

        const positionState = state.spot.balances.find((pos) => pos.coin === candidate.coin.split('/')[0]);
        if (!positionState) {
            this.logger.debug(
                `Skipping alert for high-value spot trade (no position found): ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
            );
            return;
        }

        const upstreamTotalNotional = parseFloat(positionState.total) * parseFloat(positionState.px);
        if (upstreamTotalNotional < config.hyperliquid.minSpotNotionalUSD) {
            this.logger.debug(
                `Skipping alert for high-value spot trade (upstream notional too low): ${candidate.wallet} ${candidate.coin} ${formatCurrency(upstreamTotalNotional)} (${candidate.direction})`
            );
            return;
        }

        candidate.totalNotional = upstreamTotalNotional;
        await HyperliquidDBService.updateTradeNotional(candidate.id, candidate.totalNotional);

        const lastAlerts = await HyperliquidDBService.getLastAlerts(
            candidate.wallet,
            candidate.coin,
            candidate.direction,
            alertChannels.map((c) => c.chatId)
        );
        if (lastAlerts.size > 0) {
            const latestAlert = [...lastAlerts.values()].reduce((a, b) =>
                new Date(a.sentAt) > new Date(b.sentAt) ? a : b
            );
            const growth = candidate.totalNotional - latestAlert.totalNotional;
            const dynamicThreshold = Math.max(
                (latestAlert.totalNotional * config.hyperliquid.minimalGrowthPercent) / 100,
                config.hyperliquid.minimalGrowthUSD
            );
            if (growth < dynamicThreshold) {
                this.logger.debug(
                    `Skipping spot ${candidate.wallet} ${candidate.coin} (${candidate.direction}): growth ${growth} < dynamicThreshold ${dynamicThreshold}`
                );
                return;
            }

            this.logger.info(
                `Spot trade growth for ${candidate.wallet} ${candidate.coin} (${candidate.direction}): growth ${growth} >= dynamicThreshold ${dynamicThreshold}`
            );
            const replyText = this.formatGrowingPositionMessage(candidate.totalNotional, latestAlert.totalNotional);
            for (let i = 0; i < alertChannels.length; i++) {
                if (i > 0) await sleep(1000);
                const channel = alertChannels[i];
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
                await HyperliquidDBService.insertAlert({
                    wallet: candidate.wallet,
                    coin: candidate.coin,
                    direction: candidate.direction,
                    totalNotional: candidate.totalNotional,
                    sentAt: new Date(),
                    chatId: channel.chatId,
                    messageId
                });
            }
            return;
        }

        this.logger.info(
            `Sending spot alert: ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
        );

        const result = this.formatSpotAlertMessage({ candidate, state, portfolio });
        if (!result) return;
        const { msg, buttons } = result;

        let screenshot: Buffer | null = null;
        if (config.puppeteer.screenshotEnabled) {
            screenshot = await this.screenshoter.capture(
                `${this.explorer}/address/${candidate.wallet}#spot`,
                undefined,
                () => {
                    const result = document.evaluate(
                        '//div[text()=" Overview "]/div/span',
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                    );
                    const el = result.singleNodeValue as Element | null;
                    if (!el?.textContent) return false;
                    const num = parseFloat(el.textContent.replace(/,/g, '').replace('$', ''));
                    return !isNaN(num) && num > 0;
                }
            );
        }
        for (let i = 0; i < alertChannels.length; i++) {
            if (i > 0) await sleep(1000);
            const channel = alertChannels[i];
            let messageId: number | undefined;
            if (screenshot) {
                messageId = await this.tg.sendPhoto(channel.chatId, screenshot, msg, {
                    reply_markup: buttons,
                    message_thread_id: channel.topicId
                });
            } else {
                messageId = await this.tg.sendMessage(channel.chatId, msg, {
                    message_thread_id: channel.topicId,
                    reply_markup: buttons
                });
            }
            await HyperliquidDBService.insertAlert({
                wallet: candidate.wallet,
                coin: candidate.coin,
                direction: candidate.direction,
                totalNotional: candidate.totalNotional,
                sentAt: new Date(),
                chatId: channel.chatId,
                messageId
            });
        }
    }

    private formatAlertMessage(context: AlertContext): {
        msg: string;
        buttons: InlineKeyboardMarkup;
    } | null {
        if (context.candidate.direction === 'spot')
            throw new Error(`Invalid direction for perp alert: ${context.candidate.direction}`);
        if (!context.state.perp || !context.state.spot) return null;
        const accountTag = classifyAccountTag(context.state, context.portfolio);
        const perpState = context.state.perp;
        const candidate = context.candidate;

        const positionState = perpState.assetPositions?.find((pos) => pos.position?.coin === candidate.coin);
        const { direction, rank, pnl, entryPrice } = this.api.extractPositionDetails(positionState?.position!);

        const posTrades = candidate.tradeCount ?? 1;
        const directionIcon = direction === 'long' ? '🟢' : '🔴';
        const directionLabel = direction === 'long' ? 'Long' : 'Short';
        const positionSize = candidate.totalNotional ?? 0;

        const lines = [
            `🐋 <b>NEW WHALE ALERT</b> 🐋`,
            '',
            `${directionIcon} <b>Coin:</b> <code>${escapeHtml(candidate.coin)}</code> (${directionLabel})`,
            '',
            `<b>Leverage:</b> <code>${rank.toFixed(2)}x</code>`,
            `<b>Entry Price:</b> <code>${escapeHtml(entryPrice)}</code>`,
            `<b>Position Size:</b> <code>${formatCurrency(positionSize)}</code>`,
            `<b>Unrealized PnL:</b> <code>${formatCurrency(pnl)}</code>`,
            `<b>Total Trades:</b> ${posTrades}`,
            '',
            `📈 <b>Trader Profile</b> 📈`,
            `Wallet: <code>${escapeHtml(candidate.wallet)}</code>`,
            `Value: <code>${formatCurrency(accountTag.totalValue)}</code>`,
            `Perps Value: <code>${formatCurrency(accountTag.perpsValue)}</code>`,
            `Perps Positions: ${accountTag.perpsCount}`,
            `Spot Value: <code>${formatCurrency(accountTag.spotValue)}</code>`,
            `Spot Assets: ${accountTag.spotCount}`,
            '',
            `Account: #${accountTag.tag}`
        ];
        return {
            msg: lines.join('\n'),
            buttons: {
                inline_keyboard: [
                    [
                        {
                            text: '🔗 View on Hypurrscan',
                            url: `${this.explorer}/address/${encodeURIComponent(candidate.wallet)}`
                        }
                    ],
                    [Markup.button.callback('📌 Track Wallet', `track:${context.candidate.id}`, true)]
                ]
            }
        };
    }

    public formatSpotAlertMessage(context: AlertContext): { msg: string; buttons: InlineKeyboardMarkup } | null {
        if (context.candidate.direction !== 'spot')
            throw new Error(`Invalid direction for spot alert: ${context.candidate.direction}`);
        if (!context.state.perp || !context.state.spot) return null;
        const accountTag = classifyAccountTag(context.state, context.portfolio);
        const candidate = context.candidate;

        const icon = '🔶';
        const posTrades = candidate.tradeCount ?? 1;

        const lines = [
            `🐋 <b>SPOT WHALE ALERT</b> 🐋`,
            '',
            `${icon} <b>Coin:</b> <code>${escapeHtml(candidate.coin)}</code>`,
            '',
            `<b>Size:</b> <code>${formatCurrency(candidate.totalNotional)}</code>`,
            `<b>Total Trades:</b> ${posTrades}`,
            '',
            `📈 <b>Trader Profile</b> 📈`,
            `Wallet: <code>${escapeHtml(candidate.wallet)}</code>`,
            `Value: <code>${formatCurrency(accountTag.totalValue)}</code>`,
            `Perps Value: <code>${formatCurrency(accountTag.perpsValue)}</code>`,
            `Perps Positions: ${accountTag.perpsCount}`,
            `Spot Value: <code>${formatCurrency(accountTag.spotValue)}</code>`,
            `Spot Holdings: ${accountTag.spotCount}`,
            '',
            `Account: #${accountTag.tag}`
        ];

        return {
            msg: lines.join('\n'),
            buttons: {
                inline_keyboard: [
                    [
                        {
                            text: '🔗 View on Hypurrscan',
                            url: `${this.explorer}/address/${encodeURIComponent(candidate.wallet)}`
                        }
                    ]
                ]
            }
        };
    }

    private formatGrowingPositionMessage(currentNotional: number, previousNotional: number): string {
        const lines = [
            `🔥 <b>Growing position</b>`,
            ``,
            `<b>${formatCurrency(currentNotional)}</b>  ⬅  ${formatCurrency(previousNotional)}`
        ];
        return lines.join('\n');
    }

    private getAlertChannels(coin: string, direction: HyperTradeDirection): ChatChannel[] {
        switch (direction) {
            case 'long':
            case 'short': {
                return config.hyperliquid.mainCoins.some((c) => coin.toLowerCase() === c.toLowerCase())
                    ? this.mainPerpChannels
                    : this.otherPerpChannels;
            }
            case 'spot': {
                return config.hyperliquid.mainCoins.some((c) => coin.toLowerCase() === c.toLowerCase().split('/')[0])
                    ? this.mainSpotChannels
                    : this.otherSpotChannels;
            }
        }
    }
}
