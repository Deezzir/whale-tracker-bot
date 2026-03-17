import axios from 'axios';
import { config } from '../../config';
import { retryWithBackoff } from '../../common/utils';
import Logger from '../../common/logger';
import { getRedisClient } from '../redis';
import { HyperTradeDirection } from '../db/hyperliquid';

const logger = new Logger('HyperliquidApi');

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

export interface AssetPosition {
    position?: Position;
    type?: string;
}

export interface SpotWsPair {
    wsName: string;
    displayName: string;
}

interface MarginSummary {
    accountValue?: string;
}

interface TraderPerpState {
    assetPositions?: AssetPosition[];
    marginSummary?: MarginSummary;
}

interface TraderSpotState {
    balances: {
        coin: string;
        token: number;
        hold: string;
        total: string;
        entryNtl: string;
    }[];
}

export interface TraderState {
    spot: TraderSpotState | null;
    perp: TraderPerpState | null;
}

interface PortfolioStats {
    accountValueHistory?: PortfolioHistoryPoint[];
    pnlHistory?: PortfolioHistoryPoint[];
    vlm?: string;
}

export type PortfolioResponse = Array<[string, PortfolioStats]>;

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

export default class HyperliquidAPI {
    private api = config.hyperliquid.api;
    private perpStatsKey = 'trade:perpStats';
    private spotStatsKey = 'trade:spotStats';
    private portfolioCacheKey = 'trade:portfolioCache';
    private clearinghouseCacheKey = 'trade:clearinghouseCache';
    private redis = getRedisClient();

    public async getPerpStats(): Promise<PerpsMeta | null> {
        const cachedPerps = await this.redis.get(this.perpStatsKey);
        if (cachedPerps) return JSON.parse(cachedPerps);

        try {
            const operation = () =>
                axios.post(this.api, { type: 'metaAndAssetCtxs' }, { headers: { 'Content-Type': 'application/json' } });
            const response = await retryWithBackoff(operation);
            const data = response.data;

            const meta: PerpsMeta = {
                universe: data[0].universe,
                assetMeta: data[1]
            };
            await this.redis.setEx(this.perpStatsKey, config.monitor.cacheTTLMs / 1000, JSON.stringify(meta));
            return meta;
        } catch (error) {
            logger.error(`Failed to fetch perp stats: ${error}`);
            return null;
        }
    }

    public async getSpotStats(): Promise<SpotMeta | null> {
        const cachedSpot = await this.redis.get(this.spotStatsKey);
        if (cachedSpot) return JSON.parse(cachedSpot);

        try {
            const operation = () =>
                axios.post(
                    this.api,
                    { type: 'spotMetaAndAssetCtxs' },
                    { headers: { 'Content-Type': 'application/json' } }
                );
            const response = await retryWithBackoff(operation);
            const data = response.data;

            const meta: SpotMeta = {
                tokens: data[0].tokens,
                universe: data[0].universe,
                assetMeta: data[1]
            };
            await this.redis.setEx(this.spotStatsKey, config.monitor.cacheTTLMs / 1000, JSON.stringify(meta));
            return meta;
        } catch (error) {
            logger.error(`Failed to fetch spot stats: ${error}`);
            return null;
        }
    }

    public async fetchPortfolio(user: string): Promise<PortfolioResponse | null> {
        const key = `${this.portfolioCacheKey}:${user}`;
        const cached = await this.redis.get(key);
        if (cached) return JSON.parse(cached);

        try {
            const operation = () =>
                axios.post(this.api, { type: 'portfolio', user }, { headers: { 'Content-Type': 'application/json' } });
            const response = await retryWithBackoff(operation);
            const data = response.data as PortfolioResponse;
            await this.redis.setEx(key, config.monitor.cacheTTLMs / 1000, JSON.stringify(data));
            return data;
        } catch (error) {
            logger.error(`Failed to fetch portfolio for ${user}: ${error}`);
            return null;
        }
    }

    private async fetchTraderSpotStats(user: string): Promise<TraderSpotState | null> {
        const key = `${this.clearinghouseCacheKey}:spot:${user}`;
        const cached = await this.redis.get(key);
        if (cached) return JSON.parse(cached);

        try {
            const response = await axios.post(
                this.api,
                { type: 'spotClearinghouseState', user },
                { headers: { 'Content-Type': 'application/json' } }
            );
            const data = response.data as TraderSpotState;
            await this.redis.setEx(key, config.monitor.cacheTTLMs / 1000, JSON.stringify(data));
            return data;
        } catch (error) {
            logger.error(`Failed to fetch spot clearinghouse state for ${user}: ${error}`);
            return null;
        }
    }

    private async fetchTraderPerpStats(user: string): Promise<TraderPerpState | null> {
        const key = `${this.clearinghouseCacheKey}:perp:${user}`;
        const cached = await this.redis.get(key);
        if (cached) return JSON.parse(cached);

        try {
            const response = await axios.post(
                this.api,
                { type: 'clearinghouseState', user },
                { headers: { 'Content-Type': 'application/json' } }
            );
            const data = response.data as TraderPerpState;
            await this.redis.setEx(key, config.monitor.cacheTTLMs / 1000, JSON.stringify(data));
            return data;
        } catch (error) {
            logger.error(`Failed to fetch clearinghouse state for ${user}: ${error}`);
            return null;
        }
    }

    public async fetchTraderState(user: string): Promise<TraderState> {
        const [spot, perp] = await Promise.all([this.fetchTraderSpotStats(user), this.fetchTraderPerpStats(user)]);
        return { spot, perp };
    }

    public async fetchCoins(): Promise<string[]> {
        const response = await axios.post(
            this.api,
            { type: 'meta' },
            { headers: { 'Content-Type': 'application/json' } }
        );
        return response.data.universe.map((u: { name: string }) => u.name);
    }

    public async fetchSpotCoins(): Promise<SpotWsPair[]> {
        try {
            const response = await axios.post(
                this.api,
                { type: 'spotMeta' },
                { headers: { 'Content-Type': 'application/json' } }
            );
            const tokens: { name: string; index: number }[] = response.data.tokens;
            const universe: { tokens: number[]; index: number; name: string }[] = response.data.universe;
            return universe.map((pair) => {
                const baseToken = tokens.find((t) => t.index === pair.tokens[0]);
                const quoteToken = tokens.find((t) => t.index === pair.tokens[1]);
                return {
                    wsName: `${pair.name}`,
                    displayName: `${baseToken?.name || 'UNKNOWN'}/${quoteToken?.name || 'UNKNOWN'}`
                };
            });
        } catch (error) {
            logger.error(`Failed to fetch spot coins: ${error}`);
            return [];
        }
    }

    public isFreshWallet(portfolio: PortfolioResponse): boolean {
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

    public extractPositionDetails(pos: Position): {
        direction: HyperTradeDirection;
        rank: number;
        pnl: number;
        entryPrice: string;
    } {
        const szi: number = parseFloat(pos.szi || '0');
        const direction: HyperTradeDirection = szi > 0 ? 'long' : 'short';
        const rank: number = pos.leverage?.value ? parseFloat(pos.leverage.value.toString()) : 1;
        const pnl: number = pos.unrealizedPnl ? parseFloat(pos.unrealizedPnl) : 0;
        const entryPrice: string = pos.entryPx || 'N/A';
        return { direction, rank, pnl, entryPrice };
    }
}
