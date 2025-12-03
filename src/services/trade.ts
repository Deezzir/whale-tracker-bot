import axios from 'axios';
import { config } from '../config';
import * as common from '../common';
import DBService, { HyperAggregationRecord, TradeDirection, HyperTrackedRecord, TradeRecord } from './db.js';
import { Markup } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/types';
import { Tracker } from '../common/tracker';
import { Mutex } from '../common/mutex';

export interface WsTrade {
    coin: string;
    side: string;
    px: string;
    sz: string;
    hash: string;
    time: number;
    tid: number;
    users: [string, string];
}

type PortfolioHistoryPoint = [number, string];

interface PerpsMeta {
    universe: {
        name: string;
        szDecimals: number;
        maxLeverage: number;
        onlyIsolated?: boolean;
    }[];
    assetMeta: {
        dayNtlVlm: string;
        funding: string;
        impactPxs: number[];
        markPx: string;
        midPx: string;
        openInterest: string;
        oraclePx: string;
        premium: string;
        prevDayPx: string;
    }[];
}

interface SpotMeta {
    tokens: { name: string; szDecimals: number; weiDecimals: number; index: number }[];
    universe: { name: string; tokens: number[]; index: number; isCanonical: boolean }[];
    assetMeta: {
        dayNtlVlm: string;
        markPx: string;
        midPx: string;
        prevDayPx: string;
    }[];
}

interface LeverageInfo {
    type?: string;
    value?: number;
}

interface Position {
    coin: string;
    entryPx?: string;
    unrealizedPnl?: string;
    leverage?: LeverageInfo;
    szi: string;
}

interface AssetPosition {
    position?: Position;
    type?: string;
}

interface MarginSummary {
    accountValue?: string;
}

interface TraderState {
    assetPositions?: AssetPosition[];
    marginSummary?: MarginSummary;
}

interface PortfolioStats {
    accountValueHistory?: PortfolioHistoryPoint[];
    pnlHistory?: PortfolioHistoryPoint[];
    vlm?: string;
}

type PortfolioResponse = Array<[string, PortfolioStats]>;

interface AlertContext {
    id: string;
    aggregateTotalNotional?: number;
    aggregateTradeCount?: number;
    aggregationWindowMs?: number;
    positionState: AssetPosition;
    lastTradeTime: number;
    state: TraderState;
}

export default class TradeService extends Tracker {
    private perpStatsKey = 'trade:perpStats';
    private spotStatsKey = 'trade:spotStats';
    private portfolioCacheKey = 'trade:portfolioCache';
    private clearinghouseCacheKey = 'trade:clearinghouseCache';
    private wss = new Map<string, WebSocket>();
    private pingIntervals = new Map<string, NodeJS.Timeout>();
    private tradeBatch: TradeRecord[] = [];
    private batchInterval?: NodeJS.Timeout;
    private flushMutex = new Mutex();

    async start(): Promise<void> {
        if (this.monitoring) return;
        this.monitoring = true;
        common.logInfo('TradeService monitoring started');

        const names = await this.fetchCoins();
        if (names.length === 0) {
            this.bot.telegram.sendMessage(config.telegram.targetGroupID, 'Unable to load trading universes.');
            this.monitoring = false;
            return;
        }

        for (const name of names) {
            const ws = this.subscribeToCoinTrades(name);
            this.wss.set(name, ws);
            await common.sleep(50);
        }

        this.batchInterval = setInterval(() => {
            this.flushTradeBatch().catch((error) =>
                common.logError(`TradeService.batchInterval: error flushing trade batch: ${error}`)
            );
        }, config.hyperliquid.tradeBatchFlushIntervalMs);

        this.monitorTask = this.mainLoop();
    }

    async stop(): Promise<void> {
        if (!this.monitoring) return;
        this.monitoring = false;
        await this.monitorTask?.catch((error) =>
            common.logError(`TradeService.stop: error while awaiting monitor task: ${error}`)
        );
        this.monitorTask = undefined;
        common.logInfo('TradeService monitoring stopped');

        for (const interval of this.pingIntervals.values()) clearInterval(interval);
        this.pingIntervals.clear();
        for (const ws of this.wss.values()) ws.close();
        this.wss.clear();
        if (this.batchInterval) clearInterval(this.batchInterval);
    }

