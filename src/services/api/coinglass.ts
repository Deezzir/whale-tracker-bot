import { AxiosError } from 'axios';
import { config } from '../../config';
import Logger from '../../common/logger';
import { createApiClient, ApiClient } from '../../common/api-client';
import { sleep } from '../../common/utils';

const logger = new Logger('CoinglassAPI');
export interface ExchangePair {
    instrumentId: string;
    baseAsset: string;
    quoteAsset: string;
}

export type Interval = '1m' | '5m' | '15m' | '30m';

export interface OICandle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

export interface PriceCandle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volumeUsd: number;
}

export default class CoinglassAPI {
    private client: ApiClient;

    constructor() {
        this.client = createApiClient({
            name: this.constructor.name,
            baseURL: config.coinglass.api,
            retry: config.coinglass.retry,
            rateLimit: config.coinglass.rateLimit,
            headers: {
                'Content-Type': 'application/json',
                'CG-API-KEY': config.coinglass.apiKey,
                'User-Agent': 'whale-tracker-bot/1.0.0'
            },
            timeout: 15000
        });
    }

    getRateLimitUsage(): { usage: number; max: number } {
        return this.client.getRateLimitUsage();
    }

    async fetchExchangePairs(exchange: string): Promise<ExchangePair[] | null> {
        try {
            const response = await this.request<Record<string, any[]>>('/api/futures/supported-exchange-pairs', {
                exchange
            });

            const pairs = response[exchange] || [];
            return pairs
                .filter((p: any) => p.instrument_id && p.base_asset && p.quote_asset)
                .filter((p: any) => {
                    const id = p.instrument_id as string;
                    return id.includes('PERP') || id.includes('_PERP') || !id.match(/\d{6}$/);
                })
                .map((p: any) => ({
                    instrumentId: p.instrument_id as string,
                    baseAsset: p.base_asset as string,
                    quoteAsset: p.quote_asset as string
                }));
        } catch (err) {
            if (!(err instanceof AxiosError) || err.code !== '429') {
                logger.error(`Failed to fetch exchange pairs for ${exchange}: ${err}`);
            }
            return null;
        }
    }

    async fetchOIHistory(
        exchange: string,
        symbol: string,
        interval: Interval = '30m',
        limit: number = 96
    ): Promise<OICandle[] | null> {
        try {
            const data = await this.request<any[]>('/api/futures/open-interest/history', {
                exchange,
                symbol,
                interval,
                limit
            });

            return (data || [])
                .map((c: any) => ({
                    time: Number(c.time),
                    open: parseFloat(c.open),
                    high: parseFloat(c.high),
                    low: parseFloat(c.low),
                    close: parseFloat(c.close)
                }))
                .filter((c: OICandle) => isFinite(c.close) && c.close > 0)
                .sort((a: OICandle, b: OICandle) => a.time - b.time);
        } catch (err) {
            if (!(err instanceof AxiosError) || err.code !== '429') {
                logger.error(`Failed to fetch OI history for ${exchange} ${symbol}: ${err}`);
            }
            return null;
        }
    }

    async fetchPriceHistory(
        exchange: string,
        symbol: string,
        interval: Interval = '30m',
        limit: number = 4
    ): Promise<PriceCandle[] | null> {
        try {
            const data = await this.request<any[]>('/api/futures/price/history', {
                exchange,
                symbol,
                interval,
                limit
            });

            return (data || [])
                .map((c: any) => ({
                    time: Number(c.time),
                    open: parseFloat(c.open),
                    high: parseFloat(c.high),
                    low: parseFloat(c.low),
                    close: parseFloat(c.close),
                    volumeUsd: parseFloat(c.volume_usd || '0')
                }))
                .filter((c: PriceCandle) => isFinite(c.close) && c.close > 0)
                .sort((a: PriceCandle, b: PriceCandle) => a.time - b.time);
        } catch (err) {
            if (!(err instanceof AxiosError) || err.code !== '429') {
                logger.error(`Failed to fetch price history for ${exchange} ${symbol}: ${err}`);
            }
            return null;
        }
    }

    private async request<T>(path: string, params: Record<string, any>): Promise<T> {
        const response = await this.client.get<any>(path, { params });
        const body = response.data;

        if (body.code !== '0') {
            if (body.code === '429') {
                logger.debug(
                    `Rate limited! Usage: ${this.client.getRateLimitUsage().usage}/${this.client.getRateLimitUsage().max}. Waiting 5s...`
                );
                await sleep(5000);
                const err = new AxiosError(
                    `CoinGlass API rate limited: code=${body.code} msg=${body.msg}`,
                    '429',
                    undefined,
                    undefined,
                    { status: 429 } as any
                );
                throw err;
            }
            throw new Error(`CoinGlass API error: code=${body.code} msg=${body.msg}`);
        }

        return body.data as T;
    }
}
