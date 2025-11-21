import axios from 'axios';
import { config } from '../config';
import * as common from '../common';
import DBService, { AggregationRecord, TradeDirection } from './db.js';
import { Telegraf } from 'telegraf';
import { getRedisClient } from './redis';

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
    aggregateTotalNotional?: number;
    aggregateTradeCount?: number;
    aggregationWindowMs?: number;
    positionState: AssetPosition;
    lastTradeTime: number;
    state: TraderState;
}

export default class TradeService {
    private bot: Telegraf;
    private redis = getRedisClient();
    private portfolioCacheKey = 'trade:portfolioCache';
    private clearinghouseCacheKey = 'trade:clearinghouseCache';
    private monitoring = false;
    private monitorTask?: Promise<void>;
    private wss = new Map<string, WebSocket>();
    private pingIntervals = new Map<string, NodeJS.Timeout>();

    constructor(bot: Telegraf) {
        this.bot = bot;
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

    private formatCurrency(value: number): string {
        const abs = Math.abs(value).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
        const prefix = value < 0 ? '-' : '';
        return `${prefix}$${abs}`;
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

    private formatAlertMessage(coin: string, buyer: string, context: AlertContext): string | null {
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
            `<b>Position Size:</b> <code>${this.formatCurrency(positionSize)}</code>`,
            `<b>Unrealized PnL:</b> <code>${this.formatCurrency(pnl)}</code>`,
            `<b>Total Trades:</b> ${posTrades}`,
            '',
            `<b>Trader Profile</b>`,
            `Address: <code>${this.escapeHtml(buyer)}</code>`,
            `Account Value: <code>${this.formatCurrency(accountValue)}</code>`,
            `Coins Traded: ${coinsTraded}`,
            '',
            `<a href="https://hypurrscan.io/address/${encodeURIComponent(buyer)}">View on Hypurrscan</a>`
        ];
        return lines.join('\n');
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
            return now - firstTimestamp <= config.monitor.freshWindowMs;
        };

        return buckets.some(([, stats]) => bucketIsFresh(stats));
    }

    async handleTrade(trade: WsTrade, coin: string): Promise<void> {
        const notional = parseFloat(trade.px) * parseFloat(trade.sz);
        if (!Number.isFinite(notional)) {
            return;
        }
        const buyer = trade.users[0];
        if (!buyer) {
            return;
        }

        const direction: TradeDirection = trade.side === 'B' ? 'long' : 'short';
        await DBService.recordTrade(
            buyer,
            coin,
            notional,
            trade.time,
            direction,
            config.monitoring.aggregationWindowMs
        );
    }

    private async fetchCoins(): Promise<string[]> {
        const response = await axios.post(
            'https://api.hyperliquid.xyz/info',
            { type: 'meta' },
            { headers: { 'Content-Type': 'application/json' } }
        );
        return response.data.universe.map((u: { name: string }) => u.name);
    }

    isActive(): boolean {
        return this.monitoring;
    }

    async startMonitoring(): Promise<void> {
        if (this.monitoring) {
            return;
        }
        this.monitoring = true;
        common.logInfo('TradeService monitoring started');

        const names = await this.fetchCoins();
        if (names.length === 0) {
            this.bot.telegram.sendMessage(config.telegram.targetGroupID, 'Unable to load trading universes.');
            return;
        }

        for (const name of names) {
            const ws = this.subscribeToCoinTrades(name);
            this.wss.set(name, ws);
            await common.sleep(50);
        }

        this.monitorTask = this.monitorLoop();
    }

    async stopMonitoring(): Promise<void> {
        if (!this.monitoring) {
            return;
        }
        this.monitoring = false;
        await this.monitorTask?.catch((error) =>
            common.logError(`TradeService.stopMonitoring: error while awaiting monitor task: ${error}`)
        );
        this.monitorTask = undefined;
        common.logInfo('TradeService monitoring stopped');

        for (const interval of this.pingIntervals.values()) clearInterval(interval);
        this.pingIntervals.clear();
        for (const ws of this.wss.values()) ws.close();
        this.wss.clear();
    }

    private async monitorLoop(): Promise<void> {
        while (this.monitoring) {
            try {
                await this.scanAndAlert();
            } catch (error) {
                common.logError(`TradeService.monitorLoop: ${error}`);
            }
            if (!this.monitoring) {
                break;
            }
            await common.sleep(config.monitor.intervalMs);
        }
    }

    private async scanAndAlert(): Promise<void> {
        const candidates = await DBService.findAggregationsNeedingAlert(
            config.monitoring.minSuspiciousNotionalUSD,
            config.monitoring.aggregationWindowMs
        );

        common.logInfo(`TradeService.scanAndAlert: Found ${candidates.length} candidates needing alert`);
        for (const candidate of candidates) {
            try {
                await this.processAggregateCandidate(candidate);
            } catch (error) {
                common.logError(
                    `TradeService.scanAndAlert: Failed to alert wallet ${candidate.wallet} / ${candidate.coin} / ${candidate.direction}: ${error}`
                );
            }
        }
    }

    private async processAggregateCandidate(candidate: AggregationRecord): Promise<void> {
        const portfolio = await this.fetchPortfolio(candidate.wallet);
        if (!portfolio) return;
        if (!this.isFreshWallet(portfolio)) {
            common.logInfo(`Skipping alert for wallet ${candidate.wallet} as it is not fresh`);
            await DBService.markAlerted(candidate.wallet, candidate.coin, candidate.dateKey, candidate.direction);
            return;
        }

        common.logInfo(
            `Alerting on wallet ${candidate.wallet} for coin ${candidate.coin} with notional ${candidate.totalNotional}`
        );
        const state = await this.fetchTraderStats(candidate.wallet);
        if (!state) return;
        const positionState = state.assetPositions?.find((pos) => pos.position?.coin === candidate.coin);
        if (!positionState) {
            common.logInfo(
                `No position found for wallet ${candidate.wallet} on coin ${candidate.coin}, marking alert done`
            );
            await DBService.markAlerted(candidate.wallet, candidate.coin, candidate.dateKey, candidate.direction);
            return;
        }

        const alertContext: AlertContext = {
            aggregateTotalNotional: candidate.totalNotional,
            aggregateTradeCount: candidate.tradeCount,
            aggregationWindowMs: config.monitoring.aggregationWindowMs,
            positionState: positionState,
            lastTradeTime: candidate.lastTradeTime,
            state: state
        };

        const message = this.formatAlertMessage(candidate.coin, candidate.wallet, alertContext);
        if (!message) return;
        await this.bot.telegram.sendMessage(config.telegram.targetGroupID, message, {
            parse_mode: 'HTML'
        });

        await DBService.markAlerted(candidate.wallet, candidate.coin, candidate.dateKey, candidate.direction);
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
            common.logInfo(`Connected to coin: ${name}`);
            ws.send(JSON.stringify(payload));
            const pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ method: 'ping' }));
                }
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
        };

        ws.onclose = (event) => {
            const reason = event.reason || 'unknown';
            common.logInfo(`WebSocket closed for coin ${name}, reason: ${reason}`);
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
        };

        return ws;
    }
}