    async track(wallet: string, coin: string, direction: TradeDirection): Promise<string> {
        try {
            const found = await DBService.isWalletTracked(wallet, coin, direction);
            if (found)
                return `Wallet <code>${this.escapeHtml(wallet)}</code> is already being tracked for ${coin.toUpperCase()} ${direction.toUpperCase()}.`;

            const state = await this.fetchTraderStats(wallet);
            if (!state) {
                common.logInfo(`Unable to fetch state for a wallet ${wallet}`);
                return 'Failed to fetch trader state. Please ensure the wallet address is correct.';
            }

            const currentPosition = state.assetPositions?.find((pos) => pos.position?.coin === coin);
            if (!currentPosition || !currentPosition.position)
                return `No open position found for wallet <code>${this.escapeHtml(wallet)}</code> on coin <code>$${coin.toUpperCase()}</code>.`;

            const currentSzi = parseFloat(currentPosition.position.szi || '0');
            const currentDirection: TradeDirection = currentSzi > 0 ? 'long' : 'short';
            if (currentDirection !== direction)
                return (
                    `The current position direction for wallet <code>${this.escapeHtml(wallet)}</code> on coin <code>$${coin.toUpperCase()}</code> is <b>${currentDirection.toUpperCase()}</b>` +
                    `which does not match the requested tracking direction <b>${direction.toUpperCase()}</b>.`
                );
            const currentNotional = Math.abs(currentSzi) * parseFloat(currentPosition.position.entryPx || '0');

            await DBService.addUpdateTrackedWallet(wallet, coin, direction, currentNotional);
            return `Added wallet <code>${this.escapeHtml(wallet)}</code> for tracking (${coin.toUpperCase()} ${direction.toUpperCase()}).`;
        } catch (error) {
            common.logError(`TradeService.track error: ${error}`);
            return 'An error occurred while adding the tracked wallet. Please try again later.';
        }
    }

    async trackById(id: string): Promise<{ msg: string; buttons: InlineKeyboardMarkup | null }> {
        try {
            const trade = await DBService.getTradeById(id);
            if (!trade) return { msg: 'Trade not found.', buttons: null };
            const updated_buttons: InlineKeyboardMarkup = {
                inline_keyboard: [
                    [
                        {
                            text: '🔗 View on Hypurrscan',
                            url: `https://hypurrscan.io/address/${encodeURIComponent(trade.wallet)}`
                        }
                    ]
                ]
            };

            const found = await DBService.isWalletTracked(trade.wallet, trade.coin, trade.direction);
            if (found)
                return {
                    msg: `Wallet <code>${this.escapeHtml(trade.wallet)}</code> is already being tracked for ${trade.coin.toUpperCase()} ${trade.direction.toUpperCase()}.`,
                    buttons: updated_buttons
                };
            await DBService.addUpdateTrackedWallet(trade.wallet, trade.coin, trade.direction, trade.totalNotional);
            return {
                msg: `Added wallet <code>${this.escapeHtml(trade.wallet)}</code> for tracking (${trade.coin.toUpperCase()} ${trade.direction.toUpperCase()}).`,
                buttons: updated_buttons
            };
        } catch (error) {
            common.logError(`TradeService.track error: ${error}`);
            return { msg: 'An error occurred while adding the tracked wallet. Please try again later.', buttons: null };
        }
    }

    async untrack(wallet: string, coin: string, direction: TradeDirection): Promise<string> {
        try {
            const deleted = await DBService.removeTrackedWallet(wallet, coin, direction);
            if (deleted) return `Removed wallet <code>${this.escapeHtml(deleted.wallet)}</code> from tracking.`;
            else return `Wallet <code>${this.escapeHtml(wallet)}</code> with such order was not found in tracked list.`;
        } catch (error) {
            common.logError(`TradeService.untrack error: ${error}`);
            return 'An error occurred while removing the tracked wallet. Please try again later.';
        }
    }

