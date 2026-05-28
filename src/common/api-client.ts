import axios, { AxiosInstance, AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { RateLimiter } from './rate-limiter';
import Logger from './logger';
import { sleep } from './utils';

export interface RetryPolicy {
    maxAttempts: number;
    initialDelayMs: number;
    backoffMultiplier: number;
    maxDelayMs: number;
    shouldRetry?: (error: any) => boolean;
}

export interface RateLimitPolicy {
    requestsPerSecond: number;
    burstCapacity?: number;
    headerUsageKey?: string;
    headerLimitKey?: string;
    throttleThreshold?: number;
}

export interface ApiClientConfig {
    name: string;
    baseURL?: string;
    retry: RetryPolicy;
    rateLimit?: RateLimitPolicy;
    headers?: Record<string, string>;
    timeout?: number;
}

export interface ApiRequestConfig extends AxiosRequestConfig {}

const RETRYABLE_NETWORK_CODES = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ERR_NETWORK'
]);

export function defaultShouldRetry(error: any): boolean {
    if (error instanceof AxiosError) {
        const status = error.response?.status;
        if (!status) return true; // network error
        if (status === 429) return true;
        if (status >= 500) return true;
        return false;
    }
    if (error?.code && RETRYABLE_NETWORK_CODES.has(error.code)) return true;
    return false;
}

function parseRetryAfter(response: AxiosResponse | undefined): number | null {
    if (!response?.headers) return null;
    const retryAfter = response.headers['retry-after'];
    if (!retryAfter) return null;

    const seconds = Number(retryAfter);
    if (!isNaN(seconds) && seconds > 0) return seconds * 1000;

    const date = Date.parse(retryAfter);
    if (!isNaN(date)) {
        const delayMs = date - Date.now();
        return delayMs > 0 ? delayMs : null;
    }

    return null;
}

async function retryOperation<T>(
    operation: () => Promise<T>,
    policy: RetryPolicy,
    logger: Logger,
    moduleName: string
): Promise<T> {
    const { maxAttempts, initialDelayMs, backoffMultiplier, maxDelayMs } = policy;
    const shouldRetry = policy.shouldRetry ?? defaultShouldRetry;
    let lastError: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await operation();
        } catch (error: any) {
            lastError = error;

            if (!shouldRetry(error)) throw error;
            if (attempt === maxAttempts) break;

            let delay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
            delay = Math.min(delay, maxDelayMs);

            const retryAfterMs = parseRetryAfter(error?.response);
            if (retryAfterMs !== null && retryAfterMs > delay) {
                delay = Math.min(retryAfterMs, maxDelayMs);
            }

            logger.debug(
                `[${moduleName}] Retry ${attempt}/${maxAttempts}: delay=${delay}ms error="${error.message || error}"`
            );

            await sleep(delay);
        }
    }

    throw lastError;
}

export class ApiClient {
    private axiosInstance: AxiosInstance;
    private rateLimiter: RateLimiter | null = null;
    private logger: Logger;
    private config: ApiClientConfig;

    private rateLimitUsage = 0;
    private rateLimitMax = 0;

    constructor(clientConfig: ApiClientConfig) {
        this.config = clientConfig;
        this.logger = new Logger(`ApiClient:${clientConfig.name}`);

        this.axiosInstance = axios.create({
            baseURL: clientConfig.baseURL,
            headers: clientConfig.headers,
            timeout: clientConfig.timeout
        });

        if (clientConfig.rateLimit) {
            this.rateLimiter = new RateLimiter(
                clientConfig.rateLimit.requestsPerSecond,
                clientConfig.rateLimit.burstCapacity
            );
        }

        this.axiosInstance.interceptors.response.use((response) => {
            this.updateRateLimitFromHeaders(response);
            return response;
        });
    }

    private updateRateLimitFromHeaders(response: AxiosResponse): void {
        const policy = this.config.rateLimit;
        if (!policy?.headerUsageKey || !policy?.headerLimitKey) return;

        const usage = response.headers[policy.headerUsageKey];
        const max = response.headers[policy.headerLimitKey];
        if (max) this.rateLimitMax = parseInt(max, 10);
        if (usage) this.rateLimitUsage = parseInt(usage, 10);
    }

    private async acquireRateLimit(): Promise<void> {
        if (!this.rateLimiter) return;

        const policy = this.config.rateLimit;
        if (policy && this.rateLimitMax > 0) {
            const threshold = policy.throttleThreshold ?? 0.9;
            if (this.rateLimitUsage > this.rateLimitMax * threshold) {
                this.logger.debug(
                    `[${this.config.name}] Proactive throttle: usage=${this.rateLimitUsage}/${this.rateLimitMax}, waiting 2s`
                );
                await sleep(2000);
            }
        }

        await this.rateLimiter.acquire(this.logger, this.config.name);
    }

    async request<T>(config: ApiRequestConfig): Promise<AxiosResponse<T>> {
        return retryOperation(
            async () => {
                await this.acquireRateLimit();
                return this.axiosInstance.request<T>(config);
            },
            this.config.retry,
            this.logger,
            this.config.name
        );
    }

    async get<T>(url: string, config?: ApiRequestConfig): Promise<AxiosResponse<T>> {
        return this.request<T>({ ...config, method: 'GET', url });
    }

    async post<T>(url: string, data?: any, config?: ApiRequestConfig): Promise<AxiosResponse<T>> {
        return this.request<T>({ ...config, method: 'POST', url, data });
    }

    getRateLimitUsage(): { usage: number; max: number } {
        return { usage: this.rateLimitUsage, max: this.rateLimitMax };
    }
}

export function createApiClient(config: ApiClientConfig): ApiClient {
    return new ApiClient(config);
}
