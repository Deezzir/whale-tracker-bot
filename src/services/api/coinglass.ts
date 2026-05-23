import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../../config';
import Logger from '../../common/logger';
import { retry } from '../../common/retrier';
import { sleep } from '../../common/utils';

const logger = new Logger('CoinglassAPI');

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

export interface ExchangePair {
    instrumentId: string;
    baseAsset: string;
    quoteAsset: string;
}

function isRetryable(error: any): boolean {
    if (error instanceof AxiosError) {
        const status = error.response?.status;
        if (!status) return true;
        if (status === 429) return true;
        if (status >= 500) return true;
    }
    return false;
}

export type Interval = '1m' | '5m' | '15m' | '30m';

export default class CoinglassAPI {
    private client: AxiosInstance;
    private rateLimitUsage = 0;
    private rateLimitMax = 300;

    constructor() {
        this.client = axios.create({
            baseURL: config.coinglass.api,
            headers: {
                'Content-Type': 'application/json',
                'CG-API-KEY': config.coinglass.apiKey,
                'User-Agent': 'whale-tracker-bot/1.0.0'
            },
            timeout: 15000
        });

        this.client.interceptors.response.use((response) => {
            const maxLimit = response.headers['api-key-max-limit'];
            const useLimit = response.headers['api-key-use-limit'];
            if (maxLimit) this.rateLimitMax = parseInt(maxLimit, 10);
            if (useLimit) {
                this.rateLimitUsage = parseInt(useLimit, 10);
                if (this.rateLimitUsage > this.rateLimitMax * 0.8) {
                    logger.warn(`Rate limit warning: ${this.rateLimitUsage}/${this.rateLimitMax} requests used`);
                }
            }
            return response;
        });
    }

    getRateLimitUsage(): { usage: number; max: number } {
        return { usage: this.rateLimitUsage, max: this.rateLimitMax };
    }

    async fetchExchangePairs(exchange: string): Promise<ExchangePair[]> {
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
    }

    async fetchOIHistory(
        exchange: string,
        symbol: string,
        interval: Interval = '30m',
        limit: number = 96
    ): Promise<OICandle[]> {
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
            .filter((c: OICandle) => isFinite(c.close) && c.close >= 0)
            .sort((a: OICandle, b: OICandle) => a.time - b.time);
    }

    async fetchPriceHistory(
        exchange: string,
        symbol: string,
        interval: Interval = '30m',
        limit: number = 4
    ): Promise<PriceCandle[]> {
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
    }

    private async request<T>(path: string, params: Record<string, any>): Promise<T> {
        return retry(
            async () => {
                if (this.rateLimitUsage > this.rateLimitMax * 0.9) {
                    logger.warn('Approaching rate limit, throttling for 2s');
                    await sleep(2000);
                }

                const response = await this.client.get(path, { params });
                const body = response.data;

                if (body.code !== '0') {
                    if (body.code === '429') {
                        logger.error(`Rate limited! Usage: ${this.rateLimitUsage}/${this.rateLimitMax}. Waiting 5s...`);
                        await sleep(5000);
                    }
                    throw new Error(`CoinGlass API error: code=${body.code} msg=${body.msg}`);
                }

                return body.data as T;
            },
            {
                attempts: 3,
                delayMs: 1000,
                backoffMultiplier: 2,
                shouldRetry: isRetryable
            },
            logger
        );
    }
}
