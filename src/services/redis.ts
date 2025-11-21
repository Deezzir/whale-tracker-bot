import { createClient } from 'redis';
import { config } from '../config';
import * as common from '../common';

const redis = createClient({
    url: config.db.redisURL,
    password: config.db.redisPassword || undefined
});

export function getRedisClient() {
    return redis;
}

export async function connectRedis() {
    try {
        redis.on('error', (err) => {
            common.logError(`Redis Client Error: ${err}`);
            process.exit(1);
        });
        await redis.connect();
        common.logInfo('Connected to Redis');
    } catch (error) {
        common.logError(`Redis connection error: ${error}`);
        process.exit(1);
    }
}

export async function closeRedis() {
    try {
        await redis.quit();
        common.logInfo('Redis connection closed');
    } catch (error) {
        common.logError(`Error closing Redis connection: ${error}`);
    }
}
