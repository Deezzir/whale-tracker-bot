import axios, { isAxiosError } from 'axios';
import { RateLimiter } from '../../common/rate-limiter';
import { config } from '../../config';
import { getRedisClient } from '../redis';
import Logger from '../../common/logger';

const logger = new Logger('PolymarketApi');

export interface Market {
    id: string;
    question: string;
    conditionId: string;
    slug: string;
    outcomes: string;
    outcomePrices: string;
    clobTokenIds: string;
    closed: boolean;
    endDate: string;
    eventStartTime: string;
    volume: string;
    active: boolean;
    negRisk: boolean;
    orderPriceMinTickSize: string;
    tokenIds: { up: string; down: string };
    tags?: {
        label: string;
    }[];
    events?: {
        ticker: string;
        id: string;
    }[];
}

interface WalletInfo {
    date: Date | null;
    nickname: string | null;
}

export interface WalletStats {
    lastTradeTimestamp: number | null;
    totalBuyTrades: number;
    buyTradeAmounts: number[];
    sellTradeAmounts?: number[];
}

export interface Trade {
    proxyWallet: string;
    side: 'BUY' | 'SELL';
    asset: string;
    conditionId: string;
    size: number;
    price: number;
    timestamp: number;
    title: string;
    slug: string;
    icon: string;
    eventSlug: string;
    outcome: string;
    outcomeIndex: number;
    name: string;
    pseudonym: string;
    transactionHash: string;
    usdcSize: number;
}

const PAGE_SIZE = 100;
const MAX_OFFSET = 3000;

export default class PolymarketAPIService {
    private gammaLimiter = new RateLimiter(config.polymarket.gammaApiRateLimit);
    private dataLimiter = new RateLimiter(config.polymarket.dataApiRateLimit);
    private marketCacheKey = (slug: string) => `gamma:market:${slug}`;
    private walletCacheKey = (proxyWallet: string) => `gamma:wallet:${proxyWallet}`;
    private walletStatsCacheKey = (proxyWallet: string) => `gamma:wallet-stats:${proxyWallet}`;
    private redis = getRedisClient();

    public async getMarketBySlug(slug: string): Promise<Market | null> {
        const cached = await this.redis.get(this.marketCacheKey(slug));
        if (cached === 'null') return null;
        if (cached) return JSON.parse(cached) as Market;

        await this.gammaLimiter.acquire();

        try {
            const url = `${config.polymarket.gammaApi}/markets/slug/${slug}`;
            const result = await axios.get<Market>(url, { params: { include_tag: true } });

            await this.redis.setEx(
                this.marketCacheKey(slug),
                config.monitor.cacheTTLMs / 1000,
                JSON.stringify(result.data)
            );
            return result.data;
        } catch (err) {
            if (isAxiosError(err) && err.response?.status === 404) {
                logger.warn(`Market not found for slug: ${slug}`);
                await this.redis.setEx(this.marketCacheKey(slug), config.monitor.cacheTTLMs / 1000, 'null');
                return null;
            }
            logger.error(`Failed to fetch market metadata for ${slug}`, err);
            return null;
        }
    }

    public async getFirstTrade(proxyWallet: string): Promise<WalletInfo> {
        const cached = await this.redis.get(this.walletCacheKey(proxyWallet));
        if (cached) {
            const parsed = JSON.parse(cached) as { date: string | null; nickname: string | null };
            return { date: parsed.date ? new Date(parsed.date) : null, nickname: parsed.nickname };
        }

        await this.dataLimiter.acquire();

        try {
            const url = `${config.polymarket.dataApi}/activity`;
            const { data } = await axios.get<Trade[]>(url, {
                params: {
                    user: proxyWallet,
                    sortBy: 'TIMESTAMP',
                    sortDirection: 'ASC',
                    limit: 1,
                    type: 'TRADE'
                }
            });

            if (data.length === 0) {
                logger.warn(`No trades found for ${proxyWallet}`);
                await this.redis.setEx(
                    this.walletCacheKey(proxyWallet),
                    config.monitor.cacheTTLMs / 1000,
                    JSON.stringify({ date: null, nickname: null })
                );
                return { date: null, nickname: null };
            }

            const entry = data[0];
            const date = new Date(entry.timestamp * 1000);
            const nickname = entry.name || null;
            await this.redis.setEx(
                this.walletCacheKey(proxyWallet),
                config.monitor.cacheTTLMs / 1000,
                JSON.stringify({ date, nickname })
            );
            return { date, nickname };
        } catch (err) {
            logger.error(`Failed to fetch first trade for ${proxyWallet}`, err);
            return { date: null, nickname: null };
        }
    }

    public async getWalletStats(proxyWallet: string): Promise<WalletStats> {
        const cached = await this.redis.get(this.walletStatsCacheKey(proxyWallet));
        if (cached) return JSON.parse(cached) as WalletStats;

        await this.dataLimiter.acquire();

        try {
            const url = `${config.polymarket.dataApi}/activity`;
            const { data } = await axios.get<Trade[]>(url, {
                params: {
                    user: proxyWallet,
                    sortBy: 'TIMESTAMP',
                    sortDirection: 'DESC',
                    limit: 500,
                    type: 'TRADE'
                }
            });

            if (data.length === 0) {
                const stats: WalletStats = { lastTradeTimestamp: null, totalBuyTrades: 0, buyTradeAmounts: [] };
                await this.redis.setEx(
                    this.walletStatsCacheKey(proxyWallet),
                    config.monitor.cacheTTLMs / 1000,
                    JSON.stringify(stats)
                );
                return stats;
            }

            const lastEntry = data[0];
            const buyTrades = data.filter((r) => r.side === 'BUY');
            const sellTrades = data.filter((r) => r.side === 'SELL');

            const stats: WalletStats = {
                lastTradeTimestamp: (lastEntry.timestamp as number) * 1000,
                totalBuyTrades: buyTrades.length,
                buyTradeAmounts: buyTrades.map((r) => (r.usdcSize as number) || 0),
                sellTradeAmounts: sellTrades.map((r) => (r.usdcSize as number) || 0)
            };

            await this.redis.setEx(
                this.walletStatsCacheKey(proxyWallet),
                config.monitor.cacheTTLMs / 1000,
                JSON.stringify(stats)
            );
            return stats;
        } catch (err) {
            logger.error(`Failed to fetch wallet stats for ${proxyWallet}`, err);
            return { lastTradeTimestamp: null, totalBuyTrades: 0, buyTradeAmounts: [] };
        }
    }

    public async getRecentTrades(): Promise<Trade[]> {
        const allTrades: Trade[] = [];
        let offset = 0;

        while (offset < MAX_OFFSET) {
            await this.dataLimiter.acquire();

            const params = new URLSearchParams({
                limit: String(PAGE_SIZE),
                offset: String(offset)
            });

            const url = `${config.polymarket.dataApi}/trades?${params}`;

            try {
                const response = await fetch(url);
                if (!response.ok) {
                    logger.error(`Trades api error: ${response.status} ${response.statusText}`);
                    break;
                }

                const data: Trade[] = await response.json();
                if (data.length === 0) break;

                allTrades.push(...data);
                offset += data.length;

                if (data.length < PAGE_SIZE) break;
            } catch (err) {
                logger.error('Trades fetch failed', err);
                break;
            }
        }
        return allTrades;
    }
}
