import { sleep } from './utils';
import Logger from './logger';

export interface RetryOptions {
    attempts: number;
    delayMs?: number;
    backoffMultiplier?: number;
    shouldRetry?: (error: any) => boolean;
}

const defaultOptions: Required<Omit<RetryOptions, 'shouldRetry'>> = {
    attempts: 3,
    delayMs: 1000,
    backoffMultiplier: 2
};

export async function retry<T>(operation: () => Promise<T>, options: RetryOptions, logger?: Logger): Promise<T> {
    const { attempts, delayMs, backoffMultiplier } = { ...defaultOptions, ...options };
    let lastError: any;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await operation();
        } catch (err) {
            lastError = err;

            if (options.shouldRetry && !options.shouldRetry(err)) {
                throw err;
            }

            if (attempt === attempts) break;

            const delay = delayMs * Math.pow(backoffMultiplier, attempt - 1);
            logger?.warn(`Attempt ${attempt}/${attempts} failed, retrying in ${delay}ms...`);
            await sleep(delay);
        }
    }

    throw lastError;
}