    async untrackById(id: string): Promise<{ msg: string; buttons: InlineKeyboardMarkup | null }> {
        try {
            const deleted = await DBService.removeTrackedWalletById(id);
            if (deleted) {
                const updated_buttons: InlineKeyboardMarkup = {
                    inline_keyboard: [
                        [
                            {
                                text: '🔗 View on Hypurrscan',
                                url: `https://hypurrscan.io/address/${encodeURIComponent(deleted.wallet)}`
                            }
                        ]
                    ]
                };
                return {
                    msg: `Removed wallet <code>${this.escapeHtml(deleted.wallet)}</code> from tracking.`,
                    buttons: updated_buttons
                };
            }
            return { msg: `Wallet with such order was not found in tracked list.`, buttons: null };
        } catch (error) {
            common.logError(`TradeService.untrack error: ${error}`);
            return {
                msg: 'An error occurred while removing the tracked wallet. Please try again later.',
                buttons: null
            };
        }
    }

    async listTracked(): Promise<string> {
        try {
            const trackedWallets = await DBService.getTrackedWallets();
            if (trackedWallets.length === 0) {
                return 'No wallets are currently being tracked.';
            }
            const lines = ['📋 <b>Tracked Wallets:</b>', ''];
            for (const tracked of trackedWallets) {
                const compressedWallet = `${tracked.wallet.slice(0, 6)}...${tracked.wallet.slice(-4)}`;
                const directionIcon = tracked.direction === 'long' ? '🟢' : '🔴';
                const href = `https://hypurrscan.io/address/${encodeURIComponent(tracked.wallet)}`;
                lines.push(`<b>Wallet</b> <a href="${href}">${this.escapeHtml(compressedWallet)}</a>`);
                lines.push(`<b>Coin:</b> ${directionIcon} <code>${tracked.coin.toUpperCase()}</code>`);
                lines.push(`<b>Size:</b> <code>$${tracked.totalNotional.toLocaleString()}</code>`);
                lines.push('');
            }
            return lines.join('\n');
        } catch (error) {
            common.logError(`TradeService.listTracked error: ${error}`);
            return 'An error occurred while listing tracked wallets. Please try again later.';
        }
    }

    private async mainLoop(): Promise<void> {
        const scanLoop = async () => {
            while (this.monitoring) {
                try {
                    await this.scanAndAlert();
                } catch (error) {
                    common.logError(`TradeService.mainLoop alerting: ${error}`);
                }
                if (!this.monitoring) break;
                await this.cancellableSleep(config.monitor.intervalMs);
            }
        };

        const cleanupLoop = async () => {
            while (this.monitoring) {
                try {
                    await DBService.cleanTrades(config.hyperliquid.cleanupTTLms);
                } catch (error) {
                    common.logError(`TradeService.mainLoop cleanup: ${error}`);
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
                    common.logError(`TradeService.mainLoop cleanup: ${error}`);
                }
                if (!this.monitoring) break;
                await this.cancellableSleep(config.hyperliquid.trackCheckIntervalMs);
            }
        };

        await Promise.all([scanLoop(), cleanupLoop(), trackLoop()]);
    }

    private async scanAndAlert(): Promise<void> {
        const candidates = await DBService.getTradesToAlert(
            config.hyperliquid.minSuspiciousNotionalUSD,
            config.hyperliquid.aggregationWindowMs
        );

        common.logInfo(`TradeService.scanAndAlert: Found ${candidates.length} candidates needing alert`);
        for (const candidate of candidates) {
            try {
                await this.processAlertCandidate(candidate);
            } catch (error) {
                common.logError(
                    `TradeService.scanAndAlert: Failed to alert wallet ${candidate.wallet} / ${candidate.coin} / ${candidate.direction}: ${error}`
                );
            }
        }
    }

    private async trackAndAlert(): Promise<void> {
        const trackedWallets = await DBService.getExpiredTrackedWallets();
        common.logInfo(`TradeService.trackAndAlert: Found ${trackedWallets.length} tracked wallets to check`);

        for (const tracked of trackedWallets) {
            try {
                await this.processTrackedWallet(tracked);
            } catch (error) {
                common.logError(
                    `TradeService.trackAndAlert: Failed to check tracked wallet ${tracked.wallet} / ${tracked.coin} / ${tracked.direction}: ${error}`
                );
            }
        }
    }

