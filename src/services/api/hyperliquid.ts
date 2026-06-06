import { config } from '../../config';
import { createApiClient, ApiClient } from '../../common/api-client';
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
    accountValue: string;
    balances: {
        coin: string;
        token: number;
        hold: string;
        total: string;
        entryNtl: string;
        px: string;
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

export interface PerpsMeta {
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

interface PerpDex {
    name: string;
    fullName: string;
    deployer: string;
    oracleUpdater: string | null;
    feeRecipient: string | null;
    assetToStreamingOiCap: string[][];
    assetToFundingMultiplier: string[][];
}

export interface L2BookLevel {
    px: string;
    sz: string;
    n: number;
}

export interface L2BookResponse {
    levels: [L2BookLevel[], L2BookLevel[]]; // [bids, asks]
}

export interface TokenDetails {
    name: string;
    totalSupply: string;
    circulatingSupply: string;
    midPx: string;
    markPx: string;
    prevDayPx: string;
    deployer: string;
    deployTime: string;
}

const REQ_TIMEOUT = 10 * 1000; // 10 seconds

export default class HyperliquidAPI {
    private client: ApiClient;
    private redis = getRedisClient();

    private portfolioCacheKey = (user: string) => `hl:portfolio:${user}`;
    private clearinghouseCacheKey = (type: 'spot' | 'perp', user: string, dex?: string) =>
        `hl:clearinghouse:${type}:${dex ? dex : 'default'}:${user}`;
    private perpDexesCacheKey = (dex?: string) => `hl:perp-meta:${dex ? dex : 'default'}`;

    constructor() {
        this.client = createApiClient({
            name: this.constructor.name,
            baseURL: config.hyperliquid.api,
            retry: config.hyperliquid.retry,
            rateLimit: config.hyperliquid.rateLimit,
            headers: { 'Content-Type': 'application/json' },
            timeout: REQ_TIMEOUT
        });
    }

    public async fetchPerpDexes(): Promise<(PerpDex | null)[] | null> {
        const cacheKey = 'hl:perp-dexes';

        const cachedDexes = await this.redis.get(cacheKey);
        if (cachedDexes) return JSON.parse(cachedDexes);

        try {
            const response = await this.client.post<any>('', { type: 'perpDexs' });
            const data = response.data;
            await this.redis.setEx(cacheKey, config.monitor.cacheTTLMs / 1000, JSON.stringify(data));
            return data as PerpDex[];
        } catch (error) {
            logger.error(`Failed to fetch perp dexes: ${error}`);
            return null;
        }
    }

    public async fetchPerpMeta(dex?: string): Promise<PerpsMeta | null> {
        const cachedPerps = await this.redis.get(this.perpDexesCacheKey(dex));
        if (cachedPerps) return JSON.parse(cachedPerps);

        try {
            const response = await this.client.post<any>('', { type: 'metaAndAssetCtxs', dex });
            const data = response.data;

            const meta: PerpsMeta = {
                universe: data[0].universe,
                assetMeta: data[1]
            };
            await this.redis.setEx(this.perpDexesCacheKey(dex), config.monitor.cacheTTLMs / 1000, JSON.stringify(meta));
            return meta;
        } catch (error) {
            logger.error(`Failed to fetch perp stats: ${error}`);
            return null;
        }
    }

    public async fetchSpotMeta(): Promise<SpotMeta | null> {
        const cacheKey = 'hl:spot-meta';

        const cachedSpot = await this.redis.get(cacheKey);
        if (cachedSpot) return JSON.parse(cachedSpot);

        try {
            const response = await this.client.post<any>('', { type: 'spotMetaAndAssetCtxs' });
            const data = response.data;

            const meta: SpotMeta = {
                tokens: data[0].tokens,
                universe: data[0].universe,
                assetMeta: data[1]
            };
            await this.redis.setEx(cacheKey, config.monitor.cacheTTLMs / 1000, JSON.stringify(meta));
            return meta;
        } catch (error) {
            logger.error(`Failed to fetch spot stats: ${error}`);
            return null;
        }
    }

    public async fetchPortfolio(user: string): Promise<PortfolioResponse | null> {
        const cached = await this.redis.get(this.portfolioCacheKey(user));
        if (cached) return JSON.parse(cached);

        try {
            const response = await this.client.post<any>('', { type: 'portfolio', user });
            const data = response.data as PortfolioResponse;
            await this.redis.setEx(
                this.portfolioCacheKey(user),
                config.monitor.cacheTTLMs / 1000,
                JSON.stringify(data)
            );
            return data;
        } catch (error) {
            logger.error(`Failed to fetch portfolio for ${user}: ${error}`);
            return null;
        }
    }

    private async fetchTraderSpotStats(user: string): Promise<TraderSpotState | null> {
        const cached = await this.redis.get(this.clearinghouseCacheKey('spot', user));
        if (cached) return JSON.parse(cached);

        try {
            const response = await this.client.post<any>('', {
                type: 'spotClearinghouseState',
                user
            });

            const data = response.data as TraderSpotState;
            const meta = await this.fetchSpotMeta();

            if (meta) {
                let accountValue = 0.0;
                for (const balance of data.balances) {
                    const universe = meta.universe.find((u) => {
                        const token = meta.tokens.find((t) => t.index === u.tokens[0]);
                        return token && token.name === balance.coin;
                    });
                    const tokenMeta = universe ? meta.assetMeta[universe.index] : undefined;
                    balance.px = tokenMeta ? tokenMeta.markPx : '0';
                    accountValue += parseFloat(balance.total) * parseFloat(balance.px);
                }
                data.accountValue = accountValue.toString();
            }

            await this.redis.setEx(
                this.clearinghouseCacheKey('spot', user),
                config.monitor.cacheTTLMs / 1000,
                JSON.stringify(data)
            );
            return data;
        } catch (error) {
            logger.error(`Failed to fetch spot clearinghouse state for ${user}: ${error}`);
            return null;
        }
    }

    private async fetchTraderPerpStatsAll(user: string): Promise<TraderPerpState | null> {
        try {
            const dexes = await this.fetchPerpDexes();
            if (!dexes) throw new Error('Failed to fetch perp dexes from Hyperliquid API');

            const allPositions: AssetPosition[] = [];
            let marginSummary: MarginSummary = {
                accountValue: '0'
            };

            for (const dex of dexes) {
                const stats = await this.fetchTraderPerpStats(user, dex?.name);
                if (stats) {
                    allPositions.push(...(stats.assetPositions || []));
                    if (stats.marginSummary) {
                        marginSummary.accountValue =
                            parseFloat(marginSummary.accountValue || '0') +
                            parseFloat(stats.marginSummary.accountValue || '0') +
                            '';
                    }
                }
            }

            return { assetPositions: allPositions, marginSummary };
        } catch (error) {
            logger.error(`Failed to fetch perp clearinghouse state for ${user}: ${error}`);
            return null;
        }
    }

    private async fetchTraderPerpStats(user: string, dex?: string): Promise<TraderPerpState | null> {
        const cached = await this.redis.get(this.clearinghouseCacheKey('perp', user, dex));
        if (cached) return JSON.parse(cached);

        try {
            const response = await this.client.post<any>('', {
                type: 'clearinghouseState',
                user,
                dex
            });

            const data = response.data as TraderPerpState;
            await this.redis.setEx(
                this.clearinghouseCacheKey('perp', user),
                config.monitor.cacheTTLMs / 1000,
                JSON.stringify(data)
            );
            return data;
        } catch (error) {
            logger.error(`Failed to fetch clearinghouse state for ${user}: ${error}`);
            return null;
        }
    }

    public async fetchTraderState(user: string): Promise<TraderState> {
        const [spot, perp] = await Promise.all([this.fetchTraderSpotStats(user), this.fetchTraderPerpStatsAll(user)]);
        return { spot, perp };
    }

    public async fetchCoins(excludeDexes: string[]): Promise<string[]> {
        const cacheKey = 'hl:perp-coins-all';

        const cached = await this.redis.get(cacheKey);
        if (cached) return JSON.parse(cached);

        try {
            const dexes = await this.fetchPerpDexes();
            if (!dexes) throw new Error('Failed to fetch perp dexes from Hyperliquid API');

            const coins: string[] = [];
            for (const dex of dexes) {
                if (excludeDexes.includes(dex?.name || 'main')) continue;
                const dexMeta = await this.fetchPerpMeta(dex?.name);
                if (!dexMeta) throw new Error(`Failed to fetch perp meta for dex ${dex?.name} from Hyperliquid API`);
                const current = dexMeta.universe.map((u: { name: string }) => u.name);
                coins.push(...current);
            }
            await this.redis.setEx(cacheKey, config.monitor.cacheTTLMs / 1000, JSON.stringify(coins));
            return coins;
        } catch (error) {
            logger.error(`Failed to fetch coins: ${error}`);
            return [];
        }
    }

    public async fetchSpotCoins(): Promise<SpotWsPair[]> {
        const cacheKey = 'hl:spot-coins-all';

        const cached = await this.redis.get(cacheKey);
        if (cached) return JSON.parse(cached);

        try {
            const response = await this.fetchSpotMeta();
            if (!response) throw new Error('Failed to fetch spot meta from Hyperliquid API');
            const { tokens, universe } = response;

            const coins = universe.map((pair) => {
                const baseToken = tokens.find((t) => t.index === pair.tokens[0]);
                const quoteToken = tokens.find((t) => t.index === pair.tokens[1]);
                return {
                    wsName: `${pair.name}`,
                    displayName: `${baseToken?.name || 'UNKNOWN'}/${quoteToken?.name || 'UNKNOWN'}`
                };
            });
            await this.redis.setEx(cacheKey, config.monitor.cacheTTLMs / 1000, JSON.stringify(coins));
            return coins;
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

    public async fetchL2Book(coin: string): Promise<L2BookResponse | null> {
        const cacheKey = `hl:l2book:${coin}`;
        const cached = await this.redis.get(cacheKey);
        if (cached) return JSON.parse(cached);

        try {
            const response = await this.client.post<any>('', { type: 'l2Book', coin });
            const data = response.data as L2BookResponse;
            await this.redis.setEx(cacheKey, 60, JSON.stringify(data));
            return data;
        } catch (error) {
            logger.error(`Failed to fetch L2 book for ${coin}: ${error}`);
            return null;
        }
    }

    public async fetchTokenDetails(tokenId: string): Promise<TokenDetails | null> {
        const cacheKey = `hl:token-details:${tokenId}`;
        const cached = await this.redis.get(cacheKey);
        if (cached) return JSON.parse(cached);

        try {
            const response = await this.client.post<any>('', { type: 'tokenDetails', tokenId });
            const data = response.data as TokenDetails;
            await this.redis.setEx(cacheKey, config.monitor.cacheTTLMs / 1000, JSON.stringify(data));
            return data;
        } catch (error) {
            logger.warn(`Failed to fetch token details for ${tokenId}: ${error}`);
            return null;
        }
    }

    public computeDepthFromBook(book: L2BookResponse, midPx: number, pctFromMid: number = 0.5): number {
        const threshold = midPx * (1 - pctFromMid / 100);
        let depth = 0;
        for (const level of book.levels[0]) {
            // bids
            const px = parseFloat(level.px);
            if (px < threshold) break;
            depth += px * parseFloat(level.sz);
        }
        return depth;
    }
}
