import dotenv from 'dotenv';
dotenv.config({ path: './.env', quiet: true });

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function optionalEnv(name: string, fallback: string): string {
    return process.env[name] || fallback;
}

export enum Environment {
    Development = 'development',
    Production = 'production'
}

const ASSETS_PATH = './resources';
const runtimeEnv = optionalEnv('NODE_ENV', 'development') as Environment;

// Config
export const config = {
    env: runtimeEnv,
    logFileEnabled: optionalEnv('LOG_FILE_ENABLED', 'false') === 'true',
    healthServerPort: parseInt(optionalEnv('HEALTH_SERVER_PORT', '9988'), 10),
    logLevel: optionalEnv('LOG_LEVEL', 'INFO'),
    telegram: {
        botToken: requireEnv('BOT_TOKEN'),
        chatID: parseInt(requireEnv('CHAT_ID'), 10),
        hsMainPerpsTopicID: parseInt(requireEnv('HS_MAIN_PERPS_TOPIC_ID'), 10),
        hsOtherPerpsTopicID: parseInt(requireEnv('HS_OTHER_PERPS_TOPIC_ID'), 10),
        hsMainSpotTopicID: parseInt(requireEnv('HS_MAIN_SPOT_TOPIC_ID'), 10),
        hsOtherSpotTopicID: parseInt(requireEnv('HS_OTHER_SPOT_TOPIC_ID'), 10),
        stakeTopicID: parseInt(requireEnv('STAKE_TOPIC_ID'), 10),
        trackTopicID: parseInt(requireEnv('TRACK_TOPIC_ID'), 10),
        polyTopicID: parseInt(requireEnv('POLY_TOPIC_ID'), 10),
        ownerUserID: parseInt(requireEnv('OWNER_USER_ID'), 10)
    },
    monitor: {
        cacheTTLMs: 5 * 60 * 1000, // 2 minutes,
        intervalMs: 30 * 1000, // 30 seconds
        cleanupIntervalMs: 60 * 60 * 1000, // 1 hour
        noDataTimeoutMs: 5 * 60 * 1000, // 5 minutes
        scanStallTimeoutMs: 5 * 60 * 1000 // 5 minutes
    },
    hyperliquid: {
        minNotionalUSD: parseFloat(optionalEnv('HS_MIN_NOTIONAL_USD', '250000')),
        minSpotNotionalUSD: parseFloat(optionalEnv('HS_MIN_SPOT_NOTIONAL_USD', '300000')),
        aggregationWindowMs: parseInt(optionalEnv('HS_AGGREGATION_WINDOW_MS', String(3 * 24 * 60 * 60 * 1000)), 10),
        minimalGrowthPercent: parseFloat(optionalEnv('HS_POS_CHANGE_ALERT_PERCENT', '9')),
        minimalGrowthUSD: parseFloat(optionalEnv('HS_POS_CHANGE_ALERT_USD', '50000')),
        mainCoins: ['BTC', 'ETH', 'BNB', 'XRP', 'ZEC', 'DOGE', 'SOL', 'HYPE'] as string[],
        freshMinUSD: parseFloat(optionalEnv('HS_FRESH_MIN_USD', '200000')),
        freshMainCoinMinUSD: parseFloat(optionalEnv('HS_FRESH_MAIN_COIN_MIN_USD', '450000')),
        freshBtcEthMinUSD: parseFloat(optionalEnv('HS_FRESH_BTC_ETH_MIN_USD', '2000000')),
        whaleMinUSD: parseFloat(optionalEnv('HS_WHALE_MIN_USD', '300000')),
        bigWhaleMinUSD: parseFloat(optionalEnv('HS_BIG_WHALE_MIN_USD', '1000000')),
        twapBtcEthMinUSD: parseFloat(optionalEnv('HS_TWAP_BTC_ETH_MIN_USD', '1000000')),
        twapOtherMinUSD: parseFloat(optionalEnv('HS_TWAP_OTHER_MIN_USD', '300000')),
        wss: 'wss://api.hyperliquid.xyz/ws',
        api: 'https://api.hyperliquid.xyz/info',
        explorer: 'https://hypurrscan.io',
        batchSize: 1000,
        freshWindowMs: parseInt(optionalEnv('HS_FRESH_WINDOW_MS', String(50 * 60 * 60 * 1000)), 10),
        batchFlushIntervalMs: 60 * 1000, // 1 minute
        cleanupTTLms: 5 * 24 * 60 * 60 * 1000, // 5 days
        trackedCheckIntervalMs: 30 * 60 * 1000, // 30 minutes
        analyzeIntervalMs: 15 * 60 * 1000 // 15 minutes
    },
    stake: {
        minAlertBetUSD: parseFloat(optionalEnv('STAKE_MIN_BET_USD', '10000')),
        url: 'https://stake.com',
        api: 'https://stake.com/_api/graphql',
        wss: 'wss://stake.com/_api/websockets',
        batchSize: 30,
        batchFlushIntervalMs: 30 * 1000, // 30 seconds
        cleanupTTLms: 24 * 60 * 60 * 1000, // 24 hours
        alertAgeMs: 5 * 60 * 1000 // 5 minutes
    },
    polymarket: {
        alertThresholdUsd: Number(optionalEnv('POLY_ALERT_THRESHOLD_USD', '100000')),
        sportAlertThresholdUsd: Number(optionalEnv('POLY_SPORT_BET_ALERT_THRESHOLD_USD', '500000')),
        maxPriceFilter: Number(optionalEnv('POLY_MAX_PRICE_FILTER', '0.98')),
        minimalGrowthPercent: parseFloat(optionalEnv('POLY_POS_CHANGE_ALERT_PERCENT', '20')),
        minimalGrowthUSD: parseFloat(optionalEnv('POLY_POS_CHANGE_ALERT_USD', '9000')),
        aggregationWindowMs: parseInt(optionalEnv('POLY_AGGREGATION_WINDOW_MS', String(7 * 24 * 60 * 60 * 1000)), 10),
        url: 'https://polymarket.com',
        wss: 'wss://ws-live-data.polymarket.com',
        dataApi: 'https://data-api.polymarket.com',
        gammaApi: 'https://gamma-api.polymarket.com',
        dataApiRateLimit: 5,
        gammaApiRateLimit: 2,
        batchSize: 50,
        batchFlushIntervalMs: 10 * 1000, // 30 seconds
        cleanupTTLms: 5 * 24 * 60 * 60 * 1000 // 5 days
    },
    db: {
        mongodbURI: optionalEnv('MONGODB_URI', 'mongodb://root:example@localhost:27017') as string,
        dbName: optionalEnv('DB_NAME', 'whale-tracker-bot') as string,
        redisURL: optionalEnv('REDIS_URL', 'redis://localhost:6379') as string,
        redisPassword: optionalEnv('REDIS_PASSWORD', '') as string,
        autoIndex: optionalEnv('DB_AUTO_INDEX', runtimeEnv !== Environment.Production ? 'true' : 'false') === 'true',
        ensureIndexesOnStart: optionalEnv('DB_ENSURE_INDEXES_ON_START', 'true') === 'true'
    },
    puppeteer: {
        screenshotEnabled: optionalEnv('PUPPETEER_SCREENSHOT_ENABLED', 'true') === 'true',
        userDir: optionalEnv('PUPPETEER_USER_DIR', '') as string,
        headless: optionalEnv('PUPPETEER_HEADLESS', 'true') === 'true',
        proxiesPath: optionalEnv('PUPPETEER_PROXIES_PATH', `${ASSETS_PATH}/ports.txt`) as string,
        proxies: optionalEnv('PUPPETEER_PROXIES', '')
            .split(',')
            .map((p) => p.trim())
            .filter((p) => p) as string[]
    },
    openRouter: {
        apiKey: requireEnv('OPENROUTER_API_KEY') as string,
        classifierPromptTemplatePath: optionalEnv(
            'OPENROUTER_CLASSIFIER_PROMPT_TEMPLATE_PATH',
            `${ASSETS_PATH}/trade_classifier_prompt.txt`
        ) as string,
        fastModel: optionalEnv('OPENROUTER_FAST_MODEL', 'gpt-3.5-turbo') as string
    }
} as const;