    private async processTrackedWallet(tracked: HyperTrackedRecord): Promise<void> {
        const state = await this.fetchTraderStats(tracked.wallet);
        if (!state) {
            common.logInfo(`Unable to fetch state for tracked wallet ${tracked.wallet}`);
            return;
        }

        const currentPosition = state.assetPositions?.find((pos) => pos.position?.coin === tracked.coin);

        if (!currentPosition || !currentPosition.position) {
            await this.sendPositionChangedMessage(
                tracked.id,
                tracked.wallet,
                tracked.coin,
                tracked.direction,
                'closed'
            );
            await DBService.removeTrackedWalletById(tracked.id);
            return;
        }

        const currentSzi = parseFloat(currentPosition.position.szi || '0');
        const currentDirection: TradeDirection = currentSzi > 0 ? 'long' : 'short';

        if (currentDirection !== tracked.direction) {
            await this.sendPositionChangedMessage(
                tracked.id,
                tracked.wallet,
                tracked.coin,
                tracked.direction,
                'direction'
            );
            await DBService.removeTrackedWalletById(tracked.id);
            return;
        }

        const currentNotional = Math.abs(currentSzi) * parseFloat(currentPosition.position.entryPx || '0');
        const increaseThreshold = tracked.totalNotional * (1 + config.hyperliquid.posChangeAlertPercent / 100);
        const decreaseThreshold = tracked.totalNotional * (1 - config.hyperliquid.posChangeAlertPercent / 100);
        if (currentNotional > increaseThreshold || currentNotional < decreaseThreshold) {
            await this.sendPositionChangedMessage(tracked.id, tracked.wallet, tracked.coin, tracked.direction, 'size', {
                previousNotional: tracked.totalNotional,
                currentNotional,
                currentPosition
            });
            await DBService.addUpdateTrackedWallet(
                tracked.wallet,
                tracked.coin,
                tracked.direction,
                currentNotional,
                config.hyperliquid.trackCheckIntervalMs
            );
        } else {
            await DBService.addUpdateTrackedWallet(
                tracked.wallet,
                tracked.coin,
                tracked.direction,
                tracked.totalNotional,
                config.hyperliquid.trackCheckIntervalMs
            );
        }
    }

    private async processAlertCandidate(candidate: HyperAggregationRecord): Promise<void> {
        common.logInfo(
            `TradeService: Detected high-value trade: ${candidate.wallet} ${candidate.coin} ${common.formatCurrency(candidate.totalNotional)} (${candidate.direction})`
        );
        const portfolio = await this.fetchPortfolio(candidate.wallet);
        if (!portfolio) return;
        if (!this.isFreshWallet(portfolio)) {
            common.logInfo(
                `TradeService: Skipping alert for high-value trade (not fresh wallet): ${candidate.wallet} ${candidate.coin} ${common.formatCurrency(candidate.totalNotional)} (${candidate.direction})`
            );
            await DBService.markTradeAlerted(candidate.wallet, candidate.coin, candidate.dateKey, candidate.direction);
            return;
        }

        const state = await this.fetchTraderStats(candidate.wallet);
        if (!state) return;
        const positionState = state.assetPositions?.find((pos) => pos.position?.coin === candidate.coin);
        if (!positionState || !positionState.position) {
            common.logInfo(
                `TradeService: Skipping alert for high-value trade (no position found): ${candidate.wallet} ${candidate.coin} ${common.formatCurrency(candidate.totalNotional)} (${candidate.direction})`
            );
            await DBService.markTradeAlerted(candidate.wallet, candidate.coin, candidate.dateKey, candidate.direction);
            return;
        }
        const direction: TradeDirection = parseFloat(positionState.position.szi) > 0 ? 'long' : 'short';
        if (direction !== candidate.direction) {
            common.logInfo(
                `TradeService: Skipping alert for high-value trade (direction mismatch): ${candidate.wallet} ${candidate.coin} ${common.formatCurrency(candidate.totalNotional)} (${candidate.direction})`
            );
            await DBService.markTradeAlerted(candidate.wallet, candidate.coin, candidate.dateKey, candidate.direction);
            return;
        }

        common.logInfo(
            `TradeService: Sending alert for high-value trade: ${candidate.wallet} ${candidate.coin} ${common.formatCurrency(candidate.totalNotional)} (${candidate.direction})`
        );
        const alertContext: AlertContext = {
            id: candidate.id,
            aggregateTotalNotional: candidate.totalNotional,
            aggregateTradeCount: candidate.tradeCount,
            aggregationWindowMs: config.hyperliquid.aggregationWindowMs,
            positionState: positionState,
            lastTradeTime: candidate.lastTradeTime,
            state: state
        };

        const result = this.formatAlertMessage(candidate.coin, candidate.wallet, alertContext);
        if (!result) return;
        const { msg, buttons } = result;
        if (config.hyperliquid.mainCoins.includes(candidate.coin))
            await this.bot.telegram.sendMessage(config.telegram.targetGroupID, msg, {
                parse_mode: 'HTML',
                message_thread_id: config.telegram.targetMainTopicID,
                reply_markup: buttons
            });
        else
            await this.bot.telegram.sendMessage(config.telegram.targetGroupID, msg, {
                parse_mode: 'HTML',
                message_thread_id: config.telegram.targetOtherTopicID,
                reply_markup: buttons
            });

        await DBService.markTradeAlerted(candidate.wallet, candidate.coin, candidate.dateKey, candidate.direction);
    }

