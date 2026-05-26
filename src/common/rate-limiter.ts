import Logger from './logger';

export class RateLimiter {
    private tokens: number;
    private lastRefill: number;
    private readonly maxTokens: number;
    private readonly refillRate: number;

    constructor(ratePerSecond: number, burstCapacity?: number) {
        this.maxTokens = burstCapacity ?? ratePerSecond;
        this.refillRate = ratePerSecond;
        this.tokens = this.maxTokens;
        this.lastRefill = Date.now();
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;
    }

    async acquire(logger?: Logger, moduleName?: string): Promise<void> {
        this.refill();
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return;
        }
        const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;

        if (logger && moduleName && waitMs > 100) {
            logger.warn(
                `[${moduleName}] Rate-limit delay: waiting ${Math.round(waitMs)}ms (tokens=${this.tokens.toFixed(2)})`
            );
        }

        await new Promise((resolve) => setTimeout(resolve, waitMs));
        this.tokens = 0;
        this.lastRefill = Date.now();
    }
}
