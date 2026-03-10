import axios from 'axios';
import { RateLimiter } from '../../common/rate-limiter';
import { config } from '../../config';
import { getRedisClient } from '../redis';
import Logger from '../../common/logger';

const logger = new Logger('polymarket-api');

interface Market {
    conditionId: string;
    title: string;
    slug: string;
    icon?: string;
    outcomes: string[];
    updatedAt: Date;
}

interface WalletInfo {
    date: Date | null;
    nickname: string | null;
}

export interface WalletStats {
    lastTradeTimestamp: number | null;
    totalBuyTrades: number;
    buyTradeAmounts: number[];
}

export interface RawTrade {
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
}

const PAGE_SIZE = 100;
const MAX_OFFSET = 3000;

export default class PolymarketAPIService {
    private gammaLimier = new RateLimiter(config.polymarket.gammaApiRateLimit);
    private dataLimiter = new RateLimiter(config.polymarket.dataApiRateLimit);
    private marketCacheKey = (conditionId: string) => `gamma:market:${conditionId}`;
    private walletCacheKey = (proxyWallet: string) => `gamma:wallet:${proxyWallet}`;
    private walletStatsCacheKey = (proxyWallet: string) => `gamma:wallet-stats:${proxyWallet}`;
    private redis = getRedisClient();

    public async getMarketMetadata(conditionId: string): Promise<Market | null> {
        const cached = await this.redis.get(this.marketCacheKey(conditionId));
        if (cached) return JSON.parse(cached) as Market;

        await this.gammaLimier.acquire();

        try {
            const url = `${config.polymarket.gammaApi}/markets`;
            const { data } = await axios.get<unknown[]>(url, { params: { condition_id: conditionId } });

            if (!Array.isArray(data) || data.length === 0) {
                logger.warn(`No market found for conditionId: ${conditionId}`);
                return null;
            }

            const raw = data[0] as Record<string, unknown>;
            const market: Market = {
                conditionId,
                title: (raw.question as string) || (raw.title as string) || 'Unknown Market',
                slug: (raw.event_slug as string) || (raw.slug as string) || '',
                icon: (raw.icon as string) || undefined,
                outcomes: raw.outcomes ? JSON.parse(raw.outcomes as string) : [],
                updatedAt: new Date()
            };

            await this.redis.setEx(
                this.marketCacheKey(conditionId),
                config.monitor.cacheTTLMs / 1000,
                JSON.stringify(market)
            );
            logger.info(`Cached market: ${market.title}`);
            return market;
        } catch (err) {
            logger.error(`Failed to fetch market metadata for ${conditionId}`, err);
            return null;
        }
    }

    public async getFirstTradeInfo(proxyWallet: string): Promise<WalletInfo> {
        const cached = await this.redis.get(this.walletCacheKey(proxyWallet));
        if (cached) return JSON.parse(cached) as WalletInfo;

        await this.dataLimiter.acquire();

        try {
            const url = `${config.polymarket.dataApi}/activity`;
            const { data } = await axios.get<unknown[]>(url, {
                params: {
                    user: proxyWallet,
                    sortBy: 'TIMESTAMP',
                    sortDirection: 'ASC',
                    limit: 1,
                    type: 'TRADE'
                }
            });

            if (!Array.isArray(data) || data.length === 0) {
                logger.warn(`No trades found for ${proxyWallet}`);
                await this.redis.setEx(
                    this.walletCacheKey(proxyWallet),
                    config.monitor.cacheTTLMs / 1000,
                    JSON.stringify({ date: null, nickname: null })
                );
                return { date: null, nickname: null };
            }

            const entry = data[0] as Record<string, unknown>;
            const date = new Date((entry.timestamp as number) * 1000);
            const nickname = (entry.name as string) || null;
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
            const { data } = await axios.get<unknown[]>(url, {
                params: {
                    user: proxyWallet,
                    sortBy: 'TIMESTAMP',
                    sortDirection: 'DESC',
                    limit: 500,
                    type: 'TRADE'
                }
            });

            if (!Array.isArray(data) || data.length === 0) {
                const stats: WalletStats = { lastTradeTimestamp: null, totalBuyTrades: 0, buyTradeAmounts: [] };
                await this.redis.setEx(
                    this.walletStatsCacheKey(proxyWallet),
                    config.monitor.cacheTTLMs / 1000,
                    JSON.stringify(stats)
                );
                return stats;
            }

            const lastEntry = data[0] as Record<string, unknown>;
            const buyTrades = data.filter((r) => (r as Record<string, unknown>).side === 'BUY') as Array<
                Record<string, unknown>
            >;

            const stats: WalletStats = {
                lastTradeTimestamp: (lastEntry.timestamp as number) * 1000,
                totalBuyTrades: buyTrades.length,
                buyTradeAmounts: buyTrades.map((r) => (r.usdcSize as number) || 0)
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

    public async getRecentTrades(): Promise<RawTrade[]> {
        const allTrades: RawTrade[] = [];
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

                const data: RawTrade[] = await response.json();
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