    private reconnectWebSocket(name: string): void {
        const interval = this.pingIntervals.get(name);
        if (interval) {
            clearInterval(interval);
            this.pingIntervals.delete(name);
        }
        this.wss.delete(name);
        if (this.monitoring) {
            setTimeout(() => {
                if (this.monitoring) {
                    const newWs = this.subscribeToCoinTrades(name);
                    this.wss.set(name, newWs);
                }
            }, 5000);
        }
    }

    private subscribeToCoinTrades(name: string): WebSocket {
        const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
        const payload = {
            method: 'subscribe',
            subscription: {
                type: 'trades',
                coin: name
            }
        };

        ws.onopen = () => {
            common.logInfo(`WebSocket connected for coin: ${name}`);
            ws.send(JSON.stringify(payload));
            const pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'ping' }));
            }, 30000);
            this.pingIntervals.set(name, pingInterval);
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
                    void this.handleTrade(trade, name).catch((error) =>
                        common.logError(`Failed to handle trade in coin ${name}: ${error}`)
                    );
                }
            }
        };

        ws.onerror = (error) => {
            common.logError(`WebSocket error in coin ${name}: ${error}`);
            if (ws.readyState !== WebSocket.OPEN) this.reconnectWebSocket(name);
        };

        ws.onclose = (event) => {
            const reason = event.reason || 'unknown';
            common.logInfo(`WebSocket closed for coin ${name}, reason: ${reason}`);
            this.reconnectWebSocket(name);
        };

        return ws;
    }

    private async getPerpStats(): Promise<PerpsMeta | null> {
        const cachedPerps = await this.redis.get(this.perpStatsKey);
        if (cachedPerps) return JSON.parse(cachedPerps);

        try {
            const operation = () =>
                axios.post(
                    'https://api.hyperliquid.xyz/info',
                    { type: 'metaAndAssetCtxs' },
                    { headers: { 'Content-Type': 'application/json' } }
                );
            const response = await common.retryWithBackoff(operation);
            const data = response.data;

            const meta: PerpsMeta = {
                universe: data[0].universe,
                assetMeta: data[1]
            };
            await this.redis.setEx(this.perpStatsKey, config.monitor.cacheTtlMs / 1000, JSON.stringify(meta));
            return meta;
        } catch (error) {
            common.logError(`Failed to fetch perp stats: ${error}`);
            return null;
        }
    }

    private async getSpotStats(): Promise<SpotMeta | null> {
        const cachedSpot = await this.redis.get(this.spotStatsKey);
        if (cachedSpot) return JSON.parse(cachedSpot);

        try {
            const operation = () =>
                axios.post(
                    'https://api.hyperliquid.xyz/info',
                    { type: 'spotMetaAndAssetCtxs' },
                    { headers: { 'Content-Type': 'application/json' } }
                );
            const response = await common.retryWithBackoff(operation);
            const data = response.data;

            const meta: SpotMeta = {
                tokens: data[0].tokens,
                universe: data[0].universe,
                assetMeta: data[1]
            };
            await this.redis.setEx(this.spotStatsKey, config.monitor.cacheTtlMs / 1000, JSON.stringify(meta));
            return meta;
        } catch (error) {
            common.logError(`Failed to fetch spot stats: ${error}`);
            return null;
        }
    }

    async getCoinStats(coin: string): Promise<string> {
        try {
            const perpsStats = await this.getPerpStats();
            const spotStats = await this.getSpotStats();

            if (!perpsStats || !spotStats) {
                return 'Failed to fetch market statistics. Please try again later.';
            }

            const lines: string[] = [`📊 <b>Market Stats:</b> <code>$${this.escapeHtml(coin)}</code>`, ''];

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
                    lines.push(`24h Volume: <code>${common.formatCurrency(parseFloat(perpCtx.dayNtlVlm))}</code>`);
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
                    lines.push(`<b>Base Token:</b> <code>${this.escapeHtml(baseToken.name)}</code>`);
                }
                if (quoteToken) {
                    lines.push(`<b>Quote Token:</b> <code>${this.escapeHtml(quoteToken.name)}</code>`);
                }
                lines.push(`<b>Canonical:</b> <code>${spotPair.isCanonical ? 'Yes' : 'No'}</code>`);

                if (spotCtx) {
                    lines.push('');
                    lines.push(`Mark Price: <code>$${spotCtx.markPx}</code>`);
                    lines.push(`Mid Price: <code>$${spotCtx.midPx}</code>`);
                    lines.push('');
                    lines.push(`24h Volume: <code>${common.formatCurrency(parseFloat(spotCtx.dayNtlVlm))}</code>`);

                    const priceChange =
                        ((parseFloat(spotCtx.markPx) - parseFloat(spotCtx.prevDayPx)) / parseFloat(spotCtx.prevDayPx)) *
                        100;
                    const changeIcon = priceChange >= 0 ? '📈' : '📉';
                    lines.push(`<b>24h Change:</b> <code>${priceChange.toFixed(2)}%</code> ${changeIcon}`);
                }
            }

            return lines.join('\n');
        } catch (error) {
            common.logError(`getCoinStats error: ${error}`);
            return 'An error occurred while fetching coin stats. Please try again later.';
        }
    }

    private async fetchPortfolio(user: string): Promise<PortfolioResponse | null> {
        const cached = await this.redis.get(`${this.portfolioCacheKey}:${user}`);
        if (cached) return JSON.parse(cached);

        try {
            const operation = () =>
                axios.post(
                    'https://api.hyperliquid.xyz/info',
                    { type: 'portfolio', user },
                    { headers: { 'Content-Type': 'application/json' } }
                );
            const response = await common.retryWithBackoff(operation);
            const data = response.data as PortfolioResponse;
            await this.redis.setEx(
                `${this.portfolioCacheKey}:${user}`,
                config.monitor.cacheTtlMs / 1000,
                JSON.stringify(data)
            );
            return data;
        } catch (error) {
            common.logError(`Failed to fetch portfolio for ${user}: ${error}`);
            return null;
        }
    }

    private async fetchTraderStats(user: string): Promise<TraderState | null> {
        const cached = await this.redis.get(`${this.clearinghouseCacheKey}:${user}`);
        if (cached) return JSON.parse(cached);

        try {
            const response = await axios.post(
                'https://api.hyperliquid.xyz/info',
                { type: 'clearinghouseState', user },
                { headers: { 'Content-Type': 'application/json' } }
            );
            const data = response.data as TraderState;
            await this.redis.setEx(
                `${this.clearinghouseCacheKey}:${user}`,
                config.monitor.cacheTtlMs / 1000,
                JSON.stringify(data)
            );
            return data;
        } catch (error) {
            common.logError(`Failed to fetch clearinghouse state for ${user}: ${error}`);
            return null;
        }
    }

    private extractPositionDetails(pos: Position): {
        direction: TradeDirection;
        rank: number;
        pnl: number;
        entryPrice: string;
    } {
        const szi: number = parseFloat(pos.szi || '0');
        const direction: TradeDirection = szi > 0 ? 'long' : 'short';
        const rank: number = pos.leverage?.value ? parseFloat(pos.leverage.value.toString()) : 1;
        const pnl: number = pos.unrealizedPnl ? parseFloat(pos.unrealizedPnl) : 0;
        const entryPrice: string = pos.entryPx || 'N/A';
        return { direction, rank, pnl, entryPrice };
    }

    private formatAlertMessage(
        coin: string,
        buyer: string,
        context: AlertContext
    ): {
        msg: string;
        buttons: InlineKeyboardMarkup;
    } | null {
        if (
            !context.positionState.position ||
            !context.state.marginSummary ||
            !context.state.marginSummary.accountValue
        )
            return null;
        const { direction, rank, pnl, entryPrice } = this.extractPositionDetails(context.positionState.position);

        const accountValue = parseFloat(context.state.marginSummary.accountValue || '0');
        const coinsTraded = context.state.assetPositions ? context.state.assetPositions.length : 0;
        const posTrades = context.aggregateTradeCount ?? 1;
        const directionIcon = direction === 'long' ? '🟢' : '🔴';
        const directionLabel = direction === 'long' ? 'Long' : 'Short';
        const positionSize = context.aggregateTotalNotional ?? 0;

        const lines = [
            `🐋 <b>NEW WHALE ALERT</b> 🐋`,
            '',
            `${directionIcon} <b>Coin:</b> <code>${this.escapeHtml(coin)}</code> (${directionLabel})`,
            '',
            `<b>Leverage:</b> <code>${rank.toFixed(2)}x</code>`,
            `<b>Entry Price:</b> <code>${this.escapeHtml(entryPrice)}</code>`,
            `<b>Position Size:</b> <code>${common.formatCurrency(positionSize)}</code>`,
            `<b>Unrealized PnL:</b> <code>${common.formatCurrency(pnl)}</code>`,
            `<b>Total Trades:</b> ${posTrades}`,
            '',
            `📈 <b>Trader Profile</b> 📈`,
            `Wallet: <code>${this.escapeHtml(buyer)}</code>`,
            `Account Value: <code>${common.formatCurrency(accountValue)}</code>`,
            `Coins Traded: ${coinsTraded}`
        ];
        return {
            msg: lines.join('\n'),
            buttons: {
                inline_keyboard: [
                    [
                        {
                            text: '🔗 View on Hypurrscan',
                            url: `https://hypurrscan.io/address/${encodeURIComponent(buyer)}`
                        }
                    ],
                    [Markup.button.callback('📌 Track Wallet', `track:${context.id}`, true)]
                ]
            }
        };
    }

    private escapeHtml(input: string): string {
        return input
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private isFreshWallet(portfolio: PortfolioResponse): boolean {
        const buckets = portfolio.filter(([label]) => label === 'perpAllTime' || label === 'allTime');
        if (buckets.length === 0) {
            return true;
        }

        const now = Date.now();
        const bucketIsFresh = (stats?: PortfolioStats): boolean => {
            if (!stats) {
                return true;
            }
            const history = stats.accountValueHistory ?? [];
            if (history.length === 0 || history.length <= 2) {
                return true;
            }
            const firstTimestamp = history[0][0];
            return now - firstTimestamp <= config.hyperliquid.freshWindowMs;
        };

        return buckets.some(([, stats]) => bucketIsFresh(stats));
    }

    async flushTradeBatch(): Promise<void> {
        await this.flushMutex.runExclusive(async () => {
            if (this.tradeBatch.length === 0) return;
            const batchToFlush = [...this.tradeBatch];
            this.tradeBatch = [];

            try {
                common.logInfo(`TradeService.flushTradeBatch: Flushing trade batch of size ${batchToFlush.length}`);
                await DBService.addTradesBulk(batchToFlush, config.hyperliquid.aggregationWindowMs);
            } catch (error) {
                common.logError(`TradeService.flushTradeBatch: Error flushing trade batch: ${error}`);
            }
        });
    }
    async handleTrade(trade: WsTrade, coin: string): Promise<void> {
        const notional = parseFloat(trade.px) * parseFloat(trade.sz);
        if (!Number.isFinite(notional)) return;
        const buyer = trade.users[0];
        if (!buyer) return;

        const direction: TradeDirection = trade.side === 'B' ? 'long' : 'short';

        this.tradeBatch.push({
            wallet: buyer,
            coin,
            notional,
            tradeTime: trade.time,
            direction
        });
        if (this.tradeBatch.length >= config.hyperliquid.tradeBatchSize) await this.flushTradeBatch();
    }

    private async fetchCoins(): Promise<string[]> {
        const response = await axios.post(
            'https://api.hyperliquid.xyz/info',
            { type: 'meta' },
            { headers: { 'Content-Type': 'application/json' } }
        );
        return response.data.universe.map((u: { name: string }) => u.name);
    }

    private async sendPositionChangedMessage(
        id: string,
        wallet: string,
        coin: string,
        direction: TradeDirection,
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
                    `${directionIcon} <b>Coin:</b> <code>${this.escapeHtml(coin)}</code> (${directionLabel})`,
                    '',
                    `Wallet: <code>${this.escapeHtml(wallet)}</code>`
                );
                break;

            case 'liquidated':
                reasonIcon = '⚠️';
                reasonLabel = 'Position Liquidated';
                lines.push(
                    `${reasonIcon} <b>${reasonLabel}</b>`,
                    '',
                    `${directionIcon} <b>Coin:</b> <code>${this.escapeHtml(coin)}</code> (${directionLabel})`,
                    '',
                    `Wallet: <code>${this.escapeHtml(wallet)}</code>`
                );
                break;

            case 'direction':
                reasonIcon = '🔄';
                reasonLabel = 'Position Direction Changed';
                lines.push(
                    `${reasonIcon} <b>${reasonLabel}</b>`,
                    '',
                    `${directionIcon} <b>Coin:</b> <code>${this.escapeHtml(coin)}</code> (${directionLabel})`,
                    '',
                    `Wallet: <code>${this.escapeHtml(wallet)}</code>`
                );
                break;

            case 'size':
                if (!extra?.currentPosition?.position || !extra.previousNotional || !extra.currentNotional) {
                    common.logError('sendPositionChangedMessage: Missing required data for increased position');
                    return;
                }

                const { rank, pnl, entryPrice } = this.extractPositionDetails(extra.currentPosition.position);
                const changePercent = (extra.currentNotional / extra.previousNotional) * 100 - 100;

                reasonIcon = '📈';
                reasonLabel = 'Position Size Changed';
                lines.push(
                    `${reasonIcon} <b>${reasonLabel}</b>`,
                    '',
                    `${directionIcon} <b>Coin:</b> <code>${this.escapeHtml(coin)}</code> (${directionLabel})`,
                    '',
                    `<b>Previous Size:</b> <code>${common.formatCurrency(extra.previousNotional)}</code>`,
                    `<b>Current Size:</b> <code>${common.formatCurrency(extra.currentNotional)}</code>`,
                    `<b>Change:</b> <code>${changePercent.toFixed(2)}%</code>`,
                    '',
                    `<b>Leverage:</b> <code>${rank.toFixed(2)}x</code>`,
                    `<b>Entry Price:</b> <code>${this.escapeHtml(entryPrice)}</code>`,
                    `<b>Unrealized PnL:</b> <code>${common.formatCurrency(pnl)}</code>`,
                    '',
                    `Wallet: <code>${this.escapeHtml(wallet)}</code>`
                );
                break;
        }

        const buttons: InlineKeyboardMarkup = {
            inline_keyboard: [
                [
                    {
                        text: '🔗 View on Hypurrscan',
                        url: `https://hypurrscan.io/address/${encodeURIComponent(wallet)}`
                    }
                ],
                reason !== 'closed' && reason !== 'liquidated'
                    ? [Markup.button.callback('🗑️ Untrack Wallet', `untrack:${id}`, true)]
                    : []
            ]
        };

        try {
            if (config.hyperliquid.mainCoins.includes(coin)) {
                await this.bot.telegram.sendMessage(config.telegram.targetGroupID, lines.join('\n'), {
                    parse_mode: 'HTML',
                    message_thread_id: config.telegram.targetTrackTopicID,
                    reply_markup: buttons
                });
            } else {
                await this.bot.telegram.sendMessage(config.telegram.targetGroupID, lines.join('\n'), {
                    parse_mode: 'HTML',
                    message_thread_id: config.telegram.targetTrackTopicID,
                    reply_markup: buttons
                });
            }
        } catch (error) {
            common.logError(`Failed to send position changed message: ${error}`);
        }
    }
}
