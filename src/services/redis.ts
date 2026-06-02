import { createClient, createSentinel } from 'redis';
import { config } from '../config';
import Logger from '../common/logger';

const logger = new Logger('Redis');

const redis = createRedisClient();

function createRedisClient() {
    logger.info(`Creating Redis client in ${config.redis.mode} mode`);
    if (config.redis.mode === 'sentinel' && config.redis.sentinel) {
        return createSentinel({
            name: config.redis.sentinel.name,
            sentinelRootNodes: [{ host: config.redis.sentinel.host, port: config.redis.sentinel.port }],
            nodeClientOptions: {
                password: config.redis.password || undefined
            },
            sentinelClientOptions: {
                password: config.redis.password || undefined
            },
            replicaPoolSize: config.redis.sentinel.replicaPoolSize || 1
        });
    }

    return createClient({
        url: config.redis.url,
        password: config.redis.password || undefined,
        commandsQueueMaxLength: 128,
        socket: {
            connectTimeout: 5000,
            reconnectStrategy: (retries) => Math.min(retries * 500, 5000)
        }
    });
}

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
        // logger.info('Connected to Redis');
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
