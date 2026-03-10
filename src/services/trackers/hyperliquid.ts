import { config } from '../../config';
import { Markup } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/types';
import { Tracker } from '../../common/tracker';
import { escapeHtml, formatCurrency } from '../../common/utils';
import HyperliquidDBService, {
    HyperAggregationRecord,
    HyperTrackedRecord,
    HyperTradeDirection,
    HyperTradeRecord
} from '../db/hyperliquid';
import HyperliquidAPI, { AssetPosition, TraderState } from '../api/hyperliquid';

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

interface AlertContext {
    id: string;
    aggregateTotalNotional?: number;
    aggregateTradeCount?: number;
    aggregationWindowMs?: number;
    positionState: AssetPosition;
    lastTradeTime: number;
    state: TraderState;
}

export default class HyperliquidService extends Tracker {
    private api = new HyperliquidAPI();

    private explorer = config.hyperliquid.explorer;
    private ws: WebSocket | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private coins: string[] = [];
    private reconnecting = false;
    private tradeBatch: HyperTradeRecord[] = [];
    private batchInterval?: NodeJS.Timeout;

    async start(): Promise<void> {
        if (this.monitoring) return;
        this.monitoring = true;
        this.logger.info('Monitoring started');

        const names = await this.api.fetchCoins();
        if (names.length === 0) {
            this.tg.sendMessage(config.telegram.chatID, 'Unable to load trading universes.');
            this.monitoring = false;
            return;
        }

        this.coins = names;
        this.ws = this.connectWebSocket();

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

        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
        }
        if (this.batchInterval) clearInterval(this.batchInterval);
    }

    async track(wallet: string, coin: string, direction: HyperTradeDirection): Promise<string> {
        try {
            const found = await HyperliquidDBService.isWalletTracked(wallet, coin, direction);
            if (found)
                return `Wallet <code>${escapeHtml(wallet)}</code> is already being tracked for ${coin.toUpperCase()} ${direction.toUpperCase()}.`;

            const state = await this.api.fetchTraderStats(wallet);
            if (!state) {
                this.logger.info(`Unable to fetch state for a wallet ${wallet}`);
                return 'Failed to fetch trader state. Please ensure the wallet address is correct.';
            }

            const currentPosition = state.assetPositions?.find((pos) => pos.position?.coin === coin);
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
                            url: `${this.explorer}/${encodeURIComponent(trade.wallet)}`
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
                                url: `${this.explorer}/${encodeURIComponent(deleted.wallet)}`
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
                const href = `${this.explorer}/${encodeURIComponent(tracked.wallet)}`;
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

        const alertNoDataLoop = this.alertNoData(config.monitor.noDataTimeoutMs, async () => {
            this.logger.warn('Forcing WebSocket reconnection due to no data received.');
            this.reconnectWebSocket();
        });

        await Promise.all([scanLoop(), cleanupLoop(), trackLoop(), alertNoDataLoop]);
    }

    private async scanAndAlert(): Promise<void> {
        const candidates = await HyperliquidDBService.getTradesToAlert(
            config.hyperliquid.minSuspiciousNotionalUSD,
            config.hyperliquid.aggregationWindowMs
        );

        this.logger.info(`Found ${candidates.length} candidates needing alert`);
        for (const candidate of candidates) {
            try {
                await this.processAlertCandidate(candidate);
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
        const state = await this.api.fetchTraderStats(tracked.wallet);
        if (!state) {
            this.logger.info(`Unable to fetch state for tracked wallet ${tracked.wallet}`);
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
        const increaseThreshold = tracked.totalNotional * (1 + config.hyperliquid.posChangeAlertPercent / 100);
        const decreaseThreshold = tracked.totalNotional * (1 - config.hyperliquid.posChangeAlertPercent / 100);
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

    private async processAlertCandidate(candidate: HyperAggregationRecord): Promise<void> {
        this.logger.info(
            `Detected high-value trade: ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
        );
        const portfolio = await this.api.fetchPortfolio(candidate.wallet);
        if (!portfolio) return;
        if (!this.api.isFreshWallet(portfolio)) {
            this.logger.info(
                `Skipping alert for high-value trade (not fresh wallet): ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
            );
            await HyperliquidDBService.markTradeAlerted(
                candidate.wallet,
                candidate.coin,
                candidate.dateKey,
                candidate.direction
            );
            return;
        }

        const state = await await this.api.fetchTraderStats(candidate.wallet);
        if (!state) return;
        const positionState = state.assetPositions?.find((pos) => pos.position?.coin === candidate.coin);
        if (!positionState || !positionState.position) {
            this.logger.info(
                `Skipping alert for high-value trade (no position found): ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
            );
            await HyperliquidDBService.markTradeAlerted(
                candidate.wallet,
                candidate.coin,
                candidate.dateKey,
                candidate.direction
            );
            return;
        }
        const direction: HyperTradeDirection = parseFloat(positionState.position.szi) > 0 ? 'long' : 'short';
        if (direction !== candidate.direction) {
            this.logger.info(
                `Skipping alert for high-value trade (direction mismatch): ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
            );
            await HyperliquidDBService.markTradeAlerted(
                candidate.wallet,
                candidate.coin,
                candidate.dateKey,
                candidate.direction
            );
            return;
        }

        this.logger.info(
            `Sending alert for high-value trade: ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
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
            await this.tg.sendMessage(config.telegram.chatID, msg, {
                message_thread_id: config.telegram.hsMainTopicID,
                reply_markup: buttons
            });
        else
            await this.tg.sendMessage(config.telegram.chatID, msg, {
                message_thread_id: config.telegram.hsOtherTopicID,
                reply_markup: buttons
            });

        await HyperliquidDBService.markTradeAlerted(
            candidate.wallet,
            candidate.coin,
            candidate.dateKey,
            candidate.direction
        );
    }

    private reconnectWebSocket(): void {
        if (this.reconnecting) return;
        this.reconnecting = true;

        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
        }

        if (this.monitoring) {
            setTimeout(() => {
                this.reconnecting = false;
                if (this.monitoring) {
                    this.ws = this.connectWebSocket();
                }
            }, 5000);
        } else {
            this.reconnecting = false;
        }
    }

    private connectWebSocket(): WebSocket {
        const ws = new WebSocket(config.hyperliquid.wss);

        ws.onopen = () => {
            this.logger.info(`WebSocket connected, subscribing to ${this.coins.length} coins`);
            for (const coin of this.coins) {
                ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
            }
            this.pingInterval = setInterval(() => {
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
            if (ws.readyState !== WebSocket.OPEN) this.reconnectWebSocket();
        };

        ws.onclose = (event) => {
            const reason = event.reason || 'unknown';
            this.logger.info(`WebSocket closed, reason: ${reason}`);
            this.reconnectWebSocket();
        };

        return ws;
    }

    async getCoinStats(coin: string): Promise<string> {
        try {
            const perpsStats = await this.api.getPerpStats();
            const spotStats = await this.api.getSpotStats();

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
        const { direction, rank, pnl, entryPrice } = this.api.extractPositionDetails(context.positionState.position);

        const accountValue = parseFloat(context.state.marginSummary.accountValue || '0');
        const coinsTraded = context.state.assetPositions ? context.state.assetPositions.length : 0;
        const posTrades = context.aggregateTradeCount ?? 1;
        const directionIcon = direction === 'long' ? '🟢' : '🔴';
        const directionLabel = direction === 'long' ? 'Long' : 'Short';
        const positionSize = context.aggregateTotalNotional ?? 0;

        const lines = [
            `🐋 <b>NEW WHALE ALERT</b> 🐋`,
            '',
            `${directionIcon} <b>Coin:</b> <code>${escapeHtml(coin)}</code> (${directionLabel})`,
            '',
            `<b>Leverage:</b> <code>${rank.toFixed(2)}x</code>`,
            `<b>Entry Price:</b> <code>${escapeHtml(entryPrice)}</code>`,
            `<b>Position Size:</b> <code>${formatCurrency(positionSize)}</code>`,
            `<b>Unrealized PnL:</b> <code>${formatCurrency(pnl)}</code>`,
            `<b>Total Trades:</b> ${posTrades}`,
            '',
            `📈 <b>Trader Profile</b> 📈`,
            `Wallet: <code>${escapeHtml(buyer)}</code>`,
            `Account Value: <code>${formatCurrency(accountValue)}</code>`,
            `Coins Traded: ${coinsTraded}`
        ];
        return {
            msg: lines.join('\n'),
            buttons: {
                inline_keyboard: [
                    [
                        {
                            text: '🔗 View on Hypurrscan',
                            url: `${this.explorer}/${encodeURIComponent(buyer)}`
                        }
                    ],
                    [Markup.button.callback('📌 Track Wallet', `track:${context.id}`, true)]
                ]
            }
        };
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
            } catch (error) {
                this.logger.error(`Error flushing trade batch: ${error}`);
            }
        });
    }

    async handleTrade(trade: WsTrade, coin: string): Promise<void> {
        const notional = parseFloat(trade.px) * parseFloat(trade.sz);
        if (!Number.isFinite(notional)) return;
        const buyer = trade.users[0];
        if (!buyer) return;

        const direction: HyperTradeDirection = trade.side === 'B' ? 'long' : 'short';

        this.tradeBatch.push({
            wallet: buyer,
            coin,
            notional,
            tradeTime: trade.time,
            direction
        });
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
                        url: `${this.explorer}/${encodeURIComponent(wallet)}`
                    }
                ],
                reason !== 'closed' && reason !== 'liquidated'
                    ? [Markup.button.callback('🗑️ Untrack Wallet', `untrack:${id}`, true)]
                    : []
            ]
        };

        try {
            if (config.hyperliquid.mainCoins.includes(coin)) {
                await this.tg.sendMessage(config.telegram.chatID, lines.join('\n'), {
                    message_thread_id: config.telegram.trackTopicID,
                    reply_markup: buttons
                });
            } else {
                await this.tg.sendMessage(config.telegram.chatID, lines.join('\n'), {
                    message_thread_id: config.telegram.trackTopicID,
                    reply_markup: buttons
                });
            }
        } catch (error) {
            this.logger.error(`Failed to send position changed message: ${error}`);
        }
    }
}
