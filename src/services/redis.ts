import { createClient } from 'redis';
import { config } from '../config';
import Logger from '../common/logger';

const logger = new Logger('redis');

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
            logger.error(`Redis Client Error: ${err}`);
            process.exit(1);
        });
        await redis.connect();
        logger.info('Connected to Redis');
    } catch (error) {
        logger.error(`Redis connection error: ${error}`);
        process.exit(1);
    }
}

export async function closeRedis() {
    try {
        await redis.quit();
        logger.info('Redis connection closed');
    } catch (error) {
        logger.error(`Error closing Redis connection: ${error}`);
    }
}
