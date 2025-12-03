import dotenv from 'dotenv';
dotenv.config({ path: './.env' });

function getEnvvar(var_name: string, default_value: string = ''): any {
    const variable = process.env[var_name] || default_value;
    if (!variable) {
        console.error(`${var_name} is not set`);
        process.exit(1);
    }
    return variable;
}

export enum Environment {
    Development = 'development',
    Production = 'production'
}

// Config
export const config = {
    env: getEnvvar('NODE_ENV', 'development') as Environment,
    telegram: {
        botToken: getEnvvar('BOT_TOKEN'),
        botTitle: 'Hyperliquid Bot',
        botDescription: 'A bot to monitor Hyperliquid trades',
        botCommands: {
            start: 'Start monitoring',
            stop: 'Stop monitoring'
        },
        targetGroupID: parseInt(getEnvvar('TARGET_GROUP_ID'), 10),
        targetMainTopicID: parseInt(getEnvvar('TARGET_MAIN_TOPIC_ID'), 10),
        targetOtherTopicID: parseInt(getEnvvar('TARGET_OTHER_TOPIC_ID'), 10),
        targetTrackTopicID: parseInt(getEnvvar('TARGET_TRACK_TOPIC_ID'), 10),
        targetStakeTopicID: parseInt(getEnvvar('TARGET_STAKE_TOPIC_ID'), 10),
        ownerUserID: parseInt(getEnvvar('OWNER_USER_ID'), 10)
    },
    monitor: {
        autostart: getEnvvar('MONITOR_AUTOSTART', 'true') === 'true',
        cacheTtlMs: 5 * 60 * 1000, // 5 minutes,
        intervalMs: 30 * 1000, // 30 secondss
        cleanupIntervalMs: 60 * 60 * 1000 // 1 hour
    },
    hyperliquid: {
        freshWindowMs: 2 * 24 * 60 * 60 * 1000, // 2 days,
        trackCheckIntervalMs: 30 * 60 * 1000, // 30 minutes
        minSuspiciousNotionalUSD: parseFloat(getEnvvar('MIN_NOTIONAL_USD', '100000')),
        aggregationWindowMs: parseInt(getEnvvar('AGGREGATION_WINDOW_MS', String(24 * 60 * 60 * 1000)), 10),
        mainCoins: ['BTC', 'ETH', 'SOL'],
        posChangeAlertPercent: 10, // 10%
        tradeBatchSize: parseInt(getEnvvar('TRADE_BUFFER_SIZE', '1000'), 10),
        tradeBatchFlushIntervalMs: 60 * 1000, // 1 minute
        cleanupTTLms: 3 * 24 * 60 * 60 * 1000 // 72 hours
    },
    stake: {
        url: 'https://stake.com',
        api: 'https://stake.com/_api/graphql',
        wss: 'wss://stake.com/_api/websockets',
        minAlertBetUSD: parseFloat(getEnvvar('MIN_STAKE_USD', '10000')),
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        betsBatchSize: parseInt(getEnvvar('STAKE_BET_BUFFER_SIZE', '25'), 10),
        betsBatchFlushIntervalMs: 30 * 1000, // 30 seconds
        cleanupTTLms: 24 * 60 * 60 * 1000, // 24 hours
        alertAgeMs: 5 * 60 * 1000 // 5 minutes
    },
    db: {
        mongodbURI: getEnvvar('MONGODB_URI', 'mongodb://root:example@localhost:27017') as string,
        dbName: getEnvvar('DB_NAME', 'hyper-bot') as string,
        redisURL: getEnvvar('REDIS_URL', 'redis://localhost:6379') as string,
        redisPassword: process.env.REDIS_PASSWORD || undefined
    }
};
