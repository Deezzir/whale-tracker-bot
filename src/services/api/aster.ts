import { ApiClient, createApiClient } from '../../common/api-client';
import Logger from '../../common/logger';
import { config } from '../../config';
import { getRedisClient } from '../redis';
import { ExchangePair } from './coinglass';

const logger = new Logger('AsterAPI');

interface OIStats {
    symbol: string;
    openInterest: string;
    time: string;
}

export interface ExchangeInfo {
    timezone: string;
    serverTime: String;
    futuresType: string;
    rateLimits: {
        rateLimitType: string;
        interval: string;
        intervalNum: number;
        limit: number;
    };
    exchangeFilters: string[];
    assets: {
        asset: string;
        marginAvailable: boolean;
        autoAssetExchange: string;
    }[];
    symbols: {
        symbol: string;
        pair: string;
        contractType: string;
        deliveryDate: number;
        onboardDate: number;
        status: string;
        maintMarginPercent: string;
        requiredMarginPercent: string;
        baseAsset: string;
        quoteAsset: string;
        marginAsset: string;
        pricePrecision: number;
        quantityPrecision: number;
        baseAssetPrecision: number;
        quotePrecision: number;
        underlyingType: string;
        underlyingSubType: string[];
        symbolType: number;
        tradingMode: number;
        name: string;
        channel: string;
        sequenceNo: number;
        twapMinNotional: string;
        imn: number | null;
        tags: string[];
        settlePlan: number;
        triggerProtect: string;
        liquidationFee: string;
        marketTakeBound: string;
        createTime: number;
        filters: {}[];
        orderTypes: string[];
        timeInForce: string[];
    }[];
}

export default class AsterAPI {
    private client: ApiClient;
    private redis = getRedisClient();

    constructor() {
        this.client = createApiClient({
            name: this.constructor.name,
            baseURL: config.aster.api,
            retry: config.aster.retry,
            rateLimit: config.aster.rateLimit,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'whale-tracker-bot/1.0.0'
            },
            timeout: 15000
        });
    }

    public async fetchExchangeInfo(): Promise<ExchangeInfo | null> {
        const cacheKey = 'aster:exchange-info';

        const cachedInfo = await this.redis.get(cacheKey);
        if (cachedInfo) return JSON.parse(cachedInfo);

        try {
            const response = await this.client.get<ExchangeInfo>('/fapi/v1/exchangeInfo');
            await this.redis.setEx(cacheKey, config.monitor.cacheTTLMs / 1000, JSON.stringify(response.data));
            return response.data;
        } catch (error) {
            logger.error(`Failed to fetch exchange info: ${error}`);
            return null;
        }
    }

    public async fetchCoins(): Promise<ExchangePair[] | null> {
        const cacheKey = 'aster:coins';

        const cachedCoins = await this.redis.get(cacheKey);
        if (cachedCoins) return JSON.parse(cachedCoins);

        try {
            const exchangeInfo = await this.fetchExchangeInfo();
            if (!exchangeInfo) throw new Error('Unable to fetch exchange info for coins');

            const coins = exchangeInfo.symbols.map((asset) => ({
                baseAsset: asset.baseAsset,
                quoteAsset: asset.quoteAsset,
                instrumentId: asset.symbol
            }));
            await this.redis.setEx(cacheKey, config.monitor.cacheTTLMs / 1000, JSON.stringify(coins));
            return coins;
        } catch (error) {
            logger.error(`Failed to fetch coins: ${error}`);
            return null;
        }
    }

    async fetchOI(symbol: string): Promise<OIStats | null> {
        try {
            const response = await this.client.get<OIStats>(`/fapi/v1/openInterestHistory`, {
                params: {
                    symbol
                }
            });
            const data = response.data;
            return data;
        } catch (error) {
            logger.error(`Failed to fetch OI history for ${symbol}: ${error}`);
            return null;
        }
    }
}
