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
        ownerUserID: parseInt(getEnvvar('OWNER_USER_ID'), 10)
    },
    monitor: {
        autostart: getEnvvar('MONITOR_AUTOSTART', 'true') === 'true',
        freshWindowMs: 2 * 24 * 60 * 60 * 1000, // 2 days,
        cacheTtlMs: 5 * 60 * 1000, // 5 minutes,
        intervalMs: 30 * 1000, // 30 seconds
        cleanupIntervalMs: 60 * 60 * 1000, // 1 hour
        trackCheckIntervalMs: 30 * 60 * 1000, // 30 minutes
        minSuspiciousNotionalUSD: parseFloat(getEnvvar('MIN_NOTIONAL_USD', '100000')),
        aggregationWindowMs: parseInt(getEnvvar('AGGREGATION_WINDOW_MS', String(24 * 60 * 60 * 1000)), 10),
        mainCoins: ['BTC', 'ETH', 'SOL'],
        posChangeAlertPercent: 10 // 10%
    },
    db: {
        mongodbURI: getEnvvar('MONGODB_URI', 'mongodb://root:example@localhost:27017') as string,
        dbName: getEnvvar('DB_NAME', 'hyper-bot') as string,
        redisURL: getEnvvar('REDIS_URL', 'redis://localhost:6379') as string,
        redisPassword: process.env.REDIS_PASSWORD || undefined
    }
};
